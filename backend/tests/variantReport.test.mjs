/* End to end over `reportVariants` — the function that turns one document
 * type's paired lines into the table the owner reads.
 *
 * It was 226 lines inside check-ac-erp-reconcile.mjs, where nothing could drive
 * it without a production connection; moving it to `scripts/lib/variant-report.mjs`
 * (the file-size ceiling forced the move) is what makes this test possible, and
 * the test is what makes the move safe: a lifted block that still referenced
 * something in the old file's scope would load fine and only throw when called.
 *
 * The case is the production one, docs/bugs/0709 and 0712: two ERP rows of ONE
 * bedframe at ONE quantity on ONE delivery order, carrying NO AutoCount line
 * key, whose two colours are an exact transposition of the book's two.
 */
import { describe, it, expect } from "vitest";

import { reportVariants } from "../scripts/lib/variant-report.mjs";
import { DIFFER, NO_LINE_KEY, AGREE, RULED, RULING_LOST } from "../scripts/lib/variant-reconcile.mjs";
import { buildRulingIndex, resolveRuling } from "../scripts/lib/sofa-ruling-index.mjs";
import { buildFabricColourIndex, isPendingColour } from "../scripts/lib/fabric-colour-match.mjs";
import { parseBedframe } from "../scripts/lib/parse-bedframe.mjs";
import { SOFA_MODEL_ALIAS, parseSofa } from "../scripts/lib/parse-sofa.mjs";

/* A fabric library with the two colours the case needs. `active` is set,
   because the matcher follows the 2026-08-11 renumbering only when told. */
const FC = [
  { fabric_id: "PC151", colour_id: "PC151-02", label: "PC151-02", active: true },
  { fabric_id: "PC151", colour_id: "PC151-03", label: "PC151-03", active: true },
  /* the sofa cases below: the book names BO315-21 and one ERP line names -22 */
  { fabric_id: "BO315", colour_id: "BO315-21", label: "BO315-21", active: true },
  { fabric_id: "BO315", colour_id: "BO315-22", label: "BO315-22", active: true },
];
const { findColour } = buildFabricColourIndex(FC);
const DEPS = {
  parseBedframe,
  parseSofa,
  isPendingColour,
  modelAlias: SOFA_MODEL_ALIAS,
  knownColour: (c) => (findColour(c) ? findColour(c).colour_id : null),
  reclOf: () => false,
  colourIdentity: (t) => {
    const h = findColour(t);
    return h ? `${h.fabric_id}|${h.colour_id}` : null;
  },
  mapSpecials: (ph) => ph,
  specialCarried: () => true,
};

const erpLine = (id, colour, key) => ({
  id, item_code: "TRION (A) (HB STR)-(K)", item_group: "bedframe", qty: 1,
  line_suffix: null, proceeded: true, ac_dtlkey: key ?? null,
  variants: { fabricCode: colour, divanHeight: '8"', legHeight: '0"', gap: '14"', totalHeight: '22"' },
  custom_specials: null,
});

/** Drive one document type and collect what it printed. */
function run(rows, desc2, rulingFor = () => ({ ruling: null, ambiguous: null })) {
  const out = [];
  const locked = [];
  const noted = [];
  const vt = reportVariants({
    t: "DO",
    label: "Delivery Order",
    rows,
    /* KEYED BY NUMBER, like the snapshot decoder's own map: reportVariants
       does `desc2.get(r.acLine.dtlKey)` and a DtlKey is a number, so a map of
       string keys silently answers "the book said nothing" and every axis
       reads BOOK-BLANK. That is what this harness did on its first run. */
    desc2: new Map(Object.entries(desc2).map(([k, v]) => [Number(k), v])),
    deps: DEPS,
    /* `note` is the NON-locking channel (lib/so-verdict-derive.mjs): the
       declared classes the report names so nothing is excluded silently. A stub
       missing it would throw the moment a book-blank cell appeared, which is
       why it is a real function here and not an optional call at the callsite —
       an optional call would also hide the wiring genuinely going missing. */
    VERDICT: { record: (...a) => locked.push(a), seen: () => {}, note: (...a) => noted.push(a) },
    SHOW: 20,
    log: (m) => out.push(m),
    plain: (m) => out.push(m),
    rulingFor,
  });
  return { vt, out: out.join("\n"), locked, noted };
}

const BOOK_02 = 'Clr: PC151-02/Divan:8"+no legs/Gap:14"';
const BOOK_03 = 'Clr: PC151-03/Divan:8"+no legs/Gap:14"';

describe("reportVariants — the guessed-pairing fold, end to end", () => {
  it("two UNKEYED rows whose colours are transposed report as no-key, not as a difference", () => {
    const rows = [
      { ac: "DO-011496", erpNo: "HC-DO-011496", acLine: { dtlKey: 919934 }, erpLines: [erpLine("a", "PC151-03")] },
      { ac: "DO-011496", erpNo: "HC-DO-011496", acLine: { dtlKey: 919942 }, erpLines: [erpLine("b", "PC151-02")] },
    ];
    const { vt, out, locked } = run(rows, { 919934: BOOK_02, 919942: BOOK_03 });

    expect(vt.tally.colour.yes[DIFFER]).toBe(0);
    expect(vt.tally.colour.yes[NO_LINE_KEY]).toBe(2);
    /* And it does not lock the document: a verdict the checker guessed must not
       hold a sales order shut. */
    expect(locked.filter((l) => String(l[3]).includes("colour"))).toHaveLength(0);
    expect(out).toContain("no AutoCount line number on our rows");
    expect(out).toContain("DtlKey 919934");
    expect(out).toContain("DtlKey 919942");
  });

  it("the SAME two rows, KEYED, are a real difference and lock", () => {
    const rows = [
      { ac: "DO-011496", erpNo: "HC-DO-011496", acLine: { dtlKey: 919934 }, erpLines: [erpLine("a", "PC151-03", 919934)] },
      { ac: "DO-011496", erpNo: "HC-DO-011496", acLine: { dtlKey: 919942 }, erpLines: [erpLine("b", "PC151-02", 919942)] },
    ];
    const { vt, locked } = run(rows, { 919934: BOOK_02, 919942: BOOK_03 });
    expect(vt.tally.colour.yes[DIFFER]).toBe(2);
    expect(vt.tally.colour.yes[NO_LINE_KEY]).toBe(0);
    expect(locked.length).toBeGreaterThan(0);
  });

  it("two unkeyed rows that AGREE stay AGREE — the fold moves nothing that was not a difference", () => {
    const rows = [
      { ac: "DO-x", erpNo: "HC-DO-x", acLine: { dtlKey: 1 }, erpLines: [erpLine("a", "PC151-02")] },
      { ac: "DO-x", erpNo: "HC-DO-x", acLine: { dtlKey: 2 }, erpLines: [erpLine("b", "PC151-03")] },
    ];
    const { vt } = run(rows, { 1: BOOK_02, 2: BOOK_03 });
    expect(vt.tally.colour.yes[AGREE]).toBe(2);
    expect(vt.tally.colour.yes[NO_LINE_KEY]).toBe(0);
  });

  it("the table still adds up: every axis's verdicts sum to the modelled line count", () => {
    const rows = [
      { ac: "DO-011496", erpNo: "HC-DO-011496", acLine: { dtlKey: 919934 }, erpLines: [erpLine("a", "PC151-03")] },
      { ac: "DO-011496", erpNo: "HC-DO-011496", acLine: { dtlKey: 919942 }, erpLines: [erpLine("b", "PC151-02")] },
    ];
    const { vt } = run(rows, { 919934: BOOK_02, 919942: BOOK_03 });
    expect(vt.pop.modelled).toBe(2);
    for (const axis of ["colour", "divan", "gap", "leg", "totalHeight"]) {
      const y = vt.tally[axis].yes;
      const n = vt.tally[axis].no;
      const total = Object.values(y).reduce((a, b) => a + b, 0) + Object.values(n).reduce((a, b) => a + b, 0);
      expect(total, `axis ${axis}`).toBe(2);
    }
  });

  it("a type with no bedframe or sofa line reports NOT comparable, never a clean run", () => {
    const rows = [{ ac: "DO-y", erpNo: "HC-DO-y", acLine: { dtlKey: 9 }, erpLines: [{ id: "z", item_group: "accessory", qty: 1, variants: {} }] }];
    const { vt, out } = run(rows, {});
    expect(vt.comparable).toBe(false);
    expect(out).toContain("NOT a clean run");
  });
});

/* ── THE OWNER'S COMPARTMENT RULINGS ────────────────────────────────────────
 * The production case, docs/bugs/0714 and 0715: `HC-SO-013475`. The shop floor
 * reported it as urgent with a customer waiting; the book's text decodes to one
 * build, the owner's DRAWING says another, and he ruled that the drawing wins.
 * The ERP was corrected to his answer — and the reconcile, comparing the ERP
 * against the book's TEXT, then reported the difference his ruling had
 * deliberately created and the verdict LOCKED the order he had just unblocked.
 *
 * The book's Desc2 below is the SELF_TEST shape from lib/variant-reconcile.mjs,
 * whose decode was measured against the real decoders: five pieces. His ruling
 * is three. So the comparison would be DIFFER, which is what makes these cases
 * about the exemption and not about the parser. */
const BOOK_SOFA_5 = '1EL+1NA+C+1NA+1ER/32"/Col:BO315-21';
const D2 = 'HOK-8030 SOFA 3S(28") / COL: BO315-21';

const sofaLine = (code, { key = 777, colour = "BO315-21", desc2 = D2 } = {}) => ({
  id: code, item_code: code, item_group: "sofa", qty: 1,
  line_suffix: null, proceeded: true, ac_dtlkey: key, description2: desc2,
  variants: { fabricCode: colour, seatHeight: '32"' },
  custom_specials: null,
});

const sofaRow = (lines) => ({ ac: "SO-013475", erpNo: "HC-SO-013475", acLine: { dtlKey: 777 }, erpLines: lines });

/** His ruling for that build, in the shape lib/sofa-corrections-source.mjs loads. */
const RULING_BUILDS = [{
  docs: ["HC-SO-013475"],
  model: "8030",
  pieces: ["1A(LHF)", "1NA", "1A(RHF)"],
  desc2Match: '3S(28")',
  why: "the drawing shows three seats",
  source: "sofa-compartment-corrections-2026-09.json",
}];
const rulingFor = (index) => (w) => resolveRuling(index, w);
const RULINGS = rulingFor(buildRulingIndex(RULING_BUILDS));

describe("reportVariants — a build the owner has already ruled on", () => {
  const THREE = [
    sofaLine("8030-1A(LHF)"),
    sofaLine("8030-1NA"),
    sofaLine("8030-1A(RHF)"),
  ];

  it("the ERP holding exactly what he ruled is RULED, is not a DIFFER, and does NOT lock", () => {
    const { vt, locked, noted, out } = run([sofaRow(THREE)], { 777: BOOK_SOFA_5 }, RULINGS);

    expect(vt.tally.compartments.yes[RULED]).toBe(1);
    expect(vt.tally.compartments.yes[DIFFER]).toBe(0);
    /* THE WHOLE POINT: the order he unblocked is not shut by his own answer. */
    expect(locked.filter((l) => String(l[3]).toLowerCase().includes("sofa"))).toHaveLength(0);
    expect(locked.filter((l) => String(l[3]) === "sofa compartments")).toHaveLength(0);
    /* NAMED, never merely subtracted: his value and the file it lives in. */
    expect(noted.some((nn) => nn[3] === "ruled" && nn[4] === "sofa compartments")).toBe(true);
    expect(out).toContain("RULED BY THE OWNER");
    expect(out).toContain("1A(LHF)+1NA+1A(RHF)");
    expect(out).toContain("sofa-compartment-corrections-2026-09.json");
  });

  it("WITHOUT the ruling the SAME rows are a DIFFER and DO lock — the fix is the resolver, not the data", () => {
    const { vt, locked } = run([sofaRow(THREE)], { 777: BOOK_SOFA_5 });
    expect(vt.tally.compartments.yes[DIFFER]).toBe(1);
    expect(vt.tally.compartments.yes[RULED]).toBe(0);
    expect(locked.filter((l) => String(l[3]) === "sofa compartments")).toHaveLength(1);
  });

  it("A RULING EXCUSES THE AXIS HE RULED, NOT THE DOCUMENT: a colour difference on the SAME line still locks", () => {
    /* The book names BO315-21; the lead ERP line names BO315-22. The build is
       still exactly what he ruled, so compartments are RULED — and the colour
       must still be reported, because he ruled a sofa's PIECES and said nothing
       about its fabric. */
    const lines = [
      sofaLine("8030-1A(LHF)", { colour: "BO315-22" }),
      sofaLine("8030-1NA", { colour: "BO315-22" }),
      sofaLine("8030-1A(RHF)", { colour: "BO315-22" }),
    ];
    const { vt, locked } = run([sofaRow(lines)], { 777: BOOK_SOFA_5 }, RULINGS);

    expect(vt.tally.compartments.yes[RULED]).toBe(1);
    expect(vt.tally.colour.yes[DIFFER]).toBe(1);
    expect(locked.filter((l) => String(l[3]) === "colour / fabric")).toHaveLength(1);
  });

  it("a ruled document whose ERP NO LONGER matches his ruling is its own loud state, and it locks", () => {
    /* Somebody edited the build back to two pieces. The ruling is a CHECK, not a
       blank cheque: it says this document must equal THIS, so the exemption
       stops applying and the document is reported again — on its own axis,
       because it needs him and not a data fix. */
    const lines = [sofaLine("8030-1A(LHF)"), sofaLine("8030-1A(RHF)")];
    const { vt, locked, out } = run([sofaRow(lines)], { 777: BOOK_SOFA_5 }, RULINGS);

    expect(vt.tally.compartments.yes[RULING_LOST]).toBe(1);
    expect(vt.tally.compartments.yes[RULED]).toBe(0);
    const hits = locked.filter((l) => String(l[3]) === "sofa build differs from the owner ruling");
    expect(hits).toHaveLength(1);
    expect(out).toContain("HIS RULING NO LONGER HOLDS");
  });

  it("a build that cannot be REGROUPED is not checked against the ruling — an unkeyed row would fake a lost ruling", () => {
    /* No AutoCount line key, so the pairing returns ONE of our rows for the
       book's line. Asserting a three-piece ruling against one row would report a
       ruling as lost on a document nobody has touched. */
    const { vt, locked, out } = run(
      [sofaRow([sofaLine("8030-1A(LHF)", { key: null })])],
      { 777: BOOK_SOFA_5 },
      RULINGS,
    );
    expect(vt.tally.compartments.yes[RULING_LOST]).toBe(0);
    expect(vt.tally.compartments.yes[RULED]).toBe(0);
    expect(locked.filter((l) => String(l[3]) === "sofa build differs from the owner ruling")).toHaveLength(0);
    expect(out).toContain("A RULING EXISTS BUT COULD NOT BE CHECKED");
  });

  it("TWO rulings reaching one build are REFUSED, and the build is compared against the book", () => {
    const two = buildRulingIndex([
      ...RULING_BUILDS,
      { docs: ["HC-SO-013475"], pieces: ["2A(LHF)", "1A(RHF)"], desc2Match: "BO315-21", source: "f.json", why: "" },
    ]);
    const { vt, out, locked } = run([sofaRow(THREE)], { 777: BOOK_SOFA_5 }, rulingFor(two));
    expect(vt.tally.compartments.yes[RULED]).toBe(0);
    expect(vt.tally.compartments.yes[DIFFER]).toBe(1);
    expect(locked.filter((l) => String(l[3]) === "sofa compartments")).toHaveLength(1);
    expect(out).toContain("TWO RULINGS REACH ONE BUILD");
  });

  it("a ruling on ANOTHER document does not reach this one", () => {
    const other = buildRulingIndex([{ ...RULING_BUILDS[0], docs: ["HC-SO-999999"] }]);
    const { vt } = run([sofaRow(THREE)], { 777: BOOK_SOFA_5 }, rulingFor(other));
    expect(vt.tally.compartments.yes[RULED]).toBe(0);
    expect(vt.tally.compartments.yes[DIFFER]).toBe(1);
  });
});
