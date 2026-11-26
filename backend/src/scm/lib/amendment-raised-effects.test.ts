import { describe, expect, it, vi, beforeEach } from 'vitest';

const audits: Array<Record<string, unknown>> = [];
const notices: Array<Record<string, unknown>> = [];
const staffLookups: Array<string | null | undefined> = [];

vi.mock('./so-audit', () => ({
  recordSoAudit: async (_sb: unknown, row: Record<string, unknown>) => { audits.push(row); },
}));

vi.mock('./salesScope', () => ({
  resolveUserIdByStaffId: async (_sb: unknown, id: string | null | undefined) => {
    staffLookups.push(id);
    return id === 'staff-sales' ? 77 : null;
  },
}));

vi.mock('./companyScope', () => ({ activeCompanyId: () => 1 }));

vi.mock('../../services/amendmentNotify', () => ({
  notifySoAmendmentRaised: async (_env: unknown, opts: Record<string, unknown>) => {
    notices.push(opts);
  },
}));

const { recordAmendmentRequested, notifyAmendmentsRaised } = await import(
  './amendment-raised-effects'
);

const ctx = { env: {}, get: (k: string) => (k === 'houzsUser' ? { id: 40, name: 'Ivy' } : undefined) };

beforeEach(() => { audits.length = 0; notices.length = 0; staffLookups.length = 0; });

describe('amendment-raised effects', () => {
  it('audits the amendment, its lane, and every header change it asked for', async () => {
    await recordAmendmentRequested(null, {
      docNo: 'SO-2608-043',
      amendmentNo: 'SO-2608-043/A1',
      lane: 'DELIVERY',
      actorId: 'user-1',
      actorName: 'Ivy',
      reason: 'customer moved house',
      headerKeys: ['customerDeliveryDate', 'postcode'],
      headerChanges: { customerDeliveryDate: '2026-09-20', postcode: '47800' },
      oldHeaderSnapshot: { customerDeliveryDate: '2026-09-10', postcode: '43300' },
      columnOf: { customerDeliveryDate: 'customer_delivery_date', postcode: 'postcode' },
    });

    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('AMENDMENT_REQUESTED');
    expect(audits[0].note).toBe('customer moved house');
    expect(audits[0].fieldChanges).toEqual([
      { field: 'amendment', from: null, to: 'SO-2608-043/A1' },
      { field: 'lane', to: 'DELIVERY' },
      { field: 'requested_customer_delivery_date', from: '2026-09-10', to: '2026-09-20' },
      { field: 'requested_postcode', from: '43300', to: '47800' },
    ]);
  });

  it('audits a lines-only amendment with no header rows', async () => {
    await recordAmendmentRequested(null, {
      docNo: 'SO-1', amendmentNo: 'SO-1/A1', lane: 'LINES',
      actorId: 'user-1', actorName: null,
      headerKeys: [], headerChanges: {}, oldHeaderSnapshot: {}, columnOf: {},
    });
    expect(audits[0].fieldChanges).toHaveLength(2);
    expect(audits[0].note).toBeUndefined();
  });

  it('fires one notice per lane, resolving the salesperson exactly once', async () => {
    await notifyAmendmentsRaised(ctx, null, {
      docNo: 'SO-2608-043',
      salespersonStaffId: 'staff-sales',
      reason: 'customer changed the fabric',
      created: [
        { amendment_no: 'SO-2608-043/A1', lane: 'LINES' },
        { amendment_no: 'SO-2608-043/A2', lane: 'DELIVERY' },
      ],
    });

    expect(staffLookups).toEqual(['staff-sales']);
    expect(notices.map((n) => [n.amendmentNo, n.lane])).toEqual([
      ['SO-2608-043/A1', 'LINES'],
      ['SO-2608-043/A2', 'DELIVERY'],
    ]);
    for (const n of notices) {
      expect(n.soDocNo).toBe('SO-2608-043');
      expect(n.companyId).toBe(1);
      expect(n.salespersonUserId).toBe(77);
      expect(n.requesterUserId).toBe(40);
      expect(n.requesterName).toBe('Ivy');
      expect(n.reason).toBe('customer changed the fabric');
    }
  });

  it('still notifies when the Sales Order has no linked salesperson', async () => {
    await notifyAmendmentsRaised(ctx, null, {
      docNo: 'SO-2', salespersonStaffId: null,
      created: [{ amendment_no: 'SO-2/A1', lane: 'LINES' }],
    });
    expect(notices).toHaveLength(1);
    expect(notices[0].salespersonUserId).toBeNull();
    expect(notices[0].reason).toBeNull();
  });
});
