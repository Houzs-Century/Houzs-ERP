// ---------------------------------------------------------------------------
// ac-forced-line-pairing — decide WHICH AutoCount line each ERP row is, and
// refuse when the document cannot force the answer.
//
// THE OWNER'S QUESTION, 2026-09-08: 「为什么会这样行号不一样呢？一定要一样的啊？」
// The honest answer is that they are not DIFFERENT — the migration never copied
// AutoCount's line key onto the downstream documents at all. Migration 0280's
// own header says so: it added `linked_ac_dtlkey` to scm.grn_items,
// scm.delivery_order_items, scm.sales_invoice_items and
// scm.purchase_invoice_items, and "nothing backfills it: the keys are stamped
// forward". Measured on production the same day: 0 of 636 goods-receipt lines
// carry one.
//
// WHAT THE ABSENCE COSTS, both halves measured:
//   1. check-ac-erp-reconcile.mjs has to GUESS which of our rows answers which
//      of the book's, and it guessed wrong five separate times on 2026-09-07/08
//      — sofa colours on two delivery notes, ten bedframe dedications, two sofa
//      models, and 34 goods-receipt item codes. One of the five (the bedframes)
//      was genuinely wrong and would have made a customer's REGAL read READY
//      when a TRION arrived.
//   2. AcSyncService's /edit addresses a book row by `doc.EditDetail(dtlKey)`,
//      the only handle the 2.2 SDK exposes. With no key an edit of a migrated
//      goods receipt cannot name the line and is refused.
//
// ── WHY THIS IS NOT THE THIRD IMPLEMENTATION ───────────────────────────────
// Every decision this module needs already has a home, and it CALLS them:
//   · the sofa model, folded through SOFA_MODEL_ALIAS  -> item-code-class.mjs
//     (5535 is its own model and is NOT in that table — never fold it)
//   · what an ERP compartment code looks like          -> item-code-class.mjs
//   · the comparison form of a code                    -> ac-mapping-csv.mjs
//   · the AutoCount -> ERP sheet, read as RFC4180      -> ac-mapping-csv.mjs
// What is NEW here, and has no home yet, is the PAIRING: turning two bags of
// lines into an assignment, or into a refusal. `lib/keyless-multiset.mjs`
// (PR #3195, the 93-document lane) answers the neighbouring question — "are the
// two bags EQUAL" — which needs no assignment at all. This answers "which is
// which", and only where the document forces it.
//
// ── THE RULE, AND WHY EACH CLAUSE IS SAFE ──────────────────────────────────
// Lines are bucketed on (canonical item code, quantity). Then, per bucket:
//
//   n book lines, n ERP units, n == 1
//       Exactly one candidate on each side. The pairing is FORCED — there is no
//       other line it could be. Stamp.
//
//   n book lines, n ERP units, n > 1
//       Stamp, but ONLY when the n book lines are mutually identical on every
//       column the book states (unit price, sub-total, location, Desc2). Two
//       book rows that agree on all of those are INTERCHANGEABLE: whichever ERP
//       row receives whichever key, the row the write-back will edit is
//       indistinguishable from the one it "should" have edited. If they are not
//       mutually identical, we cannot tell them apart and nothing is stamped.
//
//   anything else
//       Not stamped. Counted and named, never guessed.
//
// NOTE WHAT IS *NOT* IN THE BUCKET KEY: the price, compared ACROSS the two
// sides. It cannot be, and saying why matters more than the omission. On a
// goods receipt `grn_items.unit_price_sen` is taken from the PURCHASE ORDER
// line by design (reshape-migrated-grns.mjs), and a migrated delivery order
// carries no money at all — so a book-vs-ERP price comparison would measure our
// own derivation, refuse nearly every document, and prove nothing. The price is
// therefore used the one way it is trustworthy: BOOK against BOOK, inside a
// bucket, as the tie-break above. That keeps the guarantee exactly as strong
// while costing no stamps to a difference we ourselves manufactured.
//
// A WRONG KEY IS STRICTLY WORSE THAN NO KEY. Migration 0273 states the
// consequence: AcSyncService APPENDS a line to the live account book instead of
// editing the one that changed. NULL means "create" and is refused loudly;
// wrong means "silently edit somebody else's line". Every refusal below is that
// trade being taken deliberately.
//
// PURE: rows in, a plan out. No filesystem, no database, no printing, no
// process.exit. The runner owns the I/O and the writes.
//
// NO SHEBANG: tests/acForcedLinePairing.test.mjs imports this module, and on
// Windows vitest inlines it, where a `#!` no longer at byte 0 is a load-time
// SyntaxError (see lib/ac-mapping-csv.mjs for the same reason).
// ---------------------------------------------------------------------------

import { modelOf, isCompartmentCode } from "./item-code-class.mjs";
import { normCode } from "./ac-mapping-csv.mjs";

/** The same /SOFA/ substring test check-ac-erp-reconcile.mjs:245 applies to the
 *  BOOK's own ItemCode. Deliberately loose — "AMN-SOFA PILLOW" takes this
 *  branch too — which is why a MODEL is required on both sides before anything
 *  folds, and an accessory whose name merely contains the word stays a plain
 *  code. */
export const isSofaCode = (s) => /SOFA/i.test(String(s ?? ""));

/** Quantities are float8 on the ERP side and decimal in the book. Bucketing on
 *  the raw double would split 1 from 1.0000000001; 4dp is finer than any
 *  quantity either system records and coarser than the noise. */
const qtyKey = (q) => (Number.isFinite(Number(q)) ? Number(Number(q).toFixed(4)) : 0);

/**
 * The key a line is compared under: its item code, or the SOFA MODEL when the
 * line is one sofa written the other system's way.
 *
 * @param {object} a
 * @param {string} a.code     the code in ERP terms (the book side must already
 *   be translated through the mapping sheet — this module never reads the CSV,
 *   because two readers of one file is the defect lib/ac-mapping-csv.mjs exists
 *   to record)
 * @param {string} [a.rawCode] the book's own untranslated ItemCode
 * @param {"book"|"erp"} a.side
 * @param {boolean} [a.suffixed] ERP side: the importer's own line_suffix flag
 * @returns {{key: string, model: string|null}}
 */
export function comparisonKey({ code, rawCode, side, suffixed = false }) {
  const c = normCode(code);
  if (!c) return { key: "", model: null };
  const looksSofa = side === "book" ? isSofaCode(rawCode ?? code) : Boolean(suffixed) || isCompartmentCode(c);
  const model = looksSofa ? modelOf(c) : null;
  return { key: model ? `SOFA ${model}` : c, model };
}

/**
 * Fold one document's ERP rows into UNITS — the things a book line can be.
 *
 * A plain row is one unit. Every compartment row of one sofa MODEL on one
 * document is ONE unit, because that is what the book holds: one line per sofa,
 * one ERP row per compartment. All of a unit's rows receive the SAME DtlKey,
 * which is what composeEdit requires — it treats a build whose compartments
 * disagree on the key as having no identity at all.
 *
 * THE FOLD RULE FOR QUANTITY IS `MIN`, the same choice lib/sofa-piece-fold.mjs
 * made and for the same reason: a whole sofa is only whole while every one of
 * its pieces is present. `ceiling` is the MAX. They differ only when the pieces
 * are uneven, and an uneven fold cannot state a quantity — so it must not be
 * allowed to state a pairing either. Such a unit is marked `uneven` and this
 * module refuses it.
 *
 * @param {Array<{id: string, code: string, qty: number, suffixed?: boolean}>} rows
 * @returns {Array<{key: string, ids: string[], qty: number, ceiling: number,
 *                  uneven: boolean, kind: "plain"|"sofa", codes: string[]}>}
 */
export function foldErpUnits(rows) {
  const units = [];
  /** `SOFA <model>` -> unit under construction */
  const sofas = new Map();
  for (const r of rows) {
    const { key, model } = comparisonKey({ code: r.code, side: "erp", suffixed: r.suffixed });
    if (!key) continue;
    if (!model) {
      units.push({
        key,
        ids: [String(r.id)],
        qty: qtyKey(r.qty),
        ceiling: qtyKey(r.qty),
        uneven: false,
        kind: "plain",
        codes: [normCode(r.code)],
      });
      continue;
    }
    if (!sofas.has(key)) sofas.set(key, { key, ids: [], pieces: new Map(), kind: "sofa" });
    const u = sofas.get(key);
    u.ids.push(String(r.id));
    const c = normCode(r.code);
    /* Compartment quantities are NOT summed: three pieces of one sofa are one
       sofa, not three. Two fabric VARIANTS of the same compartment in one build
       are still that build's one piece, so same-code rows sum before folding. */
    u.pieces.set(c, (u.pieces.get(c) ?? 0) + Number(r.qty ?? 0));
  }
  for (const u of sofas.values()) {
    const qs = [...u.pieces.values()].map(qtyKey);
    const lo = Math.min(...qs);
    const hi = Math.max(...qs);
    units.push({
      key: u.key,
      ids: u.ids,
      qty: lo,
      ceiling: hi,
      uneven: lo !== hi,
      kind: "sofa",
      codes: [...u.pieces.keys()],
    });
  }
  return units;
}

/** Every column the BOOK states about a line, as one string. Two book lines
 *  with the same fingerprint are interchangeable: nothing the book records
 *  separates them, so neither can the write-back. */
const bookFingerprint = (l) =>
  [l.unitPriceSen ?? "", l.subTotalSen ?? "", normCode(l.location ?? ""), String(l.desc2 ?? "").trim().toUpperCase()].join(
    "",
  );

/**
 * Pair ONE document.
 *
 * @param {object} a
 * @param {Array<{dtlKey: number|string, code: string, rawCode?: string, qty: number,
 *                unitPriceSen?: number|null, subTotalSen?: number|null,
 *                location?: string|null, desc2?: string|null}>} a.bookLines
 *   Book lines with their code ALREADY translated to ERP terms.
 * @param {Array<{id: string, code: string, qty: number, suffixed?: boolean,
 *                storedKey?: number|string|null}>} a.erpRows
 * @param {string} a.docNo  for the refusal messages
 * @returns {{stamps: Array<{id: string, dtlKey: number, key: string, forced: "unique"|"interchangeable"}>,
 *            refusals: Array<{key: string, reason: string, erpRows: number, bookLines: number}>,
 *            audits: Array<{id: string, stored: number, derived: number}>,
 *            blankBookRows: number}}
 */
export function pairDocument({ bookLines, erpRows, docNo }) {
  const stamps = [];
  const refusals = [];
  const audits = [];
  let blankBookRows = 0;

  /** bucket -> book lines */
  const bookBuckets = new Map();
  for (const l of bookLines) {
    const { key } = comparisonKey({ code: l.code, rawCode: l.rawCode, side: "book" });
    /* A book row with no item code is not a line the ERP can hold — see
       lib/ac-blank-book-row.mjs. It is counted, never paired, and never a
       refusal: the two sides AGREE about it. */
    if (!key) {
      blankBookRows += 1;
      continue;
    }
    const b = `${key} ${qtyKey(l.qty)}`;
    if (!bookBuckets.has(b)) bookBuckets.set(b, []);
    bookBuckets.get(b).push(l);
  }

  /** bucket -> ERP units */
  const erpBuckets = new Map();
  for (const u of foldErpUnits(erpRows)) {
    const b = `${u.key} ${u.qty}`;
    if (!erpBuckets.has(b)) erpBuckets.set(b, []);
    erpBuckets.get(b).push(u);
  }

  const storedById = new Map();
  for (const r of erpRows) if (r.storedKey != null && r.storedKey !== "") storedById.set(String(r.id), Number(r.storedKey));

  for (const [b, units] of erpBuckets) {
    const key = b.slice(0, b.indexOf(" "));
    const lines = bookBuckets.get(b) ?? [];

    const uneven = units.filter((u) => u.uneven);
    if (uneven.length) {
      refusals.push({
        key,
        reason:
          `our sofa compartments are uneven (${uneven
            .map((u) => `${u.codes.sort().join("+")} folds to between ${u.qty} and ${u.ceiling}`)
            .join("; ")}), so the fold cannot state how many sofas this is`,
        erpRows: units.reduce((s, u) => s + u.ids.length, 0),
        bookLines: lines.length,
      });
      continue;
    }
    if (lines.length === 0) {
      refusals.push({
        key,
        reason: "the book has no line of this item at this quantity on this document",
        erpRows: units.reduce((s, u) => s + u.ids.length, 0),
        bookLines: 0,
      });
      continue;
    }
    if (lines.length !== units.length) {
      refusals.push({
        key,
        reason: `the book has ${lines.length} such line(s), we have ${units.length} — not guessing which is which`,
        erpRows: units.reduce((s, u) => s + u.ids.length, 0),
        bookLines: lines.length,
      });
      continue;
    }

    let forced = "unique";
    if (units.length > 1) {
      const prints = new Set(lines.map(bookFingerprint));
      if (prints.size > 1) {
        refusals.push({
          key,
          reason:
            `the book has ${lines.length} lines of this item at this quantity and they are NOT identical ` +
            `(${prints.size} distinct price/location/Desc2 combinations), so which is which is unknowable`,
          erpRows: units.reduce((s, u) => s + u.ids.length, 0),
          bookLines: lines.length,
        });
        continue;
      }
      forced = "interchangeable";
    }

    /* Both sides in a stable order so a re-run derives the SAME assignment.
       Within an interchangeable bucket the order is arbitrary BY PROOF, not by
       luck — the book lines are identical on every column the book states. */
    const ls = [...lines].sort((x, y) => Number(x.dtlKey) - Number(y.dtlKey));
    const us = [...units].sort((x, y) => (x.ids[0] > y.ids[0] ? 1 : -1));
    us.forEach((u, i) => {
      const dtlKey = Number(ls[i].dtlKey);
      for (const id of u.ids) {
        const stored = storedById.get(id);
        if (stored != null) {
          /* Never overwritten. A stored key that DISAGREES is a live wrong
             value in a column the write-back dereferences, so it is reported
             rather than silently kept or silently replaced — the same rule
             lib/ac-line-key-audit.mjs states for the 275 purchase-order keys
             an earlier writer left behind. */
          if (stored !== dtlKey) audits.push({ id, stored, derived: dtlKey });
          continue;
        }
        stamps.push({ id, dtlKey, key: u.key, forced });
      }
    });
  }

  /* Book lines whose bucket the ERP has nothing in. Not a refusal to stamp —
     there is no row to stamp — but it is what a missing line looks like, so the
     caller can report it beside the reconcile's own line-count column. */
  const unmatchedBookLines = [];
  for (const [b, lines] of bookBuckets) {
    if (erpBuckets.has(b)) continue;
    unmatchedBookLines.push({ key: b.slice(0, b.indexOf(" ")), lines: lines.length });
  }

  return { stamps, refusals, audits, blankBookRows, unmatchedBookLines, docNo };
}

/**
 * Pair many documents and roll the counts up.
 *
 * @param {Map<string, Array>} bookByDoc  AutoCount doc key -> book lines
 * @param {Map<string, Array>} erpByDoc   the SAME doc key -> ERP rows
 * @returns {{stamps: Array, perDoc: Array, totals: object}}
 */
export function planLineKeys({ bookByDoc, erpByDoc }) {
  const stamps = [];
  const perDoc = [];
  const totals = {
    documents: 0,
    erpRows: 0,
    stampedRows: 0,
    alreadyKeyed: 0,
    refusedRows: 0,
    forcedUnique: 0,
    forcedInterchangeable: 0,
    disagreements: 0,
    blankBookRows: 0,
    documentsFullyStamped: 0,
    documentsNoBook: 0,
  };

  for (const [docNo, erpRows] of erpByDoc) {
    totals.documents += 1;
    totals.erpRows += erpRows.length;
    const already = erpRows.filter((r) => r.storedKey != null && r.storedKey !== "").length;
    totals.alreadyKeyed += already;

    const bookLines = bookByDoc.get(docNo);
    if (!bookLines) {
      /* The book does not state this document at all. Nothing to stamp and
         nothing to conclude from here — the reconcile's PRESENCE axis owns that
         question, and answering it twice is how the two drift. */
      totals.documentsNoBook += 1;
      totals.refusedRows += erpRows.length - already;
      perDoc.push({ docNo, stamped: 0, refused: erpRows.length - already, reasons: ["the book has no such document"] });
      continue;
    }

    const r = pairDocument({ bookLines, erpRows, docNo });
    stamps.push(...r.stamps);
    totals.stampedRows += r.stamps.length;
    totals.forcedUnique += r.stamps.filter((s) => s.forced === "unique").length;
    totals.forcedInterchangeable += r.stamps.filter((s) => s.forced === "interchangeable").length;
    totals.disagreements += r.audits.length;
    totals.blankBookRows += r.blankBookRows;
    /* EVERY row is exactly one of three things: already keyed, stamped now, or
       left unkeyed. Deriving the third by subtraction rather than by summing the
       refusal buckets is what makes the three add up to the denominator — a
       refused bucket can CONTAIN an already-keyed row, and summing the buckets
       counted that row twice. A report whose parts do not sum to its whole is
       the shape nobody can check. */
    const refused = erpRows.length - already - r.stamps.length;
    totals.refusedRows += refused;
    if (refused === 0) totals.documentsFullyStamped += 1;
    perDoc.push({
      docNo,
      stamped: r.stamps.length,
      refused,
      audits: r.audits,
      reasons: r.refusals.map((x) => `${x.key}: ${x.reason}`),
      unmatchedBookLines: r.unmatchedBookLines,
    });
  }

  return { stamps, perDoc, totals };
}
