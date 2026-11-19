/**
 * Child-process entry for napkin-context's background vault overview
 * (pi-napkin #139 — successor to the #132 worker thread).
 *
 * Napkin.overview() is synchronous and heavy (5–14 s, ~850 MB transient heap
 * on a 28.7k-note vault), so it runs outside pi's main thread. #132 used a
 * worker_thread for that, but a terminated worker's freed heap stays inside
 * pi's process (glibc arenas are per-process): ~330 MB stayed resident after
 * the build. A forked child process returns everything to the OS on exit —
 * same non-blocking build, none of the retained memory.
 *
 * Shipped as plain .mjs — the extension itself is loaded by pi through jiti,
 * but a forked node child needs a file Node can run directly, and this file
 * is the only TS-free artifact that has to exist for that.
 *
 * Protocol (V8-serialized IPC — "advanced", the fork() equivalent of the
 * worker's structured clone, so the overview round-trips identical):
 *   parent sends: { cwd, searchFreshnessMs? }
 *   child sends:  { overview: <VaultOverview & { root }> | null }
 *              or { error: <message> } — the parent treats both like a spawn
 *              failure and falls back to the in-thread build.
 * The child disconnects and exits right after posting; the parent SIGKILLs
 * it on timeout, session_shutdown, or pi exit.
 */

// Without an IPC channel (e.g. run by hand for debugging) the input message
// can never arrive — fail fast instead of waiting for the parent's timeout.
if (!process.send) {
  console.error(
    "overview-child.mjs must be spawned via child_process.fork with an IPC channel",
  );
  process.exit(1);
}

/** Post one message, then resolve whether or not the channel took it. */
function send(msg) {
  return new Promise((resolve) => {
    try {
      process.send(msg, () => resolve());
    } catch {
      resolve();
    }
  });
}

async function main() {
  // Inputs arrive as the first IPC message. If the parent went away first
  // (channel closed), exit rather than hanging on a message that can't come.
  const input = await new Promise((resolve) => {
    process.once("message", resolve);
    process.once("disconnect", () => process.exit(0));
  });
  const { cwd, searchFreshnessMs } = input ?? {};
  // Bare specifier resolved from THIS file's location: the child sits inside
  // the published pi-napkin package, and module resolution walks up from
  // extensions/napkin-context/ into pi-napkin's own node_modules, where
  // @cad0p/napkin is a real dependency — including pnpm's
  // .pnpm/<pkg>/node_modules sibling layout.
  const napkin = await import("@cad0p/napkin");
  const n = new napkin.Napkin(
    cwd,
    searchFreshnessMs === undefined ? undefined : { searchFreshnessMs },
  );
  // Synchronous on purpose — that is the whole reason this is a child.
  const overview = await n.overview();
  await send({ overview: overview ?? null });
}

main().then(
  // Disconnecting closes the IPC channel so the child exits once its loop
  // drains — the parent also kills it after the result lands, but a parent
  // that went away first must not leave an orphan behind.
  () => process.disconnect(),
  async (err) => {
    await send({ error: String(err?.stack ?? err) });
    process.disconnect();
  },
);
