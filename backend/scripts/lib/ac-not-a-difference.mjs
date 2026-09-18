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

/* ── 4. ITEM CODE: the CHECKER had to guess which line is which ──────────── */

/**
 * Split item-code differences into products we genuinely got wrong and
 * correspondences the checker INVENTED because it had no line key to pair on.
 *
 * WHY THIS EXISTS. `scm.grn_items` carries no AutoCount line key — migration
 * 0280 added the column and nothing backfills it — so for a goods receipt the
 * reconcile zips keyless lines on (qty, unit price), then qty, then document
 * order. A migrated receipt's price comes from the purchase ORDER by design, so
 * the first pass misses, and two qty-1 mattresses land in one bucket where
 * whichever row postgres returned first takes the first book line. Run
 * 34184553347 printed ten such pairs, every one a straight TRANSPOSITION:
 * DtlKey 917594 is `AK-IMMORTAL MATT (K)` and we answered `AKEMI ULTIMATE MATT
 * (K)`, 917604 the exact reverse. See docs/bugs/0693.
 *
 * WHY IT IS NOT AN AMNESTY, which is the only thing that matters here. The
 * identical shape on the sales and purchase side was NOT an artefact: 61 of 111
 * were genuinely the wrong product. So a document leaves the item-code column
 * only when BOTH hold, and the second is a measurement no ordering can affect:
 *
 *   a. THE ERP LINE THIS VERDICT IS ABOUT carries no line key, so the pairing it
 *      rests on was guessed rather than read. A line that HAS a key was paired
 *      for real and its difference is real.
 *   b. The book-side and ERP-side item-code MULTISETS are EQUAL — the same
 *      products in the same quantities, in any order. A wrong product changes
 *      the multiset, so this cannot swallow one.
 *
 * CLAUSE (a) USED TO BE ASKED OF THE WHOLE DOCUMENT, and that was right for
 * exactly as long as a document was all-keyed or all-keyless. It stopped being
 * true at 2026-09-08 14:22 (+08), when backfill-ac-downstream-line-keys.mjs
 * stamped 563 of 636 goods-receipt lines: it stamps only where the book FORCES
 * the pairing and leaves the rest NULL, so a PARTIALLY keyed document is now
 * the normal state and 29 receipts are in it. On such a document one keyed line
 * made `keyed` true for the whole thing and the guessed lines beside it were
 * counted as differences AND skipped silently — not even printed as impostors.
 * Measured: `GR-005334|PO-009887`, whose seven mattress rows the backfill
 * refused to key because AutoCount itself holds two lines of one item at one
 * quantity with different price/location/Desc2 (run 34199483652), and whose
 * item-code multiset the ERP matches exactly (run 34198777922). The row's own
 * key is therefore what clause (a) asks about; the document-level flag stays as
 * the fallback for a caller that does not carry the per-line fact.
 *
 * A document that satisfies (a) and fails (b) is an `impostor`: it stays
 * counted AND is printed louder, because "the sets differ too" is the strongest
 * evidence available that a product is genuinely wrong.
 *
 * What survives reclassification is exactly what should: the correspondence is
 * unknown, so the LINE-LEVEL verdict is withdrawn, while the DOCUMENT-level
 * claim — these two documents name the same goods — is asserted and proved.
 *
 * @param {{rows:{key:string,erpNo:string,line:string,erpKeyed?:boolean}[],
 *          bags:Map<string,{book:string,erp:string,keyed:boolean}>|null}} args
 *   `bags` is keyed by document, holding each side's canonical multiset string
 *   and whether ANY ERP line of that document carried a line key. A row may
 *   carry `erpKeyed` — whether THAT line carried one — and when it does, it is
 *   what clause (a) reads; the document flag is the fallback.
 * @returns {{guessed:number,differ:number,moved:object[],impostors:{line:string,why:string}[],
 *            applied:boolean,why:string}}
 */
export function splitGuessedItemCodePairing({ rows, bags }) {
  const total = rows.length;
  if (!bags) {
    preserveTotal("item code (not applied)", total, { guessed: 0, differ: total });
    return {
      guessed: 0,
      differ: total,
      moved: [],
      impostors: [],
      applied: false,
      why:
        "the per-document item-code multisets could not be built, so there is no measurement that a " +
        "difference is only a guessed correspondence. Nothing is reclassified: rule 3, an unproven " +
        "benign label is not a benign label.",
    };
  }
  const moved = [];
  const impostors = [];
  for (const r of rows) {
    const b = bags.get(r.key);
    if (!b) {
      impostors.push({ line: r.line, why: `no item-code multiset was measured for ${r.key} — unproven, counted as a difference` });
      continue;
    }
    /* The LINE's own key when the caller carried it, the document's otherwise.
       A partially keyed document is the normal state since the 14:22 backfill,
       and asking the document hid every guessed line standing beside a keyed
       one. */
    if (r.erpKeyed === undefined ? b.keyed : r.erpKeyed) continue;
    if (b.book === b.erp) moved.push(r);
    else {
      impostors.push({
        line: r.line,
        why:
          `${r.key} has NO line key AND the two sides name DIFFERENT goods, so this is not a pairing ` +
          `artefact — book [${b.book}] vs ours [${b.erp}]`,
      });
    }
  }
  const parts = { guessed: moved.length, differ: total - moved.length };
  preserveTotal("item code", total, parts);
  return {
    ...parts,
    moved,
    impostors,
    applied: true,
    why:
      "the ERP document carries no AutoCount line key, so the line-to-line pairing was GUESSED, and the " +
      "two sides' item-code multisets are equal — the same products in the same quantities. The document " +
      "is right; only which of our rows answers which of the book's rows is unknown.",
  };
}

/* ── 5. LINE COUNT: a migrated invoice is built from OUR source document ─── */

/**
 * Split invoice line-count differences into real gaps and the line SHAPE the
 * migrated chain produces by design.
 *
 * WHY. A migrated purchase / sales invoice does not copy AutoCount's invoice
 * lines — it draws them from OUR goods receipt or delivery order, which is a
 * PARTIAL mirror (src/scm/lib/migrated-chain.ts, rule 3's NOTE says so in
 * terms: a document whose line COUNT merely differs from AutoCount's is
 * converted, because the money reconciles exactly; different line shape, same
 * invoice, is normal). Three things routinely change the row count without
 * changing what was billed: AutoCount bills a FREE gift as its own RM 0.00 line
 * (`AK-SLEEP ESSENTIAL 7 HOLES` on a mattress), the book states one item code on
 * two lines where we hold one (PI-007471: qty 14 + qty 158 against our 172), and
 * a sofa fans out into compartments.
 *
 * WHAT MUST STILL BE TRUE, measured per document — a count is not waved through
 * on the module comment's say-so:
 *
 *   a. the document TOTAL is identical to the sen. This is rule 4 of the
 *      converter, re-asserted from the database rather than trusted.
 *   b. per ITEM CODE, both sides agree on quantity and money. A code the ERP
 *      does not carry at all is permitted only when the book prices it at
 *      RM 0.00 — the free line. Anything else means we billed different goods
 *      and it stays a difference.
 *
 * (b) is what stops this becoming an amnesty: a document that is short a REAL
 * line fails it, because that line carries money, and a document billing the
 * wrong product fails it on the code.
 *
 * @param {{rows:{key:string,erpNo:string,line:string}[],
 *          facts:Map<string,{totalsEqual:boolean,perCode:{code:string,why:string}[]}>|null}} args
 *   `perCode` is EMPTY when every code reconciles; each entry is a reason the
 *   document does not qualify.
 * @returns {{lineShape:number,differ:number,moved:object[],impostors:{line:string,why:string}[],
 *            applied:boolean,why:string}}
 */
/**
 * ONE document's verdict, from the shape facts. Shared by the two axes below
 * so they cannot answer differently about the same document on the same run.
 *
 * @param {{totalsEqual:boolean,perCode:{code:string,why:string}[]}|undefined} f
 * @param {string} key
 * @returns {{ok:true}|{ok:false,why:string}}
 */
function migratedChainShapeVerdict(f, key) {
  if (!f) return { ok: false, why: `no line-shape measurement for ${key} — unproven, counted as a difference` };
  if (!f.totalsEqual) {
    return { ok: false, why: `${key} differs in line COUNT and the document TOTAL is not identical — this is a money gap, not a shape` };
  }
  if (f.perCode.length) {
    return { ok: false, why: `${key} totals agree but the goods do not: ${f.perCode.map((p) => `${p.code} ${p.why}`).join("; ")}` };
  }
  return { ok: true };
}

/** The two axes' shared walk. `what` names the split for `preserveTotal`. */
function splitOnChainShape({ rows, facts }, what, why, unprovenWhy) {
  const total = rows.length;
  if (!facts) {
    preserveTotal(`${what} (not applied)`, total, { lineShape: 0, differ: total });
    return { lineShape: 0, differ: total, moved: [], impostors: [], refused: rows, applied: false, why: unprovenWhy };
  }
  const moved = [];
  const impostors = [];
  /* The refused ROWS, beside the sentences. `impostors` is what the report
     PRINTS and carries no row, so a later split cannot be handed it — and a
     second lane that re-derives "which rows were refused" from anything else
     would be free to disagree with this one about a document. */
  const refused = [];
  for (const r of rows) {
    const v = migratedChainShapeVerdict(facts.get(r.key), r.key);
    if (v.ok) moved.push(r);
    else {
      /* `key` so a LATER pass over the refused rows can say which of these
         sentences it has since answered, without matching on printed text. */
      impostors.push({ key: r.key, line: r.line, why: v.why });
      refused.push(r);
    }
  }
  const parts = { lineShape: moved.length, differ: total - moved.length };
  preserveTotal(what, total, parts);
  return { ...parts, moved, impostors, refused, applied: true, why };
}

const CHAIN_SHAPE_UNPROVEN =
  "the per-document totals and per-item-code sums could not be read, so nothing proves the difference is only " +
  "a shape difference. Nothing is reclassified.";

export function splitMigratedChainLineShape({ rows, facts }) {
  return splitOnChainShape(
    { rows, facts },
    "line count",
    "the invoice is built from OUR receipt / delivery by design and its total equals AutoCount's to the " +
      "sen, and every item code agrees on quantity and money — the only book lines we do not carry are " +
      "priced at RM 0.00. Same goods, same money, a different number of rows.",
    CHAIN_SHAPE_UNPROVEN,
  );
}

/* ── 5b. THE OTHER FACE OF THE SAME SHAPE ─────────────────────────────────── */

/**
 * Split `a book line we do not have` on a migrated-chain type by the SAME proof
 * the line COUNT is split by.
 *
 * WHY IT IS THE SAME QUESTION. A migrated invoice's rows come from OUR receipt
 * or delivery, so the book stating a row we do not carry is not a separate
 * finding from the row COUNT differing — it is the same fact seen from the
 * other end, and 5's proof settles both. Measured 2026-09-09 (run 34310423039):
 * nine sales invoices carried `a book line we do not have` on the same run and
 * the same `facts` that had already measured their `line count` as a shape, and
 * the axis had no split, so they stayed counted.
 *
 * IT IS NOT AN AMNESTY, and the tests pin it: a document whose TOTAL moves, or
 * one carrying a book line with MONEY in it, fails the same two gates and stays
 * a difference — reported louder, as an impostor. And a document with no
 * measurement at all is UNPROVEN, never waved through.
 *
 * @param {{rows:{key:string,erpNo:string,line:string}[],
 *          facts:Map<string,{totalsEqual:boolean,perCode:{code:string,why:string}[]}>|null}} args
 * @returns {{lineShape:number,differ:number,moved:object[],impostors:{line:string,why:string}[],
 *            applied:boolean,why:string}}
 */
export function splitMigratedChainUnpairedBookLine({ rows, facts }) {
  return splitOnChainShape(
    { rows, facts },
    "a book line we do not have",
    "the invoice is built from OUR receipt / delivery by design, so a book row we do not carry is the same " +
      "shape the line COUNT reports: the document total equals AutoCount's to the sen and every item code " +
      "agrees on quantity and money, so the book line we do not carry is priced at RM 0.00.",
    CHAIN_SHAPE_UNPROVEN,
  );
}

/* ── 6. THE ONWARD TRANSFER NOBODY MIGRATED ──────────────────────────────── */

/* THE DECLARATION, per CHILD document type. One entry per type whose ONWARD
 * document type the cutover deliberately left behind, so this can never leak to
 * a type nobody ruled on — the same shape as `decision` in section 2.
 *
 * `onwardType` is the type whose ABSENCE explains the shortfall, and it is what
 * the caller must measure our coverage of. Nothing here is believed: the caller
 * hands in the set of onward documents WE ACTUALLY HOLD, and a row whose onward
 * document is in that set is an impostor however well it fits the sentence. */
export const UNMIGRATED_ONWARD = Object.freeze({
  GR: {
    label: "the purchase-invoice history was never migrated",
    onwardType: "PI",
    decidedOn: "2026-09-08",
    source: "the owner, in the go-live cutover brief — the purchase-invoice HISTORY was not imported",
    ruling:
      "the account book holds 5,283 purchase invoices and the ERP holds 55, because the purchase-invoice " +
      "HISTORY was deliberately never migrated. AutoCount therefore states a goods-receipt line as fully " +
      "invoiced while we record nothing having gone on — not a wrong number, an ABSENT one",
    consequence:
      "our receipt cannot show an invoiced quantity for an invoice we do not hold, and it never will for " +
      "these documents. Repairing it would write a transfer quantity nothing in the ERP raised",
  },
  PO: {
    label: "the goods-receipt history outside the outstanding population was never migrated",
    onwardType: "GR",
    decidedOn: "2026-09-08",
    source: "the owner, in the go-live cutover brief — only receipts against OUTSTANDING orders were imported",
    ruling:
      "the account book holds 11,623 receipt×order pairs and 400 are in the expected ERP population, because " +
      "only the outstanding backlog was carried over. A purchase-order line the book received on a receipt we " +
      "never imported reads here as received in the book and untouched by us",
    consequence:
      "our purchase order cannot show a received quantity raised by a receipt we do not hold",
  },
});

/**
 * Split the transfer-TO differences into the ones the migration decision
 * explains and the ones that are real.
 *
 * THE SENTENCE IS NOT THE PROOF, and that is the whole design. "AutoCount moved
 * it and we record nothing" also describes a receipt whose purchase invoice we
 * DO hold and never counted — a genuine defect, and one this bucket would
 * swallow whole. So a row leaves the column only when all four hold, and the
 * last two are MEASURED, not assumed:
 *
 *   a. the type DECLARES the decision (`decision` non-null),
 *   b. the shape is exactly `the book moved some and we record NONE` — a
 *      partial figure is a number we computed, and a computed number that
 *      disagrees is a difference,
 *   c. the BOOK names at least one onward document raised off this one. If the
 *      book moved a quantity and no document of the onward type accounts for
 *      it, nothing has been explained and saying otherwise would be inventing a
 *      reason,
 *   d. NONE of those onward documents is in `coverage` — the set we actually
 *      hold. One that we do hold is exactly the defect this must not swallow.
 *
 * A row failing (b), (c) or (d) is returned in `impostors`, stays counted, and
 * the caller prints it louder than an ordinary difference.
 *
 * THE GRAIN IS THE DOCUMENT, AND IT IS STATED RATHER THAN DRESSED UP.
 * `FromDocDtlKey` is NULL on every one of the ~220,000 AutoCount detail rows,
 * so the book records which DOCUMENT an invoice or receipt was raised from and
 * nothing finer. The proof therefore says "no onward DOCUMENT we hold was
 * raised off this one", which is the strongest true statement available, and it
 * is never reported as a line-level accounting.
 *
 * @param {{rows:{key:string,ac:string,erpNo:string,bookDocNo:string,verdict:string,
 *                bookTransfered:number,erpCounter:number,line:string,proceeded?:boolean}[],
 *          decision:{label:string,onwardType:string,ruling:string,consequence:string}|null,
 *          coverage:Set<string>|null,
 *          onwardOf:(bookDocNo:string)=>string[]}} args
 * @returns {{notMigrated:number,differ:number,moved:object[],
 *            impostors:{line:string,why:string}[],applied:boolean,why:string}}
 */
export function splitUnmigratedOnwardTransfer({ rows, decision, coverage, onwardOf }) {
  const total = rows.length;
  const none = (why) => {
    preserveTotal("onward transfer (not applied)", total, { notMigrated: 0, differ: total });
    return { notMigrated: 0, differ: total, moved: [], impostors: [], applied: false, why };
  };
  if (!decision) {
    return none(
      "this type declares no migration decision about its onward document, so every transfer difference is a " +
        "difference",
    );
  }
  if (!coverage) {
    return none(
      `「${decision.label}」 is DECLARED for this type but the set of ${decision.onwardType} documents the ERP ` +
        "actually holds could not be read. Nothing is reclassified: an unproven decision is not a decision, and " +
        "without that set this cannot tell a migration gap from an invoice we hold and never counted.",
    );
  }

  const moved = [];
  const impostors = [];
  for (const r of rows) {
    /* (b) THE SHAPE. Only "we record NOTHING" is the absence the decision
       describes. `erp_high` and `erp_asserts_untransferred` are the ERP
       claiming MORE than the book, which no missing import can cause. */
    if (r.verdict !== "erp_low" || Number(r.erpCounter) !== 0) {
      impostors.push({
        line: r.line,
        why:
          `${r.ac} is not the absence this decision covers — the book moved ${r.bookTransfered} and ` +
          `we record ${r.erpCounter} (${r.verdict}). A number we computed and got wrong is a difference.`,
      });
      continue;
    }
    /* (c) THE BOOK MUST NAME THE ONWARD DOCUMENT. */
    const onward = onwardOf(r.bookDocNo) || [];
    if (!onward.length) {
      impostors.push({
        line: r.line,
        why:
          `${r.ac}: the book moved ${r.bookTransfered} off ${r.bookDocNo} and no ${decision.onwardType} in the ` +
          `book names it as a source, so nothing explains the transfer — unproven, counted as a difference`,
      });
      continue;
    }
    /* (d) AND WE MUST HOLD NONE OF THEM. */
    const held = onward.filter((d) => coverage.has(d));
    if (held.length) {
      impostors.push({
        line: r.line,
        why:
          `${r.ac}: we DO hold ${decision.onwardType} ${held.join(", ")}, raised off ${r.bookDocNo} — the ` +
          `migration decision does not cover this one and a zero here is a real defect`,
      });
      continue;
    }
    moved.push({ ...r, onward });
  }

  const parts = { notMigrated: moved.length, differ: total - moved.length };
  preserveTotal("onward transfer", total, parts);
  return {
    ...parts,
    moved,
    impostors,
    applied: true,
    why: decision.ruling,
  };
}

/* ── 7. THE SOURCE DOCUMENT NOBODY MIGRATED ──────────────────────────────── */

/* The mirror of section 6, and it is a DIFFERENT question. Section 6 asks why
 * the book moved a quantity ONWARD that we never recorded. This one asks why a
 * book line is ABSENT from our copy of the document — and the answer is one
 * level upstream: the line's own source document was never imported.
 *
 * WHY IT COULD NOT SHARE SECTION 6's CODE. That one keys on the DOCUMENT the
 * book raised onward; this one keys on the SOURCE of an individual LINE, and a
 * single document mixes both. Measured on the committed cut 2026-09-09:
 * `GR-000201` carries 12 lines raised from TEN purchase orders, of which two are
 * in scope — so the receipt is in scope, eight of its ten parents are not, and
 * any rule written at document grain answers the wrong question. The first
 * hypothesis tried here WAS document grain ("the source receipt is out of
 * scope") and explained 17 of 189 invoices; this one explains them because it
 * asks about the line
 * (docs/bugs/0767-the-purchase-invoices-differ-because-a-receipt-spans-purchas.md —
 * cited by FILENAME because `0767` is taken twice in the ledger).
 *
 * WHAT MAKES IT SAFE is section 6's design, unchanged: the sentence is not the
 * proof. A book line we do not carry ALSO describes a line we simply failed to
 * import from a document we DO hold — a real defect, and one this bucket would
 * swallow whole. A row leaves the column only when all four hold, and the last
 * two are MEASURED:
 *
 *   a. the type DECLARES the decision,
 *   b. the book NAMES a source document for that line — an unattributed line
 *      explains nothing and stays a difference,
 *   c. that source document is of the declared type,
 *   d. it is NOT in `coverage`, the set we actually hold. One we DO hold is
 *      exactly the defect this must not swallow.
 *
 * `sourceOf` RETURNS A LIST, NOT A DOCUMENT, and that is not defensiveness.
 * The book does not name a purchase order on a purchase-invoice line at all:
 * measured on the committed cut, `PIDTL.FromDocType` is `GR` on every one of
 * them, so the order is one hop further up and is found by matching the line's
 * item against the receipt's own lines. A receipt can legitimately receive the
 * same item against TWO orders, and then the hop has two answers. Collapsing
 * them to one would be the checker inventing a correspondence — the exact
 * failure docs/bugs/0690 paid for. So every candidate is carried, and gates
 * (c) and (d) must hold for ALL of them: if any candidate is a purchase order
 * we hold, the line could be a real defect and the document stays counted.
 *
 * AND THE VERDICT IS PER DOCUMENT, SO IT IS ALL OR NOTHING. The reconcile
 * records `a book line we do not have` once per DOCUMENT, and reclassifying
 * moves the whole document out of the difference column. A receipt whose twelve
 * unpaired lines are eleven migration gaps and ONE line we really lost would
 * then leave the column carrying the defect with it — the precise shape of
 * docs/bugs/0668, which cost 30 documents. So the gates run over EVERY unpaired
 * line on the document and the document moves only when all of them pass; the
 * first line that fails is named as the reason it stayed.
 */
export const UNMIGRATED_SOURCE = Object.freeze({
  PI: {
    label: "the purchase orders outside the outstanding population were never migrated",
    sourceType: "PO",
    decidedOn: "2026-09-09",
    source:
      "the owner, in the go-live cutover brief — only OUTSTANDING purchase orders were imported, and the " +
      "receipts that came with them carry only those orders' lines",
    ruling:
      "the account book holds 9,416 purchase orders and 474 are in the expected ERP population. One AutoCount " +
      "goods receipt serves MANY purchase orders — 124 of the 211 in-scope receipts carry lines from an order " +
      "we never imported, 837 such lines against 587 in scope — so the book's purchase invoice bills lines " +
      "whose purchase order is not in our books at all. Not a line we lost, a line we never had",
    consequence:
      "our purchase invoice can only carry the lines whose purchase order was migrated, and the document total " +
      "differs by exactly the lines that were not. The owner ruled the total need not match: " +
      "「total amount不需要 可是line amount一定一样」",
  },
});

/**
 * Split "a book line we do not have" into the documents whose every unpaired
 * book line the migration decision explains, and the ones that are real.
 *
 * One row is one DOCUMENT, carrying every book line on it that found no ERP
 * line. The document moves only when all of them are explained.
 *
 * `key` is the AutoCount document number and is what every refusal NAMES. It
 * used to read `r.ac`, a field the reconcile's rows do not carry, so the first
 * production run printed 78 refusals all beginning `undefined:` — a sentence
 * that names no document is not a finding anyone can work.
 *
 * @param {{rows:{key:string,erpNo:string,bookDocNo:string,bookDtlKeys:string[],line:string}[],
 *          decision:{label:string,sourceType:string,ruling:string,consequence:string}|null,
 *          coverage:Set<string>|null,
 *          sourceOf:(bookDocNo:string,bookDtlKey:string)=>{type:string,docNo:string}[]}} args
 * @returns {{notMigrated:number,differ:number,moved:object[],
 *            impostors:{line:string,why:string}[],applied:boolean,why:string}}
 */
export function splitUnmigratedSourceLine({ rows, decision, coverage, sourceOf }) {
  const total = rows.length;
  const none = (why) => {
    preserveTotal("source line (not applied)", total, { notMigrated: 0, differ: total });
    return { notMigrated: 0, differ: total, moved: [], impostors: [], applied: false, why };
  };
  if (!decision) {
    return none(
      "this type declares no migration decision about the documents its lines are raised from, so every book " +
        "line we do not carry is a difference",
    );
  }
  if (!coverage) {
    return none(
      `「${decision.label}」 is DECLARED for this type but the set of ${decision.sourceType} documents the ERP ` +
        "actually holds could not be read. Nothing is reclassified: an unproven decision is not a decision, and " +
        "without that set this cannot tell a migration gap from a line we failed to import from a document we hold.",
    );
  }

  /* Why one line fails the whole document, in the words the report prints.
     Returns the reason, or null with the candidates it proved. */
  const judge = (r, dtlKey) => {
    const cand = (sourceOf(r.bookDocNo, dtlKey) || []).filter((s) => s && s.docNo);
    /* (b) THE BOOK MUST NAME A SOURCE for the line. */
    if (!cand.length) {
      return { why: `${r.key}: the book names no source document for line ${dtlKey}, so nothing explains why we ` +
        "do not carry it — unproven, counted as a difference" };
    }
    /* (c) AND EVERY CANDIDATE MUST BE THE DECLARED TYPE. A line raised from
       something else is not what this decision is about. */
    const wrong = cand.find((s) => String(s.type ?? "").toUpperCase() !== decision.sourceType);
    if (wrong) {
      return { why: `${r.key}: line ${dtlKey} is raised from ${wrong.type || "(no type)"} ${wrong.docNo}, not ` +
        `from a ${decision.sourceType} — this decision does not cover it` };
    }
    /* (d) AND WE MUST HOLD NONE OF THEM. One we DO hold means the line could be
       one we failed to import, which is the defect this must never swallow.
       CERTAIN and AMBIGUOUS are said differently, because they are different
       findings for whoever works them: one order names the line, several mean
       the checker cannot tell which — and only the second is a candidate for a
       sharper hop later. */
    const held = cand.find((s) => coverage.has(s.docNo));
    if (held) {
      const certain = cand.length === 1;
      return { why: `${r.key}: we DO hold ${decision.sourceType} ${held.docNo}, which line ${dtlKey} ` +
        (certain
          ? "was raised from"
          : `may have been raised from (the receipt names ${cand.length} orders for that item and the book ` +
            "does not say which)") +
        " — the migration decision does not cover this one and a missing line here is a real defect" };
    }
    return { cand };
  };

  const moved = [];
  const impostors = [];
  for (const r of rows) {
    const keys = Array.isArray(r.bookDtlKeys) ? r.bookDtlKeys : [];
    /* A document recorded on this axis with no line keys is not evidence of
       anything. It cannot be proven and it does not move. */
    if (!keys.length) {
      impostors.push({
        key: r.key,
        line: r.line,
        why: `${r.key}: no unpaired book line key was recorded for this document, so there is nothing to ` +
          "attribute to a source purchase order — unproven, counted as a difference",
      });
      continue;
    }
    const sources = [];
    let why = null;
    for (const dtlKey of keys) {
      const v = judge(r, dtlKey);
      if (v.why) { why = v.why; break; }
      sources.push(...v.cand);
    }
    if (why) impostors.push({ key: r.key, line: r.line, why });
    else moved.push({ ...r, sources });
  }

  const parts = { notMigrated: moved.length, differ: total - moved.length };
  preserveTotal("source line", total, parts);
  return { ...parts, moved, impostors, applied: true, why: decision.ruling };
}
