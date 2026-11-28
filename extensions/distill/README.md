# napkin-distill

Pi extension that automatically distills knowledge from conversations into your napkin vault.

## How it works

1. Runs on a configurable interval (default: 60 minutes)
2. Checks if the conversation changed since last distill
3. Sends the new conversation to a model
4. The model extracts structured notes using your vault's templates
5. Notes are written directly into the vault

## Integration: origin-first, two commits

Distill is also the session's autocommit path, with a clean split between the
two kinds of work:

- **Commit (a) — session autocommit.** Every vault path the parent session
  wrote directly (write/edit tool calls, shell redirects) is copied
  byte-for-byte into the distill worktree *before* the agent runs and committed
  alone as `autocommit: <n> files written by session <label>`. A session only
  ever commits paths in its own touched set, so two parallel distills never
  commit each other's files; a path both sessions wrote is committed by
  whichever distill runs first and the second sees it already on origin.
- **Commit (b) — distill.** The agent's own notes, and its own edit layered on
  top when it touches a session-written file.

When the vault has an `origin` remote, the whole integration happens in the
worktree: fetch, merge `origin/<default>` (conflicts resolved there, unioning
both sides for notes), rebuild the two commits linearly on top of it, and push
both. The shared vault checkout is never checked out, squashed, or pulled —
the vault's own sync fast-forwards it after the push lands. Without an origin,
the same two commits are fast-forwarded into the local default branch.

A run succeeds only when `origin/<default>` provably contains the distill
commit (`merge-base --is-ancestor` after a fresh fetch), otherwise the wrapper
writes `failed:push-not-landed` and appends the outcome plus the dangling SHA
to `.napkin/distill/errors/failures.log`, which the next session surfaces.

## Where auto-distill runs

Auto-distill (the interval and the final distill on shutdown) runs only in the **top-level interactive session**: `ctx.hasUI` plus a host-bound mode that is not `"print"` (`"tui"` in the TUI, `"rpc"` under RPC).

Hosts that load extensions in-process — subagent extensions such as `@cad0p/pi-subagents-tintinweb`, SDK embedders — activate this extension once per child session with their own `session_start` / `session_shutdown`. A child never arms the interval and never spawns a distill: it keeps pi's default `mode === "print"` (the parent host passes no mode when it binds extensions), even though it reports `hasUI === true` through the child UI proxy. Its work already reaches the vault through the parent's tool result, which the parent's own distill captures.

A session's header `parentSession` is intentionally **not** the signal: pi also sets it for `/fork`, `/tree` branch creation, clone and `/new` with a parent, and those top-level sessions stay eligible. Manual `/distill` is unaffected — it works in any session that can invoke the command.

## Setup

Enable distill in your vault config:

```bash
napkin config set --key distill.enabled --value true
```

Or edit `.napkin/config.json` directly:

```json
{
  "distill": {
    "enabled": true,
    "intervalMinutes": 60,
    "model": {
      "provider": "anthropic",
      "id": "claude-sonnet-4-6"
    }
  }
}
```

## Configuration

All distill settings live in `.napkin/config.json` under the `distill` key:

| Field | Default | Description |
|-------|---------|-------------|
| `distill.enabled` | `false` | Enable automatic distillation |
| `distill.intervalMinutes` | `60` | How often to check for new content |
| `distill.model.provider` | `"anthropic"` | LLM provider |
| `distill.model.id` | `"claude-sonnet-4-6"` | Model for distillation |


## Manual trigger

Use `/distill` in pi to manually trigger distillation of the full conversation.

## Turn off for this session

`/distill-auto-this-session` turns auto-distill off or on for the current session only. Manual `/distill` still works regardless.

| Invocation | Effect |
|------------|--------|
| `/distill-auto-this-session` | Toggle (on ↔ off) |
| `/distill-auto-this-session on` | Turn auto-distill on |
| `/distill-auto-this-session off` | Turn auto-distill off |
| `/distill-auto-this-session status` | Report current state and time to next run |

### Status bar indicator

| Display | Meaning |
|---------|---------|
| `distill: 59m30s` | Auto-distill is on — countdown to next run |
| `distill: off (session)` | Auto-distill is off for this session |
| `distill: off` | Distill is disabled at the vault level (`distill.enabled=false`) |
| `● distill 12s` | A distillation is currently running |

### Persistence

The off/on state is written into the session file as a `CustomEntry` (it does not enter the LLM context). Resuming the same session with `pi --session <path>` — or picking it from the session list — restores the state. Other sessions (and new sessions) are unaffected.

On resume, a brief notification reminds you when auto-distill is still off, so you don't lose track of it.

Turning auto-distill back on resets the countdown so the next run respects the full interval instead of firing immediately.

Persistent vault-wide opt-out still lives in `.napkin/config.json` (`distill.enabled`).

### Notes

- `/distill-auto-this-session off` does **not** interrupt a distillation already in flight. It only suppresses future scheduled runs.
- If `distill.enabled` is `false` in the vault config, the command warns that the session flag has no effect — enable distill in the vault config first.
- Forking a session with auto-distill off carries the state forward (the CustomEntry is copied with the rest of the session). Run `/distill-auto-this-session on` in the fork to turn it back on.
