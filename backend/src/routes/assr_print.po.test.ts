/* BUG-91 (Farra 2026-10-08): "PO number tak show masa print, tapi dalam ERP
 * memang sudah ada PO NO". The list's PO column merges the SO's supplier
 * Order POs (`order_pos`) with the case's own service PO (`po_no`); the printed
 * Office and Supplier copies read `po_no` alone, which a case created from an
 * ERP sales order leaves empty. So the screen showed HC-PO-… and the paper a
 * dash. The copies now print the same merged value the list column does. */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const detail = vi.hoisted(() => ({ current: null as any }));

vi.mock('../services/assr', () => ({ getAssrDetail: async () => detail.current }));
vi.mock('../services/assrVisibility', () => ({
  assrCaseRowInScope: async () => true,
  assrCallerIsScoped: async () => false,
  stripCreditorFields: () => {},
}));
vi.mock('../services/assrSupplierReturns', () => ({
  earlierSupplierReturns: () => [],
  ensureFirstSupplierReturn: async () => {},
  listSupplierReturns: async () => [],
}));
vi.mock('../scm/lib/companyScope', () => ({ allowedCompanyIds: () => undefined }));

import assrPrint from './assr_print';

const stmt = { bind: () => stmt, all: async () => ({ results: [] }), first: async () => null };
const ENV = { DB: { prepare: () => stmt }, POD_BUCKET: { get: async () => null } };

function caseWith(over: Record<string, unknown>) {
  return {
    case: {
      id: 7, company_id: 1, assr_no: 'ASSR-2610-001', stage: 'pending_review',
      customer_name: 'Test Customer', doc_no: 'HC-SO-013900', po_no: null, order_pos: [],
      ...over,
    },
    items: [], attachments: [], activity: [], logistics: null, supplier_returns: [],
  };
}

async function print(variant: 'office' | 'supplier' | 'customer') {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user' as never, { id: 1, permissions: ['service_cases.read'] } as never);
    await next();
  });
  app.route('/', assrPrint);
  const res = await app.request(`/7?variant=${variant}`, {}, ENV as never);
  expect(res.status).toBe(200);
  return res.text();
}

describe('ASSR print — PO No (BUG-91)', () => {
  it('prints the SO Order PO when the case has no service po_no', async () => {
    detail.current = caseWith({ order_pos: [{ id: 'u1', po_number: 'HC-PO-009918' }] });
    expect(await print('office')).toMatch(/PO No<\/div><div class="vc mono">HC-PO-009918</);
    expect(await print('supplier')).toMatch(/PO Number<\/div><div class="v">HC-PO-009918</);
  });

  it('prints Order PO and service PO together, deduped like the list column', async () => {
    detail.current = caseWith({
      order_pos: [{ id: 'u1', po_number: 'HC-PO-009122' }, { id: 'u2', po_number: 'HC-PO-009918' }],
      po_no: 'PO-009918',
    });
    expect(await print('office')).toContain('HC-PO-009122 · HC-PO-009918<');
  });

  it('still prints a hand-typed service PO alone, and a dash when there is none', async () => {
    detail.current = caseWith({ po_no: 'SVC-PO-0042' });
    expect(await print('office')).toMatch(/PO No<\/div><div class="vc mono">SVC-PO-0042</);
    detail.current = caseWith({});
    expect(await print('office')).toMatch(/PO No<\/div><div class="vc mono">—</);
  });
});
