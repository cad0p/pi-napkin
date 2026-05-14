# pi-napkin

🧻 [Napkin](https://github.com/cad0p/napkin) integration for [pi](https://github.com/badlogic/pi-mono).

Gives a pi agent first-class access to an Obsidian-compatible knowledge vault, with automatic knowledge distillation that safely captures conversation context into notes as you work.

## Install

pi-napkin depends on the [`@cad0p/napkin`](https://github.com/cad0p/napkin) CLI. Install it first:

```bash
npm install -g @cad0p/napkin
# or: bun add -g @cad0p/napkin
```

Then install the pi-napkin extension:

```bash
pi install npm:@cad0p/pi-napkin
```

<details>
<summary>Pre-release / dev installs</summary>

- Pre-release (calver snapshots from `main`, published to npm `@next` on every push):

  ```bash
  pi install npm:@cad0p/pi-napkin@next
  ```

  pi pins npm installs with an explicit tag or version — `pi update` won't auto-bump this. Re-run the install to pick up newer `@next` builds.

- Install from source for local development:

  ```bash
  pi install git:github.com/cad0p/pi-napkin
  ```

</details>

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

## Auto-distill requires subdir vault layout

Auto-distill (interval + shutdown) uses git worktrees for concurrency safety.
That requires the vault to use napkin's **subdir layout** — the config in a
`.napkin/` subdir distinct from the content root:

```
my-vault/
  .napkin/
    config.json    ← napkin config here, with `"vault": { "root": ".." }`
  NAPKIN.md
  changelog/
  daily/
  …
```

`napkin init` creates this layout by default, so freshly created vaults work out
of the box. If your vault uses the **legacy embedded layout** (config at
`<vault>/config.json` with no `.napkin/` subdir, where `configPath ===
contentPath`), you'll see a migration notification at session start and
auto-distill will be disabled for the session. Legacy layout continues to
work for manual `/distill` (which doesn't need concurrency safety) and for
napkin CLI commands generally — only auto-distill requires the subdir
layout.

### Why

Worktree-based concurrency relies on napkin's `findVault(cwd)` resolving
`cwd=worktree` back to the worktree itself. On a subdir-layout vault, the
branch tracks `.napkin/config.json`, so the worktree has a `.napkin/`
subdir that findVault picks up. On a legacy-embedded vault, the branch
has no `.napkin/` subdir, findVault walks past the worktree, and
resolves to the user's REAL vault via the global-config fallback —
distill writes bypass the worktree entirely and the concurrency
guarantee silently degrades to nothing.

### Where worktrees live

Active distill worktrees are placed under
`$XDG_CACHE_HOME/napkin-distill/<vault-hash>/<id>/` (typically
`~/.cache/napkin-distill/…`), outside your vault. `<vault-hash>` is
`sha256(contentPath).slice(0, 16)` so worktrees from multiple vaults never
collide. External placement avoids:

- **Cloud-sync pollution** — OneDrive/Dropbox don't respect `.gitignore`;
  in-vault worktrees would upload tens of MB per distill spawn.
- **Filesystem-walker pollution** — Obsidian plugins and `find` descend
  into worktrees and see N full vault copies for N concurrent distills.
- **Autocommit-cron noise** — gitlinks can surface in `git status` under
  some command sequences; external placement eliminates the surface.

Inspect active distills with `/distill-status`. If you ever need to nuke
all distill state for a vault (stuck lock, etc.):

```bash
rm -rf ~/.cache/napkin-distill/<hash>/
```

Safe — anything valuable is either already committed to main or was
never going to commit.

### Migration from legacy layout

```bash
# From your vault directory (e.g. ~/.napkin or wherever configPath == contentPath)
mkdir .napkin
mv config.json .napkin/config.json
# Edit .napkin/config.json and add at the top level:
#   "vault": { "root": ".." }
# After editing, reload pi (or /quit and restart).
```

Verify with `napkin vault --json` — the `path` field should point at
`<vault>/.napkin/` (that's the new configPath) and napkin should still
find all your notes.

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
| `distill.maxDurationMinutes` | `10` | Maximum wall-clock duration a detached distill subprocess is allowed before the parent's poll loop declares it stuck and force-cleans its worktree. Values `<= 0` or non-finite silently fall back to the 10-minute default so a bad config can't disable the timeout entirely. Lower this for short-session vaults where a 10-minute hang is unacceptable; raise it for vaults with large merge windows or slow providers. |
| `distill.onShutdown` | `true` | Also run a final distill at pi shutdown, to capture anything the interval missed. |
| `distill.model.provider` | `"anthropic"` | Model provider for the distill subprocess. |
| `distill.model.id` | `"claude-sonnet-4-6"` | Model ID. Prefer a cheap, fast model — distill is automated, not interactive. |

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
2. Scaffolds `.gitignore` (excludes `.napkin/distill/` — the per-worktree session fork) and `.gitattributes` (routes `*.md` through the LLM merge driver). Distill worktrees themselves live outside the vault (see [Where worktrees live](#where-worktrees-live)), so `.gitignore` doesn't need to exclude them.
3. Commits everything as `napkin: initial vault commit (auto-distill setup)`.
4. Notifies you once, with instructions to undo (`rm -rf <vault>/.git`) or opt out (`distill.enabled: false`).

Auto-distill requires git **and** the subdir vault layout (see [Auto-distill requires subdir vault layout](#auto-distill-requires-subdir-vault-layout)). Manual `/distill` requires neither — it just spawns a detached `pi -p` with the session forked to a temp dir, no worktree.

### Running an auto-distill loop

Once configured, nothing further is required: open any pi session in a directory under the vault and the timer arms automatically. You'll see a `distill: Xm..s` countdown in the status bar and a one-time notice when a distill begins, completes, or fails.

To pause for the current session only (e.g., you're drafting sensitive content you don't want captured):

```
/distill-auto-this-session off
```

Toggles back on with `/distill-auto-this-session on`. State persists across pi restarts of that same session.

## Concurrency

Running multiple pi sessions against the same vault (for example, autonomous agent fleets spawning many sessions in parallel) or having Obsidian open while a distill is running would race on file writes. pi-napkin uses git worktrees to make this safe.

### Worktree per distill

Each auto-distill invocation (interval fire or shutdown) creates its own temporary branch and worktree under `$XDG_CACHE_HOME/napkin-distill/<vault-hash>/<branch-suffix>/` (typically `~/.cache/napkin-distill/…`). The distill subprocess runs with `cwd` pointing at the worktree, so napkin's vault resolution picks up the isolated copy. See [Where worktrees live](#where-worktrees-live) for why placement is external.

### LLM merge driver

When the distill commits its changes and merges back to main, conflicts are resolved by a custom git merge driver (`.napkin-distill-merge`) that calls the same model as the distill itself. The driver is registered per-worktree via `git config --local` and routed at the file level by an `*.md merge=napkin-distill-merge` entry in `.gitattributes`.

The driver makes three attempts per conflict. After three strikes, the driver exits 1 and git leaves conflict markers — handled by the next step.

### Partial-merge salvage

If the LLM merge driver fails on some files, we don't abort the whole merge. Files that merged cleanly keep the distill's content; files that failed fall back to main's version via `git checkout main -- <file>`.

Think of it as: "save what you can, log what you lost." A per-failure entry is written to `<vault>/.napkin/distill/errors/` so you can inspect what was discarded, and the dangling distill commit SHA is kept for ~2 weeks of git gc grace in case you want to recover it manually.

### Linear history

Successful distill lifecycles produce exactly one squash commit on `main`, with an LLM-generated summary message. This keeps history clean and makes it easy to revert a bad distill with `git revert <sha>`.

## Agent visibility

When a background distill completes a squash-merge that touches files you've also written this session, pi-napkin posts a one-line notice into the conversation as a custom session message so the agent knows its recent writes may have been merged or overwritten:

```
⚠️ Background napkin distill is editing files you've also touched: notes/foo.md.
Recent writes to these files may be overwritten or merged automatically at distill
completion; consider re-reading before further edits.
```

Key properties:
- **Trigger**: per distill completion (when the wrapper's squash-merge has landed and the worktree is gone), not per agent turn. Files actually changing in the parent's view is the right moment to surface the overlap.
- **Channel**: posted via `appendCustomMessageEntry` with `customType: "napkin-distill-overlap"`. Lives in session history (so distill subprocesses inherit it cleanly via session-fork) and is displayed in the TUI so you see it too.
- **Cache parity**: custom messages land at the END of the message array, so Anthropic-style prompt caching's prefix stays byte-identical. The notice itself becomes a one-time cache write rather than the recurring cache-bust the previous per-turn `appendSystemPrompt` mechanism produced.
- **Frequency**: bounded by the per-distill-completion trigger — typically ~5–12 messages/day for an active session, only when actual file overlap exists.
- **Cursor**: each completion only considers entries added since the previous completion. On a fresh session this starts at 0; on a resumed session it starts at the pre-resume entry count, so resume doesn't surface stale notices for files written in earlier pi processes.

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

Check `/distill-status` to see if there are stale / dead worktrees. The next session start will sweep them automatically (`cleanupStaleWorktrees`). If that doesn't help, nuke the per-vault cache dir:

```bash
rm -rf ~/.cache/napkin-distill/<vault-hash>/
# Or, if you're not sure which hash matches your vault, the nuclear option:
rm -rf ~/.cache/napkin-distill/
```

Safe — anything valuable is either already committed to main or was never going to commit.

### Merge driver fails repeatedly

Error log: `<vault>/.napkin/distill/errors/<ISO-timestamp>-<pid>-<branch-hash>.log`.

Each log has the conflicted files, the last LLM response, and an optional one-liner describing the failure. Common causes:

- Model is rate-limited → retry later.
- LLM returned empty / tiny / huge output → driver sanity-check rejects it. Usually a transient provider issue.
- Conflicted content is genuinely unmergeable (same line added with different content) → the partial-merge salvage falls back to main's version; the distill commit SHA is kept in reflog for ~2 weeks if you want to recover it.

### "vault not a git repo" / "legacy embedded layout"

Auto-distill requires **git** and the **subdir vault layout**. If you see:

- `vault not a git repo` — either set `distill.enabled: true` and let pi-napkin auto-init git for you on next session, run `git init` in the vault root manually, or disable auto-distill with `distill.enabled: false`.
- `legacy embedded layout` — follow the [migration steps](#migration-from-legacy-layout). Auto-distill stays off for this session; manual `/distill` works regardless.

Manual `/distill` works without git and works on any vault layout.

### Testing hooks

The distill wrapper (`extensions/distill/scripts/distill-wrapper.sh`) reads several environment variables that exist solely to make integration tests deterministic. Production code never sets them; documenting here so future maintainers know they exist and what they do, and so a future-you grepping for one of these names can land on this section.

| Variable | Purpose |
|---|---|
| `NAPKIN_DISTILL_PI_BIN` | Override the `pi` binary path. Tests point this at `/usr/bin/true` (exits 0 quickly) or a stub script so the wrapper completes its lifecycle without contacting a real LLM. |
| `NAPKIN_DISTILL_MERGE_MOCK` | Forwarded to `napkin-distill-merge` (the LLM driver). Set to `fail` to force every conflict to 3-strike, or `ok-after-N` to succeed after N attempts. Used to exercise the partial-merge salvage path. |
| `NAPKIN_DISTILL_SKIP_PI=1` | Skip BOTH the napkin shim install AND the `pi` invocation. Used by tests that pre-stage file changes manually and only want to exercise the wrapper's git lifecycle (commit/merge/squash). |
| `NAPKIN_DISTILL_HALT_AFTER_META=1` | Halt right after rewriting `meta.json`'s pid to the wrapper's pid. Lets tests inspect the updated meta without the cleanup trap wiping the worktree. Clears the `EXIT` trap so cleanup is skipped — caller is responsible for tearing down the worktree afterwards. |
| `NAPKIN_DISTILL_HALT_AFTER_SHIM=1` | Halt right after the per-distill napkin shim is installed at `<worktree>/.napkin/distill/bin/napkin`. Lets tests inspect the shim contents and PATH injection without the cleanup trap firing. |
| `NAPKIN_DISTILL_FORCE_MERGE_HEAD=1` | Force `MERGE_HEAD` to exist right before the escape-hatch check. Lets tests cover the belt-and-braces "merge did not complete" bail-out path, which isn't reliably triggerable via real driver output (git clears `MERGE_HEAD` on driver exit 0). |
| `NAPKIN_DISTILL_FORCE_MERGE_RC=<n>` | Override the captured merge exit code. Lets tests cover the unexpected-exit-code branch (128 etc.) without contriving a real git failure of that shape. |

Production never sets any of these. If you find one in your environment by accident, `unset` it and re-run — the wrapper falls back to its normal behaviour automatically.

## Future: builder-deleter

Next major feature: a "builder-deleter" janitor that acts on the `supersedes:` frontmatter convention that auto-distill already writes. When a note lists `supersedes: ["old/note.md"]`, the janitor archives the superseded file. Threshold-triggered to avoid running on every distill, git gc as the safety net.

See [features/pi-napkin-distill/builder-deleter](https://github.com/cad0p/pi-napkin/blob/main/features/) (design pending) for the full design.

## License

MIT
