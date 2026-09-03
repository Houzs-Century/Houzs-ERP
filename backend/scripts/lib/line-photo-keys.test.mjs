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
