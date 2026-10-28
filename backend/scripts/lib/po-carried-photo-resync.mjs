// Pure planner for the PO carried-photo re-sync repair. No I/O, no DB, and NO
// SHEBANG — a test imports it (CLAUDE.md). The runnable script
// repair-po-carried-photos.mjs does the reads/writes and calls this to decide
// what to change.
//
// THE BUG (docs/bugs/0789): a PO line's `photo_urls` copies the source SO line's
// photo keys at convert time and a revision preserves that copy — so when the SO
// line's photos change (or the line is replaced with a new id and a new photo),
// the PO keeps a STALE `so-items/<old>/...` key whose R2 object is gone, and the
// PO photo strip renders "err". Carried photos are read-only, authored on the
// SO, so the PO should MIRROR the SO line's CURRENT photos.
//
// This repair re-aligns the CARRIED (`so-items/...`) keys to the linked SO
// line's current `photo_urls`, and PRESERVES the PO's OWN uploads
// (`po-items/...`). It touches `photo_urls` only.

const isPoOwned = (k) => String(k).startsWith('po-items/');
const arraysEqual = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Decide which PO lines carry a stale/missing SO photo set and what to set it to.
 *
 * @param {Array<{ poLineId: string, poNumber: string, itemCode: string,
 *   poPhotoUrls: string[]|null, soLineExists: boolean, soPhotoUrls: string[]|null }>} rows
 *   one row per PO line that carries at least one `so-items/` key, joined to its
 *   linked SO line (`so_item_id`): `soLineExists` says the SO line is still there,
 *   `soPhotoUrls` its CURRENT photos.
 * @returns {{ toFix: Array<{poLineId:string,poNumber:string,itemCode:string,from:string[],to:string[]}>,
 *             skipped: Array<{poLineId:string,reason:string}> }}
 */
export function planPhotoResync(rows) {
  const toFix = [];
  const skipped = [];
  for (const r of rows) {
    // A dangling so_item_id (SO line deleted) is a DIFFERENT problem — we cannot
    // resolve the current photos, so leave it and report rather than guess.
    if (!r.soLineExists) {
      skipped.push({ poLineId: r.poLineId, reason: 'the linked SO line no longer exists — cannot resolve current photos' });
      continue;
    }
    const cur = r.poPhotoUrls ?? [];
    const poOwned = cur.filter(isPoOwned);
    const soCurrent = r.soPhotoUrls ?? [];
    // Desired = the PO's OWN uploads + the SO line's CURRENT photos, de-duplicated
    // (po-owned first so a shared key keeps the PO's position).
    const desired = [];
    for (const k of [...poOwned, ...soCurrent]) if (!desired.includes(k)) desired.push(k);
    if (arraysEqual(cur, desired)) {
      skipped.push({ poLineId: r.poLineId, reason: 'carried photos already match the SO line' });
      continue;
    }
    toFix.push({ poLineId: r.poLineId, poNumber: r.poNumber, itemCode: r.itemCode, from: cur, to: desired });
  }
  return { toFix, skipped };
}

/**
 * Shape assertion for the fresh-connection verify: every fixed line's stored
 * `photo_urls` now equals the desired array we wrote. Returns the poLineIds that
 * FAILED (empty = clean); a row missing from `afterByLineId` is a failure.
 *
 * @param {Array<{poLineId:string,to:string[]}>} toFix
 * @param {Map<string,string[]|null>} afterByLineId  re-read `id -> photo_urls`
 * @returns {string[]}
 */
export function verifyPhotoResync(toFix, afterByLineId) {
  const failures = [];
  for (const f of toFix) {
    const got = afterByLineId.get(f.poLineId);
    if (!got || !arraysEqual(got, f.to)) failures.push(f.poLineId);
  }
  return failures;
}
