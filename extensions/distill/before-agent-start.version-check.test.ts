/**
 * C8 — Meta-test: pin pi's `before_agent_start` systemPrompt contract.
 *
 * The distill extension's overlap injector concatenates onto
 * `event.systemPrompt` and returns `{ systemPrompt: <concat> }`:
 *
 *   return { systemPrompt: event.systemPrompt + formatOverlapNotice(overlap) };
 *
 * For that contract to hold, pi's public types must keep:
 *   - `BeforeAgentStartEvent.systemPrompt: string` (we string-concat).
 *   - `BeforeAgentStartEventResult.systemPrompt?: string` (we return it).
 *
 * If pi ever changes those fields (e.g. to a structured object, or to a
 * required property), our concat would silently truncate or become a
 * runtime type error. This test flags such upstream drift at CI time so
 * we get an explicit "review + resync" moment rather than a mysterious
 * regression in overlap injection.
 *
 * Not a behavior test — we don't import or call pi's handler dispatch.
 * Just a layout check on the `.d.ts` file that ships with pi.
 *
 * Companion of session-touched-files.version-check.test.ts; if this test
 * fails after a pi version bump:
 *   1. Inspect the new BeforeAgentStart* types in node_modules.
 *   2. If the contract has genuinely changed, update the distill
 *      overlap injector to match and loosen / update these assertions.
 *   3. If a rename (not a semantic change), update just the assertions.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PI_TYPES_PATH = join(
  __dirname,
  "..",
  "..",
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "core",
  "extensions",
  "types.d.ts",
);

describe("pi before_agent_start systemPrompt contract (C8)", () => {
  test("types.d.ts is still present at the expected path", () => {
    expect(existsSync(PI_TYPES_PATH)).toBe(true);
  });

  test("BeforeAgentStartEvent still declares `systemPrompt: string`", () => {
    const src = readFileSync(PI_TYPES_PATH, "utf-8");
    // Extract the `BeforeAgentStartEvent` interface body.
    const m = src.match(
      /export interface BeforeAgentStartEvent\s*\{([\s\S]*?)^}/m,
    );
    expect(m).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: assertion above
    const body = m![1];
    // Required, string-typed, NOT an array or object. A rename to e.g.
    // `systemPrompt: SystemPromptParts[]` would break our concat.
    expect(body).toMatch(/systemPrompt\s*:\s*string\s*;/);
  });

  test("BeforeAgentStartEventResult still accepts `systemPrompt?: string`", () => {
    const src = readFileSync(PI_TYPES_PATH, "utf-8");
    const m = src.match(
      /export interface BeforeAgentStartEventResult\s*\{([\s\S]*?)^}/m,
    );
    expect(m).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: assertion above
    const body = m![1];
    // Optional on the result side — our injector returns it conditionally.
    expect(body).toMatch(/systemPrompt\?\s*:\s*string\s*;/);
  });

  test("pi documents that multiple extensions chain the systemPrompt result", () => {
    // Belt-and-braces: the overlap injector returns systemPrompt on overlap
    // but not when there's no overlap (so pi's default / other extensions'
    // handlers continue to own the prompt). The chaining contract is
    // explicit in the docstring today — assert it stays so, otherwise a
    // rewrite to "last wins" could silently drop our notice.
    const src = readFileSync(PI_TYPES_PATH, "utf-8");
    // Loose phrase check: the pi docstring uses "chained" today. If it
    // rephrases to "sequenced" or "composed", this test fails and we
    // resync the comment in index.ts — but the BEHAVIOR we rely on
    // (prior extensions' contributions survive our return) must hold.
    expect(src).toMatch(/chained|chain/i);
  });
});
