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
//   · the key a line is compared under, sofa fold and all -> keyless-multiset.mjs
//     `comparisonKey`, which is also what `bagOf` there uses. The two MUST
//     canonicalise a line identically or the bag that calls a document clean and
//     the pairing that stamps its keys would describe different lines.
//   · the sofa model, folded through SOFA_MODEL_ALIAS  -> item-code-class.mjs
//     (5535 is its own model and is NOT in that table — never fold it)
//   · the comparison form of a code                    -> ac-mapping-csv.mjs
//   · the AutoCount -> ERP sheet, read as RFC4180      -> ac-mapping-csv.mjs
// What is NEW here, and has no home yet, is the PAIRING: turning two bags of
// lines into an assignment, or into a refusal. `lib/keyless-multiset.mjs`
// (#3195, the 93-document lane) answers the neighbouring question — "are the
// two bags EQUAL" — which needs no assignment at all. This answers "which is
// which", and only where the document forces it. Ideally these keys land and
// that lane then verifies WITH them instead of around them.
//
// ── THE RULE, AND WHY EACH CLAUSE IS SAFE ──────────────────────────────────
// Lines are bucketed on (canonical item code, quantity) — and, on a document
// where BOTH sides state a source for EVERY line, on the source document too.
// See `pairDocument`'s partition comment: an invoice's lines name the delivery
// order / goods receipt they were raised from (`IVDTL.FromDocNo` /
// `PIDTL.FromDocNo`), which is the book's own key and the only thing that tells
// apart two identical lines the migration carried only one of. It is
// all-or-nothing per document, so the goods-receipt and delivery-order lanes —
// which pass no source at all — are bit-for-bit what they were.
//
// Then, per bucket:
//
//   n book lines, n ERP units, n == 1
//       Exactly one candidate on each side. The pairing is FORCED — there is no
//       other line it could be. Stamp.
//
//   n book lines, n ERP units, n > 1, and the BUILD TEXTS match one-to-one
//       Stamp by that text. Each unit carries the Desc2 its rows were imported
//       with and each book line states its own; where the two sets are equal
//       after normalisation and the match is a perfect bijection, which line a
//       unit is is not a choice at all. Anything short of a bijection — a unit
//       matching two lines, a line claimed by two units, a missing text on
//       either side — falls through to the next clause.
//
//   n book lines, n ERP units, n > 1, texts do NOT decide it
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

import { normCode } from "./ac-mapping-csv.mjs";
import { comparisonKey } from "./keyless-multiset.mjs";
import { normaliseDesc2 } from "./sofa-desc2-match.mjs";

export { comparisonKey };

/** Quantities are float8 on the ERP side and decimal in the book. Bucketing on
 *  the raw double would split 1 from 1.0000000001; 4dp is finer than any
 *  quantity either system records and coarser than the noise. */
const qtyKey = (q) => (Number.isFinite(Number(q)) ? Number(Number(q).toFixed(4)) : 0);

/* The bucket a line falls in: its comparison key and its quantity, joined.
   JSON.stringify, not a hand-picked separator — an item code legitimately
   CONTAINS spaces ("DSL-8030 SOFA") and hyphens, so any literal delimiter is
   either ambiguous or has to be a control character, and a raw one of those in
   source is what tests/noNulBytesInSource.test.mjs exists to refuse. The key is
   carried BESIDE the bucket rather than parsed back out of it, so nothing ever
   has to un-join this string. */
const bucketOf = (key, qty, sourceDoc = null) => JSON.stringify([key, qtyKey(qty), sourceDoc]);

/** A source document number, or null. Blank and absent are the SAME answer —
 *  "the book states no source here" — and both must switch the partition off
 *  rather than becoming a bucket everything sourceless falls into together. */
const srcOf = (v) => {
  const s = v == null ? "" : String(v).trim();
  return s === "" ? null : s;
};

/**
 * WHICH of our line's parents the book means.
 *
 * An ERP invoice line reaches TWO documents — a sales invoice line knows its
 * delivery order AND the sales order behind it, a purchase invoice line knows
 * its goods receipt AND that receipt's purchase order — because the BOOK writes
 * both edges: `IVDTL.FromDocNo` names a delivery order on most lines and a
 * sales order on 169 of them, and `PIDTL.FromDocNo` a receipt on most and an
 * order on the rest (lib/ac-transfer-chain-run.mjs states the same two-parent
 * shape for the same reason).
 *
 * The book names exactly ONE per line, so the book's own list for that invoice
 * decides which of ours answers. Preferring one join over the other instead
 * would silently bucket a direct invoice's line under a delivery order the book
 * never mentioned — a pairing built on our join order, which is position
 * matching wearing a link's clothes (docs/bugs/0690).
 *
 * Exactly one candidate in the book's list, or null. Both means the invoice
 * bills the receipt AND the order behind it and this row does not say which;
 * null switches the partition off for the whole document and the older, coarser
 * rule stands — the cheap outcome.
 *
 * @param {Array<string|null|undefined>} candidates  our line's parents
 * @param {Set<string>} bookSources  every FromDocNo the book states on this document
 * @returns {string|null}
 */
export function resolveErpSource(candidates, bookSources) {
  const inBook = [...new Set((candidates || []).map(srcOf).filter(Boolean))].filter((c) => bookSources.has(c));
  return inBook.length === 1 ? inBook[0] : null;
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
 * ── WHEN ONE MODEL ON ONE DOCUMENT IS TWO SOFAS ────────────────────────────
 * Folding every compartment of a model into ONE unit is right until the
 * customer bought two of that model. Measured on production 2026-09-08 (plan
 * run 34209494838): 25 of the 44 refused sales orders were refused for exactly
 * that — "the book has 2 such line(s), we have 1" — by ARITHMETIC, not by
 * ambiguity. The book holds two lines; we hold one folded unit; the counts
 * cannot agree however clear the data is.
 *
 * The build text separates them, and it is the ONLY thing that does. Where
 * every compartment row of a model on a document carries a non-empty
 * `desc2` — the build the ERP stored when the line was imported — the rows are
 * grouped by it, so two builds ordered with different text become two units.
 * `normaliseDesc2` is the comparison form, taken from lib/sofa-desc2-match.mjs
 * rather than written again: that module's own header records the day a plain
 * `includes` dropped seven owner-approved builds because one side wrote a
 * newline and the other wrote the two characters backslash-n.
 *
 * IT ONLY EVER SPLITS ON EVIDENCE. If ANY row of that model lacks a build text
 * the model folds as before — a partial split would invent a build boundary out
 * of a blank column. And a split alone stamps nothing: `pairDocument` still has
 * to match each unit to a book line, and does that by the SAME text, exactly.
 * Callers that pass no `desc2` (the goods-receipt and delivery-order lanes) are
 * bit-for-bit unaffected, which is what their own tests pin.
 *
 * @param {Array<{id: string, code: string, qty: number, suffixed?: boolean,
 *                desc2?: string|null}>} rows
 * @returns {Array<{key: string, ids: string[], qty: number, ceiling: number,
 *                  uneven: boolean, kind: "plain"|"sofa", codes: string[],
 *                  desc2: string|null}>}
 */
export function foldErpUnits(rows) {
  const units = [];
  /** `SOFA <model>` -> unit under construction */
  const sofas = new Map();
  /* Every model's build texts, before anything is grouped: the split may only
     happen when EVERY row of that model states one. */
  const textsByModel = new Map();
  for (const r of rows) {
    const { key, model } = comparisonKey({ code: r.code, side: "erp", suffixed: r.suffixed });
    if (!key || !model) continue;
    if (!textsByModel.has(key)) textsByModel.set(key, []);
    textsByModel.get(key).push(normaliseDesc2(r.desc2));
  }
  const splits = new Set();
  for (const [key, texts] of textsByModel) {
    if (texts.every((t) => t !== "") && new Set(texts).size > 1) splits.add(key);
  }

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
        desc2: null,
        sourceDoc: srcOf(r.sourceDoc),
      });
      continue;
    }
    const text = normaliseDesc2(r.desc2);
    const group = splits.has(key) ? `${key}${text}` : key;
    if (!sofas.has(group)) sofas.set(group, { key, ids: [], pieces: new Map(), sources: new Set(), kind: "sofa", desc2: splits.has(key) ? text : null });
    const u = sofas.get(group);
    u.ids.push(String(r.id));
    u.sources.add(srcOf(r.sourceDoc));
    const c = normCode(r.code);
    /* Compartment quantities are NOT summed: three pieces of one sofa are one
       sofa, not three. Two fabric VARIANTS of the same compartment in one build
       are still that build's one piece, so same-code rows sum before folding. */
    u.pieces.set(c, (u.pieces.get(c) ?? 0) + Number(r.qty ?? 0));
  }
  for (const u of sofas.values()) {
    /* Sorted so `ids[0]` is the same row whatever order the database handed the
       compartments back in. The pairing sorts units by it, and a plan that
       depends on an unordered SELECT is not reproducible — which is exactly the
       flaw backfill-ac-line-keys.mjs's retired purchase-order half had, where
       the zip ordered by a `line_no` it selected as NULL. */
    u.ids.sort();
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
      desc2: u.desc2,
      /* A fold that cannot state ONE source must not be allowed to state a
         pairing either — the same argument `uneven` makes about quantity. Two
         compartments raised from different deliveries leave the unit sourceless,
         which switches the partition off for the whole document. */
      sourceDoc: u.sources.size === 1 ? [...u.sources][0] : null,
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
 * @returns {{stamps: Array<{id: string, dtlKey: number, key: string, forced: "unique"|"interchangeable"|"build text"}>,
 *            refusals: Array<{key: string, reason: string, erpRows: number, bookLines: number}>,
 *            audits: Array<{id: string, stored: number, derived: number}>,
 *            blankBookRows: number}}
 */
export function pairDocument({ bookLines, erpRows, docNo }) {
  const stamps = [];
  const refusals = [];
  const audits = [];
  let blankBookRows = 0;

  /* The coded book lines, keyed once. A book row with no item code is not a
     line the ERP can hold — see lib/ac-blank-book-row.mjs. It is counted, never
     paired, and never a refusal: the two sides AGREE about it. */
  const coded = [];
  for (const l of bookLines) {
    const { key } = comparisonKey({ code: l.code, rawCode: l.rawCode, side: "book" });
    if (!key) {
      blankBookRows += 1;
      continue;
    }
    coded.push({ l, key });
  }
  const allUnits = foldErpUnits(erpRows);

  /* ── THE SOURCE-DOCUMENT PARTITION ────────────────────────────────────────
     A migrated INVOICE holds a deliberate SUBSET of the book's lines: the
     migration carried the OUTSTANDING population, so 131 of 192 in-scope
     purchase invoices bill at least one line whose purchase order was never
     carried (lib/ac-chain-line-grain.mjs). Bucketed on (item, quantity) alone
     that reads as ambiguity — "the book has 2 such lines, we have 1" — and the
     line is refused for a reason that is SCOPE, not doubt.

     The book states the discriminator itself: `IVDTL.FromDocNo` /
     `PIDTL.FromDocNo` name the delivery order / goods receipt each invoice line
     was raised from, and our own row knows which of ours it came from. So the
     bucket becomes (source document, item, quantity) and the pairing is still
     the book's own key — never a position, never a resemblance.

     ALL-OR-NOTHING PER DOCUMENT, on purpose. If either side leaves ONE row's
     source unstated the partition is off and the rule is exactly what it was:
     a sourceless row must not fall into a shared "" bucket with every other
     sourceless row, which would pair lines the book never linked. The
     goods-receipt and delivery-order lanes pass no source at all and are
     therefore bit-for-bit unaffected — pinned in tests/acForcedLinePairing. */
  const partition =
    coded.length > 0 &&
    allUnits.length > 0 &&
    coded.every(({ l }) => srcOf(l.sourceDoc)) &&
    allUnits.every((u) => srcOf(u.sourceDoc));

  /** bucket -> book lines */
  const bookBuckets = new Map();
  /* The SAME lines bucketed WITHOUT the source, so a stamp can say honestly
     whether the source document is what narrowed it or whether the bucket held
     one candidate all along. */
  const bookBucketsNoSrc = new Map();
  for (const { l, key } of coded) {
    const b = bucketOf(key, l.qty, partition ? srcOf(l.sourceDoc) : null);
    if (!bookBuckets.has(b)) bookBuckets.set(b, { key, lines: [] });
    bookBuckets.get(b).lines.push(l);
    const nb = bucketOf(key, l.qty, null);
    bookBucketsNoSrc.set(nb, (bookBucketsNoSrc.get(nb) ?? 0) + 1);
  }

  /** bucket -> ERP units */
  const erpBuckets = new Map();
  for (const u of allUnits) {
    const b = bucketOf(u.key, u.qty, partition ? srcOf(u.sourceDoc) : null);
    if (!erpBuckets.has(b)) erpBuckets.set(b, { key: u.key, qty: u.qty, units: [] });
    erpBuckets.get(b).units.push(u);
  }

  const storedById = new Map();
  for (const r of erpRows) if (r.storedKey != null && r.storedKey !== "") storedById.set(String(r.id), Number(r.storedKey));

  for (const [b, { key, qty, units }] of erpBuckets) {
    const lines = bookBuckets.get(b)?.lines ?? [];
    /* Did the source document do the narrowing? Only if the source-agnostic
       bucket held MORE candidates than this one. Saying so where it is not true
       would credit the partition with stamps it did not earn. */
    const narrowedBySource = partition && (bookBucketsNoSrc.get(bucketOf(key, qty, null)) ?? 0) > lines.length;

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
      /* WHY THE BUILD TEXTS ARE NAMED IN THE REFUSAL. This is the bucket where
         one model on one document is really two sofas, and the only thing that
         can tell them apart is the text they were ordered with. Saying how many
         distinct texts our rows carry turns "not guessing" into a measurement
         the next reader can act on: 1 means the ERP genuinely cannot separate
         them, 0 means nothing was stored, and N>1 with the counts still wrong
         means the split ran and the book still disagrees. */
      const texts = new Set(units.map((u) => u.desc2).filter((t) => t));
      refusals.push({
        key,
        reason:
          `the book has ${lines.length} such line(s), we have ${units.length} — not guessing which is which ` +
          `(our rows carry ${texts.size} distinct build text(s))`,
        erpRows: units.reduce((s, u) => s + u.ids.length, 0),
        bookLines: lines.length,
      });
      continue;
    }

    let forced = narrowedBySource ? "source document" : "unique";
    /* Both sides in a stable order so a re-run derives the SAME assignment. */
    let ls = [...lines].sort((x, y) => Number(x.dtlKey) - Number(y.dtlKey));
    let us = [...units].sort((x, y) => (x.ids[0] > y.ids[0] ? 1 : -1));

    if (units.length > 1) {
      /* ── THE BUILD TEXT, WHERE BOTH SIDES STATE ONE ───────────────────────
         Two sofas of one model are two book lines and, once foldErpUnits has
         split them, two units. Which is which is then not a choice: each unit
         carries the build text its rows were imported with, and it is matched
         to the book line stating the SAME text. Exact equality after
         normalisation, and a perfect bijection or nothing — a unit that matches
         two lines, or a line matched by two units, is refused with everything
         else in the bucket. This is an identity, not a resemblance: `2+C+2NA+C
         TABLE(28'INCH)` and `C TABLE(W)+2(28'INCH)` share a document
         (HC-SO-013164) and must keep on not seeing each other. */
      const byText = new Map();
      for (const l of ls) {
        const t = normaliseDesc2(l.desc2);
        if (!t) continue;
        if (!byText.has(t)) byText.set(t, []);
        byText.get(t).push(l);
      }
      const matched = us.map((u) => (u.desc2 ? byText.get(u.desc2) ?? [] : []));
      const bijection =
        us.every((u, i) => u.desc2 && matched[i].length === 1) &&
        new Set(matched.map((m) => m[0].dtlKey)).size === us.length;
      if (bijection) {
        ls = matched.map((m) => m[0]);
        forced = "build text";
      } else {
        const prints = new Set(lines.map(bookFingerprint));
        if (prints.size > 1) {
          refusals.push({
            key,
            reason:
              `the book has ${lines.length} lines of this item at this quantity and they are NOT identical ` +
              `(${prints.size} distinct price/location/Desc2 combinations), and the build texts do not match ` +
              "one-to-one either, so which is which is unknowable",
            erpRows: units.reduce((s, u) => s + u.ids.length, 0),
            bookLines: lines.length,
          });
          continue;
        }
        /* Interchangeable: the book lines are identical on every column the
           book states, so the arbitrary order is arbitrary BY PROOF, not by
           luck — whichever row receives whichever key, the line the write-back
           edits is indistinguishable from the one it "should" have edited. */
        forced = "interchangeable";
      }
    }

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
  for (const [b, { key, lines }] of bookBuckets) {
    if (erpBuckets.has(b)) continue;
    unmatchedBookLines.push({ key, lines: lines.length });
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
    forcedBuildText: 0,
    forcedSourceDoc: 0,
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
    totals.forcedBuildText += r.stamps.filter((s) => s.forced === "build text").length;
    totals.forcedSourceDoc += r.stamps.filter((s) => s.forced === "source document").length;
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
