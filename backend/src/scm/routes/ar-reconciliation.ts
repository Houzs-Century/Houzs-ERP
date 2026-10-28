// ---------------------------------------------------------------------------
// ar-reconciliation.ts — the AR-005 receivables PREVIEW.
//
// Owner 2026-07-18: the bank receipt feed "还没做好的，所以你可以先 preview，可是
// 之后我们再来补它的细节功能". So this is the half that CAN be built truthfully
// today — reconciling each order against the payment ledger we already own — and
// the foundation the bank-feed matching lands on later.
//
// Per open order it answers the three AR questions (spec §7.2): what is due, what
// was actually paid, and may it be released. Plus the one thing only a
// reconciliation can see:
//
//   DRIFT — the SO header's `paid_sen` stamp disagreeing with the SUM of its
//   payment ledger rows. The header is a stamp; the ledger is the record. When
//   they differ, one of the two screens in this ERP is lying about money, and
//   which one you happen to be looking at decides what you believe. Surfacing it
//   is the point — this file NEVER writes, so it cannot "fix" a drift by
//   overwriting either side (that is a human's call with the receipts in hand).
//
// READ-ONLY. No migration, no write, no agent — a page/endpoint the office reads.
// Receipt→bank matching is deliberately ABSENT until the feed exists; inventing a
// match with no bank data would be the confident lie this codebase keeps logging.
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import type { Env, Variables } from '../env';
import { paginateAll } from '../lib/paginate-all';
import { scopeToAllowedCompanies } from '../lib/companyScope';
import { canViewAllSales } from '../lib/houzs-perms';
import { resolveSalesScopeIds } from '../lib/salesScope';
import { computeReleaseGate } from '../../services/agents/release-gate';
import { supabaseAuth } from '../middleware/auth';

export const arReconciliation = new Hono<{ Bindings: Env; Variables: Variables }>();

// Attach the scm-scoped supabase-js client (c.get('supabase')) the handler reads.
// This router is mounted in scm/index.ts WITHOUT the usual `scm.use(prefix,
// scmAreaGuard(...))` line (it rides the coarse scm.access umbrella as a read-only
// preview) and shipped without its own supabaseAuth too — so `c.get('supabase')`
// was undefined and the first `sb.from('mfg_sales_orders')` threw a TypeError,
// 500-ing the AR reconciliation preview for everyone. Same `.use('*', supabaseAuth)`
// every other scm sub-router carries.
arReconciliation.use('*', supabaseAuth);

/** Orders still in play for receivables — a draft has no money story yet and a
 *  cancelled one is closed. */
const AR_STATUSES = ['CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'INVOICED'];

interface SoRow {
  doc_no: string;
  so_date?: string | null;
  status?: string | null;
  debtor_name?: string | null;
  local_total_sen?: number | null;
  paid_sen?: number | null;
}
interface PayRow { so_doc_no: string; amount_sen?: number | null }

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/* GET /api/scm/ar/reconciliation — per-order AR truth + the release gate. */
arReconciliation.get('/reconciliation', async (c) => {
  const sb = c.get('supabase');
  const onlyDrift = c.req.query('drift') === 'true';
  const onlyOutstanding = c.req.query('outstanding') === 'true';

  /* PER-SALESPERSON ROW SCOPE, matching unbilled-deliveries.ts:187 — the
     sibling that answers the same question against DOs. Without it a
     self-scoped rep who reached this page saw the whole book's debtor names,
     totals, paid and remaining, while their own SO list showed only theirs.

     resolveSalesScopeIds returns null for a view-all caller (ops, finance,
     management) — they are unchanged. It MUST be given the REAL Houzs integer
     id via houzsUser: `user.id` here is the SCM bridge's pinned system-staff
     uuid, and feeding that to the scope lookup is the documented non-admin 500.

     Owner decision 2026-08-13: gate it like its siblings. The area guard
     (scm.finance.outstanding) was added at the mount in scm/index.ts. */
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));

  let soQ = sb
    .from('mfg_sales_orders')
    .select('doc_no, so_date, status, debtor_name, local_total_sen, paid_sen, salesperson_id')
    .in('status', AR_STATUSES)
    .order('so_date', { ascending: false })
    .limit(2000);
  if (scopeIds) soQ = soQ.in('salesperson_id', scopeIds);
  soQ = scopeToAllowedCompanies(soQ, c);
  const { data: soData, error: soErr } = await soQ;
  if (soErr) return c.json({ error: 'load_failed', reason: soErr.message }, 500);
  const sos = (soData ?? []) as SoRow[];
  if (sos.length === 0) return c.json({ rows: [], summary: emptySummary() });

  /* The payment LEDGER for those orders. paginateAll because PostgREST caps a
     plain select at 1000 — a silent truncation here would understate what a
     customer has paid, which is the worst direction to be wrong in. */
  const docNos = new Set(sos.map((s) => s.doc_no));
  const { data: payData, error: payErr } = await paginateAll<PayRow>((from, to) =>
    sb.from('mfg_sales_order_payments').select('so_doc_no, amount_sen').order('so_doc_no').range(from, to),
  );
  if (payErr) return c.json({ error: 'payments_load_failed', reason: payErr.message }, 500);
  const paidByDoc = new Map<string, number>();
  for (const p of payData ?? []) {
    if (!docNos.has(p.so_doc_no)) continue;
    paidByDoc.set(p.so_doc_no, (paidByDoc.get(p.so_doc_no) ?? 0) + n(p.amount_sen));
  }

  const rows = sos.map((s) => {
    const totalSen = n(s.local_total_sen);
    const paidLedgerSen = paidByDoc.get(s.doc_no) ?? 0;
    const paidHeaderSen = n(s.paid_sen);
    const remainingSen = Math.max(0, totalSen - paidLedgerSen);
    // The gate is computed from the LEDGER, never the header stamp — the ledger
    // is the record of money actually received.
    const gate = computeReleaseGate({ totalSen, paidSen: paidLedgerSen });
    return {
      doc_no: s.doc_no,
      so_date: s.so_date ?? null,
      status: s.status ?? '',
      debtor_name: s.debtor_name ?? null,
      total_sen: totalSen,
      paid_ledger_sen: paidLedgerSen,
      paid_header_sen: paidHeaderSen,
      remaining_sen: remainingSen,
      /* The header stamp vs the ledger. Reported, never reconciled here. */
      drift_sen: paidHeaderSen - paidLedgerSen,
      has_drift: paidHeaderSen !== paidLedgerSen,
      release_gate: {
        decision: gate.decision,
        collect_on_delivery_sen: gate.collectOnDeliverySen,
        reason: gate.reason,
      },
    };
  });

  const filtered = rows.filter((r) =>
    (!onlyDrift || r.has_drift) && (!onlyOutstanding || r.remaining_sen > 0));

  const summary = {
    orders: filtered.length,
    outstandingSen: filtered.reduce((s, r) => s + r.remaining_sen, 0),
    withDrift: filtered.filter((r) => r.has_drift).length,
    held: filtered.filter((r) => r.release_gate.decision === 'HOLD').length,
    collectOnDeliverySen: filtered.reduce((s, r) => s + r.release_gate.collect_on_delivery_sen, 0),
    // Named so nobody reads this preview as full AR-005: bank-receipt matching
    // needs a feed that does not exist yet.
    receiptMatching: 'not available — no bank receipt feed is connected yet',
  };

  return c.json({ rows: filtered, summary });
});

function emptySummary() {
  return {
    orders: 0, outstandingSen: 0, withDrift: 0, held: 0, collectOnDeliverySen: 0,
    receiptMatching: 'not available — no bank receipt feed is connected yet',
  };
}

export default arReconciliation;
