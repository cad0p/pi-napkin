/**
 * Distill-mode tool gate (issues #117, #111, #108, and the #122 subset).
 *
 * The distill agent is a fork of a *different* session, resumed in that
 * session's cwd with every tool loaded. #117's incident ran a merge, a
 * git push, a systemd gate unit and a PR body refresh through built-in
 * `bash` alone, so a gate that only refuses *non-built-in* tools cannot
 * hold. The gate here is the early-feedback half of the guarantee (the
 * wrapper's tree-diff + validation is the guarantee):
 *
 *   - write/edit only inside the per-distill sandbox (the worktree, or
 *     the vault itself on the git-less tmpdir path), symlink escapes
 *     resolved;
 *   - bash only when every segment is a distill-legitimate command:
 *     the `napkin` CLI, `git` against the sandbox with non-landing
 *     subcommands, and a small set of read-only text tools;
 *   - every other tool (Agent, timer, heartbeat, codemode, MCP, …)
 *     refused: the fork must distill, not resume the parent's work.
 *
 * A `tool_call` hook changes neither the system prompt nor the tool
 * list, so prompt-cache parity (POST-R6-CACHE) is preserved.
 */

import { describe, expect, test } from "vitest";
import {
  type DistillScope,
  distillToolGate,
  isPathInside,
  type RealpathFn,
  resolveDistillScope,
  shellWords,
} from "./index";

const VAULT = "/home/user/Goldmine";
const SANDBOX = "/home/user/.cache/napkin-distill/abc/distill-1";
const PARENT_CWD = "/home/user/project";

/** Sandbox paths that "exist"; `link` points outside the sandbox. */
const EXISTING: Record<string, string> = {
  [VAULT]: VAULT,
  [SANDBOX]: SANDBOX,
  [PARENT_CWD]: PARENT_CWD,
  [`${SANDBOX}/notes`]: `${SANDBOX}/notes`,
  [`${SANDBOX}/notes/a.md`]: `${SANDBOX}/notes/a.md`,
  [`${SANDBOX}/link`]: "/etc",
  "/etc": "/etc",
};
const realpath: RealpathFn = (p) => EXISTING[p] ?? null;

/** The pair #122 shipped; kept as the alias path through this gate. */
const ENV_WORKTREE = {
  NAPKIN_DISTILL_VAULT: VAULT,
  NAPKIN_DISTILL_WORKTREE: SANDBOX,
};
/** The canonical pair from #117. */
const ENV = {
  NAPKIN_DISTILL_VAULT: VAULT,
  NAPKIN_DISTILL_SANDBOX: SANDBOX,
};

const DISTILL = /distill run/i;

function rawGate(
  scope: DistillScope | null,
  toolName: string,
  input: Record<string, unknown>,
  cwd = PARENT_CWD,
) {
  return distillToolGate({ event: { toolName, input }, scope, cwd, realpath });
}

function gate(
  toolName: string,
  input: Record<string, unknown>,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return rawGate(
    resolveDistillScope(opts.env ?? ENV),
    toolName,
    input,
    opts.cwd ?? PARENT_CWD,
  );
}

function bash(command: string, cwd = PARENT_CWD, env = ENV) {
  return gate("bash", { command }, { cwd, env });
}

describe("resolveDistillScope", () => {
  test("null outside a distill run (no scope vars at all)", () => {
    expect(resolveDistillScope({})).toBeNull();
    // NAPKIN_DISTILL_NO_RECURSE alone is a recursion marker, not the
    // tool-gate trigger: an interactive session may set it.
    expect(resolveDistillScope({ NAPKIN_DISTILL_NO_RECURSE: "1" })).toBeNull();
  });

  test("resolves the canonical explicit pair", () => {
    const scope = resolveDistillScope(ENV);
    expect(scope).toEqual({
      kind: "armed",
      sandbox: SANDBOX,
      vault: VAULT,
    });
  });

  test("accepts NAPKIN_DISTILL_WORKTREE as the sandbox alias (#122)", () => {
    expect(resolveDistillScope(ENV_WORKTREE)).toEqual({
      kind: "armed",
      sandbox: SANDBOX,
      vault: VAULT,
    });
  });

  test("a sandbox that is the vault (git-less tmpdir path) has no read-only vault", () => {
    expect(
      resolveDistillScope({
        NAPKIN_DISTILL_SANDBOX: VAULT,
        NAPKIN_DISTILL_VAULT: VAULT,
      }),
    ).toEqual({ kind: "armed", sandbox: VAULT, vault: null });
  });

  test("sandbox alone is enough (vault optional)", () => {
    expect(resolveDistillScope({ NAPKIN_DISTILL_SANDBOX: SANDBOX })).toEqual({
      kind: "armed",
      sandbox: SANDBOX,
      vault: null,
    });
  });

  test("a vault without a sandbox is invalid, not un-gated", () => {
    const scope = resolveDistillScope({ NAPKIN_DISTILL_VAULT: VAULT });
    expect(scope?.kind).toBe("invalid");
    if (scope?.kind === "invalid") expect(scope.reason).toContain("sandbox");
  });

  test("empty and relative sandboxes are invalid", () => {
    expect(resolveDistillScope({ NAPKIN_DISTILL_SANDBOX: "" })?.kind).toBe(
      "invalid",
    );
    expect(
      resolveDistillScope({ NAPKIN_DISTILL_SANDBOX: "relative/wt" })?.kind,
    ).toBe("invalid");
  });
});

describe("isPathInside", () => {
  test("matches the directory itself and descendants", () => {
    expect(isPathInside(VAULT, VAULT)).toBe(true);
    expect(isPathInside(`${VAULT}/notes/a.md`, VAULT)).toBe(true);
  });

  test("does not match a sibling whose name shares the prefix", () => {
    // /home/user/Goldmine-evil must not count as inside /home/user/Goldmine.
    expect(isPathInside(`${VAULT}-evil/a.md`, VAULT)).toBe(false);
    expect(isPathInside("/home/user", VAULT)).toBe(false);
  });
});

describe("shellWords", () => {
  test("splits on whitespace and keeps quoted paths whole", () => {
    expect(shellWords(`git -C ${JSON.stringify(`${VAULT}/x`)} status`)).toEqual(
      ["git", "-C", `${VAULT}/x`, "status"],
    );
  });
});

describe("distillToolGate — write/edit stay inside the sandbox", () => {
  test("a write inside the sandbox is allowed", () => {
    expect(gate("write", { path: `${SANDBOX}/notes/new.md` }).block).toBe(
      false,
    );
    expect(gate("edit", { path: `${SANDBOX}/notes/a.md` }).block).toBe(false);
  });

  test("a relative path is resolved against the agent cwd", () => {
    expect(
      gate("write", { path: "notes/new.md" }, { cwd: SANDBOX }).block,
    ).toBe(false);
  });

  test("the live vault is outside the sandbox", () => {
    const decision = gate("write", { path: `${VAULT}/reflections/x.md` });
    expect(decision.block).toBe(true);
    expect(decision.reason).toMatch(DISTILL);
    expect(decision.reason).toContain(SANDBOX);
    expect(gate("edit", { path: `${VAULT}/README.md` }).block).toBe(true);
  });

  test("the parent repo is outside the sandbox", () => {
    expect(gate("write", { path: `${PARENT_CWD}/src/x.ts` }).block).toBe(true);
  });

  test("anywhere else on disk is outside the sandbox", () => {
    expect(gate("write", { path: "/etc/passwd" }).block).toBe(true);
    expect(gate("write", { path: "/home/user/.bashrc" }).block).toBe(true);
  });

  test("a symlink inside the sandbox cannot escape it", () => {
    const decision = gate("write", { path: `${SANDBOX}/link/passwd` });
    expect(decision.block).toBe(true);
    expect(decision.reason).toMatch(/symlink/i);
    expect(gate("write", { path: `${SANDBOX}/link` }).block).toBe(true);
  });

  test("an unresolvable sandbox fails closed", () => {
    // Every realpath probe fails: containment cannot be proven.
    const decision = distillToolGate({
      event: { toolName: "write", input: { path: `${SANDBOX}/notes/a.md` } },
      scope: resolveDistillScope(ENV),
      cwd: PARENT_CWD,
      realpath: () => null,
    });
    expect(decision.block).toBe(true);
  });

  test("a write with no path fails closed", () => {
    expect(gate("write", {}).block).toBe(true);
  });
});

describe("distillToolGate — the #117 bash refusals", () => {
  test("gh", () => {
    expect(bash("gh pr create --title x --body y").block).toBe(true);
    expect(bash("gh issue comment 117 --body hi").block).toBe(true);
    expect(bash("gh pr merge 1278 --squash").block).toBe(true);
  });

  test("git push and every remote-changing subcommand", () => {
    expect(bash(`git -C ${SANDBOX} push origin HEAD`).block).toBe(true);
    expect(bash(`git -C ${SANDBOX} fetch origin`).block).toBe(true);
    expect(bash(`git -C ${SANDBOX} pull --rebase`).block).toBe(true);
    expect(bash(`git -C ${SANDBOX} remote add x https://h`).block).toBe(true);
    expect(bash(`git -C ${SANDBOX} update-ref refs/heads/x HEAD`).block).toBe(
      true,
    );
  });

  test("systemd", () => {
    expect(
      bash("systemd-run --user --unit=pc-gate-1278d --wait true").block,
    ).toBe(true);
    expect(bash("systemctl --user stop pc-gate-1278d").block).toBe(true);
  });

  test("network and process tools", () => {
    expect(bash("curl -s https://api.github.com").block).toBe(true);
    expect(bash("wget https://example.com/x").block).toBe(true);
    expect(bash("ssh host uptime").block).toBe(true);
    expect(bash("kill 127646").block).toBe(true);
    expect(bash("pkill -f 'pi --session'").block).toBe(true);
    expect(bash("docker ps").block).toBe(true);
  });

  test("git against the live vault or the parent repo", () => {
    expect(bash(`git -C ${VAULT} commit -m x`).block).toBe(true);
    expect(bash("git -C . status").block).toBe(true);
    // A bare git inherits the agent cwd (the parent session's repo).
    expect(bash("git checkout main").block).toBe(true);
    expect(bash(`git -C ${SANDBOX} --git-dir=${VAULT}/.git log`).block).toBe(
      true,
    );
    expect(bash(`git --work-tree=${VAULT} status`).block).toBe(true);
    // -C composes: the second hop must still land inside the sandbox.
    expect(bash(`git -C ${SANDBOX} -C ../../../../.. status`).block).toBe(true);
  });

  test("cd outside the sandbox", () => {
    const decision = bash("cd /home/user/project && napkin overview");
    expect(decision.block).toBe(true);
    expect(decision.reason).toMatch(DISTILL);
    expect(bash("cd .. && git status", SANDBOX).block).toBe(true);
    expect(bash("cd && git status").block).toBe(true);
    // A symlinked cd target is judged by its real path.
    expect(bash(`cd ${SANDBOX}/link && git status`).block).toBe(true);
  });

  test("config injection through git is refused", () => {
    // --config-env / -c can point core.hooksPath at arbitrary code,
    // and --exec-path / --upload-pack run programs from anywhere.
    expect(
      bash(`git -c core.hooksPath=/tmp/h -C ${SANDBOX} commit -m x`).block,
    ).toBe(true);
    expect(bash(`git --config-env=core.pager=E -C ${SANDBOX} log`).block).toBe(
      true,
    );
    expect(bash(`git --exec-path=/tmp/bin -C ${SANDBOX} status`).block).toBe(
      true,
    );
    expect(bash(`git --upload-pack=/tmp/x -C ${SANDBOX} status`).block).toBe(
      true,
    );
  });

  test("landing verbs inside an allowed subcommand", () => {
    expect(bash(`git -C ${SANDBOX} commit --amend -m x`).block).toBe(true);
    expect(bash(`git -C ${SANDBOX} merge --squash main`).block).toBe(true);
    expect(bash(`git -C ${SANDBOX} merge -s ours main`).block).toBe(true);
  });

  test("a shell wrapper cannot smuggle a refused command", () => {
    expect(bash(`sh -c "git -C ${SANDBOX} push"`).block).toBe(true);
    expect(bash(`bash -c "gh pr create"`).block).toBe(true);
    expect(bash(`env GH_TOKEN=x gh pr list`).block).toBe(true);
    expect(bash("nohup napkin overview").block).toBe(true);
    expect(bash("npm publish").block).toBe(true);
    expect(bash("node -e 'require(\"child_process\")'").block).toBe(true);
  });

  test("command substitution is refused", () => {
    expect(bash("cat $(gh pr list)").block).toBe(true);
    expect(bash("cat `gh pr list`").block).toBe(true);
    expect(bash("cat <(gh pr list)").block).toBe(true);
  });

  test("writes through redirection and tool flags are refused", () => {
    expect(bash(`cat ${SANDBOX}/notes/a.md > ${SANDBOX}/out.md`).block).toBe(
      true,
    );
    expect(bash("echo pwned > /home/user/.bashrc").block).toBe(true);
    expect(bash("cat /etc/hosts >> /home/user/out").block).toBe(true);
    expect(bash(`find ${SANDBOX} -name '*.md' -delete`).block).toBe(true);
    expect(bash(`find ${SANDBOX} -exec gh pr create \\;`).block).toBe(true);
    expect(bash(`sort -o ${SANDBOX}/x.md ${SANDBOX}/notes/a.md`).block).toBe(
      true,
    );
    expect(bash("tee /home/user/out").block).toBe(true);
    expect(bash(`sed -i s/a/b/ ${SANDBOX}/notes/a.md`).block).toBe(true);
  });

  test("napkin cannot be re-pointed outside the sandbox", () => {
    expect(bash(`napkin --vault ${VAULT} append notes/a.md hi`).block).toBe(
      true,
    );
    expect(bash("napkin --vault=/etc create x").block).toBe(true);
  });
});

describe("distillToolGate — the #117 bash allowlist", () => {
  test("the napkin CLI", () => {
    expect(bash("napkin overview").block).toBe(false);
    expect(bash("napkin template list").block).toBe(false);
    expect(bash(`napkin search refs`).block).toBe(false);
    expect(bash(`napkin append notes/a.md "hi there"`).block).toBe(false);
    expect(bash(`napkin create notes/new.md --title x`).block).toBe(false);
    expect(bash(`napkin --vault ${SANDBOX} overview`).block).toBe(false);
  });

  test("git inside the sandbox: the step-7 contract", () => {
    expect(bash(`git -C ${SANDBOX} add -A`).block).toBe(false);
    expect(bash(`git -C ${SANDBOX} commit -m "distill: x"`).block).toBe(false);
    expect(bash(`git -C ${SANDBOX} merge --no-edit main`).block).toBe(false);
    expect(bash(`git -C ${SANDBOX} add .`).block).toBe(false);
    expect(bash(`git -C ${SANDBOX} commit --no-edit`).block).toBe(false);
    expect(bash(`git -C ${SANDBOX} status`).block).toBe(false);
    expect(bash(`git -C ${SANDBOX} log --oneline -5`).block).toBe(false);
    expect(bash(`git -C ${SANDBOX} ls-files -u`).block).toBe(false);
    expect(bash(`git -C ${SANDBOX} rev-parse --abbrev-ref HEAD`).block).toBe(
      false,
    );
  });

  test("a cd into the sandbox re-bases a bare git", () => {
    expect(bash(`cd ${SANDBOX} && git status`).block).toBe(false);
    expect(bash(`cd ${SANDBOX} && git add -A && git commit -m x`).block).toBe(
      false,
    );
  });

  test("read-only text tools anywhere", () => {
    expect(bash(`cat ${SANDBOX}/notes/a.md`).block).toBe(false);
    expect(bash(`head -20 ${VAULT}/README.md`).block).toBe(false);
    expect(bash(`grep -rn distill ${SANDBOX}/notes`).block).toBe(false);
    expect(bash(`rg -n distill ${VAULT}`).block).toBe(false);
    expect(bash(`find ${SANDBOX} -name '*.md'`).block).toBe(false);
    expect(bash(`ls -la ${SANDBOX}`).block).toBe(false);
    expect(bash(`wc -l ${SANDBOX}/notes/a.md`).block).toBe(false);
    expect(bash("pwd").block).toBe(false);
    expect(bash("echo hello").block).toBe(false);
    expect(bash("").block).toBe(false);
  });

  test("harmless redirections stay allowed", () => {
    expect(bash(`cat ${SANDBOX}/notes/a.md 2>/dev/null`).block).toBe(false);
    expect(bash("napkin overview > /dev/null").block).toBe(false);
  });

  test("a command chain is only as strong as its weakest segment", () => {
    expect(
      bash(`napkin overview && git -C ${SANDBOX} push origin HEAD`).block,
    ).toBe(true);
    expect(bash("napkin overview & gh pr create").block).toBe(true);
  });
});

describe("distillToolGate — tools outside the built-in set are refused", () => {
  test.each([
    "Agent",
    "timer",
    "heartbeat",
    "codemode",
    "SendMessage",
    "task",
    "todo",
    "mcp__github__create_pull_request",
    "web_fetch",
  ])("%s is refused with the distill-only reason", (toolName) => {
    const decision = gate(toolName, {});
    expect(decision.block).toBe(true);
    expect(decision.reason).toMatch(DISTILL);
  });

  test("the read-only built-ins are allowed, including on the live vault", () => {
    expect(gate("read", { path: `${VAULT}/reflections/x.md` }).block).toBe(
      false,
    );
    expect(gate("grep", { pattern: "x", path: VAULT }).block).toBe(false);
    expect(gate("find", { glob: "**/*.md", path: VAULT }).block).toBe(false);
    expect(gate("ls", { path: VAULT }).block).toBe(false);
  });
});

describe("distillToolGate — a misconfigured scope fails closed", () => {
  const invalid = resolveDistillScope({ NAPKIN_DISTILL_VAULT: VAULT });

  test("every mutating tool is refused", () => {
    expect(rawGate(invalid, "write", { path: `${SANDBOX}/x.md` }).block).toBe(
      true,
    );
    expect(rawGate(invalid, "bash", { command: "napkin overview" }).block).toBe(
      true,
    );
    expect(rawGate(invalid, "Agent", {}).block).toBe(true);
  });

  test("read-only tools stay available so the agent can still explain itself", () => {
    expect(rawGate(invalid, "read", { path: `${VAULT}/x.md` }).block).toBe(
      false,
    );
  });

  test("outside a distill run the gate is inert", () => {
    expect(rawGate(null, "bash", { command: "gh pr create" }).block).toBe(
      false,
    );
    expect(rawGate(null, "write", { path: "/etc/passwd" }).block).toBe(false);
    expect(rawGate(null, "Agent", {}).block).toBe(false);
  });
});

describe("extension wiring (issue #117)", () => {
  test("registers the tool_call gate only when a distill spawn exports the scope", async () => {
    const { default: distillExtension } = await import("./index");
    const { makeMockExtensionAPI } = await import("./_test-helpers");
    const saved = {
      vault: process.env.NAPKIN_DISTILL_VAULT,
      sandbox: process.env.NAPKIN_DISTILL_SANDBOX,
      worktree: process.env.NAPKIN_DISTILL_WORKTREE,
    };
    type Api = Parameters<typeof distillExtension>[0];
    const restore = () => {
      for (const [key, value] of [
        ["NAPKIN_DISTILL_VAULT", saved.vault],
        ["NAPKIN_DISTILL_SANDBOX", saved.sandbox],
        ["NAPKIN_DISTILL_WORKTREE", saved.worktree],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
    try {
      delete process.env.NAPKIN_DISTILL_VAULT;
      delete process.env.NAPKIN_DISTILL_SANDBOX;
      delete process.env.NAPKIN_DISTILL_WORKTREE;
      const outer = makeMockExtensionAPI();
      distillExtension(outer.api as Api);
      expect(outer.captured.handlers.tool_call).toBeUndefined();

      process.env.NAPKIN_DISTILL_VAULT = VAULT;
      process.env.NAPKIN_DISTILL_SANDBOX = SANDBOX;
      const inner = makeMockExtensionAPI();
      distillExtension(inner.api as Api);
      const handler = inner.captured.handlers.tool_call;
      expect(handler).toBeDefined();
      expect(
        (
          await handler?.(
            { toolName: "bash", input: { command: "gh pr create" } },
            {},
          )
        )?.block,
      ).toBe(true);
      expect(
        (
          await handler?.(
            { toolName: "bash", input: { command: "napkin overview" } },
            {},
          )
        )?.block,
      ).toBe(false);
      expect(
        (await handler?.({ toolName: "Agent", input: {} }, {}))?.block,
      ).toBe(true);
    } finally {
      restore();
    }
  });
});
