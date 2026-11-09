/* Backlog A1 — a delivery return whose units are on a live credit note cannot
   be cancelled until the credit note is: the stock would go back out while the
   customer kept the credit. Drives the REAL status handler. */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { patchDeliveryReturnStatusHandler } from '../src/scm/routes/delivery-returns';

const CO = 2;
function harness(noteStatus: string) {
  const sb = fakeSb({
    delivery_returns: [{ id: 'dr-1', company_id: CO, status: 'RECEIVED' }],
    delivery_return_items: [{ id: 'r1', company_id: CO, delivery_return_id: 'dr-1', qty_returned: 2 }],
    acc_credit_notes: [{ id: 'n1', company_id: CO, status: noteStatus }],
    acc_credit_note_lines: [{ id: 'l1', company_id: CO, note_id: 'n1', delivery_return_item_id: 'r1', qty: 1 }],
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('companyCode' as never, 'HC' as never);
    c.set('companies' as never, [{ id: CO, code: 'HC' }] as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.patch('/delivery-returns/:id/status', patchDeliveryReturnStatusHandler as never);
  return { app, sb };
}
const cancel = (app: Hono) => app.request('/delivery-returns/dr-1/status', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'CANCELLED' }) });

describe('cancelling a credit-noted return', () => {
  test('is refused while a live credit note credits its units', async () => {
    const { app, sb } = harness('POSTED');
    const res = await cancel(app);
    expect(res.status).toBe(409);
    expect((await res.json() as Row).error).toBe('dr_credit_noted');
    expect((sb.tables.delivery_returns as Row[])[0]!.status).toBe('RECEIVED');
  });

  test('goes past the hold once that note is cancelled', async () => {
    const { app } = harness('CANCELLED');
    const res = await cancel(app);
    expect((await res.json() as Row).error).not.toBe('dr_credit_noted');
  });
});
