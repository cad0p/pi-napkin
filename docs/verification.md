# Verification checklist

How to verify a pi-napkin change before it is marked ready. CI covers the
mechanical gate; this file covers what CI cannot see — model-facing behavior,
real distill lifecycles, and session-level effects. Every change runs the
always-on gate; then run the rows that match its change class.

## Always-on gate (every change)

```bash
cd <worktree>
pnpm lint        # biome check extensions/
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run, full suite
pnpm build       # tsc -p tsconfig.build.json
```

Plus green PR checks: `test (ubuntu-latest)`, `test (macos-latest)`,
`validate-package-version`, `validate-release-pr`.

Flake policy: when something fails once, re-run that test file in isolation
before assuming it is your change. Record pre-existing warnings/flakes in the
PR instead of "fixing" unrelated code.

## By change class

| Change class | Additional verification | Why |
| --- | --- | --- |
| Pure logic (parsers, gates, bookkeeping) | Targeted unit tests + full suite | Behavior is fully captured by tests |
| LLM-facing text (prompts, notices, tool descriptions) | Unit pin + session forge/replay (below) | The contract is model behavior, not just bytes |
| Distill lifecycle / wrapper | Unit tests + `pnpm run verify:e2e` (README Maintenance; real LLM, ~$0.50 per LLM-driven variant) | Only the real wrapper + subprocess + sidecar path proves it |
| Extension / session lifecycle | tmux smoke run in a scratch vault | Load/unload, status paint, no stray worktrees/branches |

## Session forge / replay — for LLM-facing changes

Use when a string in a prompt/notice/tool description changes what the agent
believes or does. Replay the situation against a forged session instead of
waiting for it to recur in production.

### Safety rules (mandatory)

- **Never** point `--session` at a real session file. Forge (or copy) into a
  temp directory.
- Use a temp **vault** with its own `.napkin/config.json` and
  `"distill": { "enabled": false }`, so vault resolution cannot touch the
  real vault even if something goes wrong.
- Export `XDG_CONFIG_HOME` to an empty temp directory (blocks the global
  napkin config fallback).
- Unset inherited `PI_*` variables (`PI_PROVIDER`, `PI_MODEL`,
  `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_REASONING_LEVEL`,
  `PI_CODING_AGENT`): a child `pi` otherwise adopts the parent session's
  provider/model, muddying the run.
- Run with `--no-extensions --no-skills --no-context-files` for a clean,
  reproducible surface (the forged notice lives in session history, so no
  extension needs to load).
- After the runs, assert that the real vault's `git status` and
  `git worktree list` are unchanged, and that the real session store's
  `.jsonl` count is unchanged. No fixture session directories may appear
  under `~/.pi/agent/sessions/`.

### Procedure

1. Extract the exact string under test from the code, never from memory:

   ```bash
   cd <worktree>
   node --import tsx -e "const m = await import('./extensions/distill/index.ts'); \
     process.stdout.write(JSON.stringify(m.formatOverlapNotice(['notes/foo.md'])))"
   ```

2. Forge a session JSONL in the temp directory: session header (with the
   fixture vault as `cwd`), `model_change`, a user message, an assistant
   reply, then the notice entry. For the overlap notice that entry is:

   ```json
   {"type":"custom_message","id":"e5f6a7b8","parentId":"d4e5f6a7",
    "timestamp":"2026-09-13T12:01:00.000Z",
    "customType":"napkin-distill-overlap",
    "content":"\n\n⚠️ Background napkin distill has edited …","display":true}
   ```

   Entry schema: pi's `session-format` docs (Session File Format → Extended
   Message Types → `CustomMessage`); `id`/`parentId` chain through the
   preceding entries, and `display:true` surfaces the notice in the TUI.
3. Run 3 times per wording — the old wording as the control, the new wording
   as the candidate (otherwise you cannot show the change caused the
   difference):

   ```bash
   env -u PI_PROVIDER -u PI_MODEL -u PI_SESSION_ID -u PI_SESSION_FILE \
       -u PI_REASONING_LEVEL -u PI_CODING_AGENT \
       XDG_CONFIG_HOME=<tmp>/xdg pi -p \
       --no-extensions --no-skills --no-context-files --thinking minimal \
       --model <provider>/<model> --session <tmp>/run.jsonl "<probe>"
   ```

4. Score the transcripts by what the agent *does with the state*, not by
   echoed words (the candidate wording itself contains "has edited"):
   - confused (old): waits for or checks on an in-progress distill
     ("still running", "let the distill finish", "when it finishes",
     "check its status")
   - fixed (new): treats the distill as already completed and bases the next
     action on fresh content ("may have been overwritten", re-reads the file
     before editing, no waiting)
5. Paste abridged old-vs-new transcripts into the PR under Verification.

### Worked example — #104 (past-tense overlap notice)

Fixture: temp vault with `distill.enabled: false` and `notes/foo.md`; probe
*"what has happened to notes/foo.md since you edited it, and what should you
do before making your next edit to it?"*; 3 runs per wording on
`deepseek/deepseek-v4-flash`.

| Wording | Result | Evidence (abridged) |
| --- | --- | --- |
| old (`is editing`) | 3/3 confused | *"…may merge or overwrite my write when it finishes… ideally let the distill finish first"*; *"if distill is still running, wait for it to finish"*; *"…could change before the distill finishes… waiting until the distill completes"* |
| new (`has edited`) | 3/3 correct | *"…the warning says a background napkin distill edited notes/foo.md after my append, so my line may have been overwritten or merged… I should re-read before any further edit"*; runs 2–3 re-read the file and based the next edit on fresh content, with no waiting |

Post-run safety checks for the example: real session store unchanged (623
`.jsonl` files, no fixture directories), real vault `git worktree list`
unchanged (`main` only), no new modifications to tracked vault files.

Reference: PR #106.
