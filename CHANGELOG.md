# Changelog

All notable changes to this project will be documented in this file.

## [0.3.0] - 2026-05-19

<!-- USER-EDITABLE SECTION START -->

First semver release of the cad0p fork, consolidating all changes since upstream Michaelliv/pi-napkin v0.2.4 (the fork point). Pre-existing calver releases on this fork (`v0.2.4-20260518.0` etc.) are rolled into this entry.

Fork drift vs upstream v0.2.4:

- kb_search / kb_read tool output respects the Ctrl+O expand/collapse toggle ([#2](https://github.com/cad0p/pi-napkin/pull/2)).
- Biome formatter lint fix in the distill status setter ([#3](https://github.com/cad0p/pi-napkin/pull/3)).
- Switch the `napkin-ai` dependency to the cad0p fork to consume native global-config support for vault resolution.
- Use napkin's native global config for vault resolution; README updated accordingly.
- Enhance the distill prompt with `_about.md` content, folder paths, and daily-notes context so the agent has folder-level orientation when distilling.
- Trailing-dot cleanup in the prompt for upstream consistency.
- Distill uses pi's default model when none is configured in vault config ([#5](https://github.com/cad0p/pi-napkin/pull/5)).
- Document the `_about.md` format in the distill prompt ([#6](https://github.com/cad0p/pi-napkin/pull/6)).
- Allowlist `napkin-ai` for pnpm build scripts ([#7](https://github.com/cad0p/pi-napkin/pull/7)).
- Consume `@cad0p/napkin` from npm directly; drop the build-script workaround; README updated ([#8](https://github.com/cad0p/pi-napkin/pull/8)).
- Document vault resolution + first-time setup in the skill so users don't hit the bare-vault footgun ([#9](https://github.com/cad0p/pi-napkin/pull/9)).
- New `/distill-auto-this-session` command toggles auto-distill for the current session without changing vault config ([#10](https://github.com/cad0p/pi-napkin/pull/10)).
- Shutdown-distill + worktree-based concurrency safety: distill runs in a per-attempt `git worktree`, multiple sessions / interval / shutdown distills no longer race on vault files ([#11](https://github.com/cad0p/pi-napkin/pull/11)).
- Agent-driven merge architecture ([#12](https://github.com/cad0p/pi-napkin/pull/12)). Replaces the per-file LLM merge driver with an agent that owns commit → merge → squash → push end-to-end, plus full hardening + race fix + verify:e2e gate.

<!-- USER-EDITABLE SECTION END -->


### 🚀 Features

- *(distill)* Agent-driven merge architecture ([#12](https://github.com/cad0p/pi-napkin/pull/12))


