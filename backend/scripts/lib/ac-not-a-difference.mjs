/* ac-not-a-difference — the counts in the reconcile SUMMARY that are NOT
 * differences, and the PROOF each one must produce before it is allowed to
 * leave a column headed "differ".
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * The owner reads the summary table and asks about every non-zero cell. Three
 * of them were never differences at all:
 *
 *   PO price   241  the BOOK states no price on those lines. Houzs prices a
 *                   purchase when the goods arrive, so 10,810 of 18,890 book
 *                   purchase-order lines carry UnitPrice 0.00 and 7,591 of
 *                   9,416 purchase orders total RM 0.00. Copying the book would
 *                   ERASE 241 real ERP prices. "Price differs" is the wrong
 *                   sentence; "the book states no price" is the right one.
 *   GR money   100  our goods receipt carries RM 0.00 where the book states a
 *                   value. The owner ruled 2026-09-08: 「GR 0 没关系」. It moves
 *                   no stock, no cost and no MRP.
 *   PO absent    1  PO-009979, whose only line is description-only. The owner
 *                   ruled to mint an accessory for it first. A decided item
 *                   awaiting execution is not an unexplained gap.
 *
 * A number that is correct-by-design sitting under a heading that says
 * "difference" is a false alarm the owner has to re-ask about every single
 * time, and he has. Reclassifying is NOT hiding: every count below keeps its
 * own labelled column, its own sentence, and its own examples.
 *
 * ── THE RULE THIS FILE IS BUILT AROUND ──────────────────────────────────────
 * The failure mode of a "benign" bucket is that a REAL difference falls into
 * it and stops being counted. That has already happened here, twice, in the
 * opposite direction and in this direction:
 *
 *   docs/bugs/0668-the-reconcile-printed-real-gaps-as-owner-decisions-for-do-iv
 *     — a hand-typed `absenceIs: "DECISION"` printed 30 real gaps as decisions
 *       nobody had made. The fix was to DERIVE the label (`decisionHolds`
 *       requires the constant AND an empty population) rather than trust it.
 *   docs/bugs/0665 — an exchange rate read as a discount, because a foreign
 *       document was scored in the money column. The fix gave it its OWN
 *       column instead of folding it anywhere.
 *
 * So every classifier here obeys three rules, and they are enforced in code,
 * not in this comment:
 *
 *   1. A COUNT IS NEVER LOST. Each split asserts `benign + differ === total`
 *      and THROWS if it does not. A silent shortfall is the whole risk.
 *   2. A BENIGN LABEL IS DERIVED FROM A MEASUREMENT, never from a constant
 *      alone. The constant says WHICH rows may claim the label; a measured
 *      predicate says whether the claim holds for each row. A row that claims
 *      it and fails it is reported LOUDER than an ordinary difference, because
 *      a document dressed as a decision is one nobody goes and looks at.
 *   3. WHEN THE PROOF IS UNAVAILABLE, NOTHING MOVES. No probe, no column: the
 *      count stays where it was and the run says why. A verdict computed over
 *      nothing must never read as a pass.
 *
 * READ-ONLY and dependency-free: pure functions over values the caller already
 * has. No database, no filesystem, no network.
 */

/** Assert a split lost nothing. Throwing is correct: a shortfall here is a
 *  coding defect in the classifier, not a property of the data, and the one
 *  outcome this file may never produce is a quietly smaller number. */
function preserveTotal(what, total, parts) {
  const sum = Object.values(parts).reduce((a, n) => a + n, 0);
  if (sum !== total) {
    throw new Error(
      `ac-not-a-difference: ${what} split lost a count — ${total} in, ` +
        `${Object.entries(parts).map(([k, n]) => `${k} ${n}`).join(" + ")} = ${sum} out. ` +
        "A reclassification that does not preserve the total is hiding a difference.",
    );
  }
}

/* ── 1. UNIT PRICE: the book states none ─────────────────────────────────── */

/**
 * Split the unit-price differences into the ones that are copy jobs and the
 * ones where the book simply holds no price.
 *
 * The caller has already bucketed them — `bookUnpriced` (book 0.00 with a 0.00
 * line subtotal, ERP priced), `bothPriced`, `erpDropped` (book priced, ERP
 * 0.00) and `bookDropped`. `bookDropped` is the EXPORT SELF-CHECK: the book
 * states a line SubTotal while its UnitPrice is zero, which is what a transport
 * that lost the price looks like. Measured over the whole book on 2026-09-07
 * (18,890 PODTL rows read directly over sqlcmd): 10,810 rows have UnitPrice 0
 * and the SAME 10,810 have SubTotal 0, so this bucket is expected to stay empty.
 *
 * If it is NOT empty the export is lying, and then `bookUnpriced` cannot be
 * trusted either — so NOTHING is reclassified and the whole count stays in the
 * difference column. That is rule 3 above, and it is the only branch here that
 * matters: it is the difference between a column that is honest and a column
 * that is convenient.
 *
 * @param {{bookUnpriced:unknown[],bothPriced:unknown[],erpDropped:unknown[],bookDropped:unknown[]}} P
 * @returns {{noPrice:number,differ:number,trusted:boolean,why:string}}
 */
export function splitBookUnpriced(P) {
  const total = P.bookUnpriced.length + P.bothPriced.length + P.erpDropped.length + P.bookDropped.length;
  if (P.bookDropped.length) {
    preserveTotal("unit price (untrusted)", total, { noPrice: 0, differ: total });
    return {
      noPrice: 0,
      differ: total,
      trusted: false,
      why:
        `the export self-check FIRED: ${P.bookDropped.length} line(s) state a SubTotal while their UnitPrice ` +
        "is zero, which is what a lost price looks like. While that is non-zero the `book holds NO price` " +
        "bucket cannot be told apart from an export failure, so NOTHING is reclassified and all " +
        `${total} stay counted as differences.`,
    };
  }
  const parts = { noPrice: P.bookUnpriced.length, differ: P.bothPriced.length + P.erpDropped.length };
  preserveTotal("unit price", total, parts);
  return {
    ...parts,
    trusted: true,
    why:
      "the export self-check is clean (0 lines state a SubTotal over a zero UnitPrice), so a zero unit price " +
      "in the book IS the book's own statement and not a transport failure",
  };
}

/* ── 2. DOCUMENT TOTAL: our document carries RM 0.00 ─────────────────────── */

/**
 * Split the document-total differences into real money differences and the
 * ones the owner has already ruled on.
 *
 * THE SHAPE ALONE IS NOT ENOUGH, and that is the entire design. "ERP total is
 * zero" also describes a NEW, typed goods receipt whose money was lost — which
 * would be a serious defect and would be swallowed by a shape-only rule. So a
 * row leaves the money column only when all three hold:
 *
 *   a. the type DECLARES the decision (`decision` non-null — configured per
 *      type, so it can never leak to a type the owner never ruled on),
 *   b. the row's shape is exactly `ERP 0 while the book states a value`,
 *   c. the PROOF says this document is migrated paperwork: `migrated_no_stock`
 *      is true AND no inventory movement names it.
 *
 * A row that satisfies (a) and (b) but fails (c) is returned in `impostors`,
 * stays counted as a difference, and the caller prints it loudly. A row with no
 * proof entry at all is an impostor too — an absent measurement is not a pass.
 *
 * @param {{rows:{key:string,erpNo:string,bookSen:number|null,erpSen:number|null,line:string}[],
 *          decision:{label:string,ruling:string,consequence:string}|null,
 *          proof:Map<string,{migratedNoStock:boolean,movements:number}>|null}} args
 * @returns {{erpZero:number,differ:number,moved:object[],impostors:{line:string,why:string}[],
 *            applied:boolean,why:string}}
 */
export function splitErpZeroMoney({ rows, decision, proof }) {
  const total = rows.length;
  const none = (why) => {
    preserveTotal("document total (not applied)", total, { erpZero: 0, differ: total });
    return { erpZero: 0, differ: total, moved: [], impostors: [], applied: false, why };
  };
  if (!decision) return none("this type declares no owner decision about a zero ERP total, so every difference is a difference");
  if (!proof) {
    return none(
      `${decision.label} is DECLARED for this type but its proof could not be read from the ERP ` +
        "(the migrated-paperwork columns did not answer). Nothing is reclassified: an unproven decision " +
        "is not a decision.",
    );
  }

  const moved = [];
  const impostors = [];
  for (const r of rows) {
    const shape = Number(r.erpSen ?? 0) === 0 && Number(r.bookSen ?? 0) !== 0;
    if (!shape) continue;
    const p = proof.get(r.erpNo);
    if (!p) {
      impostors.push({ line: r.line, why: `no migrated-paperwork row for ERP ${r.erpNo} — unproven, counted as a difference` });
    } else if (p.migratedNoStock !== true) {
      impostors.push({ line: r.line, why: `ERP ${r.erpNo} is NOT migrated paperwork (migrated_no_stock is not true) — it is a live document with no money` });
    } else if (p.movements !== 0) {
      impostors.push({ line: r.line, why: `ERP ${r.erpNo} has ${p.movements} inventory movement(s) — it MOVED STOCK, so 「${decision.label}」 does not cover it` });
    } else {
      moved.push(r);
    }
  }
  const parts = { erpZero: moved.length, differ: total - moved.length };
  preserveTotal("document total", total, parts);
  return {
    ...parts,
    moved,
    impostors,
    applied: true,
    why: decision.ruling,
  };
}

/* ── 3. ABSENCE: the owner has already ruled what to do ──────────────────── */

/* THE REGISTER. One entry per in-scope document the owner has decided about but
 * which has not been executed yet. It is deliberately small, deliberately
 * per-DOCUMENT, and every entry is printed BY NAME on every run — the owner's
 * instruction was "keep it visible until it is done", not "stop counting it".
 *
 * `requires` names a predicate below that must MEASURE true against the book
 * snapshot before the entry may be honoured. That is the 0668 lesson applied at
 * document grain: the constant says which document may claim the label, the
 * measurement says whether the reason still holds. If PO-009979 ever gains an
 * item code, the stated reason has evaporated and the entry stops applying by
 * itself rather than by anyone remembering. */
export const DECIDED_ABSENCES = [
  {
    type: "PO",
    docNo: "PO-009979",
    decidedOn: "2026-09-08",
    source: "the owner, relayed in the go-live cutover brief of 2026-09-08 (Malaysia time, UTC+8)",
    ruling: "mint a new accessory for the code-less \"ERGOTEX PILLOW CASE\", then import this purchase order",
    pending: "create the accessory in scm.products, then re-run the outstanding-PO import for this document",
    requires: "every-line-description-only",
  },
];

/** The measurements a register entry may require. Each one is a property of the
 *  BOOK, readable from the snapshot, so the reason an entry gives can be
 *  checked rather than believed. */
export const ABSENCE_PREDICATES = {
  "every-line-description-only": {
    says:
      "every line of this document is description-only — AutoCount states no ItemCode on any of them, so there " +
      "is no product master for the importer to point at",
    holds: (lines) => Array.isArray(lines) && lines.length > 0 && lines.every((l) => !l.hasCode),
  },
};

/**
 * Split the in-scope absences into ones with a recorded, still-valid owner
 * decision and ones that are unexplained gaps.
 *
 * Also returns `stale`: register entries for this type whose document is NOT in
 * the absent list any more. That is not silence — it is either done (delete the
 * entry) or out of scope (delete the entry), and either way the register is
 * lying until someone does. A register that quietly accumulates dead entries is
 * how a future real gap gets a free pass.
 *
 * @param {{t:string,missing:string[],linesOf:(docNo:string)=>unknown[],
 *          register?:typeof DECIDED_ABSENCES}} args
 * @returns {{decided:number,absent:number,decidedRows:object[],refused:object[],
 *            stale:object[],absentDocs:string[]}}
 */
export function splitDecidedAbsences({ t, missing, linesOf, register = DECIDED_ABSENCES }) {
  const total = missing.length;
  const mine = register.filter((e) => e.type === t);
  const byDoc = new Map(mine.map((e) => [e.docNo, e]));

  const decidedRows = [];
  const refused = [];
  const absentDocs = [];
  for (const docNo of missing) {
    const e = byDoc.get(docNo);
    if (!e) {
      absentDocs.push(docNo);
      continue;
    }
    const pred = ABSENCE_PREDICATES[e.requires];
    if (!pred) {
      refused.push({ ...e, why: `the register names an unknown predicate "${e.requires}"` });
      absentDocs.push(docNo);
      continue;
    }
    if (!pred.holds(linesOf(docNo))) {
      refused.push({ ...e, why: `the recorded reason no longer measures true — ${pred.says}` });
      absentDocs.push(docNo);
      continue;
    }
    decidedRows.push({ ...e, proof: pred.says });
  }

  const stale = mine.filter((e) => !missing.includes(e.docNo));
  const parts = { decided: decidedRows.length, absent: absentDocs.length };
  preserveTotal(`${t} absences`, total, parts);
  return { ...parts, decidedRows, refused, stale, absentDocs };
}
