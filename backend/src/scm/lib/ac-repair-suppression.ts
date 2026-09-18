// ----------------------------------------------------------------------------
// ac-repair-suppression — the mark that says "this database client belongs to a
// cutover repair, so nothing it does may be written back to AutoCount".
//
// WHY THIS EXISTS. Owner, 2026-09-09, on finding 173 sales orders waiting in
// the write-back queue after two days of cutover repairs:
//
//   「正常来说你的这批更改不应该是syncback autocount啊 应该remain啊」
//   「你不可以有记录再这边啊 这是你import进来的错误 所以没有影响这些啊」
//
// A repair COPIES a value out of the account book. Sending that value back is
// pointless where the two already agree, and where they differ it overwrites
// his single source of truth with our version of it. Those queue rows are an
// artefact of our own import work; they are not business activity and they
// should never have been created.
//
// WHAT THIS IS NOT: an off switch for the write-back. `scm.autocount_writeback`
// is that, it is the owner's, and it must stay ON — a salesperson creating or
// editing an order in the ERP still has to reach AutoCount, which is the point
// of the ERP being live. This suppresses ONE population: work done by a script.
//
// ── WHY THE MARK IS ON THE CLIENT ────────────────────────────────────────────
//
// The alternative was an option on every enqueue* call. That is a thing each of
// ~40 repair scripts has to remember, and the failure mode of forgetting is
// silent and lands in a live account book. The TRANSPORT is the thing a script
// cannot avoid: a script reaches the database through scripts/lib/pgrest-shim.mjs
// and a request reaches it through db/supabase.ts. Those are different objects,
// so marking the shim marks every script at once — including the ones nobody
// has written yet.
//
// ── WHY SUPPRESSED IS THE DEFAULT FOR A SCRIPT ───────────────────────────────
//
// pgrestShim marks every client it builds. A tool whose PURPOSE is to push —
// rebuild-ac-document.mjs, requeue-autocount-skipped.mjs,
// recompose-autocount-transfer.mjs, sync-ac-delta.mjs's LANES=push — opts back
// in explicitly, by name, at the point it builds its client.
//
// So the polarity carries the review property the owner asked for: a repair
// that FORGETS gets the safe behaviour, and the dangerous choice is the one
// that has to be typed out, which is the one a reviewer can see. The opposite
// polarity — enqueue unless suppressed — puts the silent failure on the common
// path and the visible act on the rare one, which is backwards.
//
// ── WHY A SYMBOL ────────────────────────────────────────────────────────────
//
// "Impossible to set by accident from a UI request" has to be structural, not a
// convention. A request body, a query string and a header can only ever produce
// STRING keys, and JSON has no symbols — so no amount of hostile or careless
// input can put this mark on anything. It is also non-enumerable, so it does
// not survive a spread or a JSON round-trip and cannot leak into a payload.
//
// Symbol.for (the global registry) rather than a module-local Symbol, because
// pgrest-shim.mjs is plain ESM loaded by `node` as well as by `tsx`, and must be
// able to set the same mark without importing this TypeScript module. The
// registry key is the contract between the two files and is written in both.
// ----------------------------------------------------------------------------

/** The mark. Also spelled, as a string, in scripts/lib/pgrest-shim.mjs. */
export const REPAIR_CLIENT = Symbol.for('houzs.ac.repairClient');

/**
 * Mark a database client as belonging to a cutover repair.
 *
 * Non-enumerable and non-writable: once a client is a repair client it cannot
 * be talked out of it, which matters because the code between here and the
 * enqueue is long and passes the client through several layers.
 */
export function markRepairClient<T extends object>(sb: T): T {
  Object.defineProperty(sb, REPAIR_CLIENT, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return sb;
}

/**
 * Is this a repair client? NEVER THROWS — it is called on the enqueue path,
 * which may not fail a user's save, and it is handed whatever the caller had.
 */
export function isRepairClient(sb: unknown): boolean {
  if (sb == null) return false;
  const t = typeof sb;
  if (t !== 'object' && t !== 'function') return false;
  try {
    return (sb as Record<symbol, unknown>)[REPAIR_CLIENT] === true;
  } catch {
    /* A proxy that throws on symbol access is not something to guess about. It
       is not a repair client — the shim's own clients are plain objects — and
       the write-back's ordinary gates still apply. */
    return false;
  }
}
