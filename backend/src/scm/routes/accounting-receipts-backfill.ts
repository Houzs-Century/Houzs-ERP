// /accounting/receipts/backfill — the official receipts history is owed.
//
// Every sales-order payment births a receipt (acc/receipts.ts), but the rows
// recorded before the module, and the SO-create rows before the hook moved,
// have none. The plan (GET) lists what is missing per payment month with the
// numbers the run would take; the run (POST) creates each receipt through the
// same call the live path uses, in payment-date order, and then turns the
// card payments merchant reconciliation has already confirmed formal on their
// payout bank — exactly what a confirm does today. Idempotent: a payment with
// a receipt is never touched, so a second press does nothing.

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId, docPrefixForCode } from '../lib/companyScope';
import { companyCodeById, docMonthTag } from '../lib/doc-no';
import { paginateAll } from '../lib/paginate-all';
import { createReceiptForPayment, formaliseReceiptsForSettlement } from '../../acc/receipts';
import { resolveRoles } from '../../acc/rules';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
type Row = Record<string, unknown>;

const requirePerm = (c: Ctx): boolean =>
  hasHouzsPerm(c, 'scm.payment_voucher.post') || hasHouzsPerm(c, 'scm.sales_order.write');

type Missing = {
  id: string; docNo: string; paidAt: string; method: string; amountSen: number; createdBy: string | null;
  /** The acquirer whose confirmed settlement covers this card payment, if any. */
  acquirer: string | null;
};

const str = (v: unknown): string | null => (v == null ? null : String(v));
const dayOf = (v: unknown): string => String(v ?? '').slice(0, 10);

/** Sales-order payments of the company with no receipt, oldest paid first.
    A converted row moved money that was receipted when first received; a
    zero row has nothing to receipt. */
async function loadMissing(sb: any, companyId: number): Promise<{ ok: true; rows: Missing[] } | { ok: false; reason: string }> {
  const pays = await paginateAll<Row>((from, to) => sb.from('mfg_sales_order_payments')
    .select('id, so_doc_no, paid_at, method, amount_sen, created_by, created_at')
    .eq('company_id', companyId)
    .order('paid_at', { ascending: true }).order('created_at', { ascending: true }).order('id', { ascending: true })
    .range(from, to));
  if (pays.error) return { ok: false, reason: `payments: ${pays.error.message}` };
  const receipts = await paginateAll<Row>((from, to) => sb.from('acc_official_receipts')
    .select('payment_id')
    .eq('company_id', companyId).eq('payment_source', 'SOPAY')
    .order('id', { ascending: true })
    .range(from, to));
  if (receipts.error) return { ok: false, reason: `receipts: ${receipts.error.message}` };
  const has = new Set((receipts.data ?? []).map((r) => String(r.payment_id)));
  const missing = (pays.data ?? [])
    .filter((p) => !has.has(String(p.id)) && String(p.method ?? '') !== 'converted' && Number(p.amount_sen ?? 0) > 0)
    .map((p): Missing => ({
      id: String(p.id), docNo: String(p.so_doc_no ?? ''), paidAt: dayOf(p.paid_at), method: String(p.method ?? ''),
      amountSen: Number(p.amount_sen ?? 0), createdBy: str(p.created_by), acquirer: null,
    }));
  if (missing.length === 0) return { ok: true, rows: [] };

  /* Which of them merchant reconciliation has confirmed, and on whose report. */
  const ids = missing.map((m) => m.id);
  const links: Row[] = [];
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await sb.from('acc_settlement_matches')
      .select('payment_id, settlement_row_id')
      .eq('company_id', companyId).eq('payment_source', 'SOPAY').in('payment_id', ids.slice(i, i + 150));
    if (error) return { ok: false, reason: `settlement links: ${error.message}` };
    links.push(...((data ?? []) as Row[]));
  }
  const rowIds = [...new Set(links.map((l) => Number(l.settlement_row_id)))];
  const acquirerByRow = new Map<number, string>();
  for (let i = 0; i < rowIds.length; i += 150) {
    const { data, error } = await sb.from('acc_settlement_rows')
      .select('id, acquirer_code, confirmed_at')
      .eq('company_id', companyId).in('id', rowIds.slice(i, i + 150));
    if (error) return { ok: false, reason: `settlement rows: ${error.message}` };
    for (const r of (data ?? []) as Row[]) if (r.confirmed_at) acquirerByRow.set(Number(r.id), String(r.acquirer_code ?? ''));
  }
  const acquirerByPayment = new Map<string, string>();
  for (const l of links) {
    const acq = acquirerByRow.get(Number(l.settlement_row_id));
    if (acq) acquirerByPayment.set(String(l.payment_id), acq);
  }
  for (const m of missing) {
    if (m.method === 'merchant' || m.method === 'installment') m.acquirer = acquirerByPayment.get(m.id) ?? null;
  }
  return { ok: true, rows: missing };
}

/** The acquirer → payout-bank letter map, and the banks with no letter yet. */
async function lettersByAcquirer(sb: any, companyId: number): Promise<{ ok: true; letters: Map<string, string | null> } | { ok: false; reason: string }> {
  const { data: acqs, error: aErr } = await sb.from('acc_acquirers').select('code, bank_account_code').eq('company_id', companyId);
  if (aErr) return { ok: false, reason: `acquirers: ${aErr.message}` };
  const { data: lets, error: lErr } = await sb.from('acc_bank_letters').select('account_code, letter').eq('company_id', companyId);
  if (lErr) return { ok: false, reason: `bank letters: ${lErr.message}` };
  const roles = await resolveRoles(sb, companyId);
  const letterOf = new Map<string, string>(((lets ?? []) as Row[]).map((l) => [String(l.account_code), String(l.letter)]));
  const out = new Map<string, string | null>();
  for (const a of (acqs ?? []) as Row[]) {
    const bank = str(a.bank_account_code);
    out.set(String(a.code), bank == null ? null : bank === roles.CASH ? 'C' : letterOf.get(bank) ?? null);
  }
  return { ok: true, letters: out };
}

/** The highest number already taken on a monthly series, from the live rows.
    A read that fails is not an empty series: the plan would name numbers
    the run then cannot take. */
async function seriesFloor(sb: any, companyId: number, monthPrefix: string): Promise<{ ok: true; max: number } | { ok: false; reason: string }> {
  const { data, error } = await sb.from('acc_official_receipts').select('or_number').eq('company_id', companyId).like('or_number', `${monthPrefix}-%`);
  if (error) return { ok: false, reason: `${monthPrefix}: ${error.message}` };
  let max = 0;
  for (const r of (data ?? []) as Row[]) {
    const m = /-(\d+)$/.exec(String(r.or_number ?? ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return { ok: true, max };
}

export type BackfillSeries = { series: string; count: number; from: string; to: string };
export type BackfillMonth = { ym: string; payments: number; cash: number; confirmedCards: number; unlettered: number; series: BackfillSeries[] };
export type BackfillPlan = { total: number; months: BackfillMonth[] };

const pad = (n: number, digits: number): string => String(n).padStart(digits, '0');

/** What the run would mint, month by month, from the live maxima — the numbers
    the owner sees before he presses. */
async function planFor(sb: any, companyId: number, companyCode: string, rows: Missing[]): Promise<{ ok: true; plan: BackfillPlan } | { ok: false; reason: string }> {
  const letters = await lettersByAcquirer(sb, companyId);
  if (!letters.ok) return letters;
  const prefix = docPrefixForCode(companyCode);
  const { data: numbering, error: nErr } = await sb.from('acc_numbering').select('doc_digits').eq('company_id', companyId).maybeSingle();
  if (nErr) return { ok: false, reason: `numbering: ${nErr.message}` };
  const digits = Number((numbering as { doc_digits?: number } | null)?.doc_digits ?? 3) || 3;
  const byMonth = new Map<string, Missing[]>();
  for (const r of rows) {
    const ym = docMonthTag(r.paidAt);
    byMonth.set(ym, [...(byMonth.get(ym) ?? []), r]);
  }
  const months: BackfillMonth[] = [];
  for (const [ym, list] of [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const counts = new Map<string, number>();
    const bump = (series: string) => counts.set(series, (counts.get(series) ?? 0) + 1);
    let cash = 0; let confirmed = 0; let unlettered = 0;
    for (const r of list) {
      bump(`${prefix}DraftOR-${ym}`);
      if (r.method === 'cash') { cash += 1; bump(`${prefix}COR-${ym}`); }
      if (r.acquirer) {
        const letter = letters.letters.get(r.acquirer) ?? null;
        if (letter) { confirmed += 1; bump(`${prefix}${letter}OR-${ym}`); } else unlettered += 1;
      }
    }
    const series: BackfillSeries[] = [];
    for (const [s, count] of counts) {
      const floor = await seriesFloor(sb, companyId, s);
      if (!floor.ok) return floor;
      series.push({ series: s, count, from: `${s}-${pad(floor.max + 1, digits)}`, to: `${s}-${pad(floor.max + count, digits)}` });
    }
    months.push({ ym, payments: list.length, cash, confirmedCards: confirmed, unlettered, series });
  }
  return { ok: true, plan: { total: rows.length, months } };
}

/** GET /accounting/receipts/backfill — the plan. */
export const receiptsBackfillPlan = async (c: Ctx) => {
  if (!requirePerm(c)) return c.json({ error: "You don't have permission to see receipts." }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const code = await companyCodeById(sb, co.companyId);
  if (!code) return c.json({ error: 'company_code_missing', message: 'This company has no document prefix.' }, 409);
  const missing = await loadMissing(sb, co.companyId);
  if (!missing.ok) return c.json({ error: 'load_failed', reason: missing.reason }, 500);
  const plan = await planFor(sb, co.companyId, code, missing.rows);
  if (!plan.ok) return c.json({ error: 'load_failed', reason: plan.reason }, 500);
  return c.json(plan.plan);
};

export type BackfillResult = {
  created: number; formalised: number;
  failed: Array<{ paymentId: string; docNo: string; reason: string }>;
  remaining: number;
};

/** POST /accounting/receipts/backfill?limit=N — one BATCH of the run (owner
    2026-09-16: 179 in one call outran the client's 30 s and the card could
    not say whether it saved): the oldest N missing receipts through the live
    path, the confirmed card ones among them formal on their payout bank, and
    what is still left — the card calls again until nothing is. Series order
    holds because every batch is the oldest first. */
export const BATCH_DEFAULT = 30;
export const BATCH_MAX = 100;
export const receiptsBackfillRun = async (c: Ctx) => {
  if (!requirePerm(c)) return c.json({ error: "You don't have permission to issue receipts." }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const code = await companyCodeById(sb, co.companyId);
  if (!code) return c.json({ error: 'company_code_missing', message: 'This company has no document prefix.' }, 409);
  const missingAll = await loadMissing(sb, co.companyId);
  if (!missingAll.ok) return c.json({ error: 'load_failed', reason: missingAll.reason }, 500);
  const limitRaw = Number(c.req.query('limit') ?? BATCH_DEFAULT);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, BATCH_MAX) : BATCH_DEFAULT;
  const missing = { rows: missingAll.rows.slice(0, limit) };
  const actor = (c.get('houzsUser') as { name?: string } | undefined)?.name ?? null;

  const failed: BackfillResult['failed'] = [];
  let created = 0;
  for (const r of missing.rows) {
    const made = await createReceiptForPayment(sb, {
      source: 'SOPAY', paymentId: r.id, companyId: co.companyId, companyCode: code,
      docNo: r.docNo, method: r.method, amountSen: r.amountSen, paidAt: r.paidAt || null, createdBy: r.createdBy,
    });
    if (made.ok) created += 1; else failed.push({ paymentId: r.id, docNo: r.docNo, reason: made.reason });
  }

  /* Formal on the payout bank, per acquirer, in payment-date order — the
     confirm's own step, run for the confirmations that predate the receipt. */
  const { data: acqs, error: aErr } = await sb.from('acc_acquirers').select('code, bank_account_code').eq('company_id', co.companyId);
  if (aErr) return c.json({ error: 'load_failed', reason: `acquirers: ${aErr.message}` }, 500);
  const bankOf = new Map<string, string | null>((acqs as Row[]).map((a) => [String(a.code), str(a.bank_account_code)]));
  let formalised = 0;
  const byAcquirer = new Map<string, Missing[]>();
  for (const r of missing.rows) if (r.acquirer) byAcquirer.set(r.acquirer, [...(byAcquirer.get(r.acquirer) ?? []), r]);
  for (const [acquirer, list] of byAcquirer) {
    const outcomes = await formaliseReceiptsForSettlement(
      sb, co.companyId, code, list.map((r) => ({ source: 'SOPAY', id: r.id })), bankOf.get(acquirer) ?? null, actor,
    );
    for (const o of outcomes) {
      if (o.outcome === 'formalised' || o.outcome === 'already_formal') formalised += 1;
      else failed.push({ paymentId: o.paymentId, docNo: list.find((r) => r.id === o.paymentId)?.docNo ?? '', reason: `formalise: ${o.outcome}` });
    }
  }

  const after = await loadMissing(sb, co.companyId);
  const result: BackfillResult = { created, formalised, failed, remaining: after.ok ? after.rows.length : -1 };
  return c.json(result);
};
