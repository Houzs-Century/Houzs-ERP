import { describe, expect, test } from 'vitest';

import {
  PLAN_MAX_AGE_CEILING_MIN,
  buildPlan,
  checkRowPrecondition,
  planDigest,
  resolveMaxAgeMinutes,
  verifyPlanEnvelope,
} from '../scripts/lib/photo-repair-plan.mjs';

/* ---------------------------------------------------------------------------
   THE STALENESS GUARD IS THE POINT OF THE PLAN FILE.

   The two AutoCount line-photo repairs need two credentials in one process: an
   R2 token, because "this address is dead" is a fact about the bucket, and a
   WRITING database URL. This repository is public, so the R2 token can never be
   an Actions secret — it reads every photograph the company owns. So the plan
   is computed where the bucket can be asked and applied where the database can
   be written, and the plan file is what crosses between them.

   That is exactly the shape of the failure this repo has already paid for:
   `backend/scripts/backfill-photo-urls-from-keys.mjs` replayed a MONTH-OLD key
   log and attached 64 addresses with no object behind them
   (docs/bugs/0625-a-backfill-replayed-the-round-1-photo-key-log-without-asking.md).
   A minutes-old, freshly verified plan is a different object from a month-old
   log ONLY IF something enforces the difference. These tests are that
   something.
   ------------------------------------------------------------------------ */

const PRUNE = 'prune-dead-line-photo-keys';
const REPOINT = 'repoint-line-photos-to-owning-line';

const ACCOUNT = '816e457307d7fa0491c2a08a72ad5dcd';
const BUCKET = 'houzs-erp';

const R1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const R2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const OLD = 'cccccccc-3333-4333-8333-cccccccccccc';
const K = (doc: string, row: string, dtl: string, n: number) =>
  `po-items/${doc}/${row}/ac-${dtl}-${n}.jpg`;

const NOW = new Date('2026-09-04T10:00:00.000Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

const pruneOps = () => [
  {
    arm: 'PURCHASE ORDER',
    id: R1,
    doc: 'HC-PO-1',
    dtl: '778434',
    drop: K('HC-PO-1', OLD, '778434', 1),
    keeps: [K('HC-PO-1', R1, '778434', 1)],
  },
  {
    arm: 'PURCHASE ORDER',
    id: R2,
    doc: 'HC-PO-2',
    dtl: '778436',
    drop: K('HC-PO-2', OLD, '778436', 1),
    keeps: [K('HC-PO-2', R2, '778436', 1)],
  },
];

const freshPrunePlan = (generatedAt = NOW) =>
  buildPlan({
    kind: PRUNE,
    account: ACCOUNT,
    bucket: BUCKET,
    company: 1,
    ops: pruneOps(),
    generatedAt,
  });

const expectOf = (plan: any) => ({
  kind: plan.kind,
  account: ACCOUNT,
  bucket: BUCKET,
  company: 1,
  now: NOW,
  maxAgeMinutes: PLAN_MAX_AGE_CEILING_MIN,
});

const codes = (r: { problems: { code: string }[] }) => r.problems.map((p) => p.code);

describe('the plan envelope', () => {
  test('a plan written minutes ago, for this bucket and this company, is accepted', () => {
    const plan = freshPrunePlan(minutesAgo(7));
    const v = verifyPlanEnvelope(plan, expectOf(plan));
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    expect(Math.round(v.ageMinutes!)).toBe(7);
    expect(plan.count).toBe(2);
  });

  test('a stale plan is refused — older than the ceiling, however valid it is', () => {
    const plan = freshPrunePlan(minutesAgo(PLAN_MAX_AGE_CEILING_MIN + 1));
    const v = verifyPlanEnvelope(plan, expectOf(plan));
    expect(v.ok).toBe(false);
    expect(codes(v)).toContain('stale');
    // The digest is INTACT. Staleness is not a corruption; it is age, and age
    // alone has to be enough to refuse — that is the whole difference between
    // this and the month-old key log.
    expect(codes(v)).not.toContain('digest-mismatch');
  });

  test('a plan dated in the future is refused too — a forward clock is not freshness', () => {
    const plan = freshPrunePlan(new Date(NOW.getTime() + 30 * 60_000));
    expect(codes(verifyPlanEnvelope(plan, expectOf(plan)))).toContain('future');
  });

  test('the max age may be lowered but NEVER raised', () => {
    expect(resolveMaxAgeMinutes(undefined).minutes).toBe(PLAN_MAX_AGE_CEILING_MIN);
    expect(resolveMaxAgeMinutes('30').minutes).toBe(30);
    expect(resolveMaxAgeMinutes('1440').error).toMatch(/ceiling/i);
    expect(resolveMaxAgeMinutes('0').error).toBeTruthy();
    expect(resolveMaxAgeMinutes('-5').error).toBeTruthy();
    expect(resolveMaxAgeMinutes('soon').error).toBeTruthy();
  });

  test('a tampered digest is refused — one address changed after signing', () => {
    const plan = freshPrunePlan(minutesAgo(3));
    plan.ops[0].drop = K('HC-PO-1', OLD, '999999', 1); // a different photograph
    const v = verifyPlanEnvelope(plan, expectOf(plan));
    expect(v.ok).toBe(false);
    expect(codes(v)).toContain('digest-mismatch');
  });

  test('a tampered TIMESTAMP is refused — re-dating a stale plan breaks its digest', () => {
    const plan = freshPrunePlan(minutesAgo(PLAN_MAX_AGE_CEILING_MIN + 60));
    plan.generatedAt = minutesAgo(1).toISOString(); // "make it fresh"
    expect(codes(verifyPlanEnvelope(plan, expectOf(plan)))).toContain('digest-mismatch');
  });

  test('a plan for another company, bucket, account or repair is refused', () => {
    const plan = freshPrunePlan(minutesAgo(3));
    expect(codes(verifyPlanEnvelope(plan, { ...expectOf(plan), company: 2 }))).toContain('wrong-company');
    expect(codes(verifyPlanEnvelope(plan, { ...expectOf(plan), bucket: 'houzs-erp-staging' }))).toContain('wrong-bucket');
    expect(codes(verifyPlanEnvelope(plan, { ...expectOf(plan), account: 'deadbeef' }))).toContain('wrong-account');
    expect(codes(verifyPlanEnvelope(plan, { ...expectOf(plan), kind: REPOINT }))).toContain('wrong-kind');
  });

  test('a count that disagrees with the operation list is refused', () => {
    const plan = freshPrunePlan(minutesAgo(3));
    plan.count = 99;
    expect(codes(verifyPlanEnvelope(plan, expectOf(plan)))).toContain('digest-mismatch');
  });

  test('an op naming a table this script does not have is refused', () => {
    const plan = buildPlan({
      kind: PRUNE,
      account: ACCOUNT,
      bucket: BUCKET,
      company: 1,
      generatedAt: minutesAgo(3),
      ops: [{ ...pruneOps()[0], arm: 'scm.mfg_sales_order_items; DROP TABLE' }],
    });
    const v = verifyPlanEnvelope(plan, { ...expectOf(plan), arms: ['SALES ORDER', 'PURCHASE ORDER'] });
    expect(codes(v)).toContain('unknown-arm');
  });

  test('a plan that is not a plan at all is refused, not crashed on', () => {
    expect(verifyPlanEnvelope(null, expectOf({ kind: PRUNE })).ok).toBe(false);
    expect(codes(verifyPlanEnvelope({ kind: PRUNE }, expectOf({ kind: PRUNE })))).toContain('plan-shape');
  });

  test('the digest covers the header, not only the operations', () => {
    const a = freshPrunePlan(minutesAgo(3));
    const b = { ...a, company: 2 };
    expect(planDigest(b)).not.toEqual(a.digest);
  });
});

describe('the per-row precondition — what stops a plan that WAS true', () => {
  test('a row whose column drifted is refused while its siblings still apply', () => {
    const ops = pruneOps();
    // Row 1 moved after the plan was written: the working sibling that licensed
    // the prune is gone, so dropping the dead address would leave the line with
    // no picture at all. Row 2 is untouched and must still be repaired.
    const drifted = [ops[0].drop]; // the keeps address is no longer there
    const intact = [ops[1].drop, ...ops[1].keeps];

    const bad = checkRowPrecondition(PRUNE, ops[0], drifted);
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('drifted-missing');
    expect(bad.why).toContain(ops[0].keeps[0]);

    expect(checkRowPrecondition(PRUNE, ops[1], intact)).toEqual({ ok: true });
  });

  test('a prune whose dead address is already gone is refused, not silently skipped', () => {
    const op = pruneOps()[0];
    const r = checkRowPrecondition(PRUNE, op, op.keeps);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('drifted-missing');
  });

  test('an address that appeared after the plan does not block a prune', () => {
    const op = pruneOps()[0];
    const withAnUpload = [op.drop, ...op.keeps, 'po-items/HC-PO-1/x/operator-upload.jpg'];
    expect(checkRowPrecondition(PRUNE, op, withAnUpload)).toEqual({ ok: true });
  });

  test('a re-point is refused when the target row already carries what it was going to add', () => {
    const op = {
      arm: 'PURCHASE ORDER',
      id: R2,
      doc: 'HC-PO-1',
      dtl: '778436',
      code: 'AKEMI (SP)',
      before: [],
      add: [K('HC-PO-1', R1, '778436', 2)],
    };
    expect(checkRowPrecondition(REPOINT, op, [])).toEqual({ ok: true });
    const r = checkRowPrecondition(REPOINT, op, op.add);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('drifted-present');
  });

  test('a re-point is refused when the target row lost an address the plan saw', () => {
    const kept = K('HC-PO-1', R2, '000000', 1);
    const op = {
      arm: 'PURCHASE ORDER',
      id: R2,
      doc: 'HC-PO-1',
      dtl: '778436',
      code: 'AKEMI (SP)',
      before: [kept],
      add: [K('HC-PO-1', R1, '778436', 2)],
    };
    expect(checkRowPrecondition(REPOINT, op, [kept])).toEqual({ ok: true });
    expect(checkRowPrecondition(REPOINT, op, []).code).toBe('drifted-missing');
  });

  test('a column that is not an array is refused — the jsonb double-encoding shape', () => {
    const op = pruneOps()[0];
    const r = checkRowPrecondition(PRUNE, op, '{"a"}' as unknown as string[]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('not-an-array');
  });

  test('a row the plan named but the database no longer has is refused', () => {
    const op = pruneOps()[0];
    const r = checkRowPrecondition(PRUNE, op, null as unknown as string[]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('not-an-array');
  });
});
