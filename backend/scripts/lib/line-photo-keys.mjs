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

import { isOneModel, modelsIn } from './one-model-group.mjs';

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
    /* THE GROUP MUST BE ONE PRODUCT — docs/bugs/0672 site 9.
       `(doc_no, DtlKey)` is NOT unique: migrations 0273 and 0280 index
       `linked_ac_dtlkey` non-uniquely, and probe-link-identity.mjs run
       34172468269 counted 310 shared keys on the sales-order lines (774 rows)
       and 106 on the purchase-order lines (275 rows) in production.

       `firstRow(group)` below is the owner's own sofa rule when the group is one
       build's compartments (2026-08-10, 「每个 SKU 的照片都一样,留第一个就可以
       了」). When it is not, it is a coin flip: the picture lands on whichever
       row sorted first, and nothing downstream can tell.

       The MODEL is the test, not the item code — a build's compartments
       deliberately carry DIFFERENT codes (MODEL-1S, MODEL-2S, MODEL-CNR), so
       comparing codes would refuse every sofa, which is the whole population
       this planner exists for. Measured: every shared key in production passes
       the model test today, so this refuses nothing now and refuses the first
       group that ever regresses. A row with no code at all also refuses: a blank
       cannot be asserted equal to anything. */
    if (!isOneModel(group, (r) => r.itemCode)) continue;
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

/**
 * ATTACH plan: an AutoCount line that shows NOTHING, whose photograph has since
 * been uploaded to R2 under the address the importer itself minted for it.
 *
 * ── IT MINTS NO KEY, AND THAT IS THE POINT ───────────────────────────────────
 * `planned` is the importer's OWN resolve output — the same `file -> key` list
 * `upload-line-photos-r2.mjs` consumes — so there is still exactly one answer to
 * "where does this photograph live". A second key generator here would be a
 * second answer, and the addresses already in production were built by the
 * first one.
 *
 * ── THE THREE REFUSALS, AND WHAT EACH ONE COSTS IF IT IS DROPPED ─────────────
 *  1. THE OBJECT MUST BE IN R2 (`liveKeys`). Dropping this is bug 0625 and bug
 *     0668 exactly: an address that names nothing, written onto a line, is
 *     invisible until an operator opens it and sees a broken picture. Measured
 *     2026-09-08 on the purchase side: of the 25 addresses a blanket
 *     `APPLY=1` would have written, 15 named objects R2 does not hold.
 *  2. THE LINE MUST SHOW NOTHING TODAY. This repair fills a BLANK line; it never
 *     adds a second address to a line that already displays. That is what keeps
 *     the owner's sofa rule intact (2026-08-10, 「每个 SKU 的照片都一样,留第一个
 *     就可以了」) and it is the guard that excludes all 15 above — every one of
 *     them sits on a line that already arrived.
 *  3. THE GROUP MUST BE ONE MODEL (`isOneModel`, docs/bugs/0672 and 0690).
 *     `(doc_no, DtlKey)` is not unique, so "the first row" only means something
 *     when the rows behind that key are one build's compartments. A row with no
 *     item code at all refuses too — a blank cannot be asserted equal.
 *
 * Everything refused is RETURNED, never dropped in silence: a repair that
 * quietly does less than it was asked reports success for the gap it left.
 *
 * @param rows      [{ id, doc, lineNo, dtl, itemCode, pics: string[] }]
 * @param planned   [{ key, doc, dtl }] — the importer's resolve output, parsed
 * @param liveKeys  Set of object keys that exist in R2, read at run time
 */
export function planAttachUploaded(rows, planned, liveKeys) {
  const lines = byLine(rows);
  /* The importer's plan, gathered per AutoCount line. Order is preserved: the
     `-1`/`-2` suffix of an address is the image's ordinal and the list is the
     book's own order. */
  const wanted = new Map();
  for (const p of planned) {
    const dtl = p.dtl ?? acDtlKeyOf(p.key);
    if (dtl === null) continue;
    const k = `${p.doc}|${dtl}`;
    if (!wanted.has(k)) wanted.set(k, []);
    wanted.get(k).push(p.key);
  }

  const plan = [];
  const skipped = [];
  for (const [lk, keys] of wanted) {
    const doc = lk.slice(0, lk.lastIndexOf('|'));
    const dtl = lk.slice(lk.lastIndexOf('|') + 1);
    const group = lines.get(lk);
    if (!group || !group.length) { skipped.push({ doc, dtl, why: 'no ERP row carries this AutoCount line' }); continue; }

    /* REFUSAL 2 — this line already shows its picture. */
    const shows = group.some((r) => (r.pics ?? []).some((k) => liveKeys.has(k) && acDtlKeyOf(k) === dtl));
    if (shows) { skipped.push({ doc, dtl, why: 'the line already shows a live address — not this repair to make' }); continue; }

    /* REFUSAL 3 — "the first row" needs the group to be one product. */
    if (!isOneModel(group, (r) => r.itemCode)) {
      skipped.push({ doc, dtl, why: `the rows behind this key are not one model (${modelsIn(group, (r) => r.itemCode).join(', ') || 'a row has no item code'})` });
      continue;
    }

    /* REFUSAL 1 — the object has to be in the bucket. */
    const live = keys.filter((k) => liveKeys.has(k));
    const dead = keys.filter((k) => !liveKeys.has(k));
    if (!live.length) { skipped.push({ doc, dtl, why: `R2 holds none of the ${keys.length} planned object(s) — upload them first` }); continue; }

    const target = firstRow(group);
    /* The address must name THIS target row, or the plan was computed against a
       different row layout than the one in front of us now. Refusing beats
       attaching an address whose embedded id disagrees with where it hangs. */
    const mine = live.filter((k) => rowIdOf(k) === target.id);
    const elsewhere = live.filter((k) => rowIdOf(k) !== target.id);
    if (elsewhere.length) {
      skipped.push({ doc, dtl, why: `${elsewhere.length} planned address(es) name a row that is not this line's first piece — re-run the importer's RESOLVE` });
    }
    const add = mine.filter((k) => !(target.pics ?? []).includes(k));
    if (!add.length) continue;
    plan.push({ id: target.id, doc, dtl, code: target.itemCode, keys: add, before: [...(target.pics ?? [])], dead });
  }
  return { plan, skipped };
}
