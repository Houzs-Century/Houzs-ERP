/* so-verdict-derive — turn a reconcile RUN into a per-document verdict.
 *
 * The migrated-sales-order lock used to answer a question about ORIGIN. It now
 * answers one about CORRECTNESS: a migrated order is open when it MATCHES the
 * account book, and shut while it still differs. This module is where "still
 * differs" becomes a row per document.
 *
 * ── IT IS A RECORDER, NOT A SECOND COMPARISON ───────────────────────────────
 * Nothing here compares anything. check-ac-erp-reconcile.mjs already does that,
 * and its findings are what the owner reads; a SECOND implementation of
 * "different" is how two statements of one rule come to disagree while both
 * report on "the same" documents. That failure is written into that file's own
 * header twice — two CSV parsers for one sheet printed 40 wrong findings on
 * go-live morning (docs/bugs/0689), and two statements of the scope rule made a
 * checker measure a population no importer ever carried.
 *
 * So the reconcile CALLS this as it finds things, and this only tallies.
 *
 * ── A DOCUMENT MUST BE SEEN TO BE CLEAN ─────────────────────────────────────
 * `seen()` is not bookkeeping. Only a document the run actually COMPARED can
 * earn `clean`; a document that was never reached produces no row at all, and
 * the guard reads an absent row as `no-verdict-published`, which LOCKS. That is
 * the difference between "we checked it and it matches" and "we never looked",
 * and collapsing the two is the whole hazard this design exists to avoid.
 *
 * ── WHICH AXES LOCK, AND WHY THE OTHERS DO NOT ──────────────────────────────
 * LOCKING_AXES below is the whole answer, and every member is a difference the
 * reconcile's SUMMARY counts as work. The classes it leaves out are the ones
 * that file already prints under "NOT differences", each with a measurement
 * behind it rather than a label:
 *
 *   sofa decomposition   one book line is one ERP line PER COMPARTMENT, so line
 *                        count and per-line unit price are not commensurable.
 *                        The document TOTAL still has to match to the sen, and
 *                        it does — `document total` IS a locking axis.
 *   item translation     the same product written another way, via
 *                        data/autocount-erp-mapping-1561.csv.
 *   no-price             the BOOK states no unit price. Houzs prices a purchase
 *                        when the goods arrive; copying the book would ERASE a
 *                        real price (owner's 空白不覆盖 rule).
 *   book-blank variants  the ERP carries a value the book never stated. An
 *                        operator filled it in, which is allowed.
 *   ERP-blank on an order that is NOT proceeded — owner: 还没proceed还没确认的就
 *                        可以直接放空的.
 *   pend / recorded      the book says TBC/KIV; or the priced special is already
 *                        carried on the line under the owner's 2026-09-03 ruling
 *                        甲 - the factory sees the option and the document's
 *                        money did not move, so it is DECIDED work, not a
 *                        difference (see lib/variant-reconcile.mjs, which
 *                        owns that verdict). The jsonb key it lives under is
 *                        deliberately NOT spelled here: a tree scan in
 *                        backend/tests asserts that only display surfaces name
 *                        it, and a mention in this header would have to become
 *                        an exception in that scan. A check with an exception
 *                        in it is the shape this repo keeps paying for.
 *
 * Everything the reconcile could not ANSWER is a locking axis, not an absent
 * one. `sofa build not verifiable` is the live example: where a document's ERP
 * lines carry no AutoCount line key the compartments of one build cannot be
 * regrouped, so the reconcile says UNREADABLE rather than agreeing. "We could
 * not tell" is not "it matches", and the permissive answer must be unreachable
 * by a comparison that did not run.
 */

/** The axis names the guard may lock on. The reconcile's own vocabulary. */
export const LOCKING_AXES = Object.freeze([
  'line count',
  'item code',
  'quantity',
  'unit price',
  'document total',
  'currency',
  'a book line we do not have',
  'a line key on the wrong document',
  'lines could not be matched',
  'sofa build not verifiable',
  /* ── THE DOCUMENT CONVERSION CHAIN ─────────────────────────────────────────
   * The owner, 2026-09-08: 「然后transfer from和transfer to？」 — and until this
   * lane the answer was that the chain had never been an axis at all.
   * check-ac-erp-reconcile.mjs read `fromDocType` / `fromDocNo` /
   * `transferedQty` ONLY to decide SCOPE, so a line could point at the wrong
   * source document, or carry the wrong transferred quantity, and every report
   * would still have said the documents tally. One column carrying several
   * populations — this repo's own named class, found by the owner asking.
   *
   * `transfer from` is a wrong or missing parent link; `transfer to` is our
   * stored transfer counter disagreeing with AutoCount's own. The verdicts are
   * lib/transfer-chain-verdict.mjs's, which re-exports the counter rule from
   * lib/transfer-counter-verdict.mjs rather than restating it. */
  'transfer from',
  'transfer to',
  /* the variant axes, spelled exactly as lib/variant-reconcile.mjs labels them */
  'colour / fabric',
  'divan height',
  'gap',
  'leg height',
  'T.Heights',
  'seat size',
  'sofa compartments',
  'specials',
  /* THE CHAIN'S OWN "we could not tell". Separate from `transfer from` for the
   * same reason `sofa build not verifiable` is separate from `sofa
   * compartments`: our parent carries no AutoCount number, or the book states a
   * source LINE and our row has no line key to answer with. Neither is a wrong
   * link and neither is agreement, and folding it into either is how 110
   * documents came to be reported as clean on 2026-09-08 while nothing had
   * compared them. */
  'transfer chain not verifiable',
]);

const LOCKING = new Set(LOCKING_AXES);

/* ── THE AXES ON WHICH THE CHECKER REFUSED TO ANSWER ─────────────────────────
 * A locking axis, but NOT a difference: the two sides were never compared on
 * it, so calling the document "different" is as wrong as calling it "the same".
 * It locks — 「我们没看过」 must never open a document — and it is broken out by
 * check-so-tally.mjs into its own column so it cannot be summed into either
 * neighbour. On 2026-09-08 the same corpus was reported as "0 differ" and as
 * "8 differ" on the same day; the per-document verdict said 149, of which 110
 * were this. All three sentences were true about different axes, which is what
 * made none of them an answer.
 *
 * Membership is a property of the AXIS, not of a document: `sofa build not
 * verifiable` is recorded ONLY where variant-report set the compartment cell
 * to UNREADABLE, and it is recorded for no other reason. */
export const UNANSWERABLE_AXES = Object.freeze([
  'sofa build not verifiable',
  'transfer chain not verifiable',
]);

const UNANSWERABLE = new Set(UNANSWERABLE_AXES);
for (const a of UNANSWERABLE_AXES) {
  /* An unanswerable axis that does not LOCK would be a document opened on a
     comparison that never ran. Asserted at import so the two lists cannot drift
     apart in a later edit. */
  if (!LOCKING.has(a)) throw new Error(`UNANSWERABLE_AXES member ${a} is not in LOCKING_AXES`);
}

/** True when every finding on this row is the checker refusing to answer. */
export const isUnanswerableOnly = (axes) =>
  Array.isArray(axes) && axes.length > 0 && axes.every((a) => UNANSWERABLE.has(a));

/* ── THE NON-LOCKING CHANNEL ─────────────────────────────────────────────────
 * `note()` records the classes the reconcile prints as NOT differences —
 * bookblank, no-key, pend, recorded, an ERP blank on an order nobody has
 * proceeded, the sofa decomposition. None of them changes `clean`, and none of
 * them can: the two channels are separate Maps and only `record()` feeds the
 * lock.
 *
 * They are recorded at all because a declaration nobody can enumerate is a
 * suppression (docs/bugs/0668). The owner has asked three times whether the
 * sales orders tally; an answer that says "N differ" without also saying WHAT
 * WAS EXCLUDED AND UNDER WHOSE RULING is the answer he has already been given
 * twice and could not act on. */
export const NOTE_CLASSES = Object.freeze([
  /* the ERP states a value the book never did — an operator filled it in */
  'book-blank',
  /* the book says TBC/KIV */
  'pending',
  /* the priced special is carried under the owner's 2026-09-03 ruling 甲 */
  'recorded',
  /* our rows carry no book line number and both sides state the same set */
  'no-line-key',
  /* the ERP is blank on an order NOBODY HAS PROCEEDED — 还没proceed还没确认的就可以直接放空的 */
  'erp-blank-not-proceeded',
  /* one book line is one ERP line per compartment */
  'sofa-decomposition',
  /* AutoCount's own empty row */
  'blank-book-row',
  /* WHY a compartment answer was unanswerable — the sofa-unread-split bucket */
  'unanswerable-cause',
  /* A MIGRATED goods receipt carrying RM 0.00 — the owner, 2026-09-08:
     「GR 0 没关系」. PROVED per document by lib/ac-not-a-difference.mjs
     (`migrated_no_stock` and zero inventory movements), never assumed. */
  'erp-zero-money',
  /* THE BOOK ITSELF RECORDS NO SOURCE LINE ON THIS EDGE. `FromDocDtlKey` is
     NULL on every one of the ~220,000 rows of all six AutoCount detail tables,
     so a delivery, invoice or receipt states the source DOCUMENT and nothing
     finer. We agree on everything the book states — declared, counted, and
     never printed as though a LINE comparison had run. */
  'chain-line-not-in-book',
  /* the book raised this line from nothing — the head of a chain */
  'chain-no-source',
  /* the ERP stores NO onward counter on this edge, because it computes the
     answer live off the child rows every time it is asked. Nothing can drift,
     and the silence is declared rather than left to read as a measurement. */
  'chain-no-erp-counter',
]);

const NOTED = new Set(NOTE_CLASSES);

/**
 * Collects findings per (type, AutoCount document).
 *
 * `record` is a NO-OP for an axis outside LOCKING_AXES rather than a throw: the
 * reconcile calls it from inside its comparison loops, and this module must
 * never be able to take down the check the owner is reading. An axis nobody
 * declared shows up as a missing lock, which the CI test below catches, not as
 * a failed run at go-live. `note` is a NO-OP for an unknown class for the same
 * reason.
 */
export function makeVerdictRecorder() {
  /** type -> Map(acDocNo -> { erpNo, axes, proceededAxes, notes }) */
  const byType = new Map();
  /** type -> Map(presence class -> string[]) — DOCUMENT grain, no ERP row */
  const presenceByType = new Map();

  const bucket = (type) => {
    let m = byType.get(type);
    if (!m) { m = new Map(); byType.set(type, m); }
    return m;
  };
  const docOf = (type, acDocNo, erpNo) => {
    const m = bucket(type);
    let d = m.get(acDocNo);
    if (!d) {
      d = { erpNo: erpNo ?? null, axes: new Map(), proceededAxes: new Set(), notes: new Map() };
      m.set(acDocNo, d);
    }
    if (d.erpNo == null && erpNo != null) d.erpNo = erpNo;
    return d;
  };

  return {
    /** This document was COMPARED. Required before it can ever be clean. */
    seen(type, acDocNo, erpNo) { docOf(type, acDocNo, erpNo); },

    /**
     * This document differs on `axis`. `detail` is one line for a human.
     *
     * `proceeded` is the 6th argument and OPTIONAL on purpose: every existing
     * call site keeps its exact meaning, and only the ones that genuinely know
     * whether the order has been proceeded pass it. An omitted flag records
     * nothing rather than guessing `false` — the owner's blank rule turns on
     * that fact and a defaulted answer would decide it silently.
     */
    record(type, acDocNo, erpNo, axis, detail, proceeded) {
      if (!LOCKING.has(axis)) return;
      const d = docOf(type, acDocNo, erpNo);
      let lines = d.axes.get(axis);
      if (!lines) { lines = []; d.axes.set(axis, lines); }
      if (detail && lines.length < 5) lines.push(String(detail));
      if (proceeded === true) d.proceededAxes.add(axis);
    },

    /**
     * This document carries a DECLARED class on `axis`. Never locks, never
     * touches `clean`; counted and named so the reader can see what the verdict
     * excluded without having to trust that it excluded the right things.
     */
    note(type, acDocNo, erpNo, klass, axis, detail, proceeded) {
      if (!NOTED.has(klass)) return;
      const d = docOf(type, acDocNo, erpNo);
      let byAxis = d.notes.get(klass);
      if (!byAxis) { byAxis = new Map(); d.notes.set(klass, byAxis); }
      let cell = byAxis.get(axis);
      if (!cell) { cell = { n: 0, proceeded: 0, lines: [] }; byAxis.set(axis, cell); }
      cell.n += 1;
      if (proceeded === true) cell.proceeded += 1;
      if (detail && cell.lines.length < 5) cell.lines.push(String(detail));
    },

    /**
     * MOVE a finding from the locking channel to the note channel, because a
     * split that runs AFTER the document loop has ruled it is not a difference.
     *
     * ── WHY THIS EXISTS, AND WHY IT IS THE NARROWEST THING THAT WORKS ───────
     * Some of the owner's rulings cannot be applied inside the loop, because
     * they need EVIDENCE the loop has not gathered yet. 「GR 0 没关系」 is the
     * live case: a migrated goods receipt may carry RM 0.00, but only where the
     * run can PROVE the receipt is migrated paperwork — `migrated_no_stock`
     * with zero inventory movements — and that proof is a separate read,
     * classified by `splitErpZeroMoney` once the whole type has been walked.
     *
     * So the comparison records the money difference honestly, and the split
     * then reclassifies the ones the ruling covers. Without this, the ruling
     * reached the SUMMARY table and NOT the per-document verdict, and the goods
     * receipts read as 109 documents of work when 100 of them were the owner's
     * own decision. That is `docs/bugs/0715` exactly — a declared class counted
     * as work — with the arrow pointing the other way.
     *
     * ── IT CAN OPEN A DOCUMENT, SO IT IS FENCED ────────────────────────────
     * This is the ONLY method that can make a recorded document `clean`, which
     * makes it the only one that could wrongly open one. Three fences:
     *   - `klass` must be a declared NOTE class, so nothing can be dropped into
     *     a channel nobody enumerates;
     *   - it is a NO-OP unless that axis was actually recorded on that
     *     document, so it cannot invent a clean row for a document the run
     *     never compared;
     *   - the caller passes the split's OWN output, never a predicate of its
     *     own. The decision stays in one place; this only records it.
     */
    reclassify(type, acDocNo, axis, klass, detail) {
      if (!NOTED.has(klass)) return;
      const m = bucket(type);
      const d = m.get(acDocNo);
      if (!d || !d.axes.has(axis)) return;
      d.axes.delete(axis);
      d.proceededAxes.delete(axis);
      let byAxis = d.notes.get(klass);
      if (!byAxis) { byAxis = new Map(); d.notes.set(klass, byAxis); }
      let cell = byAxis.get(axis);
      if (!cell) { cell = { n: 0, proceeded: 0, lines: [] }; byAxis.set(axis, cell); }
      cell.n += 1;
      if (detail && cell.lines.length < 5) cell.lines.push(String(detail));
    },

    /**
     * A DOCUMENT-level fact about a document that has no ERP row to attach to —
     * absent, phantom, decided. It cannot go through `record`, which is keyed on
     * a comparison that happened.
     */
    presence(type, klass, docNo) {
      let m = presenceByType.get(type);
      if (!m) { m = new Map(); presenceByType.set(type, m); }
      let list = m.get(klass);
      if (!list) { list = []; m.set(klass, list); }
      list.push(String(docNo));
    },

    /** Everything recorded for one document type. */
    forType(type) { return bucket(type); },

    /** The document-level facts for one type, as a plain object. */
    presenceFor(type) {
      const m = presenceByType.get(type) || new Map();
      return Object.fromEntries([...m.entries()].map(([k, v]) => [k, v]));
    },
  };
}

/**
 * The rows to publish, for ONE document type.
 *
 * A document with no ERP number produces NO ROW. The verdict table is keyed on
 * the ERP document number because that is what the guard has in its hand and
 * what the salesperson sees; a finding we cannot attribute to an ERP document
 * is not a verdict about one, and inventing a key would be the only way for a
 * wrong row to open a document.
 */
export function buildVerdictRows({ recorder, type, companyId, measuredAt, runId }) {
  const rows = [];
  for (const [acDocNo, d] of recorder.forType(type)) {
    if (!d.erpNo) continue;
    const axes = [...d.axes.keys()].sort();
    const detail = axes.length
      ? axes.map((a) => `${a}: ${(d.axes.get(a) || []).join(' | ')}`).join('\n')
      : null;
    rows.push({
      doc_no: String(d.erpNo),
      company_id: companyId,
      ac_doc_no: acDocNo,
      /* UNCHANGED, and it must stay unchanged: this is the column the migrated
         sales-order guard reads, and the columns added below are for the report
         the owner reads. An unanswerable axis is still NOT clean. */
      clean: axes.length === 0,
      axes,
      detail,
      /* which of those axes had at least one finding on a PROCEEDED order */
      axes_proceeded: axes.filter((a) => d.proceededAxes.has(a)),
      /* the DECLARED classes, counted and named. Never affects `clean`. */
      notes: Object.fromEntries(
        [...d.notes.entries()].map(([klass, byAxis]) => [
          klass,
          Object.fromEntries(
            [...byAxis.entries()].map(([axis, cell]) => [axis, { n: cell.n, proceeded: cell.proceeded, lines: cell.lines }]),
          ),
        ]),
      ),
      measured_at: measuredAt,
      run_id: runId,
    });
  }
  rows.sort((a, b) => (a.doc_no < b.doc_no ? -1 : a.doc_no > b.doc_no ? 1 : 0));
  return rows;
}

/** Counts for the run row and for the operator reading the log. */
export function summariseVerdict(rows) {
  const perAxis = new Map();
  let clean = 0;
  for (const r of rows) {
    if (r.clean) { clean++; continue; }
    for (const a of r.axes) perAxis.set(a, (perAxis.get(a) ?? 0) + 1);
  }
  return {
    docCount: rows.length,
    cleanCount: clean,
    differCount: rows.length - clean,
    /** documents touched per axis, descending — NOT findings */
    perAxis: [...perAxis.entries()].sort((a, b) => b[1] - a[1]),
  };
}
