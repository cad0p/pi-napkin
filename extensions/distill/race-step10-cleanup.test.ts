/**
 * Regression guard: wrapper write_outcome runs before any worktree
 * removal on the happy path. Pins the structural fix from
 * `fix(distill): drop step 10 (worktree cleanup) from agent prompt`.
 *
 * Pre-fix the agent ran `git worktree remove` itself (step 10 of the
 * distill prompt) BEFORE the wrapper had finished post-validation and
 * written the outcome sidecar. The JS-side poller in `runDistillWith`
 * ticks every ~2 s and observed worktree-gone in the gap between the
 * agent's step 10 and the wrapper's `write_outcome` call — then
 * dispatched a spurious "Distillation terminated abnormally — no
 * outcome record" warning on a successful merged-content distill.
 *
 * The fix drops step 10 from the agent prompt; the wrapper's EXIT
 * trap (which has always run unconditionally) is now the sole worktree-
 * removal step on the happy path, and it fires AFTER `write_outcome`.
 * The stub at `test-fixtures/agent-stubs/step10-race.sh` no longer
 * removes the worktree itself — it matches post-fix production
 * behaviour (agent commits + exits; wrapper handles cleanup).
 *
 * Post-fix timeline (happy path):
 *
 *   t0   wrapper invokes `pi --session ... -p $PROMPT`
 *   t0+  agent runs steps 1–9: distill, merge, squash, push
 *   t1   agent exits → pi exits → wrapper resumes
 *   t1+  wrapper runs validate_no_markers / validate_commit_count /
 *        detect_local_only (~tens of ms)
 *   t2   wrapper writes the `<ts>-<pid>-<branchShort>.outcome` sidecar
 *   t3   wrapper EXIT trap removes the worktree
 *
 *   The race window is closed structurally: there is no point at which
 *   `worktree-gone AND outcome-not-written` is observable. The JS
 *   poller's tick lands somewhere in [t0, t3]; if it lands in [t3, ...]
 *   it sees worktree-gone AND outcome-already-written.
 *
 * Strategy: spawn the wrapper detached — mirroring how
 * `spawnDistillInWorktree` does it in production — and poll worktree
 * disappearance from JS at 50 ms intervals. When disappearance is
 * observed, immediately call `findDistillOutcomeForBranch`. This
 * snapshots the file-system state the production poller sees at the
 * race tick. Then wait for the wrapper to fully exit and call again
 * — this snapshots the eventual state.
 *
 * The fixture (`test-fixtures/agent-stubs/step10-race.sh`) widens the
 * window between agent-exit and worktree-removal deterministically by
 * sleeping 0.5 s after the agent's commit work but before the stub
 * exits, keeping the wrapper blocked on the `pi` subprocess long
 * enough that the JS poller's tick lands inside the
 * [agent-exit, worktree-removed] interval.
 *
 * Assertion contract:
 *   - outcomeAfterExit:    must be `merged-content` — proves the
 *                          wrapper does eventually succeed at writing
 *                          the outcome (so the test isn't passing for
 *                          some unrelated reason like a wrapper crash).
 *   - outcomeAtRaceWindow: must be non-null — the wrapper invariant
 *                          (write_outcome before any worktree-removal)
 *                          guarantees the JS poller's tick at
 *                          worktree-disappearance always sees the
 *                          outcome already written.
 *
 * If a future change re-introduces an agent-side worktree removal
 * (or any other worktree-removing step before `write_outcome`), this
 * test FAILS. Pair with `wrapper-invariant.test.ts` for the broader
 * invariant pin (covers happy + salvage paths).
 *
 * The historic step-10 reference in this file's name and stub name is
 * retained as context for `git log` archaeology — the test originated
 * as the deterministic reproducer for the agent-step-10 race.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { makeWrapperScaffold, withNapkinOnPath } from "./_test-helpers";
import {
  createDistillWorkspace,
  findDistillOutcomeForBranch,
} from "./distill-workspace";
import { formatOutcomeNotification } from "./index";
import { DISTILL_WRAPPER_SCRIPT } from "./scripts-paths";

const FIXTURE = path.join(
  __dirname,
  "test-fixtures",
  "agent-stubs",
  "step10-race.sh",
);

describe("agent step-10 / wrapper outcome-write race (regression)", () => {
  let pathHandle: { restore: () => void };

  beforeEach(() => {
    pathHandle = withNapkinOnPath();
  });

  afterEach(() => {
    pathHandle.restore();
  });

  test("outcome sidecar exists at the moment worktree disappears (wrapper-invariant regression guard)", async () => {
    expect(fs.existsSync(FIXTURE)).toBe(true);

    const s = makeWrapperScaffold("napkin-distill-step10-race-");
    try {
      const workspace = createDistillWorkspace(
        s.vault,
        s.sessionFile,
        s.parentCwd,
      );
      const branch = workspace.branchName;
      const branchShort = branch.replace(/^distill\//, "");

      const env: Record<string, string> = {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
        NAPKIN_DISTILL_NO_RECURSE: "1",
        NAPKIN_DISTILL_PI_BIN: FIXTURE,
        NAPKIN_STUB_VAULT: s.vault,
        NAPKIN_STUB_WORKTREE: workspace.worktreePath,
        NAPKIN_STUB_BRANCH: branch,
        NAPKIN_STUB_DEFAULT_BRANCH: "main",
      };

      // Detached spawn — mirrors `spawnDistillInWorktree`'s production
      // shape (detached:true, unref()) so any timing-dependent behaviour
      // around the parent-child relationship matches. We pipe stderr so
      // the test can surface wrapper diagnostics on assertion failure.
      const child = spawn(
        "bash",
        [
          DISTILL_WRAPPER_SCRIPT,
          s.vault,
          workspace.worktreePath,
          branch,
          workspace.sessionForkPath,
          "test prompt",
          s.errorDir,
          "", // model
          "main", // defaultBranch
          s.parentCwd,
          "60", // maxDurationSecs
          path.dirname(workspace.worktreePath), // cache root
        ],
        {
          cwd: s.parentCwd,
          env,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.unref();

      let stderrBuf = "";
      child.stderr?.on("data", (chunk) => {
        stderrBuf += chunk.toString();
      });
      let stdoutBuf = "";
      child.stdout?.on("data", (chunk) => {
        stdoutBuf += chunk.toString();
      });

      // Poll worktree disappearance from JS at 50 ms intervals — same
      // logic shape as `runDistillWith`'s pollHandle, just with a
      // tighter tick to keep the test fast (production ticks at
      // ~2 s).
      const target = workspace.worktreePath;
      const startMs = Date.now();
      while (fs.existsSync(target) && Date.now() - startMs < 30_000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const timedOut = fs.existsSync(target);

      // Race-window snapshot: the FS state at the exact tick where
      // production's poller would call `checkOutcome`. The bug
      // manifests as `outcomeAtRaceWindow === null`.
      const outcomeAtRaceWindow = findDistillOutcomeForBranch(
        s.errorDir,
        branchShort,
      );

      // Wait for wrapper to fully exit so the after-exit snapshot
      // observes the final state.
      const exitCode = await new Promise<number>((resolve) => {
        if (child.exitCode !== null) {
          resolve(child.exitCode);
          return;
        }
        child.on("exit", (code) => resolve(code ?? -1));
      });

      const outcomeAfterExit = findDistillOutcomeForBranch(
        s.errorDir,
        branchShort,
      );

      // Diagnostic context surfaced when assertions fail. Bun's expect
      // doesn't have built-in `because`/labels, so we attach via a
      // try/catch that re-throws with the wrapper's stderr appended —
      // kept simple here, just emit on failure.
      const diag = () =>
        `\nwrapper stderr:\n${stderrBuf || "(empty)"}\nwrapper stdout:\n${stdoutBuf || "(empty)"}\ntimedOut waiting for worktree disappearance: ${timedOut}`;

      // Sanity: the worktree did disappear within the budget.
      expect(timedOut, `worktree never disappeared within 30s${diag()}`).toBe(
        false,
      );

      // Sanity: wrapper completed successfully and the outcome ended
      // up as merged-content. If either of these fails, the test isn't
      // exercising the right scenario (the wrapper crashed, or the
      // fixture didn't drive the happy path) and the race-window
      // assertion below would be misleading.
      expect(exitCode, `wrapper exit code${diag()}`).toBe(0);
      expect(
        outcomeAfterExit,
        `outcome sidecar missing after wrapper exit${diag()}`,
      ).not.toBeNull();
      expect(outcomeAfterExit?.outcomeClass).toBe("merged-content");

      // Wrapper-invariant assertion. The wrapper writes the outcome
      // before any worktree-removal step on the happy path (EXIT trap
      // fires AFTER write_outcome). The JS-side poller's tick at
      // worktree-disappearance therefore always sees the outcome
      // already written. If a future change re-introduces an
      // agent-side worktree removal (or any other worktree-removing
      // step before write_outcome), this assertion fails.
      expect(
        outcomeAtRaceWindow,
        `outcome sidecar was missing at the moment the worktree disappeared — wrapper write_outcome is no longer running before worktree-removal on the happy path${diag()}`,
      ).not.toBeNull();
      expect(outcomeAtRaceWindow?.outcomeClass).toBe("merged-content");

      // Production-symptom equivalence: feed `outcomeAtRaceWindow`
      // through the same `formatOutcomeNotification` call site
      // `runDistillWith` uses. This makes the regression's user-
      // visible failure mode show up directly in the test's failure
      // message instead of requiring a mental translation from
      // "outcome was null" → "user saw 'terminated abnormally'".
      const dispatch = formatOutcomeNotification({
        outcome: outcomeAtRaceWindow,
        elapsedSec: 0,
      });
      expect(
        dispatch.message,
        `JS-side dispatch on the race-window snapshot would notify the user with "terminated abnormally" on a successful distill${diag()}`,
      ).not.toMatch(/terminated abnormally/i);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  }, 60_000);
});
