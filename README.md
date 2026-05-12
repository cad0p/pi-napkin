# pi-napkin

🧻 [Napkin](https://github.com/cad0p/napkin) integration for [pi](https://github.com/badlogic/pi-mono).

Gives a pi agent first-class access to an Obsidian-compatible knowledge vault, with automatic knowledge distillation that safely captures conversation context into notes as you work.

## Install

```bash
# pnpm
pnpm add -g @cad0p/napkin

# npm
npm install -g @cad0p/napkin

pi install git:github.com/cad0p/pi-napkin
```

## What you get

Two pi extensions, one skill, two slash commands, one agent tool.

### Extensions

| Extension | What it does |
|---|---|
| `napkin-context` | On session start, injects the vault overview into the agent's context. Registers `kb_search` + `kb_read` tools. |
| `napkin-distill` | Automatic knowledge distillation. Runs on a timer and at shutdown, forks the conversation, and asks a cheap model to extract structured notes into the vault. |

### Skill

The [`napkin` skill](skills/napkin/SKILL.md) gives the agent a full CLI reference — all commands, flags, and patterns.

### Slash commands

- `/distill` — Trigger a manual distill now. Works in any vault; does not require git.
- `/distill-auto-this-session` — Turn the automatic timer off / on for the current session. Persists across pi restarts.
- `/distill-status` — Show active background distill processes for the current vault.

### Agent tool

- `napkin_distill_status` — JSON version of `/distill-status`, for the agent to query programmatically before making concurrent vault edits.

## Vault resolution

Both extensions use napkin's built-in vault resolution. The resolution order is:

1. **Local project vault** — walk up from cwd looking for `.napkin/` (or `.obsidian/.napkin/`)
2. **Global fallback** — read `$XDG_CONFIG_HOME/napkin/config.json` (defaults to `~/.config/napkin/config.json`)
3. **Bare vault** — create a new vault at cwd as a last resort

```json
// ~/.config/napkin/config.json
{
  "vault": "~/path/to/vault"
}
```

Local project vaults take priority when present.

### Migrating from `~/.pi/agent/napkin.json`

If you previously configured your vault in `~/.pi/agent/napkin.json`, move it to the new location:

```bash
mkdir -p ~/.config/napkin
cp ~/.pi/agent/napkin.json ~/.config/napkin/config.json
```

## Auto-distill

Auto-distill is the core feature. It runs in the background without prompting the user, periodically forking your pi session and asking a cheap model to extract knowledge into the vault. It's off by default.

### Enable it

```bash
napkin --vault ~/path/to/vault config set --key distill.enabled --value true
```

Or edit `<vault>/.napkin/config.json` directly:

```jsonc
{
  "distill": {
    "enabled": true,
    "intervalMinutes": 60,
    "onShutdown": true,
    "model": { "provider": "kiro", "id": "claude-sonnet-4-6" }
  }
}
```

### Config keys

| Setting | Default | Description |
|---|---|---|
| `distill.enabled` | `false` | Master switch. When false, nothing auto-distill related happens. |
| `distill.intervalMinutes` | `60` | Timer interval. |
| `distill.onShutdown` | `true` | Also run a final distill at pi shutdown, to capture anything the interval missed. |
| `distill.model.provider` | `"anthropic"` | Model provider for the distill subprocess. |
| `distill.model.id` | `"claude-sonnet-4-6"` | Model ID. Prefer a cheap, fast model — distill is automated, not interactive. |

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `NAPKIN_DISTILL_MAX_DURATION_MS_OVERRIDE` | `600000` (10 min) | Override the maximum wall-clock duration a detached distill subprocess is allowed before the parent's poll loop declares it stuck and force-cleans its worktree. Value is milliseconds as a positive integer; invalid values (`0`, negative, non-numeric, NaN) are silently ignored and the 10-minute default is used. Lower this for short-session vaults where a 10-minute hang is unacceptable; raise it for vaults with large merge windows. |

### How it works

When enabled, on session start the extension:

1. Runs `ensureVaultReadyForAutoDistill` on the vault (see below) — git-inits if needed and scaffolds `.gitignore` / `.gitattributes`.
2. Sweeps stale distill worktrees left by crashed pi instances (`cleanupStaleWorktrees`).
3. Arms a timer (`intervalMinutes`) that spawns a detached `pi -p` subprocess on tick.
4. On shutdown (unless `distill.onShutdown` is false or the session file is already captured), spawns one final distill.

Each distill subprocess gets its own isolated copy of the vault via `git worktree add`. See [Concurrency](#concurrency) below.

The distill subprocess runs a prompt that asks the model to:
- Learn the vault structure via `napkin overview` and `_about.md` files
- Read the templates via `napkin template list`
- Search for existing notes on a topic before creating duplicates
- Create or append to notes as appropriate
- Add `[[wikilinks]]` to related notes
- Tag superseded notes with `supersedes: ["path/to/old.md"]` frontmatter for a future janitor to archive

### Auto-init on first use

When you enable `distill.enabled: true` on a vault that isn't a git repo, pi-napkin auto-initializes it on the next session start:

1. Runs `git init`.
2. Scaffolds `.gitignore` (excludes `.napkin/distill/`, `.napkin/distill-worktrees/`) and `.gitattributes` (routes `*.md` through the LLM merge driver).
3. Commits everything as `napkin: initial vault commit (auto-distill setup)`.
4. Notifies you once, with instructions to undo (`rm -rf <vault>/.git`) or opt out (`distill.enabled: false`).

Auto-distill requires git. Manual `/distill` does not — it just spawns a detached `pi -p` with the session forked to a temp dir, no worktree.

### Running an auto-distill loop

Once configured, nothing further is required: open any pi session in a directory under the vault and the timer arms automatically. You'll see a `distill: Xm..s` countdown in the status bar and a one-time notice when a distill begins, completes, or fails.

To pause for the current session only (e.g., you're drafting sensitive content you don't want captured):

```
/distill-auto-this-session off
```

Toggles back on with `/distill-auto-this-session on`. State persists across pi restarts of that same session.

## Concurrency

Running multiple pi sessions against the same vault (e.g., via `cr-auto-action`) or having Obsidian open while a distill is running would race on file writes. pi-napkin uses git worktrees to make this safe.

### Worktree per distill

Each auto-distill invocation (interval fire or shutdown) creates its own temporary branch and worktree under `<vault>/.napkin/distill-worktrees/<branch-suffix>/`. The distill subprocess runs with `cwd` pointing at the worktree, so napkin's vault resolution picks up the isolated copy.

### LLM merge driver

When the distill commits its changes and merges back to main, conflicts are resolved by a custom git merge driver (`.napkin-distill-merge`) that calls the same model as the distill itself. The driver is registered per-worktree via `git config --local` and routed at the file level by an `*.md merge=napkin-distill-merge` entry in `.gitattributes`.

The driver makes three attempts per conflict. After three strikes, the driver exits 1 and git leaves conflict markers — handled by the next step.

### Partial-merge salvage

If the LLM merge driver fails on some files, we don't abort the whole merge. Files that merged cleanly keep the distill's content; files that failed fall back to main's version via `git checkout main -- <file>`.

Think of it as: "save what you can, log what you lost." A per-failure entry is written to `<vault>/.napkin/distill/errors/` so you can inspect what was discarded, and the dangling distill commit SHA is kept for ~2 weeks of git gc grace in case you want to recover it manually.

### Linear history

Successful distill lifecycles produce exactly one squash commit on `main`, with an LLM-generated summary message. This keeps history clean and makes it easy to revert a bad distill with `git revert <sha>`.

## Agent visibility

When the main agent has been writing to vault files that a background distill is also editing, pi-napkin injects a one-line notice into the next turn's system prompt:

```
⚠️ Background napkin distill is editing files you've also touched: notes/foo.md.
Recent writes to these files may be overwritten or merged automatically at distill
completion; consider re-reading before further edits.
```

Key properties:
- Injected via `before_agent_start`'s `systemPrompt` return, NOT `message` — so it's per-turn and ephemeral.
- Zero tokens when there's no overlap. The handler runs, finds no intersection, and returns nothing.
- Not persisted to the session file — subsequent turns only see the notice if the overlap still exists.

The session-touched-files detector reimplements pi's internal `extractFileOpsFromMessage` (not exported from pi) and tracks `write`, `edit`, and bash-redirection-style writes. A companion version-check test (`session-touched-files.version-check.test.ts`) pins pi's upstream utility so we get an explicit test failure if pi renames / removes it.

## Vault setup

### New vault

```bash
mkdir my-vault && cd my-vault
napkin init
```

Then edit `.napkin/config.json` to set `distill.enabled: true`. On first pi session in the vault, auto-distill will auto-init git for you.

### Existing Obsidian vault

Just `cd` into it and run `pi`. napkin will detect `.obsidian/` and treat it as a vault. The `.napkin/` config dir lives alongside `.obsidian/`.

If you want auto-distill on an existing Obsidian vault:

1. Set `distill.enabled: true` in `.napkin/config.json` (create the file if missing).
2. Start a pi session in the vault.
3. On session start, pi-napkin prompts to auto-init git if the vault isn't already one.

If your vault IS already a git repo (common for "vault as project"), pi-napkin just adds the `.gitignore` / `.gitattributes` scaffolds and moves on.

## Troubleshooting

### "No vault in cwd"

Some command or tool couldn't resolve a vault from the current directory. Either:
- Run from a directory under a vault (any ancestor with `.napkin/` or `.obsidian/`)
- Set the global fallback in `~/.config/napkin/config.json`
- Pass `--vault <path>` to the napkin CLI

### Auto-distill stopped working

Check `/distill-status` to see if there are stale / dead worktrees. The next session start will sweep them automatically (`cleanupStaleWorktrees`), but you can also manually delete `<vault>/.napkin/distill-worktrees/*` if needed.

### Merge driver fails repeatedly

Error log: `<vault>/.napkin/distill/errors/<ISO-timestamp>-<pid>-<branch-hash>.log`.

Each log has the conflicted files, the last LLM response, and an optional one-liner describing the failure. Common causes:

- Model is rate-limited → retry later.
- LLM returned empty / tiny / huge output → driver sanity-check rejects it. Usually a transient provider issue.
- Conflicted content is genuinely unmergeable (same line added with different content) → the partial-merge salvage falls back to main's version; the distill commit SHA is kept in reflog for ~2 weeks if you want to recover it.

### "vault not a git repo"

Auto-distill requires git. Either:
- Set `distill.enabled: true` and let pi-napkin auto-init git for you on next session
- Run `git init` in the vault root manually
- Or disable auto-distill: `distill.enabled: false`

Manual `/distill` works without git.

## Future: builder-deleter

Next major feature: a "builder-deleter" janitor that acts on the `supersedes:` frontmatter convention that auto-distill already writes. When a note lists `supersedes: ["old/note.md"]`, the janitor archives the superseded file. Threshold-triggered to avoid running on every distill, git gc as the safety net.

See [features/pi-napkin-distill/builder-deleter](https://github.com/cad0p/pi-napkin/blob/main/features/) (design pending) for the full design.

## License

MIT
