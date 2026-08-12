import { describe, expect, test } from "vitest";
import napkinSteeringPlugin, {
  isNapkinVault,
  napkinSteeringPlugin as namedPlugin,
} from "./index.ts";

/**
 * Plugin shape tests — pins the public contract of
 * `@cad0p/pi-napkin/steering`:
 *
 *   - plugin name `napkin` (the `disabledPlugins` + diagnostics key),
 *   - exactly the two shipped git-plugin rule names exempted,
 *   - positive-form `when` clauses with NO `onUnknown` anywhere
 *     (exemptions are strictly fail-closed — type-level ban plus
 *     load-time rejection in pi-steering; this test pins the shape
 *     the plugin actually ships),
 *   - the `isNapkinVault` predicate registered.
 */

describe("napkin steering plugin shape", () => {
  test("name is 'napkin'", () => {
    expect(napkinSteeringPlugin.name).toBe("napkin");
  });

  test("exemptions target exactly the two shipped git-plugin rule names, positive-form", () => {
    const exemptions = napkinSteeringPlugin.exemptions ?? [];
    expect(exemptions).toHaveLength(2);

    const rules = exemptions.map((e) => e.rule);
    expect(rules).toEqual(["no-main-commit", "no-main-commit-github"]);

    for (const exemption of exemptions) {
      // Deep no-onUnknown walk: exemption clauses must stay in the
      // modifier-stripped `ExemptionWhenClause` shape.
      expect(JSON.stringify(exemption.when)).not.toContain("onUnknown");
      expect(exemption.when).toEqual({ isNapkinVault: true });
    }
  });

  test("isNapkinVault predicate is registered", () => {
    expect(typeof napkinSteeringPlugin.predicates?.isNapkinVault).toBe(
      "function",
    );
  });

  test("default export === named napkinSteeringPlugin export", () => {
    expect(napkinSteeringPlugin).toBe(namedPlugin);
  });

  test("predicate handler is exported for piece-picking consumers", () => {
    expect(typeof isNapkinVault).toBe("function");
  });
});
