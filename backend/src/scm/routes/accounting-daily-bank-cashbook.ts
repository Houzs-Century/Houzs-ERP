// ----------------------------------------------------------------------------
// accounting-daily-bank-cashbook — Daily Bank's cash book (owner 2026-11-23:
// 先做一个daily bank的一开始直接，但不需要列实际差额。然后我每天会手动输入收到的金额;
// 付款就根据pv). Per money account, the bank's real balance at the start of a
// day; then the money received, typed by hand per bank and day. Both live only
// here and on the board (acc/daily-bank.ts): nothing posts a journal, and no
// books-versus-bank difference is shown anywhere.
//
//   GET    /daily-bank/cashbook?date=        the money accounts with their start,
//                                            the day's typed receipts, and the
//                                            day's deleted ones (who, when)
//   PUT    /daily-bank/starts/:accountCode   { startDate, balanceSen, note? }
//   DELETE /daily-bank/starts/:accountCode   the account reads the ledger again
//   POST   /daily-bank/receipts              { accountCode, date, amountSen, note }
//   PATCH  /daily-bank/receipts/:id          any of those four
//   DELETE /daily-bank/receipts/:id          stamps deleted_at / deleted_by; the row stays
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

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
type Sb = Variables['supabase'];
type Refusal = { status: ContentfulStatusCode; body: Record<string, unknown> };

const canWrite = (c: Ctx): boolean => hasHouzsPerm(c, 'scm.payment_voucher.post');
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
  if (!canWrite(c)) return { resp: c.json(NO_PERM, 403) };
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

/* ── GET /daily-bank/cashbook?date= ─────────────────────────────────────────── */
export const cashbookGet = async (c: Ctx): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const date = calendarDay(c.req.query('date')) ?? todayMyt();
  const sb = c.get('supabase');
  const [acc, st, rc] = await Promise.all([
    sb.from('accounts').select('account_code, account_name')
      .eq('company_id', co.companyId).eq('acc_money', true).eq('is_active', true).order('account_code'),
    sb.from('acc_daily_bank_starts').select('account_code, start_date, balance_sen, note, set_by, updated_at')
      .eq('company_id', co.companyId),
    paginateAll<Record<string, unknown>>((from, to) => sb.from('acc_daily_bank_receipts')
      .select('id, account_code, receipt_date, amount_sen, note, created_by, created_at, updated_by, updated_at, deleted_by, deleted_at')
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
      amountSen: Number(r.amount_sen), note: String(r.note ?? ''),
      createdBy: (r.created_by as string | null) ?? null, createdAt: (r.created_at as string | null) ?? null,
      updatedBy: (r.updated_by as string | null) ?? null, updatedAt: (r.updated_at as string | null) ?? null,
      deletedBy: (r.deleted_by as string | null) ?? null, deletedAt: (r.deleted_at as string | null) ?? null,
      /* On the board only while its account's start is on or before it. */
      counted: r.deleted_at == null && start != null && start.date <= date,
    };
  });
  return c.json({
    date, today: todayMyt(), canWrite: canWrite(c), accounts,
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
    note: `${code}: starting balance removed; the account reads the ledger again`,
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
    return { ok: false, status: 409, body: { error: 'no_start', message: `Set ${acct.name}'s starting balance first. Until then it reads the ledger and a typed receipt would not count.` } };
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
