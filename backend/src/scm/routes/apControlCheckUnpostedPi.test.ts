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

const sb = fakeSb({
  acc_account_roles: [],
  journal_entries: [],
  v_gl_entries: [],
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
    expect(other.foreignLines).toEqual([]);
    expect(other.ok).toBe(true);
  });
});
