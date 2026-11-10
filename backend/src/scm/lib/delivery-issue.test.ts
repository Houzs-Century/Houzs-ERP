// "Delivered with issue": the crew's POD problem report records an issue row
// and opens a Service Case linked to the SO + DO with the photos, without
// touching the delivery's status; every read and write of the row stays inside
// the caller's companies.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createAssrCase = vi.fn();
const saveAttachment = vi.fn();
const logActivity = vi.fn();
vi.mock('../../services/assr', () => ({
  createAssrCase: (...a: unknown[]) => createAssrCase(...a),
  saveAttachment: (...a: unknown[]) => saveAttachment(...a),
  logActivity: (...a: unknown[]) => logActivity(...a),
}));
vi.mock('../../services/assrNotify', () => ({ notifyServiceCaseResponsible: vi.fn(async () => undefined) }));
const claimPodPhotos = vi.fn();
vi.mock('./pod-photo-claim', async (orig) => ({ ...(await orig<Record<string, unknown>>()), claimPodPhotos: (...a: unknown[]) => claimPodPhotos(...a) }));

import {
  parseDeliveryIssueBody, deliveryIssueComplaint, reportDeliveryIssue, listDeliveryIssues,
  DELIVERY_ISSUE_CATEGORY, type DeliveryIssueTarget,
} from './delivery-issue';

type Call = { table: string; op: string; args: unknown[] };

/** A PostgREST builder fake: records every chained call per statement. */
function fakeSb(results: { insert?: unknown; update?: unknown; select?: unknown[] } = {}) {
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
      b.then = (res: (v: unknown) => unknown) => res({ data: op === 'select' ? (results.select ?? []) : null, error: null });
      return b;
    },
  };
  return { sb, calls };
}

function ctx(sb: unknown, opts: { allowed?: number[] | undefined; active?: number } = {}) {
  const vars: Record<string, unknown> = {
    supabase: sb,
    user: { id: 'staff-1' },
    houzsUser: { id: 42, name: 'Aimir' },
    allowedCompanyIds: 'allowed' in opts ? opts.allowed : [1],
    companyId: opts.active,
  };
  const DB = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };
  return { get: (k: string) => vars[k], env: { DB } } as unknown as Parameters<typeof listDeliveryIssues>[0];
}

const DO_TARGET: DeliveryIssueTarget = {
  companyId: 1, deliveryOrderId: '11111111-1111-1111-1111-111111111111', doNumber: 'HC-DO-000100',
  soDocNo: 'HC-SO-000200', job: null, caseDocNo: 'HC-SO-000200', where: 'HC-DO-000100 (SO HC-SO-000200)',
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
    createAssrCase.mockReset(); saveAttachment.mockReset(); logActivity.mockReset(); claimPodPhotos.mockReset();
    claimPodPhotos.mockResolvedValue({ ok: true, keys: ['slips/p1', 'slips/p2'] });
  });

  it('opens a case on the SO, linked to the DO, with the photos as complaint photos', async () => {
    createAssrCase.mockResolvedValue({ id: 77, assr_no: 'ASSR/2611-001' });
    const { sb, calls } = fakeSb({ insert: { id: 'iss-1' }, update: { id: 'iss-1', assr_no: 'ASSR/2611-001' } });
    const r = await reportDeliveryIssue(ctx(sb), DO_TARGET, { kinds: ['damaged'], note: null, photoKeys: ['slips/p1', 'slips/p2'] });
    expect(r).toMatchObject({ ok: true, issue: { assr_no: 'ASSR/2611-001' } });

    const input = createAssrCase.mock.calls[0]![1];
    expect(input).toMatchObject({
      doc_no: 'HC-SO-000200', delivery_order: 'HC-DO-000100', issue_category: DELIVERY_ISSUE_CATEGORY,
      company_id: 1, created_by: 42, items: [],
    });
    expect(saveAttachment.mock.calls.map((a) => [a[1], a[2], a[5]])).toEqual([[77, 'slips/p1', 'complaint'], [77, 'slips/p2', 'complaint']]);

    const insert = calls[0]!.find((x) => x.op === 'insert')!.args[0] as Record<string, unknown>;
    expect(insert).toMatchObject({ company_id: 1, delivery_order_id: DO_TARGET.deliveryOrderId, kinds: ['damaged'], photo_keys: ['slips/p1', 'slips/p2'] });
    // The link-up write is company-scoped and never touches delivery_orders (status stays as it is).
    const link = calls[1]!;
    expect(link.find((x) => x.op === 'update')!.args[0]).toEqual({ assr_case_id: 77, assr_no: 'ASSR/2611-001' });
    expect(link.find((x) => x.op === 'in')!.args).toEqual(['company_id', [1]]);
    expect(calls.flat().some((x) => x.table === 'delivery_orders')).toBe(false);
  });

  it('a failed case create removes the issue row so a retry starts clean', async () => {
    createAssrCase.mockRejectedValue(new Error('db down'));
    const { sb, calls } = fakeSb({ insert: { id: 'iss-2' } });
    const r = await reportDeliveryIssue(ctx(sb), DO_TARGET, { kinds: ['damaged'], note: null, photoKeys: [] });
    expect(r).toMatchObject({ ok: false, error: 'case_failed' });
    const del = calls[1]!;
    expect(del.some((x) => x.op === 'delete')).toBe(true);
    expect(del.find((x) => x.op === 'in')!.args).toEqual(['company_id', [1]]);
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
    createAssrCase.mockResolvedValue({ id: 5, assr_no: 'ASSR/2611-002' });
    const { sb, calls } = fakeSb({ insert: { id: 'iss-3' }, update: { id: 'iss-3' } });
    await reportDeliveryIssue(ctx(sb, { allowed: [2], active: 2 }), {
      ...DO_TARGET, companyId: null, deliveryOrderId: null, doNumber: null, soDocNo: null,
      job: { sourceType: 'project', sourceId: '9', leg: 'SETUP' }, caseDocNo: 'PRJ-9', where: 'SETUP job PRJ-9',
    }, { kinds: ['missing_part'], note: null, photoKeys: [] });
    expect((calls[0]!.find((x) => x.op === 'insert')!.args[0] as Record<string, unknown>)).toMatchObject({
      company_id: 2, source_type: 'project', source_id: '9', leg: 'SETUP',
    });
    expect(createAssrCase.mock.calls[0]![1]).toMatchObject({ doc_no: 'PRJ-9', company_id: 2, delivery_order: null });
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
