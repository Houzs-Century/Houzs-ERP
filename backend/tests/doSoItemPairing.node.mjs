// Guards for the pairing that repairs a Delivery Order line's lost link to its
// Sales Order line (scripts/lib/do-so-item-pairing.mjs).
//
// The repair writes into delivery history, so the interesting cases are the
// ones where it must REFUSE. A wrong link credits one line's shipment against
// another and is indistinguishable from a fact afterwards; a missing link is at
// least visible as the shortage it causes.
//
// RUN IT WITH (from backend/):
//   node --test tests/doSoItemPairing.node.mjs
// Wired into `npm run test:scale-contract`, which is `pretest`.
import assert from "node:assert/strict";
import test from "node:test";
import { pairDoLinesToSoLines, variantIdentity } from "../scripts/lib/do-so-item-pairing.mjs";

const so = (id, item_code, extra = {}) => ({ id, doc_no: "SO-1", item_code, qty: 1, ...extra });
const doLine = (id, item_code, extra = {}) => ({ id, so_doc_no: "SO-1", item_code, qty: 1, ...extra });

test("the common case: one DO line, one SO line of that code", () => {
  const { pairs, unresolved } = pairDoLinesToSoLines([doLine("d1", "XAMMAR-L(LHF)")], [so("s1", "XAMMAR-L(LHF)")]);
  assert.equal(unresolved.length, 0);
  assert.deepEqual(pairs, [
    { doItemId: "d1", soItemId: "s1", so_doc_no: "SO-1", item_code: "XAMMAR-L(LHF)", how: "only line of its code" },
  ]);
});

test("two lines of the same code pair on the colour BOTH documents carry", () => {
  // 2990-SO-2606-016 / 2990-DO-2608-005: two CODY-(K), BF-10 and BF-12.
  const dos = [
    doLine("d-bf12", "CODY-(K)", { variants: { colourId: "BF-12", pwpCode: "PWP-2995KJGU" } }),
    doLine("d-bf10", "CODY-(K)", { variants: { colourId: "BF-10", pwpCode: "PWP-3085SIOZ" } }),
  ];
  const sos = [
    so("s-bf10", "CODY-(K)", { variants: { colourId: "BF-10", pwpCode: "PWP-3085SIOZ" } }),
    so("s-bf12", "CODY-(K)", { variants: { colourId: "BF-12", pwpCode: "PWP-2995KJGU" } }),
  ];
  const { pairs, unresolved } = pairDoLinesToSoLines(dos, sos);
  assert.equal(unresolved.length, 0);
  const got = Object.fromEntries(pairs.map((p) => [p.doItemId, p.soItemId]));
  // Crossed, not positional — the DO is listed BF-12 first, the SO BF-10 first.
  assert.deepEqual(got, { "d-bf12": "s-bf12", "d-bf10": "s-bf10" });
});

test("refuses two same-code lines that carry no distinguishing variant", () => {
  const dos = [doLine("d1", "CODY-(K)"), doLine("d2", "CODY-(K)")];
  const sos = [so("s1", "CODY-(K)"), so("s2", "CODY-(K)")];
  const { pairs, unresolved } = pairDoLinesToSoLines(dos, sos);
  assert.equal(pairs.length, 0, "an arbitrary bijection is still a guess");
  assert.equal(unresolved.length, 1);
  assert.match(unresolved[0].reason, /do not pair one-to-one/);
});

test("refuses when two lines claim the SAME identity", () => {
  const v = { variants: { colourId: "BF-10" } };
  const { pairs, unresolved } = pairDoLinesToSoLines(
    [doLine("d1", "CODY-(K)", v), doLine("d2", "CODY-(K)", v)],
    [so("s1", "CODY-(K)", v), so("s2", "CODY-(K)", v)],
  );
  assert.equal(pairs.length, 0);
  assert.equal(unresolved.length, 1);
});

test("refuses a DO line whose code is on no SO line at all", () => {
  const { pairs, unresolved } = pairDoLinesToSoLines([doLine("d1", "GHOST-ITEM")], [so("s1", "CODY-(K)")]);
  assert.equal(pairs.length, 0);
  assert.equal(unresolved[0].reason, "no SO line with this item code");
});

test("never pairs across sales orders", () => {
  const { pairs, unresolved } = pairDoLinesToSoLines(
    [{ id: "d1", so_doc_no: "SO-1", item_code: "CODY-(K)", qty: 1 }],
    [{ id: "s1", doc_no: "SO-2", item_code: "CODY-(K)", qty: 1 }],
  );
  assert.equal(pairs.length, 0, "SO-2's line is not a candidate for SO-1's delivery");
  assert.equal(unresolved.length, 1);
});

test("variantIdentity prefers the most specific field available", () => {
  assert.equal(variantIdentity({ variants: { pwpCode: "P1", colourId: "C1" } }), "pwp:P1");
  assert.equal(variantIdentity({ variants: { colourId: "C1" } }), "colour:C1");
  assert.equal(variantIdentity({ description2: "BF-10 / DIVAN 8\"" }), 'd2:BF-10 / DIVAN 8"');
  assert.equal(variantIdentity({}), "");
  // An array-shaped variants blob (the jsonb double-encoding COE) is not an
  // identity — it must fall through, not throw.
  assert.equal(variantIdentity({ variants: [] }), "");
});
