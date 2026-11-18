/**
 * Distill-mode tool gate (issue #122, design case 9).
 *
 * The wrapper is the guarantee (it judges the tree diff); this gate is the
 * early-feedback half: in a distill run the agent must not write into the
 * live vault and must not run git there, so a run does not spend its budget
 * producing work the wrapper will drop.
 *
 * Scope: the vault-path subset of #117 item 1 only. Paths outside the vault,
 * non-git commands and non-built-in tools stay allowed.
 */

import { describe, expect, test } from "vitest";
import {
  type DistillScope,
  distillToolGate,
  isPathInside,
  liveVaultGitTarget,
  resolveDistillScope,
  shellWords,
} from "./index";

const VAULT = "/home/user/Goldmine";
const WORKTREE = "/home/user/.cache/napkin-distill/abc/distill-1";
const SCOPE: DistillScope = { vault: VAULT, worktree: WORKTREE };

function gate(
  toolName: string,
  input: Record<string, unknown>,
  cwd = "/home/user/project",
  scope: DistillScope | null = SCOPE,
) {
  return distillToolGate({ event: { toolName, input }, scope, cwd });
}

describe("resolveDistillScope", () => {
  test("null outside a distill run (both wrapper vars absent)", () => {
    expect(resolveDistillScope({})).toBeNull();
    expect(resolveDistillScope({ NAPKIN_DISTILL_VAULT: VAULT })).toBeNull();
    expect(
      resolveDistillScope({ NAPKIN_DISTILL_WORKTREE: WORKTREE }),
    ).toBeNull();
  });

  test("resolves the env pair the wrapper exports", () => {
    expect(
      resolveDistillScope({
        NAPKIN_DISTILL_VAULT: VAULT,
        NAPKIN_DISTILL_WORKTREE: WORKTREE,
      }),
    ).toEqual({ vault: VAULT, worktree: WORKTREE });
  });

  test("ignores a malformed pair whose worktree nests inside the vault", () => {
    // Nested: every worktree write would look like a live-vault write. Gate
    // nothing rather than block the agent out of its own worktree.
    expect(
      resolveDistillScope({
        NAPKIN_DISTILL_VAULT: VAULT,
        NAPKIN_DISTILL_WORKTREE: `${VAULT}/.napkin/wt`,
      }),
    ).toBeNull();
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

describe("liveVaultGitTarget", () => {
  test("finds git -C <vault>", () => {
    expect(liveVaultGitTarget(`git -C ${VAULT} commit -m x`, "/p", VAULT)).toBe(
      VAULT,
    );
  });

  test("finds --git-dir= and --work-tree= pointed at the vault", () => {
    expect(
      liveVaultGitTarget(`git --git-dir=${VAULT}/.git status`, "/p", VAULT),
    ).toBe(`${VAULT}/.git`);
    expect(
      liveVaultGitTarget(`git --work-tree ${VAULT} status`, "/p", VAULT),
    ).toBe(VAULT);
  });

  test("judges a bare git by the cwd", () => {
    expect(liveVaultGitTarget("git status", VAULT, VAULT)).toBe(VAULT);
    expect(
      liveVaultGitTarget("git status", "/home/user/project", VAULT),
    ).toBeNull();
  });

  test("allows git against the worktree or an unrelated repo", () => {
    expect(
      liveVaultGitTarget(`git -C ${WORKTREE} commit -m x`, "/p", VAULT),
    ).toBeNull();
    expect(
      liveVaultGitTarget("git -C /tmp/other status", "/p", VAULT),
    ).toBeNull();
  });

  test("resolves a relative -C against the cwd", () => {
    expect(liveVaultGitTarget("git -C . status", VAULT, VAULT)).toBe(VAULT);
  });

  test("a non-git command is never a target", () => {
    expect(
      liveVaultGitTarget("napkin append notes/a.md x", "/p", VAULT),
    ).toBeNull();
    expect(liveVaultGitTarget(`ls ${VAULT}`, "/p", VAULT)).toBeNull();
  });
});

describe("distillToolGate - the design case-9 matrix", () => {
  test("with the distill env set: vault write/edit blocked", () => {
    expect(gate("write", { path: `${VAULT}/x.md` }).block).toBe(true);
    expect(gate("edit", { path: `${VAULT}/notes/x.md` }).block).toBe(true);
    // A relative path that resolves into the vault is the same write.
    expect(gate("write", { path: "notes/x.md" }, VAULT).block).toBe(true);
    // The reason names the vault and points at the worktree.
    expect(gate("write", { path: `${VAULT}/x.md` }).reason).toContain(VAULT);
    expect(gate("write", { path: `${VAULT}/x.md` }).reason).toContain(WORKTREE);
  });

  test("with the distill env set: worktree write allowed", () => {
    expect(gate("write", { path: `${WORKTREE}/notes/x.md` }).block).toBe(false);
    expect(gate("edit", { path: `${WORKTREE}/note.md` }).block).toBe(false);
  });

  test("with the distill env set: git against the vault is blocked", () => {
    expect(gate("bash", { command: `git -C ${VAULT} commit -m x` }).block).toBe(
      true,
    );
    expect(
      gate("bash", { command: `cd /p && git --git-dir=${VAULT}/.git log` })
        .block,
    ).toBe(true);
    // Bare git when the agent cwd is the vault.
    expect(gate("bash", { command: "git checkout main" }, VAULT).block).toBe(
      true,
    );
  });

  test("with the distill env set: napkin and worktree git are allowed", () => {
    expect(
      gate("bash", { command: "napkin append notes/a.md hello" }).block,
    ).toBe(false);
    expect(
      gate("bash", { command: `git -C ${WORKTREE} commit -m x` }).block,
    ).toBe(false);
    expect(
      gate("bash", { command: "git status" }, "/home/user/project").block,
    ).toBe(false);
  });

  test("with the env unset nothing is blocked", () => {
    expect(gate("write", { path: `${VAULT}/x.md` }, "/p", null).block).toBe(
      false,
    );
    expect(
      gate("bash", { command: `git -C ${VAULT} commit -m x` }, "/p", null)
        .block,
    ).toBe(false);
  });

  test("read is not gated: the agent may read the vault", () => {
    expect(gate("read", { path: `${VAULT}/x.md` }).block).toBe(false);
  });
});

describe("extension wiring (issue #122)", () => {
  test("registers the tool_call gate only when the wrapper exports the scope", async () => {
    const { default: distillExtension } = await import("./index");
    const { makeMockExtensionAPI } = await import("./_test-helpers");
    const savedVault = process.env.NAPKIN_DISTILL_VAULT;
    const savedWorktree = process.env.NAPKIN_DISTILL_WORKTREE;
    type Api = Parameters<typeof distillExtension>[0];
    try {
      delete process.env.NAPKIN_DISTILL_VAULT;
      delete process.env.NAPKIN_DISTILL_WORKTREE;
      const outer = makeMockExtensionAPI();
      distillExtension(outer.api as Api);
      expect(outer.captured.handlers.tool_call).toBeUndefined();

      process.env.NAPKIN_DISTILL_VAULT = VAULT;
      process.env.NAPKIN_DISTILL_WORKTREE = WORKTREE;
      const inner = makeMockExtensionAPI();
      distillExtension(inner.api as Api);
      const handler = inner.captured.handlers.tool_call;
      expect(handler).toBeDefined();
      const decision = await handler?.(
        { toolName: "write", input: { path: `${VAULT}/x.md` } },
        {},
      );
      expect(decision?.block).toBe(true);
      const allowed = await handler?.(
        { toolName: "bash", input: { command: "napkin append a.md b" } },
        {},
      );
      expect(allowed?.block).toBe(false);
    } finally {
      if (savedVault === undefined) delete process.env.NAPKIN_DISTILL_VAULT;
      else process.env.NAPKIN_DISTILL_VAULT = savedVault;
      if (savedWorktree === undefined)
        delete process.env.NAPKIN_DISTILL_WORKTREE;
      else process.env.NAPKIN_DISTILL_WORKTREE = savedWorktree;
    }
  });
});
