import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fakeSb } from './fake-postgrest';
import { fairStateLabel, fairStateOf, recordFairChange } from './fair-audit';
import { canReassignFair } from './fair-reassign';
import type { FairDb } from './fair-binding';
import type { Variables } from '../env';

/* Every change of an order's fair is in its History (owner 2026-10-16 / 10-19),
 * named as the FAIR and the booth's brand — never a project id — and only
 * Finance or PMS may re-assign one from the settle screen. */

const booth = { projectId: 340, venue: 'MID VALLEY', organizer: 'REX', brand: 'AKEMI', startDate: '2026-10-15', endDate: '2026-10-18', status: 'confirmed' };

describe('fairStateLabel — how History names a fair state', () => {
  it('a linked booth reads as its fair, then its brand', () => {
    expect(fairStateLabel({ projectId: 340, fairMatch: 'PICKED' }, booth)).toBe('MID VALLEY — REX (10/15 - 10/18) · AKEMI');
  });
  it('the unlinked states say why, and No fair says so', () => {
    expect(fairStateLabel({ projectId: null, fairMatch: 'NO_FAIR' }, undefined)).toBe('No fair');
    expect(fairStateLabel({ projectId: null, fairMatch: 'AMBIGUOUS' }, undefined)).toBe('Not linked (two booths fit)');
    expect(fairStateLabel({ projectId: null, fairMatch: null }, undefined)).toBe('Not linked');
  });
  it('a booth PMS no longer has still names itself by number rather than vanishing', () => {
    expect(fairStateLabel({ projectId: 999, fairMatch: 'PICKED' }, undefined)).toBe('Fair #999');
  });
  it('reads the order columns', () => {
    expect(fairStateOf({ project_id: '340', fair_match: 'PICKED' })).toEqual({ projectId: 340, fairMatch: 'PICKED' });
    expect(fairStateOf({ project_id: null, fair_match: undefined })).toEqual({ projectId: null, fairMatch: null });
  });
});

describe('recordFairChange — one History row per move', () => {
  const db: FairDb = {
    prepare: () => ({ bind: () => ({ all: async <T>() => ({ results: [{ id: 340, venue: 'MID VALLEY', organizer: 'REX', brand: 'AKEMI', startdate: '2026-10-15', enddate: '2026-10-18', status: 'confirmed' }] as unknown as T[] }) }) }),
  };

  it('writes the move with both sides named, who did it, and why', async () => {
    const tables: Record<string, Array<Record<string, unknown>>> = {
      mfg_sales_orders: [{ doc_no: 'HC-SO-2610-001', company_id: 1 }],
      mfg_so_audit_log: [],
    };
    await recordFairChange({
      sb: fakeSb(tables, {}) as unknown as SupabaseClient, db, companySql: ' AND p.company_id = 1', docNo: 'HC-SO-2610-001',
      before: { projectId: null, fairMatch: 'AMBIGUOUS' }, after: { projectId: 340, fairMatch: 'PICKED' },
      how: 'settle', actorId: 'staff-1', actorName: 'Finance Person', note: 'checked the slip',
    });
    expect(tables.mfg_so_audit_log).toEqual([expect.objectContaining({
      so_doc_no: 'HC-SO-2610-001', action: 'UPDATE_FAIR', source: 'settle',
      field_changes: [{ field: 'fair', from: 'Not linked (two booths fit)', to: 'MID VALLEY — REX (10/15 - 10/18) · AKEMI' }],
    })]);
  });

  it('nothing changed, nothing written', async () => {
    const tables: Record<string, Array<Record<string, unknown>>> = { mfg_sales_orders: [], mfg_so_audit_log: [] };
    await recordFairChange({
      sb: fakeSb(tables, {}) as unknown as SupabaseClient, db, companySql: '', docNo: 'X',
      before: { projectId: 340, fairMatch: 'PICKED' }, after: { projectId: 340, fairMatch: 'PICKED' },
      how: 'edit', actorId: null, actorName: null,
    });
    expect(tables.mfg_so_audit_log).toEqual([]);
  });
});

describe('canReassignFair — Finance or PMS (owner 2026-10-16: 「就开放 finance 和 pms 啊」)', () => {
  const as = (u: Partial<NonNullable<Variables['houzsUser']>>) => ({
    get: () => ({ id: 1, permissions_set: new Set<string>(), ...u } as Variables['houzsUser']),
  });
  it('Finance, and the owner / IT wildcard', () => {
    expect(canReassignFair(as({ permissions_set: new Set(['scm.finance.accounting']) }))).toBe(true);
    expect(canReassignFair(as({ permissions_set: new Set(['*']) }))).toBe(true);
  });
  it('PMS — whoever may open a fair: a BD role, the Owner position, weisiang', () => {
    expect(canReassignFair(as({ role_name: 'BD Executive' }))).toBe(true);
    expect(canReassignFair(as({ position_name: 'Owner' }))).toBe(true);
    expect(canReassignFair(as({ email: 'weisiang329@gmail.com' }))).toBe(true);
  });
  it('anyone else may not — a salesperson changes their own order instead', () => {
    expect(canReassignFair(as({ position_name: 'Sales Executive', permissions_set: new Set(['scm.access', 'scm.sales.orders']) }))).toBe(false);
  });
});
