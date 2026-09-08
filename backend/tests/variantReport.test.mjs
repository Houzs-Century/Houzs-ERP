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
import { DIFFER, NO_LINE_KEY, AGREE } from "../scripts/lib/variant-reconcile.mjs";
import { buildFabricColourIndex, isPendingColour } from "../scripts/lib/fabric-colour-match.mjs";
import { parseBedframe } from "../scripts/lib/parse-bedframe.mjs";
import { SOFA_MODEL_ALIAS, parseSofa } from "../scripts/lib/parse-sofa.mjs";

/* A fabric library with the two colours the case needs. `active` is set,
   because the matcher follows the 2026-08-11 renumbering only when told. */
const FC = [
  { fabric_id: "PC151", colour_id: "PC151-02", label: "PC151-02", active: true },
  { fabric_id: "PC151", colour_id: "PC151-03", label: "PC151-03", active: true },
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
function run(rows, desc2) {
  const out = [];
  const locked = [];
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
    VERDICT: { record: (...a) => locked.push(a), seen: () => {} },
    SHOW: 20,
    log: (m) => out.push(m),
    plain: (m) => out.push(m),
  });
  return { vt, out: out.join("\n"), locked };
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
