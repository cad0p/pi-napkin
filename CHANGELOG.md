# Changelog

All notable changes to this project will be documented in this file.

## [calver-released]

<!-- USER-EDITABLE SECTION START -->
<!-- Add your curated release notes here. -->
<!-- USER-EDITABLE SECTION END -->

### 🐛 Bug Fixes

- *(distill)* Preserve OpenAI prompt cache key ([#22](https://github.com/cad0p/pi-napkin/pull/22))

### ⚙️ Miscellaneous Tasks

- *(gitignore)* .DS_Store ([#20](https://github.com/cad0p/pi-napkin/pull/20))


## [0.3.1] - 2026-05-25

<!-- USER-EDITABLE SECTION START -->

Fixes [#14](https://github.com/cad0p/pi-napkin/issues/14): distill worktrees showed `Empty vault` when `.napkin/config.json` wasn't git-tracked, forcing users to manually copy it into every worktree. Auto-setup now tracks `config.json` on first run, and a centralized two-tier health check (fast at session_start, full at worktree-spawn) refuses to spawn distill on misconfigured setups instead of producing weird behavior. Landed in two phases: [#15](https://github.com/cad0p/pi-napkin/pull/15) (scaffolding + the actual fix) and [#17](https://github.com/cad0p/pi-napkin/pull/17) (remaining full-level invariants).

<!-- USER-EDITABLE SECTION END -->


### 🚀 Features

- *(distill)* Centralized auto-distill health check (Phase A) ([#15](https://github.com/cad0p/pi-napkin/pull/15))

- *(distill)* Centralized auto-distill health check (Phase B) ([#17](https://github.com/cad0p/pi-napkin/pull/17))


### ⚙️ Miscellaneous Tasks

- Replace 🧻 with 📜 as the napkin emoji ([#18](https://github.com/cad0p/pi-napkin/pull/18))


## [0.3.0] - 2026-05-19

<!-- USER-EDITABLE SECTION START -->

First semver release of the cad0p fork, consolidating all changes since upstream Michaelliv/pi-napkin v0.2.4 (the fork point). Pre-existing calver releases on this fork (`v0.2.4-20260518.0` etc.) are rolled into this entry.

Fork drift vs upstream v0.2.4:

- **Agent-driven distill merge** ([#12](https://github.com/cad0p/pi-napkin/pull/12)). The distill agent now owns commit → merge → squash → push end-to-end, replacing the per-file LLM merge driver. New `distill.maxDurationMinutes` config knob (default 10); structured outcome sidecar; race-fix outcome-write ordering; macOS in CI.
- **Worktree-based distill concurrency** ([#11](https://github.com/cad0p/pi-napkin/pull/11)). Each distill runs in its own `git worktree` so concurrent distills (interval / shutdown / multiple sessions) don't race on vault files.
- **`/distill-auto-this-session` command** ([#10](https://github.com/cad0p/pi-napkin/pull/10)). Toggles auto-distill for the current session without changing vault config.
- **Distill prompt enhancements** ([#6](https://github.com/cad0p/pi-napkin/pull/6) + earlier work). `_about.md` content, folder paths, and daily-notes context give the agent folder-level orientation when distilling. Falls back to pi's default model when none is configured in vault config ([#5](https://github.com/cad0p/pi-napkin/pull/5)).
- **`@cad0p/napkin` dependency** ([#7](https://github.com/cad0p/pi-napkin/pull/7), [#8](https://github.com/cad0p/pi-napkin/pull/8) + earlier work). Switched from `napkin-ai` to the cad0p fork (consumed from npm directly), unlocking native global-config support for vault resolution. First-time-setup docs in the skill help users avoid the bare-vault footgun ([#9](https://github.com/cad0p/pi-napkin/pull/9)).
- **UX fixes**. `kb_search` / `kb_read` tool output respects the Ctrl+O expand/collapse toggle ([#2](https://github.com/cad0p/pi-napkin/pull/2)); biome formatter lint in distill status setter ([#3](https://github.com/cad0p/pi-napkin/pull/3)).

<!-- USER-EDITABLE SECTION END -->


### 🚀 Features

- *(distill)* Agent-driven merge architecture ([#12](https://github.com/cad0p/pi-napkin/pull/12))


