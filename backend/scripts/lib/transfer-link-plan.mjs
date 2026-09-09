/* transfer-link-plan — the PURE rule that turns "the book says this line came
 * from that line" into "this ERP row's parent pointer must be that ERP row".
 *
 * ── THE ONE FACT THIS RULE STANDS ON ───────────────────────────────────────
 * The account book DOES record which LINE a delivery, invoice or receipt was
 * raised from. Not in the detail tables — `GRDTL.FromDocDtlKey` and its five
 * siblings are NULL on all ~220,000 rows, and every checker in this repo was
 * built on that measurement — but in AutoCount's own `DocTransfer` table, which
 * holds 134,501 rows with `FromDocDtlKey` and `ToDocDtlKey` set on every single
 * one. `export-ac-doc-transfer.mjs` pulls it and re-asserts three things every
 * run: no child line has more than one source, no line key is null, and no
 * `DtlKey` appears in two detail tables.
 *
 * So this module NEVER guesses. It does not pair by position — `PO-009081`
 * ordered two identical bedframes and two receipts each took one, and position
 * pairs them backwards (docs/bugs/0690). It does not pair by item code either:
 * on `GR-004940` the book names purchase line `829688` while the only
 * code-matching line on that order is `829690`, so a code rule would have
 * written the wrong link and called it derived.
 *
 * ── WHERE A CHOICE STILL EXISTS, AND WHY IT IS NOT A GUESS ─────────────────
 * One BOOK line can be SEVERAL ERP rows: a sofa is one line in the book and one
 * row per compartment here. So resolving the book's source line key can land on
 * a set. The tie-break is the ERP's OWN compartment code, applied only inside
 * the single book line the book already chose — `9058-1A(RHF)` answers
 * `9058-1A(RHF)`. That is a match between two decompositions we made ourselves,
 * not an inference about the book.
 *
 * If that still leaves more than one, or none, this REFUSES and names the row.
 * A blank beats a wrong link: an earlier lane left 11 of 28 lines blank because
 * the book could not separate them, and that was the right call.
 *
 * PURE. No filesystem, no database, no clock, no printing.
 * NO SHEBANG: tests import this module (see lib/ac-mapping-csv.mjs for the
 * Windows vitest reason).
 */

/** Every outcome resolving one child row can reach. */
export const OUTCOMES = Object.freeze([
  /* the book names a source line, exactly one ERP parent row answers it, and
     our row does not already point there — this is the write */
  "link",
  /* our row already points exactly where the book says. Nothing to do. */
  "already_correct",
  /* the book names no source for this line at all — the head of a chain */
  "no_source_in_book",
  /* the book names a source line we hold NO row for. The parent line was never
     migrated, or never carried its AutoCount line key. Named, never guessed. */
  "parent_line_not_held",
  /* several ERP rows answer the book's source line and the compartment code
     does not separate them — REFUSED */
  "ambiguous",
  /* the ERP parent row exists but its DOCUMENT carries no AutoCount number, so
     writing the link would still leave the chain unanswerable */
  "parent_doc_unstamped",
]);

export const IS_WRITE = Object.freeze(new Set(["link"]));
export const IS_REFUSAL = Object.freeze(new Set(["parent_line_not_held", "ambiguous", "parent_doc_unstamped"]));

const norm = (s) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");
const key = (s) => String(s ?? "").trim();

/**
 * Resolve ONE child row.
 *
 * child  = { id, itemCode, currentParentId, bookSourceLineKey }
 *          `bookSourceLineKey` is "" when the book states no source.
 * parents = the ERP rows that carry `linked_ac_dtlkey === bookSourceLineKey`,
 *          each { id, itemCode, docNo } where docNo is the AutoCount number of
 *          the document the row sits on, or "" when it carries none.
 *
 * @returns {{outcome: string, parentId: string|null, why: string}}
 */
export function resolveOne(child, parents) {
  const want = key(child?.bookSourceLineKey);
  if (!want) return { outcome: "no_source_in_book", parentId: null, why: "the book raised this line from nothing" };

  const rows = Array.isArray(parents) ? parents : [];
  if (rows.length === 0) {
    return {
      outcome: "parent_line_not_held",
      parentId: null,
      why: `the book raised it from line ${want} and no ERP row carries that AutoCount line key`,
    };
  }

  let pick = rows;
  if (pick.length > 1) {
    /* THE ONLY TIE-BREAK, and it is between two decompositions WE made: one
       book line is one ERP row per compartment, so the compartment code picks
       the counterpart. Never applied ACROSS book lines. */
    const same = rows.filter((p) => norm(p.itemCode) === norm(child.itemCode));
    if (same.length !== 1) {
      return {
        outcome: "ambiguous",
        parentId: null,
        why: `the book raised it from line ${want}, which is ${rows.length} ERP row(s) here, and ${same.length} of them carry this row's item code ${child.itemCode} — refusing rather than choosing`,
      };
    }
    pick = same;
  }

  const p = pick[0];
  if (!norm(p.docNo)) {
    return {
      outcome: "parent_doc_unstamped",
      parentId: null,
      why: `the book raised it from line ${want}; the ERP row answering it is on a document carrying no AutoCount number, so the chain stays unanswerable until that number is stamped`,
    };
  }
  if (key(child.currentParentId) && key(child.currentParentId) === key(p.id)) {
    return { outcome: "already_correct", parentId: p.id, why: `already points at line ${want}` };
  }
  return {
    outcome: "link",
    parentId: p.id,
    why: `the book raised it from line ${want} on ${p.docNo}`,
  };
}

/** Counts per outcome, for a list of resolutions. */
export function tally(resolutions) {
  const t = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  for (const r of resolutions) t[r.outcome] += 1;
  return t;
}

/* ── PLANTED CASES ──────────────────────────────────────────────────────────
 * Every one must land on its own outcome and nothing else. The runner calls
 * `runSelfTest()` BEFORE it reads a row and REFUSES on a failure: a resolver
 * that cannot resolve must not go on writing links confidently. */
export function selfTestCases() {
  const P = (id, itemCode, docNo) => ({ id, itemCode, docNo });
  return [
    { name: "the head of a chain — the book names no source",
      child: { id: "c1", itemCode: "X", currentParentId: null, bookSourceLineKey: "" },
      parents: [], want: "no_source_in_book" },

    { name: "one parent row answers the book's line — the write",
      child: { id: "c1", itemCode: "CODY-(K)", currentParentId: null, bookSourceLineKey: "61216" },
      parents: [P("p1", "CODY-(K)", "PO-000290")], want: "link" },

    { name: "already points exactly where the book says",
      child: { id: "c1", itemCode: "CODY-(K)", currentParentId: "p1", bookSourceLineKey: "61216" },
      parents: [P("p1", "CODY-(K)", "PO-000290")], want: "already_correct" },

    { name: "points somewhere ELSE — still a write, to the book's line",
      child: { id: "c1", itemCode: "CODY-(K)", currentParentId: "pOTHER", bookSourceLineKey: "61216" },
      parents: [P("p1", "CODY-(K)", "PO-000290")], want: "link" },

    { name: "one book line, several compartments — the compartment code picks one",
      child: { id: "c1", itemCode: "9058-1A(RHF)", currentParentId: null, bookSourceLineKey: "868276" },
      parents: [P("p1", "9058-1A(RHF)", "GR-005045"), P("p2", "9058-1NA", "GR-005045"),
                P("p3", "9058-CNR", "GR-005045")], want: "link" },

    { name: "two compartments of the SAME code under one book line — REFUSE",
      child: { id: "c1", itemCode: "9058-1A(LHF)", currentParentId: null, bookSourceLineKey: "868276" },
      parents: [P("p1", "9058-1A(LHF)", "GR-005045"), P("p2", "9058-1A(LHF)", "GR-005045")],
      want: "ambiguous" },

    { name: "several rows and NONE carries this row's code — REFUSE, never fall back to the first",
      child: { id: "c1", itemCode: "9058-CNR", currentParentId: null, bookSourceLineKey: "868276" },
      parents: [P("p1", "9058-1A(LHF)", "GR-005045"), P("p2", "9058-1NA", "GR-005045")],
      want: "ambiguous" },

    { name: "the book names a line we hold no row for",
      child: { id: "c1", itemCode: "X", currentParentId: null, bookSourceLineKey: "999999" },
      parents: [], want: "parent_line_not_held" },

    { name: "the parent row exists but its document carries no AutoCount number",
      child: { id: "c1", itemCode: "X", currentParentId: null, bookSourceLineKey: "912631" },
      parents: [P("p1", "X", "")], want: "parent_doc_unstamped" },

    /* THE NON-DEFECT. Case and surrounding whitespace on an item code have
       differed between the two systems on rows that are the same row, and
       refusing on that would be this rule's own first false refusal. */
    { name: "case and spacing on the item code do not defeat the compartment tie-break",
      child: { id: "c1", itemCode: " 9058-1a(rhf) ", currentParentId: null, bookSourceLineKey: "868276" },
      parents: [P("p1", "9058-1A(RHF)", "GR-005045"), P("p2", "9058-1NA", "GR-005045")],
      want: "link" },
  ];
}

export function runSelfTest() {
  const failures = [];
  for (const c of selfTestCases()) {
    const got = resolveOne(c.child, c.parents).outcome;
    if (got !== c.want) failures.push(`${c.name}: wanted ${c.want}, got ${got}`);
  }
  for (const o of [...IS_WRITE, ...IS_REFUSAL]) {
    if (!OUTCOMES.includes(o)) failures.push(`${o} is classified but is not a declared outcome`);
  }
  for (const o of OUTCOMES) {
    if (IS_WRITE.has(o) && IS_REFUSAL.has(o)) failures.push(`${o} is both a write and a refusal`);
  }
  return failures;
}
