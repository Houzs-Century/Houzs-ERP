/* GET /accounting/payment-corrections?month=YYYY-MM — the Finance report of
   every payment action made on the correction right that month.

   Owner 2026-09-10: 「可以有一个 report 在我 finance 模块这里关于我更改的吗？
   要写 reason 错什么」. Owner 2026-09-14 (docs/bugs/0888): every payment action
   by a ROLE holding `scm.so_payment.amend` literally — an add, an edit, a
   delete, a proof attach — with the reason given and who FIRST recorded the
   payment. What it lists, and why nothing else: the payment routes mark such
   an action with `source = 'amend'` on its `mfg_so_audit_log` row, so this is
   a filtered read of the audit log the SO page already shows — one source of
   truth, two windows onto it. A same-day fix by a role without the key carries
   the default source and is not Finance's business here (owner: 靠权限改的来
   决定).

   BEFORE THE RULE (owner: his own two payments recorded on 2026-09-14, before
   this shipped — 规则之前). A row a role holding the key TODAY wrote with the
   default source — nothing asked it why — is listed too, marked as from before
   the rule. The holders are read the way the amendment notice reads its
   audience (services/permissionHolders.ts: the role grants the key literally;
   the wildcard alone does not), and matched on the name the audit snapshotted,
   which is the only name the log carries.

   WHO RECORDED IT FIRST. A row written since payments were tagged carries the
   payment's id (migration 20260914T1700), which leads to its ADD_PAYMENT row
   — the actor there — or, for a scan-born payment whose ADD row names nobody,
   to the collector on the payment row. An older, untagged correction reads
   the order's own ADD rows and is answered only when exactly one fits.

   Reads only. The shaping is `paymentCorrectionsReport` (acc/payment-corrections)
   so the report can be tested without a database. */

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { requireActiveCompanyId } from '../lib/companyScope';
import { monthWindow } from '../../acc/bank-month';
import { SO_PAYMENT_AMEND } from '../../acc/payment-reconciled';
import { usersHoldingPermission } from '../../services/permissionHolders';
import {
  AMEND_SOURCE, addedAmountOf, paymentCorrectionsReport,
  type CorrectionAuditRow, type PaymentRecorder, type RecorderLookup,
} from '../../acc/payment-corrections';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
type Row = Record<string, unknown>;

const CORRECTION_ACTIONS = ['ADD_PAYMENT', 'UPDATE_PAYMENT', 'DELETE_PAYMENT'];
/** The source a row carries when nothing marked it — what every payment action
    wrote before the rule, and what a role without the key still writes. */
const DEFAULT_SOURCE = 'web';
const AUDIT_COLS = 'id, so_doc_no, action, actor_name_snapshot, field_changes, note, created_at, payment_id, source';
const CHUNK = 200;

/** The first day of the month AFTER `month`, as the exclusive upper bound a
    timestamptz filter wants — `monthWindow` gives inclusive dates, and a
    `lte('…-30')` would drop everything corrected on the 30th after midnight. */
const nextMonthStart = (month: string): string => {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};

const str = (v: unknown): string | null => (v == null ? null : String(v));

const toAudit = (r: Row): CorrectionAuditRow => ({
  id: String(r.id ?? ''),
  so_doc_no: String(r.so_doc_no ?? ''),
  action: String(r.action ?? ''),
  actor_name_snapshot: str(r.actor_name_snapshot),
  field_changes: r.field_changes,
  note: str(r.note),
  created_at: String(r.created_at ?? ''),
  payment_id: str(r.payment_id),
  source: str(r.source),
});

const chunks = <T,>(xs: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
};

/** The names of the people whose ROLE grants the key literally, in this
    company — the audit log knows its actors by name only. Throws on a read
    that fails; the caller refuses the whole report rather than listing a
    month with the before-the-rule rows silently missing. */
async function literalHolderNames(c: Ctx, companyId: number): Promise<string[]> {
  const ids = await usersHoldingPermission(c.env, SO_PAYMENT_AMEND, { companyId });
  if (ids.length === 0) return [];
  const rows = await c.env.DB.prepare(
    `SELECT name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`,
  ).bind(...ids).all<{ name: string | null }>();
  return [...new Set(rows.results.map((r) => String(r.name ?? '').trim()).filter(Boolean))];
}

export const paymentCorrections = async (c: Ctx) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const month = String(c.req.query('month') ?? '').trim();
  const window = monthWindow(month);
  if (!window) return c.json({ error: 'bad_month', message: 'Say which month, as YYYY-MM.' }, 400);
  const sb = c.get('supabase');
  const fail = (what: string, reason: string) => c.json({ error: 'load_failed', reason: `${what}: ${reason}` }, 500);

  /* The month's actions made on the right. */
  const { data: auditRaw, error: auditErr } = await sb.from('mfg_so_audit_log')
    .select(AUDIT_COLS)
    .eq('company_id', co.companyId)
    .eq('source', AMEND_SOURCE)
    .in('action', CORRECTION_ACTIONS)
    .gte('created_at', window.from)
    .lt('created_at', nextMonthStart(month))
    .order('created_at', { ascending: false });
  if (auditErr) return fail('audit', auditErr.message);
  const audits = ((auditRaw ?? []) as Row[]).map(toAudit);

  /* …and the ones a holder of the key wrote before the rule asked them why. */
  let holders: string[];
  try {
    holders = await literalHolderNames(c, co.companyId);
  } catch (e) {
    return fail('holders', e instanceof Error ? e.message : String(e));
  }
  if (holders.length > 0) {
    const { data: earlyRaw, error: earlyErr } = await sb.from('mfg_so_audit_log')
      .select(AUDIT_COLS)
      .eq('company_id', co.companyId)
      .eq('source', DEFAULT_SOURCE)
      .in('action', CORRECTION_ACTIONS)
      .in('actor_name_snapshot', holders)
      .gte('created_at', window.from)
      .lt('created_at', nextMonthStart(month));
    if (earlyErr) return fail('audit before the rule', earlyErr.message);
    audits.push(...((earlyRaw ?? []) as Row[]).map(toAudit));
  }

  /* The customer, off the order — read in one go for the month's orders. An
     order that cannot be read shows no name rather than a wrong one; a read
     that FAILS is a refusal, because a report with every customer blank is a
     different document from the one asked for. */
  const customerByDoc = new Map<string, string | null>();
  const docs = [...new Set(audits.map((a) => a.so_doc_no).filter(Boolean))];
  for (const part of chunks(docs)) {
    const { data: soRaw, error: soErr } = await sb.from('mfg_sales_orders')
      .select('doc_no, debtor_name')
      .eq('company_id', co.companyId)
      .in('doc_no', part);
    if (soErr) return fail('orders', soErr.message);
    for (const r of (soRaw ?? []) as Row[]) customerByDoc.set(String(r.doc_no ?? ''), str(r.debtor_name));
  }

  /* Who first recorded each payment — the same rule as the customer: read
     what can be read, refuse when a read fails. */
  const addsByPayment = new Map<string, PaymentRecorder>();
  const paymentsById = new Map<string, PaymentRecorder>();
  const paymentIds = [...new Set(audits.map((a) => a.payment_id).filter((v): v is string => !!v))];
  for (const part of chunks(paymentIds)) {
    const { data: addRaw, error: addErr } = await sb.from('mfg_so_audit_log')
      .select('payment_id, actor_name_snapshot, created_at')
      .eq('company_id', co.companyId)
      .eq('action', 'ADD_PAYMENT')
      .in('payment_id', part);
    if (addErr) return fail('first recorders', addErr.message);
    for (const r of (addRaw ?? []) as Row[]) {
      const id = str(r.payment_id);
      if (id) addsByPayment.set(id, { by: str(r.actor_name_snapshot), on: String(r.created_at ?? '') });
    }
    const { data: payRaw, error: payErr } = await sb.from('mfg_sales_order_payments')
      .select('id, collected_by, created_at')
      .eq('company_id', co.companyId)
      .in('id', part);
    if (payErr) return fail('payments', payErr.message);
    const pays = (payRaw ?? []) as Row[];
    const collectorIds = [...new Set(pays.map((r) => str(r.collected_by)).filter((v): v is string => !!v))];
    const collectorName = new Map<string, string>();
    if (collectorIds.length > 0) {
      const { data: staffRaw, error: staffErr } = await sb.from('staff').select('id, name').in('id', collectorIds);
      if (staffErr) return fail('collectors', staffErr.message);
      for (const r of (staffRaw ?? []) as Row[]) collectorName.set(String(r.id ?? ''), String(r.name ?? ''));
    }
    for (const r of pays) {
      const collector = str(r.collected_by);
      paymentsById.set(String(r.id ?? ''), {
        by: collector ? (collectorName.get(collector) ?? null) : null,
        on: String(r.created_at ?? ''),
      });
    }
  }

  /* The untagged corrections — written before payments were tagged — are
     answered from their order's own ADD rows. */
  const addsByDoc = new Map<string, Array<PaymentRecorder & { amountSen: number | null }>>();
  const untaggedDocs = [...new Set(audits.filter((a) => !a.payment_id && a.action !== 'ADD_PAYMENT').map((a) => a.so_doc_no))];
  for (const part of chunks(untaggedDocs)) {
    const { data: docAddRaw, error: docAddErr } = await sb.from('mfg_so_audit_log')
      .select('so_doc_no, actor_name_snapshot, field_changes, created_at')
      .eq('company_id', co.companyId)
      .eq('action', 'ADD_PAYMENT')
      .in('so_doc_no', part)
      .order('created_at', { ascending: true });
    if (docAddErr) return fail('earlier adds', docAddErr.message);
    for (const r of (docAddRaw ?? []) as Row[]) {
      const doc = String(r.so_doc_no ?? '');
      const list = addsByDoc.get(doc) ?? [];
      list.push({ by: str(r.actor_name_snapshot), on: String(r.created_at ?? ''), amountSen: addedAmountOf(r.field_changes) });
      addsByDoc.set(doc, list);
    }
  }

  const recorders: RecorderLookup = { addsByPayment, paymentsById, addsByDoc };
  return c.json({ month, ...paymentCorrectionsReport(audits, customerByDoc, recorders) });
};
