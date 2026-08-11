# Changelog

All notable changes to this project will be documented in this file.

## [0.6.6] - 2026-08-11

<!-- USER-EDITABLE SECTION START -->
- **Injected agent context now always knows the vault root** — the napkin overview starts with `Vault root: <path> (napkin vault --json | jq -r .path)`, sourced from the SDK's new `overview.root` field (napkin 0.13.2, attached fresh at the SDK layer — never cached, so a moved vault can never serve a stale path). Sessions no longer burn time discovering where the vault lives, and the parenthetical doubles as a hint for the CLI discovery command.
<!-- USER-EDITABLE SECTION END -->

### 🚀 Features

- *(extension)* Prepend vault root to injected napkin context ([#63](https://github.com/cad0p/pi-napkin/pull/63))


## [0.6.5] - 2026-08-10

<!-- USER-EDITABLE SECTION START -->
- **Dep bump `@cad0p/napkin ^0.12.3 → ^0.13.0`** — consumes napkin 0.13.0 ignore support (`.napkinignore` + `.gitignore` + dotfiles rule, fork-first, upstream [#20](https://github.com/Michaelliv/napkin/issues/20)). SDK-driven — no extension changes needed; kb tools inherit the semantics automatically: ignored files disappear from `kb_search`/`kb_outline`/overview while `kb_read <exact-path>` still works.
<!-- USER-EDITABLE SECTION END -->

### 💼 Other

- Bump @cad0p/napkin ^0.12.3 → ^0.13.0 ([#61](https://github.com/cad0p/pi-napkin/pull/61))


## [0.6.4] - 2026-08-10

<!-- USER-EDITABLE SECTION START -->
- **Managed gitignore block** — new bare `overview-cache.json` pattern
  alongside `search-cache.json`: the napkin SDK writes the overview cache next
  to the vault config dir, so without it auto-init commits and distill worktree
  squashes churned the cache into vault history.
- **kb_search polish** — the per-result "+N more matches" hint no longer
  repeats "use kb_read" on every entry (the HINT footer already covers it),
  and the TUI timing line (`Took`/`Elapsed`) now renders
  blank-line-separated from the output, matching the native bash tool.
<!-- USER-EDITABLE SECTION END -->

### 🐛 Bug Fixes

- *(extension)* Exclude napkin overview cache from managed gitignore block ([#58](https://github.com/cad0p/pi-napkin/pull/58))
- *(extension)* Kb_search copy and Took timing parity ([#60](https://github.com/cad0p/pi-napkin/pull/60))


## [0.6.3] - 2026-08-09

<!-- USER-EDITABLE SECTION START -->
- Drop the extension's overview fallback defaults (0.6.2 workaround): napkin
  0.12.3 restored the fork's DEFAULT_CONFIG (`collapseDepth: 2, maxRows: 100`)
  after the upstream sync had temporarily shipped 1/0 — pi-napkin relies on
  napkin's defaults again (no divergent behavior), vault-config authority
  preserved. Dep `@cad0p/napkin ^0.12.2 → ^0.12.3` (guarantees the restored
  defaults).
<!-- USER-EDITABLE SECTION END -->

### ◀️ Revert

- *(extension)* Drop overview fallback defaults — napkin 0.12.3 restores fork defaults ([#56](https://github.com/cad0p/pi-napkin/pull/56))


## [0.6.2] - 2026-08-09

<!-- USER-EDITABLE SECTION START -->
- **Kb tools TUI parity** — renderCall call lines + kb_search timing (#53)
- **Align with @cad0p/napkin 0.12.2** (patch) — dep bumped ^0.12.1 → ^0.12.2,
  pulling in the upstream-v0.9.2 sync fixes (overview cache, gray-matter
  safeMatter fix, `file outline` subcommand, agent skills) while keeping the
  fork's Approach G search (bench-verified; see cad0p/napkin#43).
<!-- USER-EDITABLE SECTION END -->

### 🚀 Features

- *(extension)* Kb tools TUI parity — renderCall call lines + kb_search timing ([#53](https://github.com/cad0p/pi-napkin/pull/53))

### 🐛 Bug Fixes

- *(extension)* Napkin 0.12.2 compat — restore overview cap defaults + fix minimumReleaseAgeExclude ([#55](https://github.com/cad0p/pi-napkin/pull/55))


## [0.6.1] - 2026-08-07

<!-- USER-EDITABLE SECTION START -->
CI flake fixes (issue #49): the routing-test teardown race (wrapper EXIT
trap holds the vault as cwd after removing the worktree, ENOTEMPTY on
macOS) is fixed with a two-phase wait-for-wrapper-exit + bounded
`retryRmSync`; the kb_read page-size test now pins the SDK contract
(<= pageSize) instead of magic slack. Dep bump @cad0p/napkin ^0.12.0 ->
^0.12.1 (exact worst-case page-hint reserve for >6-digit page counts).
<!-- USER-EDITABLE SECTION END -->

### 🧪 Testing

- Fix flaky CI — routing ENOTEMPTY race + page-size contract pin ([#49](https://github.com/cad0p/pi-napkin/pull/49)) ([#51](https://github.com/cad0p/pi-napkin/pull/51))

### ⚙️ Miscellaneous Tasks

- Give validate workflows distinct job names ([#50](https://github.com/cad0p/pi-napkin/pull/50))


## [0.6.0] - 2026-08-07

<!-- USER-EDITABLE SECTION START -->
The injected vault overview now reports when it has been capped: with
`@cad0p/napkin` 0.12.0, listings sort by (depth, note count desc, path) and
`overview.maxRows` (default 100) trims the tail — the extension appends
"… N more folders (M notes) — use kb_search to find specific content" so
agents know the vault is bigger than what's shown. Also fixes the vault-root
row rendering as "//" (now "./") in the session context.
<!-- USER-EDITABLE SECTION END -->

### 🚀 Features

- *(extension)* Render collapsed subfolder counts in overview ([#43](https://github.com/cad0p/pi-napkin/pull/43))
- *(extension)* Render overview truncation footer + bump napkin 0.12.0 ([#48](https://github.com/cad0p/pi-napkin/pull/48))

### 🐛 Bug Fixes

- *(extension)* Render vault root as ./ instead of // in overview ([#46](https://github.com/cad0p/pi-napkin/pull/46))

### 📚 Documentation

- Point AGENTS.md vault check at kb tools ([#39](https://github.com/cad0p/pi-napkin/pull/39))
- Make AGENTS.md bootstrap mandatory for every request ([#42](https://github.com/cad0p/pi-napkin/pull/42))
- Point AGENTS.md kanban check at gh project ([#47](https://github.com/cad0p/pi-napkin/pull/47))

### 🧪 Testing

- *(extension)* Cover overview sibling-collapse rendering ([#44](https://github.com/cad0p/pi-napkin/pull/44))


## [0.5.0] - 2026-08-07

<!-- USER-EDITABLE SECTION START -->
<!-- Add your curated release notes here. -->
<!-- USER-EDITABLE SECTION END -->

### 🚀 Features

- *(extension)* Progressive disclosure for kb tools — paginated kb_search, kb_read section/page, kb_outline ([#34](https://github.com/cad0p/pi-napkin/pull/34))
- *(extension)* Nudge agents toward kb_outline from session context and search results ([#35](https://github.com/cad0p/pi-napkin/pull/35))

### 📚 Documentation

- *(changelog)* Changes from v0.4.0 to v0.4.0-20260806.0 ([#36](https://github.com/cad0p/pi-napkin/pull/36))


## [0.4.0] - 2026-08-03

<!-- USER-EDITABLE SECTION START -->

Picks up @cad0p/napkin **0.10.1**, which fixes the warm-path content recall
regression that briefly shipped in napkin 0.10.0 (searches after the first
returned only basename hits — e.g. 22 results instead of 388 on a large vault;
cad0p/napkin#22). napkin 0.10.0/0.10.1 also brings the search performance
rewrite (basename-only MiniSearch + in-memory substring scan) that takes full-
vault search on ~2700-file vaults from minutes to ~2s warm / ~2.5s cold.

- **deps**: `@cad0p/napkin` 0.8.1 → 0.10.1 ([#31](https://github.com/cad0p/pi-napkin/pull/31))
- **new**: `search-smoke.test.ts` extension smoke test (real `napkin init` vault;
  asserts recall, case-insensitivity, and a <2s perf ceiling vs the current
  napkin line)
- **new**: `extensions/napkin-deps.d.ts` — shim declarations for napkin's untyped
  transitive deps (`sql.js`, `jexl`, `js-yaml`) so `tsc --noEmit` stays clean
  against napkin's TS-source-shipped package
- **tooling**: bumped `minimumReleaseAgeExclude` for the freshly published
  napkin line (supply-chain gate)

<!-- USER-EDITABLE SECTION END -->


## [0.3.2] - 2026-07-21

<!-- USER-EDITABLE SECTION START -->

Maintenance release since [0.3.1]. No user-facing behavior changes — just fixes and tooling.

- **Distill prompt cache preserved** across session forks ([#22](https://github.com/cad0p/pi-napkin/pull/22)): forked distill subprocesses now reuse the parent's OpenAI `prompt_cache_key` instead of paying for a cache miss on every distill.
- **Tooling migration** ([#26](https://github.com/cad0p/pi-napkin/pull/26), [#28](https://github.com/cad0p/pi-napkin/pull/28)): moved from bun to pnpm + vitest, and enabled parallel test execution — CI test time dropped from ~74s to ~56s on ubuntu.
- **Removed** the redundant `napkin_distill_status` agent tool ([#25](https://github.com/cad0p/pi-napkin/pull/25)).

<!-- USER-EDITABLE SECTION END -->

### 🐛 Bug Fixes

- *(distill)* Preserve OpenAI prompt cache key ([#22](https://github.com/cad0p/pi-napkin/pull/22))
- Use optional chain in getSessionTouchedFiles ([#27](https://github.com/cad0p/pi-napkin/pull/27))

### 🚜 Refactor

- *(distill)* Drop napkin_distill_status agent tool ([#25](https://github.com/cad0p/pi-napkin/pull/25))

### ⚙️ Miscellaneous Tasks

- *(gitignore)* .DS_Store ([#20](https://github.com/cad0p/pi-napkin/pull/20))
- Migrate from bun to pnpm + vitest ([#26](https://github.com/cad0p/pi-napkin/pull/26))
- Enable test parallelism (remove singleFork) ([#28](https://github.com/cad0p/pi-napkin/pull/28))


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


