/* so-ref-lookup — the SO reference stamped onto rows that are not the order
 * itself (owner 2026-09-25: every search box finds a record by its SO's
 * reference). Company scope is the caller's: a document number is only unique
 * within a company, so the other company's order of the same number must never
 * lend its reference. */
import { describe, expect, it } from 'vitest';
import { fakeSb, type Row } from './fake-postgrest';
import { scopeToCompany } from './companyScope';
import { readSoRefs, readSoRefsByDoId, stampDoLineSoRefs, stampSoRefs, stampSoRefsCamel } from './so-ref-lookup';

const ctx = { get: (k: string) => (k === 'companyId' ? 1 : undefined) };
const inCompany = (q: unknown) => scopeToCompany(q, ctx);

const world = () => fakeSb({
  mfg_sales_orders: [
    { doc_no: 'SO-1', company_id: 1, ref: 'MR TAN / SUNWAY', customer_so_no: null },
    { doc_no: 'SO-2', company_id: 1, ref: null, customer_so_no: 'CUST-PO-7' },
    { doc_no: 'SO-1', company_id: 2, ref: 'OTHER COMPANY', customer_so_no: null },
    { doc_no: 'SO-9', company_id: 2, ref: 'NOT OURS', customer_so_no: null },
  ] as Row[],
  delivery_orders: [
    { id: 'do-1', company_id: 1, so_doc_no: 'SO-2' },
    { id: 'do-2', company_id: 1, so_doc_no: null },
    { id: 'do-x', company_id: 2, so_doc_no: 'SO-9' },
  ] as Row[],
});

describe('readSoRefs', () => {
  it('reads the raw pair for the caller company only, ignoring blanks and duplicates', async () => {
    const { byDoc, error } = await readSoRefs(world(), ['SO-1', 'SO-1', 'SO-2', 'SO-9', null, ''], inCompany);
    expect(error).toBeNull();
    expect(Object.fromEntries(byDoc)).toEqual({
      'SO-1': { ref: 'MR TAN / SUNWAY', customer_so_no: null },
      'SO-2': { ref: null, customer_so_no: 'CUST-PO-7' },
    });
  });

  it('reads nothing when there is nothing to read', async () => {
    const { byDoc, error } = await readSoRefs(world(), [], inCompany);
    expect(byDoc.size).toBe(0);
    expect(error).toBeNull();
  });

  it('reports a failed read instead of claiming there is no reference', async () => {
    const sb = fakeSb({ mfg_sales_orders: [{ doc_no: 'SO-1', company_id: 1, ref: 'X' }] }, { mfg_sales_orders: ['customer_so_no'] });
    const { error } = await readSoRefs(sb, ['SO-1'], inCompany);
    expect(error).not.toBeNull();
  });
});

describe('readSoRefsByDoId', () => {
  it("resolves a Delivery Order to its order's pair, in the caller company", async () => {
    const { byDoId, error } = await readSoRefsByDoId(world(), ['do-1', 'do-2', 'do-x'], inCompany);
    expect(error).toBeNull();
    expect(Object.fromEntries(byDoId)).toEqual({ 'do-1': { ref: null, customer_so_no: 'CUST-PO-7' } });
  });
});

describe('the stamps', () => {
  it('stamps snake_case rows, null when the order is unknown', async () => {
    const rows: Array<Record<string, unknown>> = [{ so_doc_no: 'SO-1' }, { so_doc_no: 'SO-404' }, { so_doc_no: null }];
    await stampSoRefs(world(), rows, 'so_doc_no', inCompany, 'test');
    expect(rows).toEqual([
      { so_doc_no: 'SO-1', so_ref: 'MR TAN / SUNWAY', so_customer_so_no: null },
      { so_doc_no: 'SO-404', so_ref: null, so_customer_so_no: null },
      { so_doc_no: null, so_ref: null, so_customer_so_no: null },
    ]);
  });

  it('stamps camelCase rows by a named document number', async () => {
    const rows = [{ docNo: 'SO-2' }];
    await stampSoRefsCamel(world(), rows, (r) => r.docNo, inCompany, 'test');
    expect(rows[0]).toEqual({ docNo: 'SO-2', soRef: null, soCustomerSoNo: 'CUST-PO-7' });
  });

  it("stamps Delivery Order lines with their order's pair", async () => {
    const rows = [{ deliveryOrderId: 'do-1' }, { deliveryOrderId: 'do-x' }];
    await stampDoLineSoRefs(world(), rows, inCompany, 'test');
    expect(rows).toEqual([
      { deliveryOrderId: 'do-1', soRef: null, soCustomerSoNo: 'CUST-PO-7' },
      { deliveryOrderId: 'do-x', soRef: null, soCustomerSoNo: null },
    ]);
  });
});
