// ----------------------------------------------------------------------------
// The gate that decides whether a spec change may move a stock bucket.
//
// IT IS ONE PLACE BECAUSE IT WAS ABOUT TO BE TWO. `apply-book-text-specials.mjs`
// grew this logic over 2026-09-12/13 and paid for two defects finding it:
//
//   - docs/bugs/0844: buckets collected from the purchase side only, so a
//     delivered line's OUT movement — bucketed on the DELIVERY line's own code —
//     would have been stranded;
//   - the same entry's second half: two chains sharing one bucket while asking
//     for DIFFERENT new keys, where the first write moves every lot and the
//     second finds nothing, filing one order's stock under another's key with no
//     error and no count.
//
// `unify-legacy-specials.mjs` needs exactly the same gate. A second author
// re-deriving it would re-pay for both, so it lives here with a test rather than
// being copied. Nothing in this file opens a database: the caller supplies the
// two lookups, which is what makes it testable.
//
// THE UNDERLYING DEFECT IT EXISTS TO PREVENT is docs/bugs/0722 — writing a
// measurement or option onto a line whose goods are already in points that line
// at a bucket no lot carries, which is a phantom OUT with no COGS.
// ----------------------------------------------------------------------------

/** A bucket this plan would move: one (item_code, old key) -> new key, with the
 *  ledger row counts already read.
 *  @typedef {{ itemCode: string, grp: string, oldKey: string, newKey: string,
 *              rows: { lots: number, movements: number, consumptions: number, untouchable: number } }} Bucket */

/** Rows in tables this class of tool does not move at all. */
export const untouchableOf = (b) => Number(b?.rows?.untouchable ?? 0);

/** Rows this tool WOULD re-key. Zero means the bucket is empty and the change
 *  is free — no goods are in, so nothing can be stranded. */
export const ledgerRowsOf = (b) =>
  Number(b?.rows?.lots ?? 0) + Number(b?.rows?.movements ?? 0) + Number(b?.rows?.consumptions ?? 0);

/** Every document-line id that belongs to a plan's own chain. A bucket shared
 *  only with these is the plan's to move. */
export function idsOfPlan(p) {
  const ids = new Set();
  const add = (x) => { if (x != null && x !== '') ids.add(String(x)); };
  add(p.soItemId);
  for (const x of p.pos ?? []) add(x.id ?? x);
  for (const x of p.grn ?? []) add(x.id ?? x);
  for (const x of p.doRows ?? p.dos ?? []) add(x.id ?? x);
  for (const x of p.pinv ?? []) add(x.id ?? x);
  for (const x of p.sinv ?? []) add(x.id ?? x);
  return ids;
}

/**
 * Split the plans into the ones safe to write and the ones that are not, and
 * say WHY for each refusal in words a person can act on.
 *
 * Two refusals, and they are different problems:
 *
 *   SHARED  — the bucket is also reached by a document OUTSIDE every plan that
 *             touches it. Re-keying would point those documents at stock that is
 *             no longer there.
 *   SPLIT   — the plans that share the bucket do NOT agree on the new key. That
 *             is a lot SPLIT by quantity, not a rename, and this class of tool
 *             does not do it. Refusing both is deliberate: writing either one
 *             first silently files the other's stock under the wrong key.
 *
 * A bucket holding NO ledger rows is never refused for either reason — there is
 * nothing to strand and nothing to split.
 *
 * @param {Array<{ doc: string, buckets: Bucket[] }>} plans
 * @param {(itemCode: string, grp: string, oldKey: string) => Promise<Array<{doc: string, id: string}>>} consumersOf
 *        every DOCUMENT LINE resolving to that bucket, across all six documents
 * @returns {Promise<{ writable: any[], refused: Array<any & {why: string}> }>}
 */
export async function classifyPlans(plans, consumersOf) {
  /* Which new keys each bucket is being asked for, and which plans touch it. */
  const asked = new Map();
  for (const p of plans) {
    for (const b of p.buckets ?? []) {
      const k = `${b.itemCode}|${b.oldKey}`;
      const e = asked.get(k) ?? { newKeys: new Set(), docs: new Set(), ids: new Set() };
      e.newKeys.add(b.newKey);
      e.docs.add(p.doc);
      for (const id of idsOfPlan(p)) e.ids.add(id);
      asked.set(k, e);
    }
  }

  const writable = [];
  const refused = [];
  for (const p of plans) {
    let why = null;
    for (const b of p.buckets ?? []) {
      if (untouchableOf(b)) {
        why = `${b.itemCode}: ${untouchableOf(b)} row(s) in rack / stock-take / transfer tables this tool does not move`;
        break;
      }
      if (ledgerRowsOf(b) === 0) continue;
      const e = asked.get(`${b.itemCode}|${b.oldKey}`);
      if (e && e.newKeys.size > 1) {
        why = `${b.itemCode} would have to SPLIT one stock bucket into ${e.newKeys.size}`
          + ` — ${[...e.docs].slice(0, 4).join(', ')} share it and ask for different options.`
          + ' Splitting a lot by quantity is not a re-key; this needs a person.';
        break;
      }
      const others = (await consumersOf(b.itemCode, b.grp, b.oldKey))
        .filter((c) => !(e?.ids ?? new Set()).has(String(c.id)));
      if (others.length) {
        why = `the stock bucket ${b.itemCode} is shared with ${others.length} line(s) outside this chain`
          + ` (${others.slice(0, 4).map((o) => o.doc).join(', ')})`;
        break;
      }
    }
    if (why) refused.push({ ...p, why }); else writable.push(p);
  }
  return { writable, refused };
}
