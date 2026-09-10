/* GET /accounting/payment-corrections?month=YYYY-MM — the Finance report of
   every customer-payment correction made on the amend right that month.

   Owner 2026-09-10: 「可以有一个 report 在我 finance 模块这里关于我更改的吗？
   要写 reason 错什么」. What it lists, and why nothing else: the two payment
   routes mark a correction made on `scm.so_payment.amend` with
   `source = 'amend'` on its `mfg_so_audit_log` row (docs/bugs/0785), so this
   is a filtered read of the audit log the SO page already shows — one source
   of truth, two windows onto it. Same-day fixes by whoever keyed the payment
   carry the default source and are not Finance's business here (owner:
   靠权限改的来决定).

   Reads only. The shaping is `paymentCorrectionsReport` (acc/payment-corrections)
   so the report can be tested without a database. */

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { requireActiveCompanyId } from '../lib/companyScope';
import { monthWindow } from '../../acc/bank-month';
import {
  AMEND_SOURCE, paymentCorrectionsReport, type CorrectionAuditRow,
} from '../../acc/payment-corrections';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
type Row = Record<string, unknown>;

const CORRECTION_ACTIONS = ['UPDATE_PAYMENT', 'DELETE_PAYMENT'];

/** The first day of the month AFTER `month`, as the exclusive upper bound a
    timestamptz filter wants — `monthWindow` gives inclusive dates, and a
    `lte('…-30')` would drop everything corrected on the 30th after midnight. */
const nextMonthStart = (month: string): string => {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};

export const paymentCorrections = async (c: Ctx) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const month = String(c.req.query('month') ?? '').trim();
  const window = monthWindow(month);
  if (!window) return c.json({ error: 'bad_month', message: 'Say which month, as YYYY-MM.' }, 400);
  const sb = c.get('supabase');

  const { data: auditRaw, error: auditErr } = await sb.from('mfg_so_audit_log')
    .select('id, so_doc_no, action, actor_name_snapshot, field_changes, note, created_at')
    .eq('company_id', co.companyId)
    .eq('source', AMEND_SOURCE)
    .in('action', CORRECTION_ACTIONS)
    .gte('created_at', window.from)
    .lt('created_at', nextMonthStart(month))
    .order('created_at', { ascending: false });
  if (auditErr) return c.json({ error: 'load_failed', reason: auditErr.message }, 500);
  const audits = ((auditRaw ?? []) as Row[]).map((r): CorrectionAuditRow => ({
    id: String(r.id ?? ''),
    so_doc_no: String(r.so_doc_no ?? ''),
    action: String(r.action ?? ''),
    actor_name_snapshot: r.actor_name_snapshot == null ? null : String(r.actor_name_snapshot),
    field_changes: r.field_changes,
    note: r.note == null ? null : String(r.note),
    created_at: String(r.created_at ?? ''),
  }));

  /* The customer, off the order — read in one go for the month's orders. An
     order that cannot be read shows no name rather than a wrong one; a read
     that FAILS is a refusal, because a report with every customer blank is a
     different document from the one asked for. */
  const customerByDoc = new Map<string, string | null>();
  const docs = [...new Set(audits.map((a) => a.so_doc_no).filter(Boolean))];
  for (let i = 0; i < docs.length; i += 200) {
    const { data: soRaw, error: soErr } = await sb.from('mfg_sales_orders')
      .select('doc_no, debtor_name')
      .eq('company_id', co.companyId)
      .in('doc_no', docs.slice(i, i + 200));
    if (soErr) return c.json({ error: 'load_failed', reason: `orders: ${soErr.message}` }, 500);
    for (const r of (soRaw ?? []) as Row[]) {
      customerByDoc.set(String(r.doc_no ?? ''), r.debtor_name == null ? null : String(r.debtor_name));
    }
  }

  return c.json({ month, ...paymentCorrectionsReport(audits, customerByDoc) });
};
