// ----------------------------------------------------------------------------
// accounting-todo — GET /accounting/todo and /accounting/todo/count: Finance's
// To do (the owner's Claude Design redesign, Finance-1a-To-do, 2026-11-02).
//
// The reads only; the rules are acc/finance-todo.ts. Each section reads on its
// own, and a read that fails is NAMED in `problems` and leaves its jobs out —
// never shown as "nothing waiting". The count is the same rules without the
// money board, the done list or the names, for the sidebar's badge.
// ----------------------------------------------------------------------------

import { requireActiveCompanyId } from '../lib/companyScope';
import { todayMyt, mytDateOf } from '../lib/my-time';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import { hasHouzsPerm, holdsHouzsPermLiterally } from '../lib/houzs-perms';
import { stampOrderDeposit } from '../lib/si-order-deposit';
import { usersHoldingPermission } from '../../services/permissionHolders';
import { keyedAs, merchantNamesOf } from '../../acc/merchant-names';
import {
  addDays, buildFinanceTodo, raiseJobs, OVERDUE_DAYS, bankName,
  type TodoBankLine, type TodoCardRow, type TodoDone, type TodoFacts, type TodoViewer,
} from '../../acc/finance-todo';
import { loadDailyBankBoard } from './accounting-daily-bank';

type Rows = Array<Record<string, any>>;
type Read<T> = { ok: true; value: T } | { ok: false; what: string; reason: string };

const fail = (what: string, reason: string) => ({ ok: false as const, what, reason });
const day = (v: unknown): string | null => (v == null || v === '' ? null : mytDateOf(String(v)));
/** HH:MM in Malaysia — the done list's clock. */
const clock = (v: unknown): string => new Date(new Date(String(v)).getTime() + 8 * 3_600_000).toISOString().slice(11, 16);
/** The first instant of a Malaysian day, as the UTC timestamp the columns hold. */
const dayStart = (ymd: string): string => new Date(`${ymd}T00:00:00+08:00`).toISOString();
const latest = (vs: unknown[]): string => vs.map(String).filter(Boolean).sort().slice(-1)[0] ?? '';

/* ── Merchant reports ─────────────────────────────────────────────────────── */

type CardFacts = Pick<TodoFacts, 'acquirers' | 'lastReportTo' | 'keyedCardDays' | 'cardRows'> & { batches: Rows };

async function readCards(sb: any, companyId: number, today: string): Promise<Read<CardFacts>> {
  const { data: acqRaw, error: acqErr } = await sb.from('acc_acquirers')
    .select('code, display_name, has_unique_ref, so_names').eq('company_id', companyId).eq('is_active', true);
  if (acqErr) return fail('merchant setups', acqErr.message);
  const acqRows = (acqRaw ?? []) as Rows;
  const acquirers = acqRows.map((a) => ({ code: String(a.code), name: String(a.display_name ?? a.code), hasUniqueRef: a.has_unique_ref !== false }));
  const active = new Set(acquirers.map((a) => a.code));

  const batches = await paginateAll<Record<string, any>>((lo, hi) => sb.from('acc_settlement_batches')
    .select('id, acquirer_code, file_name, period_from, period_to, created_at')
    .eq('company_id', companyId).order('id').range(lo, hi));
  if (batches.error) return fail('merchant reports', batches.error.message);
  const batchRows = (batches.data ?? []) as Rows;
  const lastReportTo: Record<string, string | null> = {};
  for (const a of acquirers) lastReportTo[a.code] = null;
  for (const b of batchRows) {
    const code = String(b.acquirer_code);
    const to = b.period_to ? String(b.period_to) : null;
    if (to && active.has(code) && (lastReportTo[code] == null || to > lastReportTo[code]!)) lastReportTo[code] = to;
  }

  /* Card payments keyed under a merchant's name after its last report — its
     report is due the morning after. A payment with no merchant named could be
     any of them, so it raises nothing. Looked at over the last month only. */
  const floor = addDays(today, -31);
  const froms = acquirers.map((a) => (lastReportTo[a.code] ? addDays(lastReportTo[a.code]!, 1) : floor));
  const from = froms.length ? froms.reduce((m, d) => (d < m ? d : m)) : today;
  const keyedCardDays: Record<string, string[]> = {};
  if (acquirers.length > 0 && from < today) {
    const lo = from < floor ? floor : from;
    const read = (table: string) => paginateAll<Record<string, any>>((f, t) => sb.from(table)
      .select('paid_at, merchant_provider').eq('company_id', companyId)
      .in('method', ['merchant', 'installment']).not('merchant_provider', 'is', null)
      .gte('paid_at', lo).lt('paid_at', today).order('id').range(f, t));
    const [so, si] = await Promise.all([read('mfg_sales_order_payments'), read('sales_invoice_payments')]);
    if (so.error || si.error) return fail('card payments', (so.error ?? si.error)!.message);
    const pays = [...(so.data ?? []), ...(si.data ?? [])] as Rows;
    for (const a of acqRows) {
      const code = String(a.code);
      const names = merchantNamesOf({ display_name: String(a.display_name ?? ''), so_names: Array.isArray(a.so_names) ? a.so_names : [] });
      const after = lastReportTo[code] ?? addDays(floor, -1);
      const days = pays.filter((p) => String(p.paid_at) > after && keyedAs(p.merchant_provider, names)).map((p) => String(p.paid_at).slice(0, 10));
      if (days.length) keyedCardDays[code] = [...new Set(days)].sort();
    }
  }

  const rows = await paginateAll<Record<string, any>>((lo, hi) => sb.from('acc_settlement_rows')
    .select('id, batch_id, acquirer_code, bucket, match_reason, gross_sen, txn_date')
    .eq('company_id', companyId).is('confirmed_at', null).in('bucket', ['MATCHED', 'NEEDS_CONFIRM', 'UNMATCHED'])
    .order('id').range(lo, hi));
  if (rows.error) return fail('merchant lines', rows.error.message);
  const uploadedOn = new Map(batchRows.map((b) => [Number(b.id), day(b.created_at) ?? today]));
  const cardRows: TodoCardRow[] = ((rows.data ?? []) as Rows)
    .filter((r) => active.has(String(r.acquirer_code)))
    .map((r) => ({
      acquirer: String(r.acquirer_code), batchId: Number(r.batch_id), bucket: r.bucket,
      byReference: r.match_reason === 'ref', grossSen: Number(r.gross_sen ?? 0), txnDate: String(r.txn_date),
      uploadedOn: uploadedOn.get(Number(r.batch_id)) ?? today,
    }));
  return { ok: true, value: { acquirers, lastReportTo, keyedCardDays, cardRows, batches: batchRows } };
}

/* ── Bank statements ──────────────────────────────────────────────────────── */

type BankFacts = Pick<TodoFacts, 'bankAccounts' | 'lastStatementTo' | 'bankLines' | 'lockedLastMonth'> & { statements: Rows; locks: Rows };

async function readBank(sb: any, companyId: number, today: string): Promise<Read<BankFacts>> {
  const { data: cfg, error: cfgErr } = await sb.from('acc_bank_statement_config')
    .select('account_code, bank_code, created_at').eq('company_id', companyId).eq('is_active', true);
  if (cfgErr) return fail('bank setups', cfgErr.message);
  const cfgRows = (cfg ?? []) as Rows;
  const codes = cfgRows.map((r) => String(r.account_code));
  const names = new Map<string, string>();
  if (codes.length) {
    const { data: acc, error: accErr } = await sb.from('accounts').select('account_code, account_name').eq('company_id', companyId).in('account_code', codes);
    if (accErr) return fail('bank accounts', accErr.message);
    for (const a of (acc ?? []) as Rows) names.set(String(a.account_code), String(a.account_name ?? ''));
  }
  const bankAccounts = cfgRows.map((r) => ({
    accountCode: String(r.account_code), bankCode: String(r.bank_code ?? ''),
    accountName: names.get(String(r.account_code)) ?? '', createdOn: day(r.created_at) ?? today,
  }));

  const [statements, lines, locks] = await Promise.all([
    paginateAll<Record<string, any>>((lo, hi) => sb.from('acc_bank_statements')
      .select('id, account_code, period_from, period_to, created_at').eq('company_id', companyId).order('id').range(lo, hi)),
    paginateAll<Record<string, any>>((lo, hi) => sb.from('acc_bank_statement_lines')
      .select('id, statement_id, amount_sen, booked_on').eq('company_id', companyId).eq('state', 'OPEN').order('id').range(lo, hi)),
    sb.from('acc_bank_month_locks').select('account_code, period_month, locked_at').eq('company_id', companyId).is('released_at', null),
  ]);
  if (statements.error) return fail('bank statements', statements.error.message);
  if (lines.error) return fail('bank lines', lines.error.message);
  if (locks.error) return fail('bank month locks', locks.error.message);
  const stmtRows = (statements.data ?? []) as Rows;
  const lockRows = (locks.data ?? []) as Rows;

  const lastStatementTo: Record<string, string | null> = {};
  for (const b of bankAccounts) lastStatementTo[b.accountCode] = null;
  for (const s of stmtRows) {
    const code = String(s.account_code);
    const to = s.period_to ? String(s.period_to) : null;
    if (to && code in lastStatementTo && (lastStatementTo[code] == null || to > lastStatementTo[code]!)) lastStatementTo[code] = to;
  }

  /* A locked month takes no more decisions, so its lines are not anybody's job. */
  const locked = new Set(lockRows.map((l) => `${l.account_code}|${String(l.period_month).slice(0, 7)}`));
  const stmt = new Map(stmtRows.map((s) => [Number(s.id), s]));
  const bankLines: TodoBankLine[] = [];
  for (const l of (lines.data ?? []) as Rows) {
    const s = stmt.get(Number(l.statement_id));
    if (!s || !(String(s.account_code) in lastStatementTo)) continue;
    if (locked.has(`${s.account_code}|${String(l.booked_on).slice(0, 7)}`)) continue;
    bankLines.push({
      accountCode: String(s.account_code), statementId: Number(s.id), amountSen: Number(l.amount_sen ?? 0),
      periodTo: s.period_to ? String(s.period_to) : null, uploadedOn: day(s.created_at) ?? today,
    });
  }
  const lastMonth = addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
  const lockedLastMonth = [...new Set(lockRows.filter((l) => String(l.period_month).slice(0, 7) === lastMonth).map((l) => String(l.account_code)))];
  return { ok: true, value: { bankAccounts, lastStatementTo, bankLines, lockedLastMonth, statements: stmtRows, locks: lockRows } };
}

/* ── Payments: requests and vouchers ─────────────────────────────────────── */

async function readRequests(sb: any, companyId: number): Promise<Read<TodoFacts['requests']>> {
  /* The four ways a request waits for Finance — routes/payment-requests.ts
     waitingCountHandler counts the same four: new, or answered by a bill or a
     voucher that was since cancelled, or answered by nothing. Read here as the
     answered requests and then the state of what answered them. */
  const cols = 'id, payee_name, amount_sen, created_at, ap_invoice_id, pv_id';
  const [submitted, vouchered] = await Promise.all([
    paginateAll<Record<string, any>>((lo, hi) => sb.from('acc_payment_requests').select(cols)
      .eq('company_id', companyId).eq('status', 'SUBMITTED').order('id').range(lo, hi)),
    paginateAll<Record<string, any>>((lo, hi) => sb.from('acc_payment_requests').select(cols)
      .eq('company_id', companyId).eq('status', 'VOUCHERED').order('id').range(lo, hi)),
  ]);
  if (submitted.error || vouchered.error) return fail('payment requests', (submitted.error ?? vouchered.error)!.message);
  const answered = (vouchered.data ?? []) as Rows;
  const invoiceIds = [...new Set(answered.map((r) => r.ap_invoice_id).filter(Boolean).map(String))];
  const voucherIds = [...new Set(answered.filter((r) => !r.ap_invoice_id).map((r) => r.pv_id).filter(Boolean).map(String))];
  const [invoices, vouchers] = await Promise.all([
    chunkIn<Record<string, any>>(invoiceIds, (batch, lo, hi) => sb.from('ap_invoices').select('id, status').in('id', batch).order('id').range(lo, hi)),
    chunkIn<Record<string, any>>(voucherIds, (batch, lo, hi) => sb.from('payment_vouchers').select('id, status').in('id', batch).order('id').range(lo, hi)),
  ]);
  if (invoices.error || vouchers.error) return fail('payment requests', (invoices.error ?? vouchers.error)!.message);
  const cancelled = new Set([...invoices.data, ...vouchers.data].filter((d) => d.status === 'CANCELLED').map((d) => String(d.id)));
  const waiting = answered.filter((r) => (r.ap_invoice_id
    ? cancelled.has(String(r.ap_invoice_id))
    : r.pv_id ? cancelled.has(String(r.pv_id)) : true));
  return {
    ok: true,
    value: [...((submitted.data ?? []) as Rows), ...waiting]
      .map((r) => ({ payee: String(r.payee_name ?? ''), amountSen: Number(r.amount_sen ?? 0), createdOn: day(r.created_at) ?? '' })),
  };
}

/** A voucher's total in ringgit sen — a foreign-currency voucher at its rate. */
const myrSen = (totalSen: unknown, rate: unknown): number => {
  const r = Number(rate);
  return Math.round(Number(totalSen ?? 0) * (Number.isFinite(r) && r > 0 ? r : 1));
};

async function readVouchers(sb: any, companyId: number): Promise<Read<TodoFacts['vouchers']>> {
  const { data, error } = await sb.from('payment_vouchers')
    .select('payee_name, total_sen, exchange_rate, submitted_at, submitted_by, checked_at, checked_by')
    .eq('company_id', companyId).eq('status', 'DRAFT').not('submitted_at', 'is', null).is('approved_at', null);
  if (error) return fail('payment vouchers', error.message);
  return {
    ok: true,
    value: ((data ?? []) as Rows).map((v) => (v.checked_at
      ? { stage: 'approve' as const, payee: String(v.payee_name ?? ''), amountSen: myrSen(v.total_sen, v.exchange_rate), since: day(v.checked_at) ?? '', by: v.checked_by ?? null }
      : { stage: 'check' as const, payee: String(v.payee_name ?? ''), amountSen: myrSen(v.total_sen, v.exchange_rate), since: day(v.submitted_at) ?? '', by: v.submitted_by ?? null })),
  };
}

/* ── Receipts and invoices ───────────────────────────────────────────────── */

async function readTransfers(sb: any, companyId: number): Promise<Read<TodoFacts['transfers']>> {
  const all = await paginateAll<Record<string, any>>((lo, hi) => sb.from('acc_official_receipts')
    .select('id, amount_sen, paid_at').eq('company_id', companyId).eq('status', 'DRAFT').eq('method', 'transfer')
    .order('id').range(lo, hi));
  if (all.error) return fail('official receipts', all.error.message);
  return { ok: true, value: ((all.data ?? []) as Rows).map((r) => ({ amountSen: Number(r.amount_sen ?? 0), paidOn: r.paid_at ? String(r.paid_at) : null })) };
}

async function readOverdue(sb: any, companyId: number, today: string): Promise<Read<TodoFacts['overdue']>> {
  const all = await paginateAll<Record<string, any>>((lo, hi) => sb.from('sales_invoices')
    .select('id, invoice_number, so_doc_no, debtor_name, due_date, status, total_sen, paid_sen')
    .eq('company_id', companyId).in('status', ['SENT', 'PARTIALLY_PAID', 'OVERDUE'])
    .lt('due_date', addDays(today, -OVERDUE_DAYS)).order('id').range(lo, hi));
  if (all.error) return fail('overdue invoices', all.error.message);
  const rows = (all.data ?? []) as Rows;
  /* What the invoice still owes after its order's deposit — the SI list's own rule. */
  await stampOrderDeposit(sb, rows, companyId);
  return {
    ok: true,
    value: rows
      .map((r) => ({
        invoiceNo: String(r.invoice_number ?? ''), debtor: String(r.debtor_name ?? ''), dueDate: String(r.due_date),
        outstandingSen: Number(r.total_sen ?? 0) - Number(r.paid_sen ?? 0) - Number(r.so_deposit_applied_sen ?? 0),
      }))
      .filter((r) => r.outstandingSen > 0),
  };
}

/* ── Done today ──────────────────────────────────────────────────────────── */

async function readDone(sb: any, companyId: number, today: string, cards: CardFacts | null, bank: BankFacts | null): Promise<Read<TodoDone[]>> {
  const from = dayStart(today);
  /* A voucher counts once for each step taken on it today — three plain reads, one per step. */
  const pvStep = (col: string) => sb.from('payment_vouchers').select('id, pv_number, payee_name, checked_at, approved_at, posted_at')
    .eq('company_id', companyId).gte(col, from);
  const [confirmed, decided, checkedPv, approvedPv, postedPv, requests, receipts] = await Promise.all([
    paginateAll<Record<string, any>>((lo, hi) => sb.from('acc_settlement_rows')
      .select('id, acquirer_code, posted_je_no, confirmed_at').eq('company_id', companyId).gte('confirmed_at', from).order('id').range(lo, hi)),
    paginateAll<Record<string, any>>((lo, hi) => sb.from('acc_bank_statement_lines')
      .select('id, statement_id, state, posted_je_no, updated_at').eq('company_id', companyId).in('state', ['POSTED', 'IGNORED'])
      .gte('updated_at', from).order('id').range(lo, hi)),
    pvStep('checked_at'), pvStep('approved_at'), pvStep('posted_at'),
    sb.from('acc_payment_requests').select('id, decided_at').eq('company_id', companyId).eq('status', 'VOUCHERED').gte('decided_at', from),
    sb.from('acc_official_receipts').select('id, issued_at').eq('company_id', companyId).eq('status', 'FORMAL').gte('issued_at', from),
  ]);
  const bad = [confirmed, decided, checkedPv, approvedPv, postedPv, requests, receipts].find((r) => r.error);
  if (bad) return fail('what was done today', bad.error.message);
  const vouchers = { data: [...new Map([checkedPv, approvedPv, postedPv].flatMap((r) => (r.data ?? []) as Rows).map((v) => [String(v.id), v])).values()] };
  const done: TodoDone[] = [];

  const names = new Map((cards?.acquirers ?? []).map((a) => [a.code, a.name]));
  const byAcq = new Map<string, Rows>();
  for (const r of (confirmed.data ?? []) as Rows) byAcq.set(String(r.acquirer_code), [...(byAcq.get(String(r.acquirer_code)) ?? []), r]);
  for (const [code, rs] of byAcq) {
    const jes = [...new Set(rs.map((r) => r.posted_je_no).filter(Boolean))];
    done.push({ key: `confirmed:${code}`, text: `Confirmed ${rs.length} ${names.get(code) ?? code} merchant line${rs.length > 1 ? 's' : ''}`, je: jes.length === 1 ? String(jes[0]) : null, at: clock(latest(rs.map((r) => r.confirmed_at))) });
  }
  for (const b of cards?.batches ?? []) {
    if (day(b.created_at) !== today) continue;
    const span = b.period_from && b.period_to ? (b.period_from === b.period_to ? ` · ${String(b.period_to).replace(/-/g, '/')}` : ` · ${String(b.period_from).replace(/-/g, '/')} – ${String(b.period_to).replace(/-/g, '/')}`) : '';
    done.push({ key: `report:${b.id}`, text: `Uploaded ${names.get(String(b.acquirer_code)) ?? b.acquirer_code} merchant report${span}`, je: null, at: clock(b.created_at) });
  }

  const stmt = new Map((bank?.statements ?? []).map((s) => [Number(s.id), s]));
  const bankOf = new Map((bank?.bankAccounts ?? []).map((a) => [a.accountCode, bankName(a.bankCode)]));
  for (const s of bank?.statements ?? []) {
    if (day(s.created_at) !== today) continue;
    done.push({ key: `statement:${s.id}`, text: `Uploaded ${bankOf.get(String(s.account_code)) ?? s.account_code} statement · ${s.account_code}`, je: null, at: clock(s.created_at) });
  }
  const byAccount = new Map<string, Rows>();
  for (const l of (decided.data ?? []) as Rows) {
    const code = String(stmt.get(Number(l.statement_id))?.account_code ?? '');
    if (!code) continue;
    byAccount.set(code, [...(byAccount.get(code) ?? []), l]);
  }
  for (const [code, ls] of byAccount) {
    done.push({ key: `decided:${code}`, text: `Decided ${ls.length} ${bankOf.get(code) ?? code} line${ls.length > 1 ? 's' : ''} · ${code}`, je: null, at: clock(latest(ls.map((l) => l.updated_at))) });
  }
  for (const l of bank?.locks ?? []) {
    if (day(l.locked_at) !== today) continue;
    done.push({ key: `locked:${l.account_code}:${l.period_month}`, text: `Locked ${bankOf.get(String(l.account_code)) ?? l.account_code} ${String(l.period_month).slice(0, 7).replace('-', '/')} · ${l.account_code}`, je: null, at: clock(l.locked_at) });
  }

  for (const v of (vouchers.data ?? []) as Rows) {
    const steps: Array<[string, unknown]> = [['Checked', v.checked_at], ['Approved', v.approved_at], ['Posted', v.posted_at]];
    for (const [verb, at] of steps) {
      if (day(at) !== today) continue;
      done.push({ key: `pv:${v.pv_number}:${verb}`, text: `${verb} ${v.payee_name ?? 'voucher'}`, je: v.pv_number ? String(v.pv_number) : null, at: clock(at) });
    }
  }
  const reqs = (requests.data ?? []) as Rows;
  if (reqs.length) done.push({ key: 'requests', text: `Made ${reqs.length} payment request${reqs.length > 1 ? 's' : ''} into vouchers`, je: null, at: clock(latest(reqs.map((r) => r.decided_at))) });
  const ors = (receipts.data ?? []) as Rows;
  if (ors.length) done.push({ key: 'receipts', text: `${ors.length} official receipt${ors.length > 1 ? 's' : ''} went formal`, je: null, at: clock(latest(ors.map((r) => r.issued_at))) });
  return { ok: true, value: done };
}

/* ── Whose desk ──────────────────────────────────────────────────────────── */

/* Who holds the voucher keys by ROLE barely changes; the badge polls every
   minute, so the answer is kept a few minutes per company. */
const HOLDERS_TTL_MS = 5 * 60_000;
const holdersCache = new Map<string, { at: number; names: string[] }>();

async function literalHolderNames(c: any, perm: string, companyId: number): Promise<string[]> {
  const key = `${companyId}|${perm}`;
  const hit = holdersCache.get(key);
  if (hit && Date.now() - hit.at < HOLDERS_TTL_MS) return hit.names;
  const ids = await usersHoldingPermission(c.env, perm, { companyId });
  let names: string[] = [];
  if (ids.length) {
    const rows = await c.env.DB.prepare(`SELECT name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    names = [...new Set(((rows.results ?? []) as Array<{ name: string | null }>).map((r) => String(r.name ?? '').trim()).filter(Boolean))];
    if (names.length === 0) names = ids.map((id) => `#${id}`);
  }
  holdersCache.set(key, { at: Date.now(), names });
  return names;
}

async function readViewer(c: any, companyId: number, problems: string[]): Promise<TodoViewer> {
  const finance = hasHouzsPerm(c, 'scm.payment_voucher.create') || hasHouzsPerm(c, 'scm.payment_voucher.post');
  const desk = async (perm: string): Promise<{ mine: boolean; names: string[] }> => {
    const literal = holdsHouzsPermLiterally(c, perm);
    try {
      const names = await literalHolderNames(c, perm, companyId);
      /* Nobody holds it by role here: it is on whoever may do it. */
      return { mine: literal || (names.length === 0 && hasHouzsPerm(c, perm)), names };
    } catch (e) {
      problems.push(`who ${perm.endsWith('check') ? 'checks' : 'approves'} vouchers (${e instanceof Error ? e.message : String(e)})`);
      return { mine: hasHouzsPerm(c, perm), names: [] };
    }
  };
  const [check, approve] = await Promise.all([desk('scm.payment_voucher.check'), desk('scm.payment_voucher.approve')]);
  return { finance, checker: check.mine, approver: approve.mine, checkerNames: check.names, approverNames: approve.names };
}

/* ── Facts and handlers ──────────────────────────────────────────────────── */

/** Every fact the rules read, for one company and day. `full` adds the money
    board and what was done today — the page wants them, the badge does not. */
export async function readFinanceTodoFacts(sb: any, companyId: number, today: string, full: boolean): Promise<TodoFacts> {
  const problems: string[] = [];
  /* A section that throws is a failed read like any other — named, and the rest still shown. */
  const safe = async <T,>(what: string, run: () => Promise<Read<T>>): Promise<Read<T>> => {
    try { return await run(); } catch (e) { return fail(what, e instanceof Error ? e.message : String(e)); }
  };
  const [cards, bank, requests, vouchers, transfers, overdue] = await Promise.all([
    safe('merchant reports', () => readCards(sb, companyId, today)), safe('bank statements', () => readBank(sb, companyId, today)),
    safe('payment requests', () => readRequests(sb, companyId)), safe('payment vouchers', () => readVouchers(sb, companyId)),
    safe('official receipts', () => readTransfers(sb, companyId)), safe('overdue invoices', () => readOverdue(sb, companyId, today)),
  ]);
  const ok = <T,>(r: Read<T>, empty: T): T => {
    if (r.ok) return r.value;
    problems.push(`${r.what} (${r.reason})`);
    return empty;
  };
  const card = cards.ok ? cards.value : null;
  const bk = bank.ok ? bank.value : null;
  if (!cards.ok) problems.push(`${cards.what} (${cards.reason})`);
  if (!bank.ok) problems.push(`${bank.what} (${bank.reason})`);

  let money: TodoFacts['money'] = null;
  let done: TodoDone[] = [];
  if (full) {
    const [board, doneRead] = await Promise.all([
      loadDailyBankBoard(sb, companyId, today, { withNames: false })
        .catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : String(e) })),
      safe('what was done today', () => readDone(sb, companyId, today, card, bk)),
    ]);
    if (board.ok) money = { bankCashSen: board.board.totalClosingSen, awaitingSen: board.board.pendingApprovalSen, onTheWaySen: board.board.totalTransitSen };
    else problems.push(`bank balances (${board.reason})`);
    done = ok(doneRead, []);
  }
  return {
    today,
    acquirers: card?.acquirers ?? [], lastReportTo: card?.lastReportTo ?? {}, keyedCardDays: card?.keyedCardDays ?? {}, cardRows: card?.cardRows ?? [],
    bankAccounts: bk?.bankAccounts ?? [], lastStatementTo: bk?.lastStatementTo ?? {}, bankLines: bk?.bankLines ?? [], lockedLastMonth: bk?.lockedLastMonth ?? [],
    requests: ok(requests, []), vouchers: ok(vouchers, []), transfers: ok(transfers, []), overdue: ok(overdue, []),
    money, done, problems,
  };
}

/** GET /accounting/todo — the page. */
export const financeTodoHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const today = todayMyt();
  const facts = await readFinanceTodoFacts(c.get('supabase'), co.companyId, today, true);
  const viewer = await readViewer(c, co.companyId, facts.problems);
  return c.json(buildFinanceTodo(facts, viewer));
};

/** GET /accounting/todo/count — how many jobs wait on the viewer (the sidebar badge). */
export const financeTodoCountHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json({ count: 0 });
  const facts = await readFinanceTodoFacts(c.get('supabase'), co.companyId, todayMyt(), false);
  const viewer = await readViewer(c, co.companyId, facts.problems);
  return c.json({ count: raiseJobs(facts, viewer).mine.length });
};
