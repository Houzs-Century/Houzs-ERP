/* The Purchase Invoice create is the sixth chain on the one-key-per-mount dead
   end, and the only create in the procurement chain that never got the fix.
 *
 * PRODUCTION, 2026-08-19. Raising a Purchase Invoice from a Goods Receipt
 * answered `POST /api/scm/purchase-invoices -> 500`, and went on answering it:
 * the operator pressed Save again and got the same 500, again, with nothing on
 * screen but "The system hit a problem."
 *
 * THAT IS THE MIDDLEWARE, NOT THE HANDLER. PurchaseInvoiceNew mints ONE
 * Idempotency-Key per mount (frontend lib/idempotency.ts `useIdempotencyKey`),
 * and middleware/idempotency.ts persists EVERY terminal response, "not only
 * 2xx" (:363-373), then replays it for the identical payload (:289-296). So the
 * FIRST refusal — whatever produced it — is frozen against that key, the
 * handler never runs again, and every retry from that page mount is answered
 * from the store. Correcting the payload does not escape it either: a different
 * hash under a claimed key is `idempotency_key_reused` (:167). Only a full page
 * reload gets out, and it throws away the typed invoice.
 *
 * grns.ts was fixed for exactly this on 2026-08-17 (lib/no-write-refusal.ts
 * carries the trace) — the route proves it wrote nothing and releases the
 * claim, so the corrected resubmit is a fresh claim and simply works.
 * purchase-invoices.ts contained the word `refuseWithoutWriting` zero times,
 * so the step AFTER the receipt kept the dead end the receipt lost.
 *
 * These cases drive the REAL router behind the REAL middleware; only Postgres
 * and D1 are stand-ins, and the claim store throws on any statement it does not
 * recognise so a middleware query that changes shape cannot quietly stop being
 * tested. `grnPreWriteRefusalsReleaseKey`'s PI sibling checks COMPLETENESS over
 * source shape; this one checks that the release actually reaches the operator.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { idempotency } from '../src/middleware/idempotency';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import type { Env } from '../src/types';

/* ── The receipt the owner came from: three sofa modules, all at RM 0.00,
      because the whole chain descends from an all-FOC sales order. ─────────── */
const tables: Record<string, Row[]> = {};
const seedTables = () => {
  for (const k of Object.keys(tables)) delete tables[k];
  Object.assign(tables, {
    purchase_invoices: [] as Row[],
    purchase_invoice_items: [] as Row[],
    grns: [{
      id: 'grn-1', grn_number: 'HC-GRN-2608-002', company_id: 1,
      purchase_order_id: 'po-1', supplier_id: 'sup-1', currency: 'MYR',
      exchange_rate: 1, migrated_no_stock: false, status: 'POSTED',
    }],
    grn_items: [
      { id: 'gi-1', grn_id: 'grn-1', item_code: '9028-1A(LHF)', material_kind: 'mfg_product', material_name: 'Sofa module', qty_accepted: 1, invoiced_qty: 0, returned_qty: 0, unit_price_sen: 0, allocated_charge_sen: 0, company_id: 1 },
      { id: 'gi-2', grn_id: 'grn-1', item_code: '9028-1A(RHF)', material_kind: 'mfg_product', material_name: 'Sofa module', qty_accepted: 1, invoiced_qty: 0, returned_qty: 0, unit_price_sen: 0, allocated_charge_sen: 0, company_id: 1 },
      { id: 'gi-3', grn_id: 'grn-1', item_code: '9028-1NA', material_kind: 'mfg_product', material_name: 'Sofa module', qty_accepted: 1, invoiced_qty: 0, returned_qty: 0, unit_price_sen: 0, allocated_charge_sen: 0, company_id: 1 },
    ],
    purchase_orders: [{ id: 'po-1', po_number: 'HC-PO-2608-002', company_id: 1 }],
    suppliers: [{ id: 'sup-1', name: 'S', company_id: 1 }],
    mfg_products: [], currencies: [], app_config: [], autocount_outbox: [],
    entity_audit_log: [], inventory_lots: [], inventory_movements: [],
    inventory_lot_consumptions: [], companies: [{ id: 1, code: 'HOUZS' }],
  });
};

/* One `tables` object, two clients over it: the second is the SAME data with
   `grn_items.grn_id` unreadable, which is how a statement timeout or a schema
   blip reaches the create's first guard. Flipping between them is what lets a
   test say "the read failed on attempt 1 and worked on attempt 2" — the exact
   shape of a transient that the frozen claim turns permanent. */
let readsFail = false;
const client = () => (readsFail
  ? fakeSb(tables, { grn_items: ['grn_id'] })
  : fakeSb(tables));
vi.mock('../src/db/supabase', () => ({ getSupabaseService: () => client() }));

const CALLER = {
  id: 7, email: 'buyer@houzs.test', app_metadata: {},
  user_metadata: { name: 'Buyer' }, aud: 'authenticated', created_at: '',
} as unknown as User;

const { purchaseInvoices } = await import('../src/scm/routes/purchase-invoices');

type ClaimRow = {
  key: string; scope: string; user_id: number; tenant_scope: string;
  request_hash: string; status_code: number | null; response_body: string | null;
};

/* Faithful to the five statements middleware/idempotency.ts issues, and hostile
   to every other one — copied in shape from tests/idempotencyRefusalRelease. */
function claimStore() {
  const rows: ClaimRow[] = [];
  const owner = (userId: number, tenant: string, key: string, scope: string) =>
    rows.find((r) => r.user_id === userId && r.tenant_scope === tenant && r.key === key && r.scope === scope);
  const binding = {
    prepare(sql: string) {
      const norm = sql.replace(/\s+/g, ' ').trim();
      return {
        bind(...args: unknown[]) {
          const reject = () => new Error(`claimStore has no handler for: ${norm}`);
          return {
            async first() {
              if (norm.startsWith('SELECT status_code, response_body, request_hash FROM idempotency_keys')) {
                const [userId, tenant, key, scope] = args as [number, string, string, string];
                const row = owner(userId, tenant, key, scope);
                return row ? { status_code: row.status_code, response_body: row.response_body, request_hash: row.request_hash } : null;
              }
              throw reject();
            },
            async run() {
              if (norm.startsWith('INSERT INTO app_settings')) return { success: true };
              if (norm.startsWith('INSERT INTO idempotency_keys')) {
                const [key, scope, userId, tenant, hash] = args as [string, string, number, string, string];
                if (rows.some((r) => r.key === key && r.scope === scope)) {
                  const clash = new Error('duplicate key value violates unique constraint');
                  (clash as Error & { code?: string }).code = '23505';
                  throw clash;
                }
                rows.push({ key, scope, user_id: userId, tenant_scope: tenant, request_hash: hash, status_code: null, response_body: null });
                return { success: true };
              }
              if (norm.startsWith('DELETE FROM idempotency_keys')) {
                const [userId, tenant, key, scope, hash] = args as [number, string, string, string, string];
                const row = owner(userId, tenant, key, scope);
                if (row && row.request_hash === hash) rows.splice(rows.indexOf(row), 1);
                return { success: true };
              }
              if (norm.startsWith('UPDATE idempotency_keys')) {
                const [status, bodyText, userId, tenant, key, scope, hash] = args as
                  [number, string, number, string, string, string, string];
                const row = owner(userId, tenant, key, scope);
                if (row && row.request_hash === hash) { row.status_code = status; row.response_body = bodyText; }
                return { success: true };
              }
              throw reject();
            },
          };
        },
      };
    },
  };
  return { rows, env: { DB: binding } as unknown as Env };
}

/* The real mount: auth context, then the real idempotency middleware, then the
   real router — the same order src/index.ts uses. */
function app() {
  const a = new Hono<{ Bindings: Env }>();
  a.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('userId', 7);
    c.set('companyId', 1);
    c.set('companyCode', 'HOUZS');
    await next();
  });
  a.use('*', idempotency);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  a.route('/', purchaseInvoices as any);
  return a;
}

/** One page mount = one key, for every retry of that one Save. */
const KEY = 'one-mount-one-invoice';

const line = (grnItemId: string, itemCode: string, qty: number) => ({
  grnItemId, materialKind: 'mfg_product', itemCode, materialName: itemCode,
  qty, unitPriceSen: 0, itemGroup: 'sofa', variants: { fabric_code: 'F1' },
});

const draft = (over: Record<string, unknown> = {}) => ({
  supplierId: 'sup-1', purchaseOrderId: 'po-1', grnId: 'grn-1',
  invoiceDate: '2026-08-19', currency: 'MYR', exchangeRate: 1,
  allocationMethod: 'QTY', asDraft: false,
  items: [line('gi-1', '9028-1A(LHF)', 1), line('gi-2', '9028-1A(RHF)', 1), line('gi-3', '9028-1NA', 1)],
  ...over,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const save = (a: any, env: Env, payload: unknown) =>
  a.request('https://test.local/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': KEY },
    body: JSON.stringify(payload),
  }, env);

beforeEach(() => { seedTables(); readsFail = false; });

describe('a refused Purchase Invoice create can be corrected and saved', () => {
  /* THE OWNER'S 500, AND WHY IT KEPT HAPPENING. The first attempt's guard
     could not run, so the create fails closed (purchase-invoices.ts:774) — which
     is correct. What is not correct is that the same Save, on the same screen,
     goes on answering that 500 after the condition has cleared, because the
     handler is never reached again. */
  it('a transient fail-closed 500 does not freeze the screen on 500 forever', async () => {
    const store = claimStore();
    const a = app();

    readsFail = true;
    const first = await save(a, store.env, draft());
    expect(first.status).toBe(500);
    expect((await first.json()).error).toBe('unlinked_check_failed');

    // The blip clears. The operator presses Save again — nothing else changed.
    readsFail = false;
    const retry = await save(a, store.env, draft());
    expect(retry.headers.get('Idempotent-Replay')).not.toBe('true');
    expect(retry.status).toBe(201);
    expect(tables.purchase_invoices).toHaveLength(1);
  });

  /* THE CORRECTION DEAD END. A pre-write refusal whose entire remedy is "fix
     this and try again" must leave retrying possible. */
  it('a corrected payload after a pre-write refusal is not idempotency_key_reused', async () => {
    const store = claimStore();
    const a = app();

    // Three modules received, four billed: refused before anything is written.
    const first = await save(a, store.env, draft({
      items: [line('gi-1', '9028-1A(LHF)', 4)],
    }));
    expect(first.status).toBe(409);
    expect((await first.json()).error).toBe('qty_exceeds_remaining');
    expect(tables.purchase_invoices).toHaveLength(0);

    // The operator corrects the quantity the refusal named and saves again.
    const corrected = await save(a, store.env, draft({
      items: [line('gi-1', '9028-1A(LHF)', 1)],
    }));
    expect(corrected.status).toBe(201);
    expect(tables.purchase_invoices).toHaveLength(1);
  });

  /* THE PROPERTY THE RELEASE MAY NOT COST. A claim is only released where the
     route can prove nothing survived; a COMMITTED invoice must still replay,
     or a double-tap books the supplier's bill twice. */
  it('a committed invoice still REPLAYS instead of being created twice', async () => {
    const store = claimStore();
    const a = app();

    const first = await save(a, store.env, draft());
    expect(first.status).toBe(201);

    const retry = await save(a, store.env, draft());
    expect(retry.status).toBe(201);
    expect(retry.headers.get('Idempotent-Replay')).toBe('true');
    expect(await retry.json()).toEqual(await first.json());
    expect(tables.purchase_invoices).toHaveLength(1);
  });
});
