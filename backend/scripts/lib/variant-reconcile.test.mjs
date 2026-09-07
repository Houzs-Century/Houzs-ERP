/**
 * THE TWO OWNER RULES THAT DECIDE WHAT COUNTS AS A DIFFERENCE, PINNED.
 *
 * variant-reconcile.mjs answers one question — "does the ERP line say what
 * AutoCount's Desc2 says" — and getting the ANSWER SHAPE wrong is what makes
 * the report worthless rather than merely incomplete:
 *
 *   1. 「还没proceed还没确认的就可以直接放空的」 (owner, 2026-09-04). A blank on an
 *      unconfirmed order is not a gap. The verdict still has to SAY the ERP is
 *      blank — the checker splits the count — so the test that matters is that
 *      `proceeded` travels with the verdict and never silences it.
 *   2. 「跟着 autocount 的 document 就对了，我们 migrate data 不可以更改数据啊」
 *      (owner, 2026-08-11). Where the book says nothing, the ERP saying nothing
 *      is CORRECT. BOOK_BLANK must never come out as a gap, and both-blank must
 *      come out as AGREE rather than as two absences that "match by accident".
 *
 * And the three traps this module was written around, each of which has already
 * produced a wrong number in production:
 *
 *   · a colour compared as a SPELLING reports CH141-8 against CH141-08 as a
 *     difference when the 2026-08-11 renumbering made them one colour;
 *   · sofa compartments compared BY POSITION report every correctly built sofa
 *     whose rows happen to be stored in another order (sofa-slip-notation:
 *     "the apply script compares the compartment MULTISET");
 *   · specials read off `custom_specials` alone measure a DERIVED, self-erasing
 *     column (erp-specials-field-trap) — the picker binds to
 *     `variants.specials`.
 *
 * Zero dependencies: `node --test scripts/lib/*.test.mjs` runs this on a bare
 * checkout, which is what .github/workflows/working-agreement.yml does.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { parseBedframe } from "./parse-bedframe.mjs";
import { SOFA_MODEL_ALIAS, parseSofa } from "./parse-sofa.mjs";
import { isPendingColour } from "./fabric-colour-match.mjs";
import {
  AGREE, BOOK_BLANK, DIFFER, ERP_BLANK, PENDING, RECORDED, UNREADABLE,
  compareLine, decodeBook, inches, multisetDiff, runSelfTest,
} from "./variant-reconcile.mjs";

/* A stand-in fabric library with the ONE property the real matcher supplies:
   two spellings of the same colour resolve to the same identity. */
const LIBRARY = {
  "CH141-8": "CH141|CH141-08",
  "CH141-08": "CH141|CH141-08",
  "PC151-01": "PC151|PC151-01",
  "BO315-21": "BO315|BO315-21",
};

const DEPS = {
  parseBedframe,
  parseSofa,
  isPendingColour,
  modelAlias: SOFA_MODEL_ALIAS,
  knownColour: (c) => (LIBRARY[String(c ?? "").trim().toUpperCase()] ? String(c).trim() : null),
  reclOf: () => false,
  colourIdentity: (t) => LIBRARY[String(t ?? "").trim().toUpperCase()] ?? null,
  mapSpecials: (phrases) => [...new Set(phrases)],
  specialCarried: (wanted, carried) =>
    carried.some((c) => String(c).toUpperCase().includes(String(wanted).toUpperCase())),
};

const line = (over = {}) => ({ item_code: "CODY-(SS)", item_group: "bedframe", variants: {}, custom_specials: null, proceeded: true, ...over });

const compare = (desc2, erpLines, proceeded = true) => {
  const lead = erpLines[0];
  const book = decodeBook(DEPS, { desc2, itemGroup: lead.item_group, itemCode: lead.item_code });
  return compareLine(DEPS, { book, erpLines, proceeded }).axes;
};

test("the decoders behind the checker still decode — the startup self-test itself", () => {
  assert.deepEqual(runSelfTest(DEPS), []);
});

test("rule 2: where AutoCount says nothing, the ERP saying nothing AGREES", () => {
  const axes = compare("", [line()]);
  for (const k of ["divan", "gap", "leg", "totalHeight", "colour"]) {
    assert.equal(axes[k].verdict, AGREE, `${k} should agree when neither side states it`);
  }
});

test("rule 2: a value the ERP has and the book never stated is BOOK_BLANK, not a gap", () => {
  const axes = compare('Divan:8"', [line({ variants: { divanHeight: '8"', gap: '12"' } })]);
  assert.equal(axes.divan.verdict, AGREE);
  assert.equal(axes.gap.verdict, BOOK_BLANK);
  assert.equal(axes.gap.erp, '12"');
  assert.equal(axes.gap.book, "");
});

test("rule 1: an ERP blank still reports ERP_BLANK, and carries whether the order proceeded", () => {
  const d2 = "PC151-01/8inch+4inchLeg/Gap12inch";
  const bare = [line({ variants: {} })];
  const yes = compareLine(DEPS, {
    book: decodeBook(DEPS, { desc2: d2, itemGroup: "bedframe", itemCode: "CODY-(SS)" }),
    erpLines: bare,
    proceeded: true,
  });
  const no = compareLine(DEPS, {
    book: decodeBook(DEPS, { desc2: d2, itemGroup: "bedframe", itemCode: "CODY-(SS)" }),
    erpLines: bare,
    proceeded: false,
  });
  assert.equal(yes.axes.gap.verdict, ERP_BLANK);
  assert.equal(no.axes.gap.verdict, ERP_BLANK, "the VERDICT is the same; only the count it lands in differs");
  assert.equal(yes.proceeded, true);
  assert.equal(no.proceeded, false);
});

test("the owner's leg rule survives the comparison: a divan with no leg mentioned is leg 0, and 0 is a VALUE", () => {
  const axes = compare('Col: /Div:8"/M.GAP:14"', [line({ variants: { divanHeight: '8"', gap: '14"', legHeight: '0"' } })]);
  assert.equal(axes.leg.verdict, AGREE);
  assert.equal(axes.leg.book, '0"');
  const missing = compare('Col: /Div:8"/M.GAP:14"', [line({ variants: { divanHeight: '8"', gap: '14"' } })]);
  assert.equal(missing.leg.verdict, ERP_BLANK, "leg 0 is stated by the book, so a blank ERP leg is a gap");
});

test("T.Heights is the writer's own gap+divan+leg, not a second opinion", () => {
  const axes = compare("PC151-01/8inch+4inchLeg/Gap12inch", [line({ variants: { totalHeight: '24"' } })]);
  assert.equal(axes.totalHeight.verdict, AGREE);
  const wrong = compare("PC151-01/8inch+4inchLeg/Gap12inch", [line({ variants: { totalHeight: '26"' } })]);
  assert.equal(wrong.totalHeight.verdict, DIFFER);
  assert.equal(wrong.totalHeight.book, '24"');
  assert.equal(wrong.totalHeight.erp, '26"');
});

test("colour is an IDENTITY: the 2026-08-11 renumbering is not a difference", () => {
  const agree = compare("CH141-8/Divan:8\"", [line({ variants: { fabricCode: "CH141-08" } })]);
  assert.equal(agree.colour.verdict, AGREE, "CH141-8 and CH141-08 are one library row");
  const differ = compare("PC151-01/Divan:8\"", [line({ variants: { fabricCode: "BO315-21" } })]);
  assert.equal(differ.colour.verdict, DIFFER);
});

test("TBC/KIV is its own state, so it cannot inflate the ERP-blank backlog", () => {
  const axes = compare('Divan:8”+4”leg/Gap:14”/Col:KIV', [line({ variants: { divanHeight: '8"', legHeight: '4"', gap: '14"' } })]);
  assert.equal(axes.colour.verdict, PENDING);
});

test("sofa compartments compare as a MULTISET, never by position", () => {
  const d2 = '1EL+1NA+C+1NA+1ER/32"/Col:BO315-21';
  const rows = (codes) => codes.map((c) => line({ item_code: `8050-${c}`, item_group: "sofa", variants: { seatHeight: '32"', fabricCode: "BO315-21" } }));
  const shuffled = compare(d2, rows(["CNR", "1A(RHF)", "1NA", "1A(LHF)", "1NA"]));
  assert.equal(shuffled.compartments.verdict, AGREE, "line_no is storage order, not physical layout");
  const short = compare(d2, rows(["1A(LHF)", "1NA", "CNR", "1NA"]));
  assert.equal(short.compartments.verdict, DIFFER);
  assert.match(short.compartments.detail, /MISSING 1A\(RHF\)/);
});

test("a build the decoder cannot read is UNREADABLE, never a data defect", () => {
  const axes = compare("(1 ELT / T + NA +2ER)", [line({ item_code: "5526-1S", item_group: "sofa", variants: {} })]);
  assert.equal(axes.compartments.verdict, UNREADABLE);
});

test("specials are read from variants.specials, the field the picker actually binds to", () => {
  const d2 = "PC151-01/Divan:8\"/Front Drawer";
  const onInput = compare(d2, [line({ variants: { specials: ["Front Drawer"] } })]);
  assert.equal(onInput.specials.verdict, AGREE);
  /* custom_specials is DERIVED and is nulled the moment variants.specials is
     empty, so a line carrying only it is one edit from losing the request. It
     counts as present — the data IS there — and the detail says where. */
  const derivedOnly = compare(d2, [line({ variants: {}, custom_specials: ["Front Drawer"] })]);
  assert.equal(derivedOnly.specials.verdict, AGREE);
  assert.match(derivedOnly.specials.detail, /custom_specials/);
  const absent = compare(d2, [line({ variants: {} })]);
  assert.equal(absent.specials.verdict, ERP_BLANK);
});

test("a PRICED special already in variants.specialsRecorded is RECORDED, not DIFFER", () => {
  /* The owner's ruling 甲 of 2026-09-03 — 「记下来给工厂看，但单据的钱不可以动」. The
     recording script writes `specialsRecorded` precisely BECAUSE writing
     `specials` would reprice a historical document, so a checker that reads only
     `specials` reports the owner's own applied decision as outstanding work. */
  const d2 = "PC151-01/Divan:8\"/Front Drawer";
  const recorded = compare(d2, [line({ variants: { specialsRecorded: ["Front Drawer"] } })]);
  assert.equal(recorded.specials.verdict, RECORDED);
  assert.match(recorded.specials.detail, /specialsRecorded/);
});

test("RECORDED never swallows a real gap: a PARTIAL cover stays DIFFER", () => {
  /* The failure mode of the fix, pinned. If ANY option the book asks for is
     neither ticked nor recorded, the line is still a gap — rounding a partial
     cover up to "decided" is how work disappears from a backlog. */
  const d2 = "PC151-01/Divan:8\"/Front Drawer/Left Drawer";
  const axes = compare(d2, [line({ variants: { specialsRecorded: ["Front Drawer"] } })]);
  assert.equal(axes.specials.verdict, DIFFER);
  assert.match(axes.specials.detail, /Left Drawer/);
  assert.match(axes.specials.detail, /IS recorded money-neutrally/);
});

test("a recorded option is NOT counted as carried — the line still does not tick it", () => {
  /* `specialsRecorded` must never be merged into the carried list: the ERP
     column the reader reports has to keep saying what the line actually holds,
     or the next reader cannot tell a ticked option from a recorded one. */
  const d2 = "PC151-01/Divan:8\"/Front Drawer";
  const axes = compare(d2, [line({ variants: { specialsRecorded: ["Front Drawer"] } })]);
  assert.equal(axes.specials.erp, "");
});

test("a double-encoded jsonb specials payload is MEASURED, not read as empty", () => {
  const axes = compare(
    "PC151-01/Divan:8\"/Front Drawer",
    [line({ variants: { specials: '["Front Drawer"]' } })],
  );
  assert.equal(axes.specials.verdict, AGREE);
});

test("an item group with no variant axes is never scored", () => {
  const axes = compare("anything at all", [line({ item_group: "accessory" })]);
  assert.deepEqual(Object.keys(axes), []);
});

test("inches() reads every spelling the ERP has written", () => {
  assert.equal(inches('8"'), 8);
  assert.equal(inches("24"), 24);
  assert.equal(inches('32.5"'), 32.5);
  assert.equal(inches(""), null);
  assert.equal(inches(null), null);
});

test("multisetDiff names what each side is short of", () => {
  assert.equal(multisetDiff(["1NA", "CNR"], ["CNR", "1NA"]), null);
  assert.deepEqual(multisetDiff(["1NA"], ["1NA", "CNR"]), { miss: ["CNR"], extra: [] });
  assert.deepEqual(multisetDiff(["1NA", "1NA"], ["1NA"]), { miss: [], extra: ["1NA"] });
});
