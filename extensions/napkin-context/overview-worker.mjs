/**
 * Worker-thread entry for napkin-context's background vault overview
 * (pi-napkin #132).
 *
 * Napkin.overview() is synchronous and heavy (5–14 s, ~850 MB transient heap
 * on a 28.7k-note vault), so it runs here instead of on pi's main thread: the
 * main thread does not freeze and the worker's heap is released when it exits
 * instead of being kept by pi's V8 for the rest of the session.
 *
 * Shipped as plain .mjs — the extension itself is loaded by pi through jiti,
 * but a node:worker_threads Worker needs a file Node can run directly, and
 * this file is the only TS-free artifact that has to exist for that.
 *
 * Protocol (structured-clone safe):
 *   workerData: { cwd, searchFreshnessMs?, napkinEntryUrl? }
 *   posts:      { overview: <VaultOverview & { root }> | null }
 *            or { error: <message> } — the parent treats both like a worker
 *            'error' event and falls back to the in-thread build.
 */

import { parentPort, workerData } from "node:worker_threads";

async function main() {
  const { cwd, searchFreshnessMs, napkinEntryUrl } = workerData;
  // Prefer the entry the extension resolved against pi-napkin's own package
  // (createRequire(import.meta.url).resolve — correct under pnpm/nested
  // layouts where a bare specifier would resolve against THIS file's package,
  // which may not carry @cad0p/napkin). Fall back to the bare specifier:
  // inside the published package this file sits next to the dependency.
  const napkin = napkinEntryUrl
    ? await import(napkinEntryUrl)
    : await import("@cad0p/napkin");
  const n = new napkin.Napkin(
    cwd,
    searchFreshnessMs === undefined ? undefined : { searchFreshnessMs },
  );
  // Synchronous on purpose — that is the whole reason this is a worker.
  const overview = n.overview();
  parentPort.postMessage({ overview: overview ?? null });
}

main().then(
  // Closing the port unrefs it so the worker exits once its loop drains —
  // the parent also terminates it after the result lands, but a parent that
  // went away first must not leak the thread.
  () => parentPort.close(),
  (err) => {
    try {
      parentPort.postMessage({ error: String(err?.stack ?? err) });
    } finally {
      parentPort.close();
    }
  },
);
