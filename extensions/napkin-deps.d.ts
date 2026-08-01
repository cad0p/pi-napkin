/**
 * Type shims for @cad0p/napkin's untyped transitive dependencies.
 *
 * napkin ships its TypeScript *sources* (no `dist/`, no bundled `.d.ts`),
 * so importing `Napkin` pulls napkin's `src/` into this project's `tsc`
 * compilation. napkin 0.10's `bases.ts`/`formula.ts` import `js-yaml`,
 * `sql.js`, and `jexl`, none of which ship type declarations. napkin
 * itself stays green because it carries `src/types.d.ts` shims — but
 * those live inside `node_modules/@cad0p/napkin` and are NOT picked up
 * by a consumer's compilation.
 *
 * The `sql.js` and `jexl` declarations below mirror napkin's own
 * `src/types.d.ts` *verbatim* so that `bases.ts`/`formula.ts` typecheck
 * here exactly as they do in napkin's repo. This is deliberately *not*
 * `@types/sql.js`: the real `@types/sql.js` exposes a genuine internal
 * mismatch in napkin's `bases.ts` (`unknown[][]` vs `SqlValue[][]`,
 * TS2322) that this extension does not exercise and that belongs to
 * napkin. `js-yaml` is declared as `any` (napkin's code only calls
 * `yaml.load`, and napkin itself uses `@types/js-yaml`). These three
 * modules are never imported by pi-napkin code directly.
 */
declare module "js-yaml";

declare module "sql.js" {
  interface Database {
    run(sql: string, params?: unknown[]): void;
    exec(sql: string): { columns: string[]; values: unknown[][] }[];
    close(): void;
    // biome-ignore lint/complexity/noBannedTypes: sql.js dynamic function registration
    create_function(name: string, fn: Function): void;
  }
  interface SqlJsStatic {
    Database: new () => Database;
  }

  export type { Database };
  export default function initSqlJs(): Promise<SqlJsStatic>;
}

declare module "jexl" {
  class Jexl {
    eval(expr: string, context?: Record<string, unknown>): Promise<unknown>;
    // biome-ignore lint/complexity/noBannedTypes: jexl dynamic function registration
    addFunction(name: string, fn: Function): void;
    // biome-ignore lint/complexity/noBannedTypes: jexl dynamic transform registration
    addTransform(name: string, fn: Function): void;
  }
  export default { Jexl };
}
