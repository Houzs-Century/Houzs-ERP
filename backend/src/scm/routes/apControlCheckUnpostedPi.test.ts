/* The AP control check must report a confirmed PI with no active journal.
 *
 * WHY. Found on production 2026-08-22: Houzs Century had HC-PI-2608-002 and
 * -003, both CONFIRMED, both with no journal entry — and the AP arm of
 * /control-check reported CLEAN. The AR arm, four lines above it in the same
 * function, reported the identical shape for HC-SI-2608-002 ("document has no
 * active journal"). The one check built to catch an unposted document was the
 * one that couldn't see it.
 *
 * The skip carried two justifications and both were false:
 *   - "PI posts on demand" — postPurchaseInvoiceHandler calls postPiAccounting
 *     on BOTH arms (the DRAFT->POSTED transition and the already-posted
 *     ensure), so a confirmed PI with no journal means the post FAILED.
 *   - "the AP aging is the place that surfaces unposted PIs" — scm.v_ap_aging
 *     selects from purchase_invoices alone and never joins journal_entries. It
 *     has no notion of posted.
 *
 * These cases drive the REAL route through the fake PostgREST client, and they
 * pin the three neighbours the fix must not disturb: DRAFT, CANCELLED and
 * migrated are still skipped, and a ZERO-total PI is still skipped because
 * postPiAccounting refuses one (`zero_total`) — its absence is not drift.
 */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const PI = (invoice_number: string, total_sen: number, status: string, extra = {}) => ({
  id: invoice_number, invoice_number, total_sen, status, company_id: 1,
  exchange_rate: 1, migrated_no_stock: false, ...extra,
});

/* AP invoices (docs/bugs/0654): the AP arm walks them like PIs, and their
   journals — source API on 400 or 405 — are family on both creditor controls. */
const sb = fakeSb({
  acc_account_roles: [],
  journal_entries: [
    { id: 'je-api-1', je_no: 'JE-API-1', company_id: 1, source_type: 'API', source_doc_no: '2990-API-2603-001', posted: true, reversed: false, total_debit_sen: 214_374, total_credit_sen: 214_374 },
  ],
  v_gl_entries: [
    { line_id: 1, company_id: 1, account_code: '405-0000', je_no: 'JE-API-1', source_type: 'API', debit_sen: 0, credit_sen: 214_374, posted: true, reversed: false },
    { line_id: 2, company_id: 1, account_code: '405-0000', je_no: 'JE-API-2', source_type: 'API_REVERSAL', debit_sen: 100, credit_sen: 0, posted: true, reversed: false },
    /* A debtor-bill line parked on the creditor control IS foreign. */
    { line_id: 3, company_id: 1, account_code: '405-0000', je_no: 'JE-ODB-9', source_type: 'ODB', debit_sen: 50, credit_sen: 0, posted: true, reversed: false },
  ],
  ap_invoices: [
    { id: 'api-1', invoice_number: '2990-API-2603-001', total_sen: 214_374, status: 'POSTED', company_id: 1 }, // journal present
    { id: 'api-2', invoice_number: '2990-API-2604-009', total_sen: 5_000, status: 'POSTED', company_id: 1 },   // NO journal — drift
    { id: 'api-3', invoice_number: '2990-API-2604-010', total_sen: 5_000, status: 'DRAFT', company_id: 1 },    // no journal is correct
  ],
  sales_invoices: [],
  purchase_invoices: [
    PI('HC-PI-2608-003', 140_000, 'POSTED'),        // the live case
    PI('HC-PI-2608-009', 500_00, 'DRAFT'),          // no journal is correct
    PI('HC-PI-2608-010', 500_00, 'CANCELLED'),      // no journal is correct
    PI('HC-PI-2608-011', 500_00, 'POSTED', { migrated_no_stock: true }), // AutoCount booked it
    PI('HC-PI-2608-012', 0, 'POSTED'),              // zero_total — refused by design
  ],
});

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

const CALLER = {
  id: '7', email: 'acct@houzs.test', app_metadata: {},
  user_metadata: { name: 'Acct' }, aud: 'authenticated', created_at: '',
} as unknown as User;

const { accounting } = await import('./accounting');

async function allChecks() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', 1);
    c.set('supabase', sb as never);
    await next();
  });
  app.route('/', accounting);
  const res = await app.request('/control-check');
  const body = await res.json() as { checks: Array<Record<string, any>> };
  return body.checks;
}

async function controlCheck() {
  return (await allChecks()).find((x) => x.role === 'AP')!;
}

describe('AP control check — a confirmed PI with no journal', () => {
  it('reports it, exactly as the AR arm reports the same shape', async () => {
    const ap = await controlCheck();
    const hit = (ap.driftDocs ?? []).find((d: any) => d.docNo === 'HC-PI-2608-003');
    expect(hit).toBeDefined();
    expect(hit.note).toBe('document has no active journal');
    expect(hit.jeTotalSen).toBe(0);
    expect(hit.diffSen).toBe(-140_000);
    expect(ap.ok).toBe(false);
  });

  it('still skips DRAFT, CANCELLED and migrated — their absence is correct', async () => {
    const ap = await controlCheck();
    const flagged = new Set((ap.driftDocs ?? []).map((d: any) => d.docNo));
    expect(flagged.has('HC-PI-2608-009')).toBe(false);
    expect(flagged.has('HC-PI-2608-010')).toBe(false);
    expect(flagged.has('HC-PI-2608-011')).toBe(false);
  });

  it('still skips a ZERO-total PI — postPiAccounting refuses one by design', async () => {
    const ap = await controlCheck();
    const flagged = new Set((ap.driftDocs ?? []).map((d: any) => d.docNo));
    expect(flagged.has('HC-PI-2608-012')).toBe(false);
  });
});

describe('the third arm — AP_OTHER (the 2026-09-03 split)', () => {
  it('runs on 405-0000 and does NOT repeat the per-document drift the AP arm owns', async () => {
    const checks = await allChecks();
    expect(checks.map((x: any) => x.role)).toEqual(['AR', 'AR_OTHER', 'AP', 'AP_OTHER']);
    const other = checks.find((x: any) => x.role === 'AP_OTHER')!;
    expect(other.accountCode).toBe('405-0000'); // DEFAULT_ROLE_CODES — no roles rows seeded here
    /* HC-PI-2608-003's missing journal is the AP arm's finding, once. */
    expect(other.driftDocs).toEqual([]);
    /* The AP-invoice journal and its reversal are family; only the debtor-bill
       line is foreign (docs/bugs/0654 — before, all three were reported). */
    expect(other.foreignLines.map((f: any) => f.jeNo)).toEqual(['JE-ODB-9']);
    expect(other.ok).toBe(false);
  });
});

describe('AP invoices on the AP arm (docs/bugs/0654)', () => {
  it('a posted AP invoice with no journal is drift; one with its journal, and a draft, are not', async () => {
    const ap = await controlCheck();
    const byDoc = new Map((ap.driftDocs ?? []).map((d: any) => [d.docNo, d]));
    expect(byDoc.get('2990-API-2604-009')).toMatchObject({ note: 'document has no active journal', diffSen: -5_000 });
    expect(byDoc.has('2990-API-2603-001')).toBe(false);
    expect(byDoc.has('2990-API-2604-010')).toBe(false);
  });
});
