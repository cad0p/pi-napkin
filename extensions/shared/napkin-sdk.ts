import { createRequire } from "node:module";
import type * as NapkinSdk from "@cad0p/napkin";

/**
 * The napkin SDK, loaded on first use with Node's own `require(esm)`
 * (pi-napkin #149).
 *
 * pi loads extensions through jiti (`moduleCache: false`), so a static
 * `import { Napkin } from "@cad0p/napkin"` makes jiti transpile and evaluate
 * the whole SDK graph in pi's main process at load time: +8–13 MB on a warm
 * jiti cache, +49–55 MB on a miss (first run after an install or bump), for
 * extensions that only need `findVault` at session_start. Static imports
 * therefore use `@cad0p/napkin/vault` (node builtins only), and the SDK is
 * required here, outside jiti, the first time a caller needs it.
 *
 * Why `createRequire` and not `import()`: jiti rewrites `import()` in the
 * modules it loads, and `new Function("s", "return import(s)")` fails inside
 * jiti-evaluated code ("A dynamic import callback was not specified").
 * `require(esm)` is unflagged on every Node pi supports (>= 22.19) and
 * returns the same module instance `import` does; it resolves by package
 * name through napkin's `default` export condition (napkin #121).
 */

type Sdk = typeof NapkinSdk;

let sdk: Sdk | undefined;

/** Test hook: how many times this module instance loaded the SDK. */
export const __napkinSdkState = { loads: 0 };

/** Test hook: forget the loaded SDK so the next call loads (and counts) again. */
export function __resetNapkinSdkForTests(): void {
  sdk = undefined;
  __napkinSdkState.loads = 0;
}

export function loadNapkinSdk(): Sdk {
  if (sdk === undefined) {
    sdk = createRequire(import.meta.url)("@cad0p/napkin") as Sdk;
    __napkinSdkState.loads++;
  }
  return sdk;
}
