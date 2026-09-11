import { describe, expect, test } from 'vitest';

import { planAttachUploaded } from '../scripts/lib/line-photo-keys.mjs';
import {
  ATTACH_KIND,
  buildPlan,
  checkRowPrecondition,
  verifyPlanEnvelope,
} from '../scripts/lib/photo-repair-plan.mjs';

/* ---------------------------------------------------------------------------
   THE THIRD LINE-PHOTO REPAIR, AND THE ONE NUMBER THAT JUSTIFIES IT.

   `attach-uploaded-line-photos` fills a line that shows NOTHING, once its
   photograph has been uploaded to R2. The obvious alternative — re-run
   `import-po-line-photos.mjs APPLY=1` — was measured on production, company 1,
   2026-09-08 before it was trusted: it would have written 25 addresses where
   the gap needed 10. The extra 15 sit on lines that ALREADY show a picture, and
   R2 holds none of those 15 objects (0 of 15 present, against a 13/13 positive
   control on known-good keys). Writing them is
   docs/bugs/0625-a-backfill-replayed-the-round-1-photo-key-log-without-asking.md
   and docs/bugs/0668 a third time.

   Two guards each independently exclude those 15, and these tests hold both:
   the object must be in the bucket, and the line must be blank today.
   ------------------------------------------------------------------------ */

const ACCOUNT = '816e457307d7fa0491c2a08a72ad5dcd';
const BUCKET = 'houzs-erp';

const FIRST = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SECOND = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const OTHER = 'cccccccc-3333-4333-8333-cccccccccccc';

const K = (doc: string, row: string, dtl: string, n = 1) =>
  `po-items/${doc}/${row}/ac-${dtl}-${n}.jpg`;

/** One sofa build: ONE AutoCount line held as two compartment rows. */
const sofaRows = (pics: string[] = [], siblingPics: string[] = []) => [
  { id: FIRST, doc: 'HC-PO-010085', lineNo: 1, dtl: '917329', itemCode: 'RDS-5527-2S', pics },
  { id: SECOND, doc: 'HC-PO-010085', lineNo: 2, dtl: '917329', itemCode: 'RDS-5527-CNR', pics: siblingPics },
];

const planned = (dtl = '917329', row = FIRST, ns = [1]) =>
  ns.map((n) => ({ key: K('HC-PO-010085', row, dtl, n), doc: 'HC-PO-010085', dtl }));

describe('planAttachUploaded — the blank line gets its uploaded photograph', () => {
  test('attaches to the FIRST piece of the build, once the object is in R2', () => {
    const keys = new Set([K('HC-PO-010085', FIRST, '917329', 1), K('HC-PO-010085', FIRST, '917329', 2)]);
    const { plan } = planAttachUploaded(sofaRows(), planned('917329', FIRST, [1, 2]), keys);

    expect(plan).toHaveLength(1);
    expect(plan[0].id).toBe(FIRST);
    expect(plan[0].keys).toEqual([...keys]);
    /* The sibling compartment stays blank — the owner's rule, 2026-08-10:
       one build, one photograph, on the first piece. */
    expect(plan.some((p) => p.id === SECOND)).toBe(false);
  });

  test('carries `before` so the apply can refuse a column that moved under it', () => {
    const existing = 'po-items/HC-PO-010085/aaaa/operator-upload.jpg';
    const keys = new Set([K('HC-PO-010085', FIRST, '917329')]);
    const { plan } = planAttachUploaded(sofaRows([existing]), planned(), keys);

    expect(plan[0].before).toEqual([existing]);
  });
});

describe('REFUSAL 1 — the object must be in the bucket (docs/bugs/0625, 0668)', () => {
  test('a planned address R2 does not hold is never attached', () => {
    const { plan, skipped } = planAttachUploaded(sofaRows(), planned(), new Set());

    expect(plan).toHaveLength(0);
    expect(skipped[0].why).toMatch(/R2 holds none/);
  });

  test('a line with two planned images attaches only the one that exists', () => {
    const live = K('HC-PO-010085', FIRST, '917329', 1);
    const { plan } = planAttachUploaded(sofaRows(), planned('917329', FIRST, [1, 2]), new Set([live]));

    expect(plan).toHaveLength(1);
    expect(plan[0].keys).toEqual([live]);
    /* The dead one is reported, not silently dropped. */
    expect(plan[0].dead).toEqual([K('HC-PO-010085', FIRST, '917329', 2)]);
  });
});

describe('REFUSAL 2 — a line that already shows a picture is not this repair', () => {
  test('skipped when the FIRST piece already carries a live address', () => {
    const shown = K('HC-PO-010085', FIRST, '917329');
    const extra = K('HC-PO-010085', FIRST, '917329', 2);
    const { plan, skipped } = planAttachUploaded(
      sofaRows([shown]),
      [{ key: extra, doc: 'HC-PO-010085', dtl: '917329' }],
      new Set([shown, extra]),
    );

    /* This is the guard that excluded all 15 of the extra addresses a blanket
       APPLY=1 would have written on 2026-09-08. */
    expect(plan).toHaveLength(0);
    expect(skipped[0].why).toMatch(/already shows/);
  });

  test('skipped when a SIBLING compartment carries it — the line is what shows, not the row', () => {
    const shown = K('HC-PO-010085', SECOND, '917329');
    const { plan, skipped } = planAttachUploaded(
      sofaRows([], [shown]),
      planned(),
      new Set([shown, K('HC-PO-010085', FIRST, '917329')]),
    );

    expect(plan).toHaveLength(0);
    expect(skipped[0].why).toMatch(/already shows/);
  });

  test('an address on the row whose object is GONE does not count as showing', () => {
    const dead = K('HC-PO-010085', FIRST, '917329', 9);
    const fresh = K('HC-PO-010085', FIRST, '917329', 1);
    const { plan } = planAttachUploaded(sofaRows([dead]), planned(), new Set([fresh]));

    expect(plan).toHaveLength(1);
    expect(plan[0].keys).toEqual([fresh]);
    expect(plan[0].before).toEqual([dead]);
  });
});

describe('REFUSAL 3 — "the first row" needs the group to be one model (docs/bugs/0672, 0690)', () => {
  test('two unrelated products behind one DtlKey are refused, not coin-flipped', () => {
    const rows = [
      { id: FIRST, doc: 'HC-PO-010085', lineNo: 1, dtl: '917329', itemCode: 'RDS-5527-2S', pics: [] },
      { id: SECOND, doc: 'HC-PO-010085', lineNo: 2, dtl: '917329', itemCode: 'TBL-9000', pics: [] },
    ];
    const { plan, skipped } = planAttachUploaded(rows, planned(), new Set([K('HC-PO-010085', FIRST, '917329')]));

    expect(plan).toHaveLength(0);
    expect(skipped[0].why).toMatch(/not one model/);
  });

  test('a row with no item code refuses too — a blank cannot be asserted equal', () => {
    const rows = [
      { id: FIRST, doc: 'HC-PO-010085', lineNo: 1, dtl: '917329', itemCode: 'RDS-5527-2S', pics: [] },
      { id: SECOND, doc: 'HC-PO-010085', lineNo: 2, dtl: '917329', itemCode: '', pics: [] },
    ];
    const { plan } = planAttachUploaded(rows, planned(), new Set([K('HC-PO-010085', FIRST, '917329')]));

    expect(plan).toHaveLength(0);
  });
});

describe('the address must name the row it will hang on', () => {
  test('an address minted for a different row is refused, not re-hung', () => {
    const stale = K('HC-PO-010085', OTHER, '917329');
    const { plan, skipped } = planAttachUploaded(sofaRows(), [{ key: stale, doc: 'HC-PO-010085', dtl: '917329' }], new Set([stale]));

    expect(plan).toHaveLength(0);
    expect(skipped.some((s) => /name a row that is not this line's first piece/.test(s.why))).toBe(true);
  });

  test('a book line no ERP row carries is reported, never invented', () => {
    const key = K('HC-PO-099999', FIRST, '888888');
    const { plan, skipped } = planAttachUploaded(sofaRows(), [{ key, doc: 'HC-PO-099999', dtl: '888888' }], new Set([key]));

    expect(plan).toHaveLength(0);
    expect(skipped[0].why).toMatch(/no ERP row/);
  });
});

describe('the ATTACH plan crosses to the writer under the same guards as the other two', () => {
  const ops = [{
    arm: 'PURCHASE ORDER',
    id: FIRST,
    doc: 'HC-PO-010085',
    dtl: '917329',
    before: [],
    add: [K('HC-PO-010085', FIRST, '917329')],
  }];

  test('a fresh, unedited plan for this company and bucket is accepted', () => {
    const plan = buildPlan({ kind: ATTACH_KIND, account: ACCOUNT, bucket: BUCKET, company: 1, ops });
    const verdict = verifyPlanEnvelope(plan, {
      kind: ATTACH_KIND, account: ACCOUNT, bucket: BUCKET, company: 1,
      now: new Date(), maxAgeMinutes: 120, arms: ['SALES ORDER', 'PURCHASE ORDER'],
    });

    expect(verdict.ok).toBe(true);
  });

  test('an ATTACH plan is refused by a script expecting another repair', () => {
    const plan = buildPlan({ kind: ATTACH_KIND, account: ACCOUNT, bucket: BUCKET, company: 1, ops });
    const verdict = verifyPlanEnvelope(plan, {
      kind: 'repoint-line-photos-to-owning-line', account: ACCOUNT, bucket: BUCKET, company: 1,
      now: new Date(), maxAgeMinutes: 120,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.problems.map((p) => p.code)).toContain('wrong-kind');
  });

  test('re-dating a stale ATTACH plan breaks its digest', () => {
    const plan = buildPlan({
      kind: ATTACH_KIND, account: ACCOUNT, bucket: BUCKET, company: 1, ops,
      generatedAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
    });
    const doctored = { ...plan, generatedAt: new Date().toISOString() };
    const verdict = verifyPlanEnvelope(doctored, {
      kind: ATTACH_KIND, account: ACCOUNT, bucket: BUCKET, company: 1,
      now: new Date(), maxAgeMinutes: 120,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.problems.map((p) => p.code)).toContain('digest-mismatch');
  });

  test('the per-row guard refuses a line that gained the address in the meantime', () => {
    const key = K('HC-PO-010085', FIRST, '917329');
    const c = checkRowPrecondition(ATTACH_KIND, { before: [], add: [key] }, [key]);

    expect(c.ok).toBe(false);
    expect(c.code).toBe('drifted-present');
  });

  test('the per-row guard refuses a line that LOST what the plan saw', () => {
    const key = K('HC-PO-010085', FIRST, '917329');
    const had = 'po-items/HC-PO-010085/aaaa/operator-upload.jpg';
    const c = checkRowPrecondition(ATTACH_KIND, { before: [had], add: [key] }, []);

    expect(c.ok).toBe(false);
    expect(c.code).toBe('drifted-missing');
  });

  test('a blank line that is still blank passes', () => {
    const key = K('HC-PO-010085', FIRST, '917329');
    expect(checkRowPrecondition(ATTACH_KIND, { before: [], add: [key] }, []).ok).toBe(true);
  });
});
