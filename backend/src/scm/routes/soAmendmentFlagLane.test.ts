/* PATCH /so-amendments/:id/flag-lane — the APPROVER saying "this is not mine to
 * approve" (owner 2026-09-17).
 *
 * The flag first shipped in the requester's submit dialog, where nobody can
 * judge it: a salesperson does not know which desk signs what. It belongs to
 * the person reading the change on their desk. Pinned here:
 *
 *  · only someone who could SIGN the row may flag it — a requester, or the
 *    other desk, cannot;
 *  · it is a NOTE, not a transition — status, lane and version do not move, so
 *    the row stays signable where the rule put it;
 *  · a note is required, and a row that is no longer REQUESTED cannot be flagged;
 *  · the History row and the notice both carry the note.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const sb = fakeSb({ so_amendments: [], staff: [] });
const audits: Array<{ action: string; note?: string; fieldChanges: unknown }> = [];
const flagged: Array<Record<string, unknown>> = [];

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));
vi.mock('../lib/so-audit', () => ({
  recordSoAudit: async (_sb: unknown, a: { action: string; note?: string; fieldChanges: unknown }) => { audits.push(a); },
}));
vi.mock('../../services/amendmentNotify', () => ({
  notifySoAmendmentResolved: async () => {},
  notifyPoAmendmentRaised: async () => {},
  notifySoAmendmentLaneFlagged: async (_env: unknown, o: Record<string, unknown>) => { flagged.push(o); },
}));

const { soAmendments } = await import('./so-amendments');

const ROWS = (): Row[] => [
  { id: 'a1', so_doc_no: 'HC-SO-1', amendment_no: 'HC-SO-1/A1', lane: 'DELIVERY', status: 'REQUESTED',   version: 1, company_id: 1, lane_flag_note: null, requested_by: null },
  { id: 'a2', so_doc_no: 'HC-SO-2', amendment_no: 'HC-SO-2/A1', lane: 'DELIVERY', status: 'SO_APPROVED', version: 2, company_id: 1, lane_flag_note: null, requested_by: null },
  { id: 'a3', so_doc_no: 'HC-SO-3', amendment_no: 'HC-SO-3/A1', lane: null,       status: 'REQUESTED',   version: 1, company_id: 1, lane_flag_note: null, requested_by: null },
];

function appFor(permissions: string[]) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('companyId', 1);
    c.set('user', { id: 7, email: 'desk@houzs.test', name: 'Desk', permissions } as unknown as User);
    await next();
  });
  app.route('/', soAmendments);
  return app;
}

const flag = (permissions: string[], id: string, body: unknown) =>
  appFor(permissions).request(`/${id}/flag-lane`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

const row = (id: string) => (sb.tables.so_amendments as Row[]).find((r) => r.id === id)!;

beforeEach(() => { sb.tables.so_amendments = ROWS(); audits.length = 0; flagged.length = 0; });

describe('PATCH /so-amendments/:id/flag-lane', () => {
  it('lets the desk that could sign it flag it, as a note that moves nothing', async () => {
    const res = await flag(['scm.amendment.approve_delivery'], 'a1', { note: '  this is a fabric change, Purchaser approves these ' });
    expect(res.status).toBe(200);
    expect(row('a1').lane_flag_note).toBe('this is a fabric change, Purchaser approves these');
    expect(row('a1').status).toBe('REQUESTED');
    expect(row('a1').lane).toBe('DELIVERY');
    expect(row('a1').version).toBe(1);
    expect(audits.map((a) => a.action)).toEqual(['AMENDMENT_LANE_FLAGGED']);
    expect(audits[0].note).toBe('this is a fabric change, Purchaser approves these');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ amendmentNo: 'HC-SO-1/A1', lane: 'DELIVERY', note: 'this is a fabric change, Purchaser approves these' });
  });

  it('refuses the requester and the OTHER desk — only the row\'s own approver judges its desk', async () => {
    for (const perms of [['scm.amendment.create'], ['scm.amendment.approve_lines'], []]) {
      const res = await flag(perms, 'a1', { note: 'not ours' });
      expect(res.status).toBe(403);
    }
    expect(row('a1').lane_flag_note).toBeNull();
    expect(audits).toHaveLength(0);
    expect(flagged).toHaveLength(0);
  });

  it('requires a note', async () => {
    const res = await flag(['scm.amendment.approve_delivery'], 'a1', { note: '   ' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('note_required');
    expect(row('a1').lane_flag_note).toBeNull();
  });

  it('refuses a row that has already been acted on, and a legacy row with no desk', async () => {
    const applied = await flag(['scm.amendment.approve_delivery'], 'a2', { note: 'wrong desk' });
    expect(applied.status).toBe(409);
    const legacy = await flag(['*'], 'a3', { note: 'wrong desk' });
    expect(legacy.status).toBe(409);
    expect(row('a2').lane_flag_note).toBeNull();
    expect(row('a3').lane_flag_note).toBeNull();
    expect(flagged).toHaveLength(0);
  });
});
