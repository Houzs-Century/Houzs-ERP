// ---------------------------------------------------------------------------
// line-photo-keys.mjs — the decisions behind the two AutoCount line-photo
// repairs, as PURE functions: rows in, plan out. No filesystem, no database,
// no network, no process.exit. The scripts do the I/O and own the verdict.
//
// VOCABULARY, because two different things are both called "a photo":
//   ADDRESS  one entry of a line's photo_urls column. It is an R2 object key:
//              <so|po>-items/<doc no>/<ERP row id>/ac-<AutoCount DtlKey>-<n>.jpg
//   LINE     the AutoCount line the book photographed, identified by DtlKey.
//            A sofa build is ONE line held as SEVERAL ERP rows.
//
// The two facts that make the repairs safe are both in the address itself: the
// DtlKey says WHICH photograph it is, so two addresses carrying the same DtlKey
// on the same document are the same picture; and the row id in the middle is
// only a mint-time record of where it was hung, never an authorisation — the
// read routes authorise by MEMBERSHIP of photo_urls, never by key shape
// (mfg-purchase-orders.ts, poItemPhotoSignedHandler).
// ---------------------------------------------------------------------------

/** The AutoCount DtlKey an importer-minted address names, or null if the
 *  address was not minted by the importer (an operator upload, say). */
export function acDtlKeyOf(key) {
  const m = /\/ac-(\d+)-\d+\.jpg$/.exec(key || '');
  return m ? m[1] : null;
}

/** The ERP row id an address names — where it was hung when it was minted. */
export function rowIdOf(key) {
  const m = /\/([0-9a-f-]{36})\/ac-\d+-\d+\.jpg$/.exec(key || '');
  return m ? m[1] : null;
}

/** Row order the importers anchor on: first line, then id as a tie-break. */
const firstRow = (rows) => rows
  .slice()
  .sort((a, b) => (a.lineNo ?? 0) - (b.lineNo ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];

/** Group rows by the AutoCount LINE they came from — the unit the book
 *  photographs, and the unit "this line has a picture" is true or false of. */
function byLine(rows) {
  const out = new Map();
  for (const r of rows) {
    if (r.dtl === null || r.dtl === undefined || r.dtl === '') continue;
    const k = `${r.doc}|${r.dtl}`;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}

/**
 * PRUNE plan: addresses that name no object, on rows that still show the same
 * photograph through a working address.
 *
 * The safety property is the whole point and it is checked per address, not per
 * row: an address is only dropped when THE SAME ROW carries a live address for
 * THE SAME DtlKey. So no prune can ever be the last copy of a picture, and a
 * dead address whose row would go blank is never touched — it is returned
 * separately as `wouldBlank`, which is a decision, not a repair.
 *
 * @param rows      [{ id, doc, lineNo, dtl, pics: string[] }]
 * @param liveKeys  Set of object keys that exist in R2, read at run time
 */
export function planDeadKeyPrune(rows, liveKeys) {
  const prune = [];       // { id, doc, dtl, drop, keeps }
  const wouldBlank = [];  // { id, doc, dtl, dead }
  for (const r of rows) {
    const pics = r.pics ?? [];
    for (const key of pics) {
      const dtl = acDtlKeyOf(key);
      if (dtl === null) continue;              // not ours to judge
      if (liveKeys.has(key)) continue;         // resolves — nothing to do
      const keeps = pics.filter((k) => k !== key && liveKeys.has(k) && acDtlKeyOf(k) === dtl);
      if (keeps.length) prune.push({ id: r.id, doc: r.doc, dtl, drop: key, keeps });
      else wouldBlank.push({ id: r.id, doc: r.doc, dtl, dead: key });
    }
  }
  return { prune, wouldBlank };
}

/**
 * RE-POINT plan: an AutoCount line whose photograph is in R2 but hangs on a
 * DIFFERENT row of the same document, so the line itself shows nothing.
 *
 * Skipped when ANY row of the line already shows a live address for that line —
 * which is what keeps the owner's sofa rule intact (2026-08-10, 「每个 SKU 的
 * 照片都一样,留第一个就可以了」): a build is one line, its photo belongs on the
 * first piece, and the sibling compartments showing nothing is the design, not
 * a gap. Attaching to those rows is exactly the duplication
 * prune-duplicate-sofa-photos.mjs was written to undo.
 */
export function planRepoint(rows, liveKeys) {
  const lines = byLine(rows);
  const onDoc = new Map();
  for (const r of rows) {
    if (!onDoc.has(r.doc)) onDoc.set(r.doc, []);
    onDoc.get(r.doc).push(r);
  }
  const plan = [];
  for (const [lk, group] of lines) {
    const [doc, dtl] = [lk.slice(0, lk.lastIndexOf('|')), lk.slice(lk.lastIndexOf('|') + 1)];
    const shows = group.some((r) => (r.pics ?? []).some((k) => liveKeys.has(k) && acDtlKeyOf(k) === dtl));
    if (shows) continue;
    const found = new Set();
    for (const s of onDoc.get(doc) ?? []) {
      for (const k of s.pics ?? []) if (liveKeys.has(k) && acDtlKeyOf(k) === dtl) found.add(k);
    }
    if (!found.size) continue;                 // nothing on this document to point at
    const target = firstRow(group);
    const keys = [...found].filter((k) => !(target.pics ?? []).includes(k));
    if (!keys.length) continue;
    plan.push({ id: target.id, doc, dtl, code: target.itemCode, keys });
  }
  return plan;
}
