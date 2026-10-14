// ----------------------------------------------------------------------------
// /hr/part-time-pay — a part-time salesperson's pay for an event (owner
// 2026-10-14: 2% of total sales, RM 120 a day counted from their POS logins
// with the arrival time, one RM 20 WiFi allowance per event; the owner keys the
// sheet with the bank details, HR confirms, Finance pays one voucher per person
// and attaches the bank slip, which HR and the owner then see here).
//
//   GET    /events               the company's events to pick from (?q=, ?around=)
//   GET    /?projectId=N         the sheet for an event: every salesperson who
//                                logged into the POS or sold during it, their
//                                days and arrival times, their sales, the
//                                figures, and the saved row with its request's
//                                stage, voucher and bank slip
//   PUT    /                     the owner saves rows {projectId, rows: [...]}
//   DELETE /:id                  the owner removes a row HR has not confirmed
//   POST   /:id/confirm          HR confirms a row — raises its payment request
//   GET    /:id/slip/:fileId     a file on the voucher that paid it (the bank slip)
//
// Two flat keys, checked against the REAL caller (houzsUser): the owner's
// scm.part_time_pay.request (key, edit, remove) and HR's
// scm.part_time_pay.confirm; either reads. No area guard — HR holds no SCM
// area — so requireScmAccess admits this prefix for the two keys alone.
// The sales figure is the event's orders by that salesperson (project_id = the
// event, the commission module's own status exclusions), never a sum keyed by
// hand; a saved row whose sales moved since is refused at confirm until the
// owner saves it again, so HR confirms the figure HR saw.
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { activeCompanySql, companyDocPrefix, requireActiveCompanyId, scopeToCompany } from '../lib/companyScope';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { docMonthTag, mintMonthlyDocNo } from '../lib/doc-no';
import { dateOrNull } from '../lib/date-coerce';
import { todayMyt, rangeBoundsMy } from '../lib/my-time';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import { listEventOptions, loadEventsByIds, type EventRow } from '../lib/event-tags';
import { assertAuditWritable, auditUnavailableBody, compactChanges, fieldChange, recordEntityAudit } from '../lib/entity-audit';
import { scopeStaffRowsToActiveCompany } from '../lib/staffCompanyScope';
import { callerUserId } from '../lib/payment-request';
import { COMMISSION_EXCLUDED_STATUSES } from '../shared/hr-commission';
import { partTimeAmounts, partTimeBreakdown, partTimePurpose, workDays, type LoginMark, type PartTimeRates, type WorkDay } from '../lib/part-time-pay';
import { withStages } from './payment-requests';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgREST rows through the untyped scm client, as every sibling route reads them
type Row = Record<string, any>;
type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export const PART_TIME_REQUEST_KEY = 'scm.part_time_pay.request';
export const PART_TIME_CONFIRM_KEY = 'scm.part_time_pay.confirm';

const NO_PERM = { error: "You don't have permission to do that." };
const mayRequest = (c: Ctx): boolean => hasHouzsPerm(c, PART_TIME_REQUEST_KEY);
const mayConfirm = (c: Ctx): boolean => hasHouzsPerm(c, PART_TIME_CONFIRM_KEY);
const mayRead = (c: Ctx): boolean => mayRequest(c) || mayConfirm(c);

const SHEET_COLS = 'id, company_id, project_id, staff_id, staff_name, days, sales_sen, commission_bps, commission_sen, day_rate_sen, salary_sen, wifi_sen, total_sen, bank_name, bank_account_no, bank_account_name, note, status, request_id, requested_by, requested_by_name, confirmed_by, confirmed_at, created_at, updated_at';
const EXCLUDED_STATUS_FILTER = `(${COMMISSION_EXCLUDED_STATUSES.join(',')})`;

export const partTimePay = new Hono<{ Bindings: Env; Variables: Variables }>();
partTimePay.use('*', supabaseAuth);

const text = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ── the rates, from HR Settings ─────────────────────────────────────────── */
async function loadRates(c: Ctx, companyId: number): Promise<{ rates: PartTimeRates } | { resp: Response }> {
  const sb = c.get('supabase');
  const { data, error } = await sb.from('hr_commission_config')
    .select('part_time_commission_bps, part_time_day_rate_sen, part_time_wifi_sen')
    .eq('company_id', companyId).maybeSingle();
  if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
  if (!data) {
    return { resp: c.json({ error: 'config_missing', message: 'No HR rate settings exist for this company yet, so part-time pay cannot be priced. Set the rates in HR Settings first.' }, 409) };
  }
  const r = data as { part_time_commission_bps: number | null; part_time_day_rate_sen: number | null; part_time_wifi_sen: number | null };
  return {
    rates: {
      commissionBps: Number(r.part_time_commission_bps ?? 0),
      dayRateSen: Number(r.part_time_day_rate_sen ?? 0),
      wifiSen: Number(r.part_time_wifi_sen ?? 0),
    },
  };
}

/* ── the event ───────────────────────────────────────────────────────────── */
const parseProjectId = (raw: unknown): number | null => {
  const s = String(raw ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
};

async function loadEvent(c: Ctx, projectId: number): Promise<{ event: EventRow } | { resp: Response }> {
  try {
    const found = await loadEventsByIds(c.env.DB, activeCompanySql(c, 'p.company_id'), [projectId]);
    const event = found.get(projectId);
    if (!event) return { resp: c.json({ error: 'event_not_found', message: 'That event is not in the company you are working in.' }, 404) };
    return { event };
  } catch (e) {
    return { resp: c.json({ error: 'load_failed', reason: e instanceof Error ? e.message : String(e) }, 500) };
  }
}

/* ── what the POS and the orders say about the event ─────────────────────── */
type Activity = {
  /** staff_id → their logins inside the period. */
  logins: Map<string, LoginMark[]>;
  /** staff_id → the dates of their orders at the event and the sales total. */
  orders: Map<string, { dates: string[]; salesSen: number; count: number }>;
};

async function loadActivity(c: Ctx, companyId: number, event: EventRow): Promise<{ activity: Activity } | { resp: Response }> {
  const sb = c.get('supabase');
  const bounds = rangeBoundsMy(event.startDate, event.endDate);
  let loginQ = sb.from('pos_logins').select('staff_id, logged_in_at, logged_out_at').eq('company_id', companyId);
  if (bounds.startUtc) loginQ = loginQ.gte('logged_in_at', bounds.startUtc);
  if (bounds.endUtc) loginQ = loginQ.lt('logged_in_at', bounds.endUtc);
  const loginRes = await paginateAll<Row>((f, t) => loginQ.order('logged_in_at').range(f, t));
  if (loginRes.error) return { resp: c.json({ error: 'load_failed', reason: loginRes.error.message }, 500) };
  const logins = new Map<string, LoginMark[]>();
  for (const r of loginRes.data ?? []) {
    const id = String(r.staff_id ?? '');
    if (!id) continue;
    const list = logins.get(id) ?? [];
    list.push({ at: String(r.logged_in_at), outAt: r.logged_out_at ? String(r.logged_out_at) : null });
    logins.set(id, list);
  }
  const orderRes = await paginateAll<Row>((f, t) => sb.from('mfg_sales_orders')
    .select('doc_no, salesperson_id, so_date, total_revenue_sen')
    .eq('company_id', companyId)
    .eq('project_id', event.id)
    .not('status', 'in', EXCLUDED_STATUS_FILTER)
    .eq('on_hold', false)
    .order('doc_no')
    .range(f, t));
  if (orderRes.error) return { resp: c.json({ error: 'load_failed', reason: orderRes.error.message }, 500) };
  const orders = new Map<string, { dates: string[]; salesSen: number; count: number }>();
  for (const r of orderRes.data ?? []) {
    const id = String(r.salesperson_id ?? '');
    if (!id) continue;
    const o = orders.get(id) ?? { dates: [], salesSen: 0, count: 0 };
    o.dates.push(String(r.so_date ?? ''));
    o.salesSen += Number(r.total_revenue_sen ?? 0);
    o.count += 1;
    orders.set(id, o);
  }
  return { activity: { logins, orders } };
}

/* Names for the staff the sheet shows — the company's own roster only. */
async function loadStaffNames(c: Ctx, ids: string[]): Promise<{ staff: Map<string, { name: string; code: string }> } | { resp: Response }> {
  const sb = c.get('supabase');
  const clean = [...new Set(ids.filter((id) => UUID_RE.test(id)))];
  const staff = new Map<string, { name: string; code: string }>();
  if (clean.length === 0) return { staff };
  const res = await chunkIn<Row>(clean, (batch, f, t) => sb.from('staff').select('id, name, staff_code, user_id').in('id', batch).order('id').range(f, t));
  if (res.error) return { resp: c.json({ error: 'load_failed', reason: res.error.message }, 500) };
  const scoped = await scopeStaffRowsToActiveCompany(c, res.data as Row[]);
  if (scoped.failClosed) return { resp: c.json({ error: 'company_unresolved', message: 'The active company could not be determined.' }, 503) };
  for (const r of scoped.scoped) staff.set(String(r.id), { name: String(r.name ?? ''), code: String(r.staff_code ?? '') });
  return { staff };
}

async function loadSheetRows(c: Ctx, companyId: number, projectId: number): Promise<{ rows: Row[] } | { resp: Response }> {
  const sb = c.get('supabase');
  const { data, error } = await sb.from('hr_part_time_pay').select(SHEET_COLS)
    .eq('company_id', companyId).eq('project_id', projectId).order('staff_name');
  if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
  return { rows: data as Row[] };
}

/* The payment request a confirmed row raised, with its stage, voucher and the
   voucher's files — the bank slip Finance attached. */
async function loadAnswers(c: Ctx, companyId: number, rows: Row[]): Promise<{ answers: Map<string, Row> } | { resp: Response }> {
  const sb = c.get('supabase');
  const answers = new Map<string, Row>();
  const requestIds = [...new Set(rows.map((r) => r.request_id).filter(Boolean))] as string[];
  if (requestIds.length === 0) return { answers };
  const reqRes = await chunkIn<Row>(requestIds, (batch, f, t) => sb.from('acc_payment_requests')
    .select('id, request_no, status, pv_id, ap_invoice_id, finance_note, amount_sen')
    .eq('company_id', companyId).in('id', batch).order('id').range(f, t));
  if (reqRes.error) return { resp: c.json({ error: 'load_failed', reason: reqRes.error.message }, 500) };
  const staged = await withStages(c, companyId, reqRes.data as Row[]);
  if ('resp' in staged) return staged;
  const pvIds = [...new Set(staged.rows.map((r) => r.pv_id).filter(Boolean))] as string[];
  const filesByPv = new Map<string, Row[]>();
  if (pvIds.length > 0) {
    const fRes = await chunkIn<Row>(pvIds, (batch, f, t) => sb.from('acc_pv_files')
      .select('id, pv_id, file_name, mime, size_bytes, sort_no, created_at')
      .eq('company_id', companyId).in('pv_id', batch).order('sort_no').range(f, t));
    if (fRes.error) return { resp: c.json({ error: 'load_failed', reason: fRes.error.message }, 500) };
    for (const f of fRes.data) {
      const list = filesByPv.get(String(f.pv_id)) ?? [];
      list.push({ id: f.id, fileName: f.file_name, mime: f.mime, sizeBytes: f.size_bytes, createdAt: f.created_at });
      filesByPv.set(String(f.pv_id), list);
    }
  }
  for (const r of staged.rows) {
    answers.set(String(r.id), {
      id: r.id,
      requestNo: r.request_no,
      status: r.status,
      stage: r.stage,
      financeNote: r.finance_note ?? null,
      voucher: r.voucher ?? null,
      invoice: r.invoice ?? null,
      slips: r.pv_id ? filesByPv.get(String(r.pv_id)) ?? [] : [],
    });
  }
  return { answers };
}

/* ── GET /events ──────────────────────────────────────────────────────────── */
partTimePay.get('/events', async (c) => {
  if (!mayRead(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  try {
    const around = dateOrNull(c.req.query('around')) ?? todayMyt();
    const events = await listEventOptions(c.env.DB, activeCompanySql(c, 'p.company_id'), { q: c.req.query('q') ?? null, around });
    return c.json({ events });
  } catch (e) {
    return c.json({ error: 'load_failed', reason: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/* ── GET /?projectId= ─────────────────────────────────────────────────────── */
type SheetLine = {
  staffId: string;
  staffName: string;
  staffCode: string;
  days: WorkDay[];
  suggestedDays: number;
  salesSen: number;
  orderCount: number;
  saved: Row | null;
  /** The saved row's sales no longer match the orders — save again before HR confirms. */
  salesChanged: boolean;
};

async function buildSheet(c: Ctx, companyId: number, event: EventRow, rates: PartTimeRates): Promise<{ lines: SheetLine[] } | { resp: Response }> {
  const act = await loadActivity(c, companyId, event);
  if ('resp' in act) return act;
  const saved = await loadSheetRows(c, companyId, event.id);
  if ('resp' in saved) return saved;
  const ids = [...new Set([...act.activity.logins.keys(), ...act.activity.orders.keys(), ...saved.rows.map((r) => String(r.staff_id))])];
  const names = await loadStaffNames(c, ids);
  if ('resp' in names) return names;
  const answers = await loadAnswers(c, companyId, saved.rows);
  if ('resp' in answers) return answers;
  const savedByStaff = new Map(saved.rows.map((r) => [String(r.staff_id), r]));
  const lines: SheetLine[] = [];
  for (const id of ids) {
    const who = names.staff.get(id);
    const row = savedByStaff.get(id) ?? null;
    /* A salesperson outside the company's roster is not shown — unless the
       owner already keyed a row for them (the name on it stands). */
    if (!who && !row) continue;
    const orders = act.activity.orders.get(id) ?? { dates: [], salesSen: 0, count: 0 };
    const days = workDays(act.activity.logins.get(id) ?? [], orders.dates, { startDate: event.startDate, endDate: event.endDate });
    lines.push({
      staffId: id,
      staffName: who?.name ?? String(row?.staff_name ?? ''),
      staffCode: who?.code ?? '',
      days,
      suggestedDays: days.length,
      salesSen: orders.salesSen,
      orderCount: orders.count,
      saved: row ? { ...row, breakdown: partTimeBreakdown(rowFigures(row)), answer: row.request_id ? answers.answers.get(String(row.request_id)) ?? null : null } : null,
      salesChanged: row != null && Number(row.sales_sen) !== orders.salesSen,
    });
  }
  lines.sort((a, b) => a.staffName.localeCompare(b.staffName));
  void rates;
  return { lines };
}

const rowFigures = (r: Row) => ({
  days: Number(r.days), dayRateSen: Number(r.day_rate_sen), salesSen: Number(r.sales_sen), commissionBps: Number(r.commission_bps),
  commissionSen: Number(r.commission_sen), wifiSen: Number(r.wifi_sen), totalSen: Number(r.total_sen),
});

partTimePay.get('/', async (c) => {
  if (!mayRead(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const projectId = parseProjectId(c.req.query('projectId'));
  if (projectId == null) return c.json({ error: 'bad_event', message: 'projectId must be an event id.' }, 400);
  const ev = await loadEvent(c, projectId);
  if ('resp' in ev) return ev.resp;
  const rates = await loadRates(c, co.companyId);
  if ('resp' in rates) return rates.resp;
  const sheet = await buildSheet(c, co.companyId, ev.event, rates.rates);
  if ('resp' in sheet) return sheet.resp;
  return c.json({ event: ev.event, rates: rates.rates, purpose: partTimePurpose(ev.event), lines: sheet.lines, canRequest: mayRequest(c), canConfirm: mayConfirm(c) });
});

/* ── PUT / — the owner saves the sheet ────────────────────────────────────── */
type RowInput = { staffId: string; days: number; wifi: boolean; bankName: string | null; bankAccountNo: string | null; bankAccountName: string | null; note: string | null };

function readRows(body: Row): { rows: RowInput[] } | { error: string; message: string } {
  if (!Array.isArray(body.rows)) return { error: 'rows_required', message: 'rows must be a list.' };
  const rows: RowInput[] = [];
  const seen = new Set<string>();
  for (const item of body.rows as unknown[]) {
    const raw = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const staffId = String(raw.staffId ?? '').trim();
    if (!UUID_RE.test(staffId)) return { error: 'bad_staff', message: 'Each row names a salesperson.' };
    if (seen.has(staffId)) return { error: 'staff_twice', message: 'A salesperson appears twice on the sheet.' };
    seen.add(staffId);
    const days = Number(raw.days);
    if (!Number.isInteger(days) || days < 0 || days > 60) return { error: 'bad_days', message: 'Days worked must be a whole number from 0 to 60.' };
    const note = text(raw.note);
    if (note && note.length > 500) return { error: 'note_too_long', message: 'Keep the note to 500 characters.' };
    rows.push({
      staffId, days, wifi: raw.wifi === true,
      bankName: text(raw.bankName), bankAccountNo: text(raw.bankAccountNo), bankAccountName: text(raw.bankAccountName), note,
    });
  }
  const wifi = rows.filter((r) => r.wifi);
  if (wifi.length > 1) return { error: 'wifi_twice', message: 'The WiFi allowance goes to one salesperson per event.' };
  return { rows };
}

partTimePay.put('/', async (c) => {
  if (!mayRequest(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const me = callerUserId(c);
  if (me == null) return c.json({ error: 'no_requester', message: 'Your account has no member record, so it cannot raise a request.' }, 409);
  let body: Row;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const projectId = parseProjectId(body.projectId);
  if (projectId == null) return c.json({ error: 'bad_event', message: 'projectId must be an event id.' }, 400);
  const read = readRows(body);
  if ('error' in read) return c.json(read, 400);
  const ev = await loadEvent(c, projectId);
  if ('resp' in ev) return ev.resp;
  const rates = await loadRates(c, co.companyId);
  if ('resp' in rates) return rates.resp;
  const act = await loadActivity(c, co.companyId, ev.event);
  if ('resp' in act) return act.resp;
  const existing = await loadSheetRows(c, co.companyId, projectId);
  if ('resp' in existing) return existing.resp;
  const names = await loadStaffNames(c, read.rows.map((r) => r.staffId));
  if ('resp' in names) return names.resp;
  const byStaff = new Map(existing.rows.map((r) => [String(r.staff_id), r]));

  for (const r of read.rows) {
    if (!names.staff.has(r.staffId)) return c.json({ error: 'staff_not_found', message: 'A salesperson on the sheet is not in this company.' }, 400);
    const before = byStaff.get(r.staffId);
    if (before && before.status === 'CONFIRMED') {
      return c.json({ error: 'row_confirmed', message: `${before.staff_name} is confirmed by HR already — the row cannot change.` }, 409);
    }
  }
  /* One WiFi per event, across what is saved and what is sent. */
  const wifiHolder = read.rows.find((r) => r.wifi)?.staffId ?? null;
  if (wifiHolder) {
    const other = existing.rows.find((r) => Number(r.wifi_sen) > 0 && String(r.staff_id) !== wifiHolder && !read.rows.some((x) => x.staffId === String(r.staff_id)));
    if (other) return c.json({ error: 'wifi_twice', message: `${other.staff_name} already has the WiFi allowance for this event.` }, 409);
  }

  const sb = c.get('supabase');
  const houzsUser = c.get('houzsUser') as { name?: string | null; email?: string | null } | undefined;
  const now = new Date().toISOString();
  const saved: Row[] = [];
  for (const r of read.rows) {
    const salesSen = act.activity.orders.get(r.staffId)?.salesSen ?? 0;
    const amounts = partTimeAmounts({ days: r.days, salesSen, wifi: r.wifi, rates: rates.rates });
    const who = names.staff.get(r.staffId)!;
    const fields = {
      staff_name: who.name,
      days: r.days,
      sales_sen: salesSen,
      commission_bps: rates.rates.commissionBps,
      commission_sen: amounts.commissionSen,
      day_rate_sen: rates.rates.dayRateSen,
      salary_sen: amounts.salarySen,
      wifi_sen: amounts.wifiSen,
      total_sen: amounts.totalSen,
      bank_name: r.bankName,
      bank_account_no: r.bankAccountNo,
      bank_account_name: r.bankAccountName,
      note: r.note,
      updated_at: now,
    };
    const before = byStaff.get(r.staffId);
    if (before) {
      const { data, error } = await sb.from('hr_part_time_pay').update(fields)
        .eq('company_id', co.companyId).eq('id', before.id).eq('status', 'DRAFT').select(SHEET_COLS).maybeSingle();
      if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
      if (!data) return c.json({ error: 'row_confirmed', message: `${before.staff_name} was confirmed a moment ago — the row cannot change.` }, 409);
      saved.push(data as Row);
    } else {
      const { data, error } = await sb.from('hr_part_time_pay').insert({
        company_id: co.companyId,
        project_id: projectId,
        staff_id: r.staffId,
        status: 'DRAFT',
        requested_by: me,
        requested_by_name: houzsUser?.name ?? houzsUser?.email ?? null,
        ...fields,
      }).select(SHEET_COLS).single();
      if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);
      saved.push(data as Row);
    }
  }
  return c.json({ ok: true, rows: saved });
});

/* ── DELETE /:id ──────────────────────────────────────────────────────────── */
partTimePay.delete('/:id', async (c) => {
  if (!mayRequest(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const { data: row, error } = await scopeToCompany(sb.from('hr_part_time_pay').select('id, status, staff_name').eq('id', c.req.param('id')), c).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.status !== 'DRAFT') return c.json({ error: 'row_confirmed', message: `${row.staff_name} is confirmed by HR already — the row stays.` }, 409);
  const { error: delErr } = await sb.from('hr_part_time_pay').delete().eq('company_id', co.companyId).eq('id', row.id).eq('status', 'DRAFT');
  if (delErr) return c.json({ error: 'delete_failed', reason: delErr.message }, 500);
  return c.json({ ok: true });
});

/* ── POST /:id/confirm — HR confirms; the payment request is raised ───────── */
partTimePay.post('/:id/confirm', async (c) => {
  if (!mayConfirm(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const { data: row, error } = await scopeToCompany(sb.from('hr_part_time_pay').select(SHEET_COLS).eq('id', c.req.param('id')), c).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.status !== 'DRAFT') return c.json({ error: 'already_confirmed', message: `${row.staff_name} is confirmed already.` }, 409);
  if (Number(row.total_sen) <= 0) return c.json({ error: 'nothing_to_pay', message: `${row.staff_name} has no days and no sales — there is nothing to pay.` }, 409);
  const ev = await loadEvent(c, Number(row.project_id));
  if ('resp' in ev) return ev.resp;
  /* The figure HR confirms is the figure the owner saved: if the orders moved
     since, the owner saves again first. */
  const act = await loadActivity(c, co.companyId, ev.event);
  if ('resp' in act) return act.resp;
  const liveSales = act.activity.orders.get(String(row.staff_id))?.salesSen ?? 0;
  if (liveSales !== Number(row.sales_sen)) {
    return c.json({ error: 'sales_changed', message: `${row.staff_name}'s sales at this event changed since the sheet was saved — ask the requester to save the sheet again, then confirm.` }, 409);
  }

  const pf = await assertAuditWritable(sb, { entityType: 'PAYMENT_REQUEST', action: 'CREATE', companyId: co.companyId });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);
  const purpose = partTimePurpose(ev.event);
  const note = partTimeBreakdown(rowFigures(row as Row));
  const requestNo = await mintMonthlyDocNo(sb, 'acc_payment_requests', 'request_no', `${companyDocPrefix(c)}PRQ-${docMonthTag(todayMyt())}`);
  const { data: req, error: reqErr } = await sb.from('acc_payment_requests').insert({
    company_id: co.companyId,
    request_no: requestNo,
    requested_by: Number(row.requested_by),
    requested_by_name: row.requested_by_name ?? null,
    payee_name: row.bank_account_name ?? row.staff_name,
    amount_sen: Number(row.total_sen),
    due_date: null,
    purpose,
    project_id: Number(row.project_id),
    bank_name: row.bank_name ?? null,
    bank_account_no: row.bank_account_no ?? null,
    bank_account_name: row.bank_account_name ?? null,
    note: row.note ? `${note} ${row.note}` : note,
    event_bill: false,
    status: 'SUBMITTED',
    part_time_pay_id: row.id,
  }).select('id, request_no').single();
  if (reqErr) return c.json({ error: 'save_failed', reason: reqErr.message }, 500);
  const houzsUser = c.get('houzsUser') as { name?: string | null; email?: string | null } | undefined;
  const { data: done, error: upErr } = await sb.from('hr_part_time_pay').update({
    status: 'CONFIRMED', request_id: req.id, confirmed_by: houzsUser?.name ?? houzsUser?.email ?? null, confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('company_id', co.companyId).eq('id', row.id).eq('status', 'DRAFT').select('id').maybeSingle();
  if (upErr) return c.json({ error: 'save_failed', reason: upErr.message }, 500);
  if (!done) {
    /* Confirmed twice at once: the second request never stood. */
    await sb.from('acc_payment_requests').delete().eq('company_id', co.companyId).eq('id', req.id);
    return c.json({ error: 'already_confirmed', message: `${row.staff_name} was confirmed a moment ago.` }, 409);
  }
  await recordEntityAudit(sb, {
    entityType: 'PAYMENT_REQUEST', entityId: String(req.id), entityDocNo: requestNo, action: 'CREATE',
    actor: c.get('houzsUser'), companyId: co.companyId, statusSnapshot: 'SUBMITTED',
    fieldChanges: compactChanges([
      fieldChange('payeeName', null, row.bank_account_name ?? row.staff_name), fieldChange('amountSen', null, Number(row.total_sen)),
      fieldChange('projectId', null, Number(row.project_id)), fieldChange('partTimePayId', null, String(row.id)),
    ]),
  });
  return c.json({ ok: true, request: { id: req.id, requestNo: req.request_no } }, 201);
});

/* ── GET /:id/slip/:fileId — a file on the voucher that paid it ───────────── */
partTimePay.get('/:id/slip/:fileId', async (c) => {
  if (!mayRead(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const bucket = (c.env as { SLIPS?: { get: (k: string) => Promise<{ body: ReadableStream | null } | null> } }).SLIPS;
  if (!bucket) return c.json({ error: 'r2_not_configured', reason: 'R2 binding SLIPS not configured' }, 500);
  const sb = c.get('supabase');
  const { data: row, error } = await scopeToCompany(sb.from('hr_part_time_pay').select('id, request_id').eq('id', c.req.param('id')), c).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!row || !row.request_id) return c.json({ error: 'not_found' }, 404);
  const { data: req, error: reqErr } = await sb.from('acc_payment_requests').select('id, pv_id').eq('company_id', co.companyId).eq('id', row.request_id).maybeSingle();
  if (reqErr) return c.json({ error: 'load_failed', reason: reqErr.message }, 500);
  if (!req || !req.pv_id) return c.json({ error: 'not_found', message: 'No voucher has paid this yet.' }, 404);
  const { data: file, error: fErr } = await sb.from('acc_pv_files').select('file_key, mime, file_name')
    .eq('company_id', co.companyId).eq('pv_id', req.pv_id).eq('id', c.req.param('fileId')).maybeSingle();
  if (fErr) return c.json({ error: 'load_failed', reason: fErr.message }, 500);
  if (!file) return c.json({ error: 'not_found' }, 404);
  const obj = await bucket.get(String(file.file_key));
  if (!obj) return c.json({ error: 'object_missing', message: 'The index row exists but the stored file is gone.' }, 404);
  return new Response(obj.body, {
    headers: {
      'content-type': String(file.mime),
      'content-disposition': `inline; filename="${String(file.file_name).replace(/"/g, '')}"`,
      'cache-control': 'private, max-age=300',
    },
  });
});
