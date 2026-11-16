// "Delivered with issue": the crew's POD problem report records an issue row
// with the photos kept on the POD, WITHOUT opening a Service Case (owner
// 2026-11-16 — the office opens the case). createCaseForDeliveryIssue is the
// office action that opens the case and files the POD photos onto it. Every
// read and write of the row stays inside the caller's companies, and the
// delivery's status is never touched.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createAssrCase = vi.fn();
const saveAttachment = vi.fn();
const logActivity = vi.fn();
vi.mock('../../services/assr', () => ({
  createAssrCase: (...a: unknown[]) => createAssrCase(...a),
  saveAttachment: (...a: unknown[]) => saveAttachment(...a),
  logActivity: (...a: unknown[]) => logActivity(...a),
}));
const notifyServiceCaseResponsible = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('../../services/assrNotify', () => ({ notifyServiceCaseResponsible: (...a: unknown[]) => notifyServiceCaseResponsible(...a) }));
const claimPodPhotos = vi.fn();
vi.mock('./pod-photo-claim', async (orig) => ({ ...(await orig<Record<string, unknown>>()), claimPodPhotos: (...a: unknown[]) => claimPodPhotos(...a) }));

import {
  parseDeliveryIssueBody, deliveryIssueComplaint, reportDeliveryIssue, createCaseForDeliveryIssue, listDeliveryIssues,
  DELIVERY_ISSUE_CATEGORY, type DeliveryIssueTarget,
} from './delivery-issue';

type Call = { table: string; op: string; args: unknown[] };

/** A PostgREST builder fake: records every chained call per statement.
 *  `load` feeds `.maybeSingle()` (the office create's row read); `insert` /
 *  `update` feed `.single()`; `select` feeds an awaited list read. */
function fakeSb(results: { insert?: unknown; update?: unknown; select?: unknown[]; load?: unknown } = {}) {
  const calls: Call[][] = [];
  const sb = {
    from(table: string) {
      const stmt: Call[] = [];
      calls.push(stmt);
      let op = 'select';
      const b: Record<string, unknown> = {};
      const rec = (name: string) => (...args: unknown[]) => {
        if (['insert', 'update', 'delete'].includes(name)) op = name;
        stmt.push({ table, op: name, args });
        return b;
      };
      for (const m of ['insert', 'update', 'delete', 'select', 'eq', 'in', 'or', 'order', 'limit']) b[m] = rec(m);
      b.single = async () => ({ data: op === 'insert' ? results.insert : results.update, error: null });
      b.maybeSingle = async () => ({ data: results.load ?? null, error: null });
      b.then = (res: (v: unknown) => unknown) => res({ data: op === 'select' ? (results.select ?? []) : null, error: null });
      return b;
    },
  };
  return { sb, calls };
}

function ctx(sb: unknown, opts: { allowed?: number[] | undefined; active?: number; reporterName?: string | null } = {}) {
  const vars: Record<string, unknown> = {
    supabase: sb,
    user: { id: 'staff-1' },
    houzsUser: { id: 42, name: 'Aimir' },
    allowedCompanyIds: 'allowed' in opts ? opts.allowed : [1],
    companyId: opts.active,
  };
  // env.DB answers the reporter-name lookup and the PIC read back. A single
  // stub row is enough for both reads in these tests.
  const first = async () => (opts.reporterName !== undefined ? { name: opts.reporterName } : null);
  const DB = { prepare: () => ({ bind: () => ({ first }) }) };
  return { get: (k: string) => vars[k], env: { DB } } as unknown as Parameters<typeof listDeliveryIssues>[0];
}

const DO_TARGET: DeliveryIssueTarget = {
  companyId: 1, deliveryOrderId: '11111111-1111-1111-1111-111111111111', doNumber: 'HC-DO-000100',
  soDocNo: 'HC-SO-000200', job: null,
};

/** A stored delivery_issues row the office create reads back. */
const ISSUE_ROW = {
  id: 'iss-1', company_id: 1, delivery_order_id: '11111111-1111-1111-1111-111111111111',
  do_number: 'HC-DO-000100', so_doc_no: 'HC-SO-000200', source_type: null, source_id: null, leg: null,
  kinds: ['damaged'], note: 'Back panel cracked', photo_keys: ['slips/p1', 'slips/p2'],
  assr_case_id: null, assr_no: null, reported_by: 42, reported_at: '2026-11-16T02:00:00Z',
};

describe('parseDeliveryIssueBody', () => {
  it('needs at least one problem', () => {
    expect(parseDeliveryIssueBody({ kinds: [] })).toMatchObject({ ok: false, error: 'kind_required' });
    expect(parseDeliveryIssueBody(null)).toMatchObject({ ok: false, error: 'kind_required' });
  });
  it('refuses an unknown problem type', () => {
    expect(parseDeliveryIssueBody({ kinds: ['scratched'] })).toMatchObject({ ok: false, error: 'invalid_kind' });
  });
  it('needs a note when Other is ticked', () => {
    expect(parseDeliveryIssueBody({ kinds: ['other'], note: '  ' })).toMatchObject({ ok: false, error: 'note_required' });
    expect(parseDeliveryIssueBody({ kinds: ['other'], note: 'Leg wobbles' })).toMatchObject({ ok: true });
  });
  it('keeps the kinds in list order, de-duplicated', () => {
    const r = parseDeliveryIssueBody({ kinds: ['wrong_item', 'damaged', 'damaged'], photoKeys: ['slips/a'] });
    expect(r).toEqual({ ok: true, value: { kinds: ['damaged', 'wrong_item'], note: null, photoKeys: ['slips/a'] } });
  });
  it('caps the photos', () => {
    expect(parseDeliveryIssueBody({ kinds: ['damaged'], photoKeys: Array(11).fill('slips/x') })).toMatchObject({ ok: false, error: 'too_many_photos' });
  });
});

describe('deliveryIssueComplaint', () => {
  it('names the delivery, the problems in words and the note', () => {
    const t = deliveryIssueComplaint('HC-DO-1 (SO HC-SO-2)', ['damaged', 'missing_part'], 'Back panel cracked', 'Aimir');
    expect(t).toContain('(Aimir)');
    expect(t).toContain('HC-DO-1 (SO HC-SO-2)');
    expect(t).toContain('Problem: Damaged, Missing part.');
    expect(t).toContain('Crew note: Back panel cracked');
  });
});

describe('reportDeliveryIssue', () => {
  beforeEach(() => {
    createAssrCase.mockReset(); saveAttachment.mockReset(); logActivity.mockReset();
    notifyServiceCaseResponsible.mockClear(); claimPodPhotos.mockReset();
    claimPodPhotos.mockResolvedValue({ ok: true, keys: ['slips/p1', 'slips/p2'] });
  });

  it('records the report with its photos on the POD, and opens NO service case', async () => {
    const { sb, calls } = fakeSb({ insert: ISSUE_ROW });
    const r = await reportDeliveryIssue(ctx(sb), DO_TARGET, { kinds: ['damaged'], note: null, photoKeys: ['slips/p1', 'slips/p2'] });
    expect(r).toMatchObject({ ok: true, issue: { id: 'iss-1', assr_case_id: null } });

    // One statement: the insert. No case, no attach, no link, no notify.
    expect(calls).toHaveLength(1);
    const insert = calls[0]!.find((x) => x.op === 'insert')!.args[0] as Record<string, unknown>;
    expect(insert).toMatchObject({ company_id: 1, delivery_order_id: DO_TARGET.deliveryOrderId, kinds: ['damaged'], photo_keys: ['slips/p1', 'slips/p2'] });
    expect(createAssrCase).not.toHaveBeenCalled();
    expect(saveAttachment).not.toHaveBeenCalled();
    expect(notifyServiceCaseResponsible).not.toHaveBeenCalled();
    // The delivery's own status is never touched.
    expect(calls.flat().some((x) => x.table === 'delivery_orders')).toBe(false);
  });

  it('refuses photos that are not the caller\'s uploads before saving anything', async () => {
    claimPodPhotos.mockResolvedValue({ ok: false, reason: 'not yours' });
    const { sb, calls } = fakeSb();
    const r = await reportDeliveryIssue(ctx(sb), DO_TARGET, { kinds: ['damaged'], note: null, photoKeys: ['slips/zz'] });
    expect(r).toMatchObject({ ok: false, status: 400, error: 'photo_not_accepted' });
    expect(calls).toHaveLength(0);
    expect(createAssrCase).not.toHaveBeenCalled();
  });

  it('a job with no company is stamped with the caller\'s active company', async () => {
    const { sb, calls } = fakeSb({ insert: { ...ISSUE_ROW, id: 'iss-3', company_id: 2 } });
    await reportDeliveryIssue(ctx(sb, { allowed: [2], active: 2 }), {
      ...DO_TARGET, companyId: null, deliveryOrderId: null, doNumber: null, soDocNo: null,
      job: { sourceType: 'project', sourceId: '9', leg: 'SETUP' },
    }, { kinds: ['missing_part'], note: null, photoKeys: [] });
    expect((calls[0]!.find((x) => x.op === 'insert')!.args[0] as Record<string, unknown>)).toMatchObject({
      company_id: 2, source_type: 'project', source_id: '9', leg: 'SETUP',
    });
    expect(createAssrCase).not.toHaveBeenCalled();
  });
});

describe('createCaseForDeliveryIssue', () => {
  beforeEach(() => {
    createAssrCase.mockReset(); saveAttachment.mockReset(); logActivity.mockReset();
    notifyServiceCaseResponsible.mockClear();
    createAssrCase.mockResolvedValue({ id: 77, assr_no: 'ASSR/2611-001' });
  });

  it('opens the case on the SO, files the POD photos, and links the report — company-scoped', async () => {
    const { sb, calls } = fakeSb({ load: ISSUE_ROW, update: { ...ISSUE_ROW, assr_case_id: 77, assr_no: 'ASSR/2611-001' } });
    const r = await createCaseForDeliveryIssue(sb, ctx(sb, { reporterName: 'Aimir' }), 'iss-1', 99);
    expect(r).toMatchObject({ ok: true, caseId: 77, assrNo: 'ASSR/2611-001', issue: { assr_no: 'ASSR/2611-001' } });

    const input = createAssrCase.mock.calls[0]![1] as Record<string, unknown>;
    expect(input).toMatchObject({
      doc_no: 'HC-SO-000200', delivery_order: 'HC-DO-000100', issue_category: DELIVERY_ISSUE_CATEGORY,
      company_id: 1, created_by: 99, items: [],
    });
    // The complaint reuses deliveryIssueComplaint, naming the reporter + the problem.
    expect(String(input.complaint_issue)).toContain('(Aimir)');
    expect(String(input.complaint_issue)).toContain('HC-DO-000100 (SO HC-SO-000200)');
    // The crew's POD photos are filed on the case as complaint photos.
    expect(saveAttachment.mock.calls.map((a) => [a[1], a[2], a[5], a[6]])).toEqual([
      [77, 'slips/p1', 'complaint', 99], [77, 'slips/p2', 'complaint', 99],
    ]);
    // The load read and the link write are both company-scoped; nothing touches delivery_orders.
    expect(calls[0]!.find((x) => x.op === 'in')!.args).toEqual(['company_id', [1]]);
    const link = calls[1]!;
    expect(link.find((x) => x.op === 'update')!.args[0]).toEqual({ assr_case_id: 77, assr_no: 'ASSR/2611-001' });
    expect(link.find((x) => x.op === 'in')!.args).toEqual(['company_id', [1]]);
    expect(calls.flat().some((x) => x.table === 'delivery_orders')).toBe(false);
    expect(notifyServiceCaseResponsible).toHaveBeenCalledTimes(1);
  });

  it('refuses a report that already has a case (no duplicate)', async () => {
    const { sb, calls } = fakeSb({ load: { ...ISSUE_ROW, assr_case_id: 55, assr_no: 'ASSR/2611-009' } });
    const r = await createCaseForDeliveryIssue(sb, ctx(sb), 'iss-1', 99);
    expect(r).toMatchObject({ ok: false, status: 409, error: 'already_linked' });
    expect(String((r as { reason: string }).reason)).toContain('ASSR/2611-009');
    expect(createAssrCase).not.toHaveBeenCalled();
    // Only the scoped load ran; no link write.
    expect(calls).toHaveLength(1);
  });

  it('404 when the report is not in the caller\'s companies', async () => {
    const { sb } = fakeSb({ load: null });
    const r = await createCaseForDeliveryIssue(sb, ctx(sb, { allowed: [2] }), 'iss-1', 99);
    expect(r).toMatchObject({ ok: false, status: 404, error: 'not_found' });
    expect(createAssrCase).not.toHaveBeenCalled();
  });
});

describe('listDeliveryIssues', () => {
  it('reads only the caller\'s companies, matching any of the keys', async () => {
    const { sb, calls } = fakeSb({ select: [{ id: 'a' }] });
    const rows = await listDeliveryIssues(ctx(sb, { allowed: [1, 2] }), { soDocNos: ['HC-SO-1'], jobKeys: ['assr:12:delivery', 'bogus'] });
    expect(rows).toEqual([{ id: 'a' }]);
    const stmt = calls[0]!;
    expect(stmt.find((x) => x.op === 'in')!.args).toEqual(['company_id', [1, 2]]);
    expect(stmt.find((x) => x.op === 'or')!.args[0]).toBe('so_doc_no.in.("HC-SO-1"),and(source_type.eq.assr,source_id.eq."12",leg.eq."delivery")');
  });
  it('a caller granted no company reads nothing', async () => {
    const { sb, calls } = fakeSb();
    await listDeliveryIssues(ctx(sb, { allowed: [] }), { soDocNos: ['HC-SO-1'] });
    expect(calls[0]!.find((x) => x.op === 'in')!.args).toEqual(['company_id', []]);
  });
  it('an empty filter makes no query', async () => {
    const { sb, calls } = fakeSb();
    expect(await listDeliveryIssues(ctx(sb), {})).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
