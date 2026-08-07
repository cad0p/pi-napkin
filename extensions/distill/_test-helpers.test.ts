import { describe, expect, test, vi } from "vitest";
import { retryRmSync } from "./_test-helpers";

/**
 * Unit tests for `retryRmSync` (Flake A regression, issue #49).
 *
 * The routing-test teardown races a detached wrapper subprocess that
 * holds the vault as cwd until it exits (the wrapper's EXIT trap `cd`s
 * into the vault and runs `git -C <vault> prune` + `branch -D` AFTER
 * removing the worktree). On macOS `fs.rmSync` then fails with
 * ENOTEMPTY (a directory that is a live process's cwd cannot be
 * removed); `force: true` only ignores ENOENT, never retries.
 * `retryRmSync` retries exactly that error a bounded number of times.
 * These tests pin the retry contract with a fake fs that fails N times
 * with ENOTEMPTY and then succeeds.
 */

function err(code: string): NodeJS.ErrnoException {
  const e = new Error(`fake fs error ${code}`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

function fakeFs(rmSync: ReturnType<typeof vi.fn>): typeof import("node:fs") {
  return { rmSync } as unknown as typeof import("node:fs");
}

describe("retryRmSync", () => {
  test("removes on the first attempt when nothing holds the dir", () => {
    const rmSync = vi.fn();
    retryRmSync("/tmp/x", { fs: fakeFs(rmSync), attempts: 5, delayMs: 0 });
    expect(rmSync).toHaveBeenCalledTimes(1);
  });

  test("retries ENOTEMPTY until the fs stops failing, then succeeds", () => {
    const rmSync = vi
      .fn()
      .mockImplementationOnce(() => {
        throw err("ENOTEMPTY");
      })
      .mockImplementationOnce(() => {
        throw err("ENOTEMPTY");
      })
      .mockImplementation(() => {});
    retryRmSync("/tmp/x", { fs: fakeFs(rmSync), attempts: 10, delayMs: 0 });
    expect(rmSync).toHaveBeenCalledTimes(3);
  });

  test("rethrows after the retry bound is exhausted (never hides a stuck dir)", () => {
    const rmSync = vi.fn().mockImplementation(() => {
      throw err("ENOTEMPTY");
    });
    expect(() =>
      retryRmSync("/tmp/x", { fs: fakeFs(rmSync), attempts: 4, delayMs: 0 }),
    ).toThrowError("ENOTEMPTY");
    expect(rmSync).toHaveBeenCalledTimes(4);
  });

  test("rethrows non-retryable errors immediately (no masking)", () => {
    const rmSync = vi.fn().mockImplementation(() => {
      throw err("EACCES");
    });
    expect(() =>
      retryRmSync("/tmp/x", { fs: fakeFs(rmSync), attempts: 10, delayMs: 0 }),
    ).toThrowError("EACCES");
    expect(rmSync).toHaveBeenCalledTimes(1);
  });

  test("retries EBUSY (macOS rmdir of a live-cwd dir) as well", () => {
    const rmSync = vi
      .fn()
      .mockImplementationOnce(() => {
        throw err("EBUSY");
      })
      .mockImplementation(() => {});
    retryRmSync("/tmp/x", { fs: fakeFs(rmSync), attempts: 5, delayMs: 0 });
    expect(rmSync).toHaveBeenCalledTimes(2);
  });
});
