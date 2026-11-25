// ----------------------------------------------------------------------------
// accounting-daily-bank-cashbook — Daily Bank's cash book, a second Daily Bank
// beside the original (owner 2026-11-23: 先做一个daily bank的一开始直接，但不需要列实际
// 差额。然后我每天会手动输入收到的金额; 付款就根据pv; 原版的daily bank还是要保留哦，我这
// 算是新的daily bank). Per money account, the bank's real balance at the start of
// a day; then the money received, typed by hand per bank and day. Both live only
// here and on the cash-book board (GET /daily-bank/cashbook/board, acc/daily-bank.ts);
// the original board never reads them, nothing posts a journal, and no
// books-versus-bank difference is shown anywhere.
//
//   GET    /daily-bank/cashbook?date=        the money accounts with their start,
//                                            the day's typed receipts, and the
//                                            day's deleted ones (who, when)
//   PUT    /daily-bank/starts/:accountCode   { startDate, balanceSen, note? }
//   DELETE /daily-bank/starts/:accountCode   the account leaves the cash book
//   POST   /daily-bank/receipts              { accountCode, date, amountSen, note }
//   PATCH  /daily-bank/receipts/:id          any of those four
//   DELETE /daily-bank/receipts/:id          stamps deleted_at / deleted_by; the row stays
//   PUT    /daily-bank/receipts/day          { date, cells: [{ accountCode, method, amountSen }] }
//                                            the day's grid (owner 2026-11-23: 不能做成这样的
//                                            表格给我keyin income？): one total per bank and
//                                            method; 0 clears a cell
//   PUT    /daily-bank/skips/:pvId           tick an approved voucher as already in its
//                                            bank's starting balance: the cash book lists
//                                            it, never takes it off (owner 2026-11-25:
//                                            这个是例外 … 要，加勾选)
//   DELETE /daily-bank/skips/:pvId           untick: it comes off again; stamps
//                                            unticked_at / unticked_by, the row stays
//
// Writes take the Finance write key Daily close takes (scm.payment_voucher.post),
// ask the audit trail first (assertAuditWritable) and record every change on it
// with its from -> to. Every read and write carries the company predicate.
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env, Variables } from '../env';
import { requireActiveCompanyId } from '../lib/companyScope';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { todayMyt } from '../lib/my-time';
import { paginateAll } from '../lib/paginate-all';
import {
  assertAuditWritable, auditUnavailableBody, compactChanges, fieldChange, recordEntityAudit,
  type AuditAction, type EntityType, type FieldChange,
} from '../lib/entity-audit';
import { fmtDate, fmtSen } from '../shared/format';
import { insideStart, voucherPayoutSen, type CashbookPayout } from '../../acc/daily-bank';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
type Sb = Variables['supabase'];
type Refusal = { status: ContentfulStatusCode; body: Record<string, unknown> };

/** Who may change the cash book: its starts, receipts and ticks. */
export const canWriteCashbook = (c: Ctx): boolean => hasHouzsPerm(c, 'scm.payment_voucher.post');
const NO_PERM = { error: 'forbidden', message: "You don't have permission to change the Daily Bank cash book." };
/** RM 10 billion: past this a figure is a typing slip, not a bank balance. */
const MAX_SEN = 1_000_000_000_000;
const NOTE_MAX = 300;

const who = (c: Ctx): string | null => {
  const u = c.get('houzsUser') as { name?: string | null; email?: string | null } | undefined;
  const name = String(u?.name ?? u?.email ?? '').trim();
  return name || null;
};

/** A real calendar day as YYYY-MM-DD (2026-02-30 is not one), else null. */
export function calendarDay(v: unknown): string | null {
  const s = String(v ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}

const oneLine = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim();

async function readJson(c: Ctx): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return body && typeof body === 'object' ? body as Record<string, unknown> : null;
  } catch { return null; }
}

/** The permission, then the company: what every write needs first. */
function writeGate(c: Ctx): { companyId: number } | { resp: Response } {
  if (!canWriteCashbook(c)) return { resp: c.json(NO_PERM, 403) };
  const co = requireActiveCompanyId(c);
  if (!co.ok) return { resp: c.json(co.refusal, 409) };
  return { companyId: co.companyId };
}

/** An active money account of this company — the only kind the board carries. */
async function moneyAccount(sb: Sb, companyId: number, code: string): Promise<{ ok: true; name: string } | ({ ok: false } & Refusal)> {
  const { data, error } = await sb.from('accounts').select('account_code, account_name')
    .eq('company_id', companyId).eq('account_code', code).eq('acc_money', true).eq('is_active', true).maybeSingle();
  if (error) return { ok: false, status: 500, body: { error: 'load_failed', reason: error.message } };
  if (!data) return { ok: false, status: 400, body: { error: 'not_money_account', message: `${code || 'That account'} is not a bank or cash account of this company.` } };
  return { ok: true, name: String((data as { account_name?: string }).account_name ?? code) };
}

type StartRow = { account_code: string; start_date: string; balance_sen: number; note: string | null };

async function startOf(sb: Sb, companyId: number, code: string): Promise<{ ok: true; start: StartRow | null } | ({ ok: false } & Refusal)> {
  const { data, error } = await sb.from('acc_daily_bank_starts').select('account_code, start_date, balance_sen, note')
    .eq('company_id', companyId).eq('account_code', code).maybeSingle();
  if (error) return { ok: false, status: 500, body: { error: 'load_failed', reason: error.message } };
  if (!data) return { ok: true, start: null };
  const s = data as Record<string, unknown>;
  return { ok: true, start: { account_code: String(s.account_code), start_date: String(s.start_date).slice(0, 10), balance_sen: Number(s.balance_sen), note: (s.note as string | null) ?? null } };
}

const auditReady = async (sb: Sb, entityType: EntityType, entityId: string | null, action: AuditAction, companyId: number): Promise<boolean> =>
  (await assertAuditWritable(sb, { entityType, entityId, action, companyId })).ok;

/** A way money comes in: the grid's column. */
export type ReceiptMethod = { key: string; label: string };
const FIXED_METHODS: ReceiptMethod[] = [{ key: 'online', label: 'Online' }, { key: 'cash', label: 'Cash' }, { key: 'cheque', label: 'Cheque' }];

/** The grid's columns: Online, Cash, Cheque, then each card terminal Settlement Setup
    keeps active for the company (its acquirer code), in code order. */
async function methodsOf(sb: Sb, companyId: number): Promise<{ ok: true; methods: ReceiptMethod[] } | ({ ok: false } & Refusal)> {
  const { data, error } = await sb.from('acc_acquirers').select('code').eq('company_id', companyId).eq('is_active', true).order('code');
  if (error) return { ok: false, status: 500, body: { error: 'load_failed', reason: error.message } };
  const codes = [...new Set((data as Array<{ code: string }>).map((a) => String(a.code)))];
  return { ok: true, methods: [...FIXED_METHODS, ...codes.map((code) => ({ key: `card:${code}`, label: code }))] };
}

/** What a grid receipt says on the board: its method in words. */
export const methodNote = (m: ReceiptMethod): string => (m.key.startsWith('card:') ? `${m.label} card` : m.label);

/** A method from its key, for one a day already holds: a terminal turned off in
    Settlement Setup later keeps its column on that day, to be read, changed or cleared. */
function methodFromKey(key: string): ReceiptMethod | null {
  const fixed = FIXED_METHODS.find((m) => m.key === key);
  if (fixed) return fixed;
  return /^card:\S+$/.test(key) ? { key, label: key.slice('card:'.length) } : null;
}
const withHeld = (methods: ReceiptMethod[], held: Iterable<string>): ReceiptMethod[] => {
  const out = [...methods];
  for (const key of held) {
    const m = out.some((x) => x.key === key) ? null : methodFromKey(key);
    if (m) out.push(m);
  }
  return out;
};

/* ── GET /daily-bank/cashbook?date= ─────────────────────────────────────────── */
export const cashbookGet = async (c: Ctx): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const date = calendarDay(c.req.query('date')) ?? todayMyt();
  const sb = c.get('supabase');
  const ms = await methodsOf(sb, co.companyId);
  if (!ms.ok) return c.json(ms.body, ms.status);
  const [acc, st, rc] = await Promise.all([
    sb.from('accounts').select('account_code, account_name')
      .eq('company_id', co.companyId).eq('acc_money', true).eq('is_active', true).order('account_code'),
    sb.from('acc_daily_bank_starts').select('account_code, start_date, balance_sen, note, set_by, updated_at')
      .eq('company_id', co.companyId),
    paginateAll<Record<string, unknown>>((from, to) => sb.from('acc_daily_bank_receipts')
      .select('id, account_code, receipt_date, amount_sen, note, method, created_by, created_at, updated_by, updated_at, deleted_by, deleted_at')
      .eq('company_id', co.companyId).eq('receipt_date', date)
      .order('created_at').order('id').range(from, to)),
  ]);
  if (acc.error) return c.json({ error: 'load_failed', reason: acc.error.message }, 500);
  if (st.error) return c.json({ error: 'load_failed', reason: st.error.message }, 500);
  if (rc.error) return c.json({ error: 'load_failed', reason: rc.error.message }, 500);
  const starts = new Map((st.data as Array<Record<string, unknown>>).map((s) => [String(s.account_code), {
    date: String(s.start_date).slice(0, 10), balanceSen: Number(s.balance_sen), note: (s.note as string | null) ?? null,
    setBy: (s.set_by as string | null) ?? null, setAt: (s.updated_at as string | null) ?? null,
  }]));
  const accounts = (acc.data as Array<{ account_code: string; account_name: string }>).map((a) => ({
    accountCode: a.account_code, accountName: a.account_name, start: starts.get(a.account_code) ?? null,
  }));
  const nameOf = new Map(accounts.map((a) => [a.accountCode, a.accountName]));
  const rows = (rc.data ?? []).map((r) => {
    const code = String(r.account_code);
    const start = starts.get(code) ?? null;
    return {
      id: String(r.id), accountCode: code, accountName: nameOf.get(code) ?? code, date: String(r.receipt_date).slice(0, 10),
      amountSen: Number(r.amount_sen), note: String(r.note ?? ''), method: (r.method as string | null) ?? null,
      createdBy: (r.created_by as string | null) ?? null, createdAt: (r.created_at as string | null) ?? null,
      updatedBy: (r.updated_by as string | null) ?? null, updatedAt: (r.updated_at as string | null) ?? null,
      deletedBy: (r.deleted_by as string | null) ?? null, deletedAt: (r.deleted_at as string | null) ?? null,
      /* On the cash-book board only while its account's start is on or before it. */
      counted: r.deleted_at == null && start != null && start.date <= date,
    };
  });
  const held = rows.filter((r) => r.deletedAt == null && r.method != null).map((r) => String(r.method));
  return c.json({
    date, today: todayMyt(), canWrite: canWriteCashbook(c), accounts, methods: withHeld(ms.methods, held),
    receipts: rows.filter((r) => r.deletedAt == null),
    deleted: rows.filter((r) => r.deletedAt != null),
  });
};

/* ── PUT /daily-bank/starts/:accountCode { startDate, balanceSen, note? } ───── */
export const cashbookStartPut = async (c: Ctx): Promise<Response> => {
  const g = writeGate(c);
  if ('resp' in g) return g.resp;
  const code = String(c.req.param('accountCode') ?? '').trim();
  const body = await readJson(c);
  if (!body) return c.json({ error: 'invalid_json' }, 400);
  const startDate = calendarDay(body.startDate);
  if (!startDate) return c.json({ error: 'bad_date', message: 'Give the start date as a real day.' }, 400);
  const balanceSen = Number(body.balanceSen);
  if (!Number.isSafeInteger(balanceSen) || Math.abs(balanceSen) >= MAX_SEN) {
    return c.json({ error: 'bad_amount', message: 'The starting balance must be a whole number of sen.' }, 400);
  }
  const note = oneLine(body.note).slice(0, NOTE_MAX) || null;
  const sb = c.get('supabase');
  const acct = await moneyAccount(sb, g.companyId, code);
  if (!acct.ok) return c.json(acct.body, acct.status);
  const prior = await startOf(sb, g.companyId, code);
  if (!prior.ok) return c.json(prior.body, prior.status);
  const action: AuditAction = prior.start ? 'UPDATE' : 'CREATE';
  const changes = compactChanges([
    fieldChange('start_date', prior.start?.start_date ?? null, startDate),
    fieldChange('balance_sen', prior.start?.balance_sen ?? null, balanceSen),
    fieldChange('note', prior.start?.note ?? null, note),
  ]);
  if (prior.start && changes.length === 0) return c.json({ ok: true, unchanged: true });
  if (!(await auditReady(sb, 'DAILY_BANK_START', code, action, g.companyId))) return c.json(auditUnavailableBody(), 409);
  const row = { start_date: startDate, balance_sen: balanceSen, note, set_by: who(c), updated_at: new Date().toISOString() };
  const { error } = prior.start
    ? await sb.from('acc_daily_bank_starts').update(row).eq('company_id', g.companyId).eq('account_code', code)
    : await sb.from('acc_daily_bank_starts').insert({ company_id: g.companyId, account_code: code, ...row });
  if (error) {
    if (String((error as { code?: string }).code ?? '') === '23505') {
      return c.json({ error: 'conflict', message: `Someone else has just set ${acct.name}'s starting balance. Reload and look again.` }, 409);
    }
    return c.json({ error: 'save_failed', reason: error.message }, 500);
  }
  await recordEntityAudit(sb, {
    entityType: 'DAILY_BANK_START', entityId: code, entityDocNo: code, action, actor: c.get('houzsUser'), companyId: g.companyId,
    note: `${acct.name}: cash book starts ${fmtDate(startDate)} at ${fmtSen(balanceSen)}`, fieldChanges: changes,
  });
  return c.json({ ok: true });
};

/* ── DELETE /daily-bank/starts/:accountCode ─────────────────────────────────── */
export const cashbookStartDelete = async (c: Ctx): Promise<Response> => {
  const g = writeGate(c);
  if ('resp' in g) return g.resp;
  const code = String(c.req.param('accountCode') ?? '').trim();
  const sb = c.get('supabase');
  const prior = await startOf(sb, g.companyId, code);
  if (!prior.ok) return c.json(prior.body, prior.status);
  if (!prior.start) return c.json({ error: 'not_found', message: `${code || 'That account'} has no starting balance.` }, 404);
  if (!(await auditReady(sb, 'DAILY_BANK_START', code, 'DELETE', g.companyId))) return c.json(auditUnavailableBody(), 409);
  const { error } = await sb.from('acc_daily_bank_starts').delete().eq('company_id', g.companyId).eq('account_code', code);
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  await recordEntityAudit(sb, {
    entityType: 'DAILY_BANK_START', entityId: code, entityDocNo: code, action: 'DELETE', actor: c.get('houzsUser'), companyId: g.companyId,
    note: `${code}: starting balance removed; the account leaves the cash book`,
    fieldChanges: compactChanges([
      fieldChange('start_date', prior.start.start_date, null),
      fieldChange('balance_sen', prior.start.balance_sen, null),
      fieldChange('note', prior.start.note, null),
    ]),
  });
  return c.json({ ok: true });
};

/* ── the receipt rules ──────────────────────────────────────────────────────── */

type ReceiptFields = { account_code: string; receipt_date: string; amount_sen: number; note: string };

/** The four fields as typed, checked for shape. */
function receiptShape(body: Record<string, unknown>, base: ReceiptFields | null): { ok: true; r: ReceiptFields } | ({ ok: false } & Refusal) {
  /* An edit keeps what it does not name; a new receipt names all four. */
  const kept = (k: string): boolean => base != null && body[k] === undefined;
  const account = base && kept('accountCode') ? base.account_code : String(body.accountCode ?? '').trim();
  const date = base && kept('date') ? base.receipt_date : calendarDay(body.date);
  if (!date) return { ok: false, status: 400, body: { error: 'bad_date', message: 'Give the day the money came in as a real day.' } };
  const amount = base && kept('amountSen') ? base.amount_sen : Number(body.amountSen);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount >= MAX_SEN) {
    return { ok: false, status: 400, body: { error: 'bad_amount', message: 'The amount must be more than zero, in whole sen.' } };
  }
  const note = base && kept('note') ? base.note : oneLine(body.note);
  if (!note) return { ok: false, status: 400, body: { error: 'note_required', message: 'Say who paid or what the money is for.' } };
  if (note.length > NOTE_MAX) return { ok: false, status: 400, body: { error: 'note_too_long', message: `Keep the note to ${NOTE_MAX} characters.` } };
  return { ok: true, r: { account_code: account, receipt_date: date, amount_sen: amount, note } };
}

/** A receipt counts only inside its account's cash book: a money account, with a
    start on or before the day, and a day that has happened. */
async function receiptAllowed(sb: Sb, companyId: number, r: ReceiptFields): Promise<{ ok: true; name: string } | ({ ok: false } & Refusal)> {
  const acct = await moneyAccount(sb, companyId, r.account_code);
  if (!acct.ok) return acct;
  const s = await startOf(sb, companyId, r.account_code);
  if (!s.ok) return s;
  if (!s.start) {
    return { ok: false, status: 409, body: { error: 'no_start', message: `Set ${acct.name}'s starting balance first. Until then it is not on the cash book and a typed receipt would not count.` } };
  }
  if (r.receipt_date < s.start.start_date) {
    return { ok: false, status: 409, body: { error: 'before_start', message: `${acct.name}'s cash book starts on ${fmtDate(s.start.start_date)}. Money before that is already inside its starting balance.` } };
  }
  if (r.receipt_date > todayMyt()) {
    return { ok: false, status: 400, body: { error: 'future_date', message: `${fmtDate(r.receipt_date)} has not come yet. Type money once it is received.` } };
  }
  return { ok: true, name: acct.name };
}

const receiptChanges = (from: ReceiptFields | null, to: ReceiptFields | null): FieldChange[] => compactChanges([
  fieldChange('account_code', from?.account_code ?? null, to?.account_code ?? null),
  fieldChange('receipt_date', from?.receipt_date ?? null, to?.receipt_date ?? null),
  fieldChange('amount_sen', from?.amount_sen ?? null, to?.amount_sen ?? null),
  fieldChange('note', from?.note ?? null, to?.note ?? null),
]);

type StoredReceipt = ReceiptFields & { id: string; deleted_at: string | null };

async function receiptById(sb: Sb, companyId: number, id: string): Promise<{ ok: true; row: StoredReceipt } | ({ ok: false } & Refusal)> {
  const { data, error } = await sb.from('acc_daily_bank_receipts')
    .select('id, account_code, receipt_date, amount_sen, note, deleted_at')
    .eq('company_id', companyId).eq('id', id).maybeSingle();
  const notHere: Refusal = { status: 404, body: { error: 'not_found', message: 'That receipt is not in the company you are working in.' } };
  /* 22P02: not a uuid at all — no such receipt, not a server fault. */
  if (error) return String((error as { code?: string }).code ?? '') === '22P02' ? { ok: false, ...notHere } : { ok: false, status: 500, body: { error: 'load_failed', reason: error.message } };
  if (!data) return { ok: false, ...notHere };
  const r = data as Record<string, unknown>;
  return { ok: true, row: {
    id: String(r.id), account_code: String(r.account_code), receipt_date: String(r.receipt_date).slice(0, 10),
    amount_sen: Number(r.amount_sen), note: String(r.note ?? ''), deleted_at: (r.deleted_at as string | null) ?? null,
  } };
}

/* ── POST /daily-bank/receipts { accountCode, date, amountSen, note } ──────── */
export const cashbookReceiptCreate = async (c: Ctx): Promise<Response> => {
  const g = writeGate(c);
  if ('resp' in g) return g.resp;
  const body = await readJson(c);
  if (!body) return c.json({ error: 'invalid_json' }, 400);
  const shaped = receiptShape(body, null);
  if (!shaped.ok) return c.json(shaped.body, shaped.status);
  const r = shaped.r;
  const sb = c.get('supabase');
  const allowed = await receiptAllowed(sb, g.companyId, r);
  if (!allowed.ok) return c.json(allowed.body, allowed.status);
  if (!(await auditReady(sb, 'DAILY_BANK_RECEIPT', null, 'CREATE', g.companyId))) return c.json(auditUnavailableBody(), 409);
  const { data, error } = await sb.from('acc_daily_bank_receipts')
    .insert({ company_id: g.companyId, ...r, created_by: who(c) }).select('id').single();
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  const id = String((data as { id: unknown }).id);
  await recordEntityAudit(sb, {
    entityType: 'DAILY_BANK_RECEIPT', entityId: id, entityDocNo: r.account_code, action: 'CREATE', actor: c.get('houzsUser'), companyId: g.companyId,
    note: `Received ${fmtSen(r.amount_sen)} into ${allowed.name} on ${fmtDate(r.receipt_date)}: ${r.note}`, fieldChanges: receiptChanges(null, r),
  });
  return c.json({ ok: true, id }, 201);
};

/* ── PATCH /daily-bank/receipts/:id { accountCode?, date?, amountSen?, note? } ─ */
export const cashbookReceiptUpdate = async (c: Ctx): Promise<Response> => {
  const g = writeGate(c);
  if ('resp' in g) return g.resp;
  const body = await readJson(c);
  if (!body) return c.json({ error: 'invalid_json' }, 400);
  const sb = c.get('supabase');
  const got = await receiptById(sb, g.companyId, String(c.req.param('id') ?? ''));
  if (!got.ok) return c.json(got.body, got.status);
  const before = got.row;
  if (before.deleted_at) return c.json({ error: 'deleted', message: 'That receipt was deleted. Type it again if the money did come in.' }, 409);
  const shaped = receiptShape(body, before);
  if (!shaped.ok) return c.json(shaped.body, shaped.status);
  const after = shaped.r;
  const changes = receiptChanges(before, after);
  if (changes.length === 0) return c.json({ ok: true, unchanged: true });
  const allowed = await receiptAllowed(sb, g.companyId, after);
  if (!allowed.ok) return c.json(allowed.body, allowed.status);
  if (!(await auditReady(sb, 'DAILY_BANK_RECEIPT', before.id, 'UPDATE', g.companyId))) return c.json(auditUnavailableBody(), 409);
  const { data, error } = await sb.from('acc_daily_bank_receipts')
    .update({ ...after, updated_by: who(c), updated_at: new Date().toISOString() })
    .eq('company_id', g.companyId).eq('id', before.id).is('deleted_at', null).select('id');
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  if (!Array.isArray(data) || data.length === 0) return c.json({ error: 'deleted', message: 'That receipt was deleted a moment ago. Nothing was changed.' }, 409);
  await recordEntityAudit(sb, {
    entityType: 'DAILY_BANK_RECEIPT', entityId: before.id, entityDocNo: after.account_code, action: 'UPDATE', actor: c.get('houzsUser'), companyId: g.companyId,
    note: `Receipt changed: ${fmtSen(after.amount_sen)} into ${allowed.name} on ${fmtDate(after.receipt_date)}`, fieldChanges: changes,
  });
  return c.json({ ok: true });
};

/* ── DELETE /daily-bank/receipts/:id ────────────────────────────────────────── */
export const cashbookReceiptDelete = async (c: Ctx): Promise<Response> => {
  const g = writeGate(c);
  if ('resp' in g) return g.resp;
  const sb = c.get('supabase');
  const got = await receiptById(sb, g.companyId, String(c.req.param('id') ?? ''));
  if (!got.ok) return c.json(got.body, got.status);
  const before = got.row;
  if (before.deleted_at) return c.json({ ok: true, alreadyDeleted: true });
  if (!(await auditReady(sb, 'DAILY_BANK_RECEIPT', before.id, 'DELETE', g.companyId))) return c.json(auditUnavailableBody(), 409);
  const { data, error } = await sb.from('acc_daily_bank_receipts')
    .update({ deleted_at: new Date().toISOString(), deleted_by: who(c) })
    .eq('company_id', g.companyId).eq('id', before.id).is('deleted_at', null).select('id');
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  if (!Array.isArray(data) || data.length === 0) return c.json({ ok: true, alreadyDeleted: true });
  await recordEntityAudit(sb, {
    entityType: 'DAILY_BANK_RECEIPT', entityId: before.id, entityDocNo: before.account_code, action: 'DELETE', actor: c.get('houzsUser'), companyId: g.companyId,
    note: `Receipt deleted: ${fmtSen(before.amount_sen)} into ${before.account_code} on ${fmtDate(before.receipt_date)}: ${before.note}`,
    fieldChanges: receiptChanges(before, null),
  });
  return c.json({ ok: true });
};

/* ── PUT /daily-bank/receipts/day { date, cells: [{ accountCode, method, amountSen }] } ──
   The day's income as a grid (owner 2026-11-23: 不能做成这样的表格给我keyin income？):
   each cell is one receipt — bank, day, method — holding that day's total. A cell
   sent with an amount creates or changes its receipt, a cell sent as 0 deletes it
   (kept, stamped), a cell not sent is left as it is. Each change is on the trail. */
type Cell = { account_code: string; method: ReceiptMethod; amount_sen: number };
type GridRow = { id: string; account_code: string; method: string; amount_sen: number };
type Step = { kind: 'create'; cell: Cell; old: null } | { kind: 'update' | 'delete'; cell: Cell; old: GridRow };

export const cashbookReceiptsDayPut = async (c: Ctx): Promise<Response> => {
  const g = writeGate(c);
  if ('resp' in g) return g.resp;
  const body = await readJson(c);
  if (!body) return c.json({ error: 'invalid_json' }, 400);
  const date = calendarDay(body.date);
  if (!date) return c.json({ error: 'bad_date', message: 'Give the day the money came in as a real day.' }, 400);
  if (date > todayMyt()) return c.json({ error: 'future_date', message: `${fmtDate(date)} has not come yet. Type money once it is received.` }, 400);
  if (!Array.isArray(body.cells)) return c.json({ error: 'bad_cells', message: 'Send the cells of the day.' }, 400);
  const sb = c.get('supabase');

  const ms = await methodsOf(sb, g.companyId);
  if (!ms.ok) return c.json(ms.body, ms.status);
  const { data: liveRaw, error: lErr } = await sb.from('acc_daily_bank_receipts')
    .select('id, account_code, method, amount_sen')
    .eq('company_id', g.companyId).eq('receipt_date', date).is('deleted_at', null).not('method', 'is', null);
  if (lErr) return c.json({ error: 'load_failed', reason: lErr.message }, 500);
  const live = new Map((liveRaw as Array<Record<string, unknown>>).map((r) => {
    const row: GridRow = { id: String(r.id), account_code: String(r.account_code), method: String(r.method), amount_sen: Number(r.amount_sen) };
    return [`${row.account_code}|${row.method}`, row];
  }));
  const methodBy = new Map(withHeld(ms.methods, [...live.values()].map((r) => r.method)).map((m) => [m.key, m]));
  const [st, acc] = await Promise.all([
    sb.from('acc_daily_bank_starts').select('account_code, start_date').eq('company_id', g.companyId),
    sb.from('accounts').select('account_code').eq('company_id', g.companyId).eq('acc_money', true).eq('is_active', true),
  ]);
  if (st.error) return c.json({ error: 'load_failed', reason: st.error.message }, 500);
  if (acc.error) return c.json({ error: 'load_failed', reason: acc.error.message }, 500);
  const money = new Set((acc.data as Array<{ account_code: string }>).map((a) => String(a.account_code)));
  /* The banks on the cash book this day: a money account whose start is on or before it. */
  const open = new Set((st.data as Array<{ account_code: string; start_date: string }>)
    .filter((s) => money.has(String(s.account_code)) && String(s.start_date).slice(0, 10) <= date)
    .map((s) => String(s.account_code)));

  const cells: Cell[] = [];
  const seen = new Set<string>();
  for (const raw of body.cells as unknown[]) {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const account = String(r.accountCode ?? '').trim();
    const method = methodBy.get(String(r.method ?? '').trim());
    const amount = Number(r.amountSen);
    if (!method) return c.json({ error: 'bad_method', message: `${String(r.method ?? '') || 'That'} is not a way money comes in here.` }, 400);
    if (!open.has(account)) return c.json({ error: 'not_open', message: `${account || 'That account'} is not on the cash book on ${fmtDate(date)}. Set its starting balance first.` }, 409);
    if (!Number.isSafeInteger(amount) || amount < 0 || amount >= MAX_SEN) {
      return c.json({ error: 'bad_amount', message: 'Each amount is zero or more, in whole sen.' }, 400);
    }
    const key = `${account}|${method.key}`;
    if (seen.has(key)) return c.json({ error: 'duplicate_cell', message: `${account} · ${method.label} is sent twice.` }, 400);
    seen.add(key);
    cells.push({ account_code: account, method, amount_sen: amount });
  }

  const plan = cells.flatMap((cell): Step[] => {
    const old = live.get(`${cell.account_code}|${cell.method.key}`);
    if (old && cell.amount_sen === 0) return [{ kind: 'delete', cell, old }];
    if (old && old.amount_sen !== cell.amount_sen) return [{ kind: 'update', cell, old }];
    if (!old && cell.amount_sen > 0) return [{ kind: 'create', cell, old: null }];
    return [];
  });
  if (plan.length === 0) return c.json({ ok: true, created: 0, updated: 0, deleted: 0 });
  if (!(await auditReady(sb, 'DAILY_BANK_RECEIPT', null, 'UPDATE', g.companyId))) return c.json(auditUnavailableBody(), 409);

  const by = who(c);
  const done = { created: 0, updated: 0, deleted: 0 };
  /* Applied one cell at a time: a failure part-way leaves the earlier cells saved and
     on the trail, and says so — the page re-reads the day. */
  const stopped = (reason: string, status: 409 | 500) => c.json({
    error: status === 409 ? 'conflict' : 'save_failed',
    message: `Stopped part-way (${done.created + done.updated + done.deleted} of ${plan.length} saved): ${reason} The table now shows what is saved.`,
  }, status);
  for (const step of plan) {
    const { cell } = step;
    const facts = { account_code: cell.account_code, receipt_date: date, amount_sen: cell.amount_sen, note: methodNote(cell.method) };
    if (step.kind === 'create') {
      const { data, error } = await sb.from('acc_daily_bank_receipts')
        .insert({ company_id: g.companyId, ...facts, method: cell.method.key, created_by: by }).select('id').single();
      if (error) {
        return String((error as { code?: string }).code ?? '') === '23505'
          ? stopped(`someone else has just typed ${cell.account_code} · ${cell.method.label} for this day.`, 409)
          : stopped(error.message, 500);
      }
      const id = String((data as { id: unknown }).id);
      await recordEntityAudit(sb, {
        entityType: 'DAILY_BANK_RECEIPT', entityId: id, entityDocNo: cell.account_code, action: 'CREATE', actor: c.get('houzsUser'), companyId: g.companyId,
        note: `Received ${fmtSen(cell.amount_sen)} into ${cell.account_code} on ${fmtDate(date)}: ${facts.note}`,
        fieldChanges: receiptChanges(null, facts),
      });
      done.created += 1;
      continue;
    }
    const old = step.old;
    const patch = step.kind === 'delete'
      ? { deleted_at: new Date().toISOString(), deleted_by: by }
      : { amount_sen: cell.amount_sen, note: facts.note, updated_by: by, updated_at: new Date().toISOString() };
    const { data, error } = await sb.from('acc_daily_bank_receipts').update(patch)
      .eq('company_id', g.companyId).eq('id', old.id).is('deleted_at', null).select('id');
    if (error) return stopped(error.message, 500);
    if (!Array.isArray(data) || data.length === 0) return stopped(`${cell.account_code} · ${cell.method.label} was changed by someone else a moment ago.`, 409);
    const before = { ...facts, amount_sen: old.amount_sen };
    await recordEntityAudit(sb, {
      entityType: 'DAILY_BANK_RECEIPT', entityId: old.id, entityDocNo: cell.account_code,
      action: step.kind === 'delete' ? 'DELETE' : 'UPDATE', actor: c.get('houzsUser'), companyId: g.companyId,
      note: step.kind === 'delete'
        ? `Receipt deleted: ${fmtSen(old.amount_sen)} into ${cell.account_code} on ${fmtDate(date)}: ${facts.note}`
        : `Receipt changed: ${fmtSen(cell.amount_sen)} into ${cell.account_code} on ${fmtDate(date)}: ${facts.note}`,
      fieldChanges: step.kind === 'delete' ? receiptChanges(before, null) : receiptChanges(before, facts),
    });
    if (step.kind === 'delete') done.deleted += 1; else done.updated += 1;
  }
  return c.json({ ok: true, ...done });
};

/* ── PUT / DELETE /daily-bank/skips/:pvId ─────────────────────────────────────
   The exception the owner asked for (2026-11-25: 这个是例外，因为他们不小心cancel了;
   offered a tick: 要，加勾选): an approved voucher whose money left the bank before
   that bank's cash-book start, though it was approved after it, is already inside
   the starting balance. Ticked, the cash book lists it on its day and does not take
   it off; unticked, it comes off again. The voucher and the books never change. */

type SkipVoucher = CashbookPayout & { status: string };

const notHereVoucher: Refusal = { status: 404, body: { error: 'not_found', message: 'That voucher is not in the company you are working in.' } };
/* 22P02: not a uuid at all — no such voucher, not a server fault. */
const readFailed = (error: { code?: string; message: string }): Refusal =>
  (String(error.code ?? '') === '22P02' ? notHereVoucher : { status: 500, body: { error: 'load_failed', reason: error.message } });

async function voucherOf(sb: Sb, companyId: number, pvId: string): Promise<{ ok: true; v: SkipVoucher } | ({ ok: false } & Refusal)> {
  const { data, error } = await sb.from('payment_vouchers')
    .select('id, pv_number, payee_name, status, credit_account_code, voucher_date, total_sen, exchange_rate, bank_charge_sen, approved_at, posted_at')
    .eq('company_id', companyId).eq('id', pvId).maybeSingle();
  if (error) return { ok: false, ...readFailed(error) };
  if (!data) return { ok: false, ...notHereVoucher };
  const r = data as Record<string, unknown>;
  return { ok: true, v: {
    id: String(r.id), pv_number: String(r.pv_number ?? ''), payee_name: (r.payee_name as string | null) ?? null, status: String(r.status ?? ''),
    credit_account_code: String(r.credit_account_code ?? ''), voucher_date: String(r.voucher_date ?? '').slice(0, 10),
    total_sen: Number(r.total_sen), exchange_rate: (r.exchange_rate as string | number | null) ?? null, bank_charge_sen: (r.bank_charge_sen as number | null) ?? null,
    approved_at: (r.approved_at as string | null) ?? null, posted_at: (r.posted_at as string | null) ?? null,
  } };
}

/** The voucher's tick that still counts, if any. */
async function liveSkipOf(sb: Sb, companyId: number, pvId: string): Promise<{ ok: true; id: string | null } | ({ ok: false } & Refusal)> {
  const { data, error } = await sb.from('acc_daily_bank_voucher_skips').select('id')
    .eq('company_id', companyId).eq('pv_id', pvId).is('unticked_at', null).maybeSingle();
  if (error) return { ok: false, ...readFailed(error) };
  return { ok: true, id: data ? String((data as { id: unknown }).id) : null };
}

/** The tick on the trail as one field: is the voucher taken off the cash book. */
const deductedChange = (deducted: boolean): FieldChange[] =>
  compactChanges([fieldChange('deducted', deducted ? 'No' : 'Yes', deducted ? 'Yes' : 'No')]);

/* ── PUT /daily-bank/skips/:pvId — already in the starting balance, don't deduct ─ */
export const cashbookSkipPut = async (c: Ctx): Promise<Response> => {
  const g = writeGate(c);
  if ('resp' in g) return g.resp;
  const sb = c.get('supabase');
  const got = await voucherOf(sb, g.companyId, String(c.req.param('pvId') ?? '').trim());
  if (!got.ok) return c.json(got.body, got.status);
  const v = got.v;
  if (v.status !== 'POSTED') {
    return c.json({ error: 'not_approved', message: `${v.pv_number} is not approved. Only an approved voucher comes off the cash book.` }, 409);
  }
  const notOn = { error: 'not_on_cashbook', message: `${v.pv_number} does not pay out of a bank on the cash book, so there is nothing to keep off it.` };
  const acct = await moneyAccount(sb, g.companyId, v.credit_account_code);
  if (!acct.ok) return acct.status === 500 ? c.json(acct.body, 500) : c.json(notOn, 409);
  const s = await startOf(sb, g.companyId, v.credit_account_code);
  if (!s.ok) return c.json(s.body, s.status);
  if (!s.start) return c.json(notOn, 409);
  if (insideStart(v, s.start)) {
    return c.json({ error: 'inside_start', message: `${v.pv_number} is already inside ${acct.name}'s starting balance (its cash book starts ${fmtDate(s.start.start_date)}), so the cash book never takes it off.` }, 409);
  }
  const live = await liveSkipOf(sb, g.companyId, v.id);
  if (!live.ok) return c.json(live.body, live.status);
  if (live.id) return c.json({ ok: true, alreadyTicked: true });
  if (!(await auditReady(sb, 'DAILY_BANK_SKIP', v.id, 'CREATE', g.companyId))) return c.json(auditUnavailableBody(), 409);
  const { error } = await sb.from('acc_daily_bank_voucher_skips')
    .insert({ company_id: g.companyId, pv_id: v.id, ticked_by: who(c), ticked_at: new Date().toISOString() });
  if (error) {
    if (String((error as { code?: string }).code ?? '') === '23505') return c.json({ ok: true, alreadyTicked: true });
    return c.json({ error: 'save_failed', reason: error.message }, 500);
  }
  await recordEntityAudit(sb, {
    entityType: 'DAILY_BANK_SKIP', entityId: v.id, entityDocNo: v.pv_number, action: 'CREATE', actor: c.get('houzsUser'), companyId: g.companyId,
    note: `${v.pv_number}: not taken off ${acct.name} on the cash book (${fmtSen(voucherPayoutSen(v))}), already in its starting balance`,
    fieldChanges: deductedChange(false),
  });
  return c.json({ ok: true });
};

/* ── DELETE /daily-bank/skips/:pvId — deduct it again ─────────────────────────── */
export const cashbookSkipDelete = async (c: Ctx): Promise<Response> => {
  const g = writeGate(c);
  if ('resp' in g) return g.resp;
  const pvId = String(c.req.param('pvId') ?? '').trim();
  const sb = c.get('supabase');
  const live = await liveSkipOf(sb, g.companyId, pvId);
  if (!live.ok) return c.json(live.body, live.status);
  if (!live.id) return c.json({ ok: true, alreadyUnticked: true });
  const { data: pvRow, error: pErr } = await sb.from('payment_vouchers').select('pv_number')
    .eq('company_id', g.companyId).eq('id', pvId).maybeSingle();
  if (pErr) return c.json({ error: 'load_failed', reason: pErr.message }, 500);
  const pvNumber = String((pvRow as { pv_number?: string | null } | null)?.pv_number ?? pvId);
  if (!(await auditReady(sb, 'DAILY_BANK_SKIP', pvId, 'DELETE', g.companyId))) return c.json(auditUnavailableBody(), 409);
  const { data, error } = await sb.from('acc_daily_bank_voucher_skips')
    .update({ unticked_at: new Date().toISOString(), unticked_by: who(c) })
    .eq('company_id', g.companyId).eq('id', live.id).is('unticked_at', null).select('id');
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
  if (!Array.isArray(data) || data.length === 0) return c.json({ ok: true, alreadyUnticked: true });
  await recordEntityAudit(sb, {
    entityType: 'DAILY_BANK_SKIP', entityId: pvId, entityDocNo: pvNumber, action: 'DELETE', actor: c.get('houzsUser'), companyId: g.companyId,
    note: `${pvNumber}: taken off the cash book again`,
    fieldChanges: deductedChange(true),
  });
  return c.json({ ok: true });
};
