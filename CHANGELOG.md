# Changelog

All notable changes to this project will be documented in this file.

## [0.3.0] - 2026-05-19

<!-- USER-EDITABLE SECTION START -->

Major release. The auto-distill pipeline is rebuilt around an **agent-driven merge architecture**: the distill agent now owns commit → merge → squash → push end-to-end, replacing the per-file LLM merge driver from previous releases. Per-vault config (`distill.maxDurationMinutes`) caps the agent's wall-clock budget; the wrapper owns cleanup and writes a structured outcome sidecar. All changes vs upstream v0.2.4:

**Architecture**

- Per-file `napkin-distill-merge` driver and its `.gitattributes` registration deleted; conflicts resolved by the agent inside its session with full conversation context.
- Distill runs in a per-attempt `git worktree` under the user's XDG cache (`$XDG_CACHE_HOME/napkin-distill/<vault-hash>/<branch-suffix>/`), keeping vault-side state isolated from in-flight distills.
- Wrapper post-validation: marker scan, commit-count check, HEAD-on-default verify, merged-local detection. Failure paths route through `salvage()` and emit a `failed:<reason>` outcome with a recovery hint.
- New `distill.maxDurationMinutes` config knob (default 10) bounds the agent task's wall clock.
- Salvage never touches main vault history (no `git checkout` / `reset`); always writes the outcome sidecar before any worktree removal so the JS-side poller sees a consistent state.
- Agent prompt externalised to `extensions/distill/distill-prompt.md` with `{{worktreePath}}` / `{{vaultPath}}` / `{{branchName}}` / `{{defaultBranch}}` placeholders.
- `/distill` command and `napkin_distill_status` tool surface active distills + unmerged distill branches.

**Hardening**

- Force-push detection via ancestry check (not SHA equality); divergent-history class replaces the old force-push framing with a refined recovery hint.
- `safe_rm_worktree` requires the resolved XDG cache root as an explicit positional arg; refuses any path not a descendant of it (`SEC-2`/`CORR-3`). LEGACY glob fallback dropped.
- Atomic outcome sidecar write via tmp + rename so partial reads are impossible.
- `buildDistillPrompt` rejects control characters and prompt-injection metacharacters in caller-supplied paths/branch names.
- `validate_no_markers` requires all three Git conflict-marker types co-present before classifying as agent-induced.
- Pre-existing markers (present before agent ran) classify as `pre-existing-markers`, not `markers-after-agent-exit`.
- `pi` stderr captured to a tmpfile with explicit cleanup + naming prefix.
- Path-safety guard in salvage and cleanup-trap before any `rm -rf <worktree>`.

**Race fix (post-readiness)**

- Step 10 (agent-side `git worktree remove`) dropped from the prompt — the wrapper's EXIT trap was always the actual cleanup mechanism and the agent's redundant cleanup created a race window.
- Salvage path reordered: `write_outcome "failed:<reason>"` runs before any worktree-removal command, mirroring the EXIT trap's ordering. Closes the same race shape on the failure path.
- Invariant pinned by `wrapper-invariant.test.ts` (happy + salvage) using subprocess + concurrent filesystem polling.

**Test infrastructure**

- `verify:e2e` (full-runtime: wrapper subprocess + real-LLM agent + JS-side poller + bare-origin push) replaces the prompt-only `verify:agent-prompt`. Orchestrator-side gate, ~$0.50/run.
- Bash-stub agent-behavior fixtures: `clean-distill`, `conflict-resolve-clean`, `conflict-leave-markers`, `multiple-commits-on-main`, `pushed-success`, `push-fail-merged-local`, `push-fail-pull-merge-success`, `agent-crashes`, `agent-timeout`, `squash-skipped`, `salvage-race`, `step10-race`, `slow-git`.
- Integration suites: `agent-driven-merge.test.ts`, `wrapper-validation.test.ts`, `wrapper-salvage.test.ts`, `wrapper-invariant.test.ts`, `race-step10-cleanup.test.ts`.
- `_test-helpers.ts` shares `makeWrapperScaffold`, `makeFakeUI`, `makeMockExtensionAPI`, `writePiStub`, `runWrapperWithStub` across the suite.
- Snapshot fixture (`SAMPLE_INPUTS`) matches production format precisely (XDG cache shape, 16-hex vault hash, 6-hex nonce, 10-digit epoch seconds, vault-root path).

**CI**

- macOS added to the test matrix alongside Ubuntu (`ubuntu-latest` + `macos-latest`).
- bun version pinned to `1.3.13` (no `latest` floats).
- `coreutils` installed on macOS so `gtimeout` is reachable.
- Test fixtures set local git identity to satisfy `git commit` in fresh CI runners.
- timeout(1) hardening: explicit `--kill-after` grace + macOS `gtimeout` fallback.

**Cleanup**

- Magic-number literals extracted to named constants (`GIT_SUBCOMMAND_TIMEOUT_MS`, `IDLE_STATUS_REPAINT_INTERVAL_MS`, `DISTILL_POLL_TICK_MS`) with rationale comments at the definition sites.
- Speculative backward-compat code removed: `safe_rm_worktree` LEGACY mode, `MAX_DURATION_SECS` 9-arg-shape fallback, `validate_no_markers` 1-arg fallback, `safe_rm_worktree`'s post-mandatory empty-cache-root guard.
- Dead code from feature deletions purged: `.merge-driver` log-file filters in 5 test sites, `.partial-merge.log` artificial-fixture tests + filter, unused `diffWorktreeSinceStart` helper + tests.
- Stale references and line-number drift swept; `agent-stubs/README.md` synced; `extensions/distill` README rewritten for the agent-driven architecture.
- `DistillOutcome` interface extracted to a single source of truth.

<!-- USER-EDITABLE SECTION END -->


### 🚀 Features

- *(distill)* Agent-driven merge architecture ([#12](https://github.com/cad0p/pi-napkin/pull/12))


