# Changelog

All notable changes to this project will be documented in this file.

## [0.3.0] - 2026-05-19

<!-- USER-EDITABLE SECTION START -->

This release replaces the per-file LLM merge driver with an **agent-driven merge architecture**. The distill agent now owns the full pipeline (distill content → merge → squash → push), resolving conflicts with the conversation context the previous per-file driver couldn't see.

User-visible changes:

- **No more per-file merge driver.** The driver is deleted; conflicts are resolved by the distill agent inside its own session. Vaults that previously had `*.md merge=napkin-distill-merge` in `.gitattributes` can leave it — git silently falls back when the driver script is gone.
- **`distill.maxDurationMinutes` config knob** (default 10). Per-vault override in `.napkin/config.json`. Caps how long a single distill can run before the wrapper salvages.
- **More accurate failure surfacing.** A race between the agent's worktree cleanup and the wrapper's outcome write previously produced spurious "Distillation terminated abnormally" warnings on successful distills. Closed structurally; happy and salvage paths now write outcome before any worktree removal.
- **macOS in CI.** Test matrix now runs on `ubuntu-latest` + `macos-latest`.

<!-- USER-EDITABLE SECTION END -->


### 🚀 Features

- *(distill)* Agent-driven merge architecture ([#12](https://github.com/cad0p/pi-napkin/pull/12))


