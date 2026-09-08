/**
 * node --test backend/scripts/lib/line-photo-keys.test.mjs
 *
 * Zero dependencies, so it runs on a bare checkout.
 * NO SHEBANG — see the header of line-photo-keys.mjs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { acDtlKeyOf, planDeadKeyPrune, planRepoint, rowIdOf } from './line-photo-keys.mjs';

const K = (doc, row, dtl, n) => `po-items/${doc}/${row}/ac-${dtl}-${n}.jpg`;
const R1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const R2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const OLD = 'cccccccc-3333-4333-8333-cccccccccccc';
const R3 = 'dddddddd-4444-4444-8444-dddddddddddd';

test('an address names its AutoCount line and the row it was minted on', () => {
  assert.equal(acDtlKeyOf(K('HC-PO-1', R1, '778434', 1)), '778434');
  assert.equal(rowIdOf(K('HC-PO-1', R1, '778434', 1)), R1);
  assert.equal(acDtlKeyOf('po-items/HC-PO-1/x/9f2c.jpg'), null, 'an operator upload is not ours');
  assert.equal(rowIdOf('nonsense'), null);
});

test('prune drops a dead address only when the same row still shows that picture', () => {
  const dead = K('HC-PO-1', OLD, '778434', 1);
  const live = K('HC-PO-1', R1, '778434', 1);
  const rows = [{ id: R1, doc: 'HC-PO-1', lineNo: 1, dtl: '778434', pics: [dead, live] }];
  const { prune, wouldBlank } = planDeadKeyPrune(rows, new Set([live]));
  assert.equal(prune.length, 1);
  assert.equal(prune[0].drop, dead);
  assert.deepEqual(prune[0].keeps, [live]);
  assert.equal(wouldBlank.length, 0);
});

test('prune NEVER drops the last copy — a row that would go blank is reported, not repaired', () => {
  const dead = K('HC-PO-1', OLD, '778436', 2);
  const rows = [{ id: R2, doc: 'HC-PO-1', lineNo: 2, dtl: '778436', pics: [dead] }];
  const { prune, wouldBlank } = planDeadKeyPrune(rows, new Set());
  assert.equal(prune.length, 0, 'nothing may be pruned here');
  assert.deepEqual(wouldBlank, [{ id: R2, doc: 'HC-PO-1', dtl: '778436', dead }]);
});

test('a live address for a DIFFERENT line on the same row does not license a prune', () => {
  const dead = K('HC-PO-1', OLD, '778436', 2);
  const other = K('HC-PO-1', R2, '778434', 1);
  const rows = [{ id: R2, doc: 'HC-PO-1', lineNo: 2, dtl: '778436', pics: [dead, other] }];
  const { prune, wouldBlank } = planDeadKeyPrune(rows, new Set([other]));
  assert.equal(prune.length, 0);
  assert.equal(wouldBlank.length, 1);
});

test('re-point moves a line whose picture is live on a sibling row of the same document', () => {
  const live = K('HC-PO-1', R1, '778436', 2);   // minted onto the FIRST row by item code
  const rows = [
    { id: R1, doc: 'HC-PO-1', lineNo: 1, dtl: '778434', itemCode: 'AKEMI (SP)', pics: [K('HC-PO-1', R1, '778434', 1), live] },
    { id: R2, doc: 'HC-PO-1', lineNo: 2, dtl: '778436', itemCode: 'AKEMI (SP)', pics: [] },
  ];
  const plan = planRepoint(rows, new Set([K('HC-PO-1', R1, '778434', 1), live]));
  assert.equal(plan.length, 1);
  assert.equal(plan[0].id, R2);
  assert.deepEqual(plan[0].keys, [live]);
});

test('re-point leaves a sofa build alone — one line, one photo, on the first piece', () => {
  const live = K('HC-PO-2', R1, '831373', 1);
  const rows = [
    { id: R1, doc: 'HC-PO-2', lineNo: 1, dtl: '831373', itemCode: '8050-1A', pics: [live] },
    { id: R2, doc: 'HC-PO-2', lineNo: 2, dtl: '831373', itemCode: '8050-2S', pics: [] },
  ];
  assert.deepEqual(planRepoint(rows, new Set([live])), [], 'the compartment rows are blank by design');
});

test('re-point does nothing when the picture is not in R2 at all', () => {
  const rows = [
    { id: R1, doc: 'HC-PO-3', lineNo: 1, dtl: '1', itemCode: 'A', pics: [K('HC-PO-3', OLD, '2', 1)] },
    { id: R2, doc: 'HC-PO-3', lineNo: 2, dtl: '2', itemCode: 'A', pics: [] },
  ];
  assert.deepEqual(planRepoint(rows, new Set()), []);
});

test('re-point is inert once the key is attached', () => {
  const live = K('HC-PO-4', R1, '5', 2);
  const rows = [
    { id: R1, doc: 'HC-PO-4', lineNo: 1, dtl: '4', itemCode: 'A', pics: [live] },
    { id: R2, doc: 'HC-PO-4', lineNo: 2, dtl: '5', itemCode: 'A', pics: [live] },
  ];
  assert.deepEqual(planRepoint(rows, new Set([live])), [], 'the line now shows its picture');
});

/* docs/bugs/0672 SITE 9 — planRepoint picks `firstRow(group)` for a group keyed
 * on (doc_no, DtlKey), and that key is NOT unique: migrations 0273 and 0280
 * index it non-uniquely, and probe-link-identity.mjs run 34172468269 counted 310
 * such shared keys on the sales-order lines and 106 on the purchase-order lines
 * in production.
 *
 * Taking the first row is the owner's own sofa rule when the group is one
 * build's compartments. It is a coin flip when it is not: the picture lands on
 * whichever row sorted first. The MODEL is what compartments share — their item
 * codes deliberately differ (MODEL-1S, MODEL-2S, MODEL-CNR) — so the model is
 * the test, and every group in production passes it today.
 */
/* ASK WHAT A CLEAN RESULT WOULD ALSO BE TRUE OF. The first draft of these three
   fixtures put the live key on a row INSIDE the group under test, so
   `planRepoint`'s `shows` short-circuit returned [] before any model test could
   run and all three passed against the UNFIXED code. That is this bug class
   wearing a test's clothes — a check that answers a different question and
   prints like a clean one, the same shape docs/bugs/0672 records the PR #3076
   guard falling into. The key now lives on a row with a DIFFERENT DtlKey, so
   the group under test genuinely shows nothing and the model test is what
   decides. */
test('re-point REFUSES a (doc, DtlKey) group holding two different models', () => {
  const live = K('HC-PO-9', R1, '778436', 2);   // minted on R1, which is a DIFFERENT line
  const rows = [
    { id: R1, doc: 'HC-PO-9', lineNo: 1, dtl: '778434', itemCode: 'PC151-2S', pics: [live] },
    { id: R2, doc: 'HC-PO-9', lineNo: 2, dtl: '778436', itemCode: 'PC151-2S', pics: [] },
    { id: R3, doc: 'HC-PO-9', lineNo: 3, dtl: '778436', itemCode: 'PC160-CNR', pics: [] },
  ];
  assert.deepEqual(planRepoint(rows, new Set([live])), [],
    'two models behind one DtlKey: which row owns the picture is unknowable, so nothing moves');
});

test("re-point still moves a sofa build's compartments, which share a model", () => {
  const live = K('HC-PO-9', R1, '778437', 2);
  const rows = [
    { id: R1, doc: 'HC-PO-9', lineNo: 1, dtl: '778434', itemCode: 'PC151-2S', pics: [live] },
    { id: R2, doc: 'HC-PO-9', lineNo: 2, dtl: '778437', itemCode: 'PC151-CNR', pics: [] },
    { id: R3, doc: 'HC-PO-9', lineNo: 3, dtl: '778437', itemCode: 'PC151-1S', pics: [] },
  ];
  const plan = planRepoint(rows, new Set([live]));
  assert.equal(plan.length, 1, 'one build, one target');
  assert.equal(plan[0].id, R2, 'the first compartment row of the group');
});

test('re-point refuses a group where a row carries NO item code at all', () => {
  const live = K('HC-PO-9', R1, '778436', 2);
  const rows = [
    { id: R1, doc: 'HC-PO-9', lineNo: 1, dtl: '778434', itemCode: 'PC151-2S', pics: [live] },
    { id: R2, doc: 'HC-PO-9', lineNo: 2, dtl: '778436', itemCode: 'PC151-2S', pics: [] },
    { id: R3, doc: 'HC-PO-9', lineNo: 3, dtl: '778436', itemCode: '', pics: [] },
  ];
  assert.deepEqual(planRepoint(rows, new Set([live])), [],
    'a blank cannot be asserted equal to anything');
});
