// ----------------------------------------------------------------------------
// accounting-todo-calendar — GET /accounting/todo/calendar?month=YYYY-MM, the
// To do's calendar (the owner's Claude Design redesign, batch 2; rules in
// acc/todo-calendar.ts). What falls on each day of the month: supplier bills
// and vouchers to pay, customer invoices due, routines and tasks, and the
// uploads that went late — plus the next 7 days from today. A read that fails
// is named in `problems`; the rest still shows.
// ----------------------------------------------------------------------------

import { requireActiveCompanyId } from '../lib/companyScope';
import { todayMyt } from '../lib/my-time';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import { OPEN_AP_STATUSES, OPEN_PI_STATUSES, OPEN_SI_STATUSES } from '../lib/open-invoice-states';
import { toMyrSen } from '../lib/fx';
import { raiseJobs } from '../../acc/finance-todo';
import { addDays } from '../../acc/todo-tasks';
import { firstOf, lastOf, monthOrToday, nextSeven, taskEvents, type CalendarPage, type CalEvent } from '../../acc/todo-calendar';
import { readFinanceTodoFacts } from './accounting-todo';
import { readTodoTaskFacts } from './accounting-todo-tasks';
import { billPlans } from './ap-bill-plans';
import { fmtDate } from '../shared/format';

type Rows = Array<Record<string, any>>;

/* Owner 2026-11-04 (这些supplier bill 可以remove 先吗？): supplier bills crowded
   every day of the month, so the calendar leaves them out for now — they stay
   on the AP pages. Flip to bring them back; the read below is kept as is. */
export const SUPPLIER_BILLS_ON_CALENDAR = false;

async function supplierNames(sb: any, companyId: number, ids: string[]): Promise<Map<string, string>> {
  const r = await chunkIn<Record<string, any>>([...new Set(ids)], (batch, lo, hi) => sb.from('suppliers').select('id, name')
    .eq('company_id', companyId).in('id', batch).order('id').range(lo, hi));
  if (r.error) throw new Error(`suppliers: ${r.error.message}`);
  return new Map(r.data.map((s) => [String(s.id), String(s.name ?? '')]));
}

/** Supplier bills to pay in [from, to], on the day Finance planned (the
    redesign, step 7) or else their due date: AP invoices and purchase
    invoices still owing, in ringgit. A bill planned into the month but due
    outside it is read by its id. */
async function billEvents(sb: any, companyId: number, from: string, to: string): Promise<CalEvent[]> {
  const plans = await billPlans(sb, companyId);
  if (!plans.ok) throw new Error(plans.reason);
  const plannedIn: Record<'API' | 'PI', string[]> = { API: [], PI: [] };
  for (const [key, day] of plans.byBill) {
    const [kind, id] = key.split(':') as ['API' | 'PI', string];
    if (day >= from && day <= to) plannedIn[kind].push(id);
  }
  const COLS = 'id, invoice_number, supplier_id, due_date, total_sen, paid_sen, exchange_rate';
  const [apiPlanned, piPlanned] = await Promise.all([
    chunkIn<Record<string, any>>(plannedIn.API, (batch, lo, hi) => sb.from('ap_invoices').select(COLS)
      .eq('company_id', companyId).in('status', [...OPEN_AP_STATUSES]).in('id', batch).order('id').range(lo, hi)),
    chunkIn<Record<string, any>>(plannedIn.PI, (batch, lo, hi) => sb.from('purchase_invoices').select(COLS)
      .eq('company_id', companyId).in('status', [...OPEN_PI_STATUSES]).in('id', batch).order('id').range(lo, hi)),
  ]);
  if (apiPlanned.error) throw new Error(`AP invoices planned: ${apiPlanned.error.message}`);
  if (piPlanned.error) throw new Error(`purchase invoices planned: ${piPlanned.error.message}`);
  const [api, pi] = await Promise.all([
    paginateAll<Record<string, any>>((lo, hi) => sb.from('ap_invoices')
      .select('id, invoice_number, supplier_id, due_date, total_sen, paid_sen, exchange_rate')
      .eq('company_id', companyId).in('status', [...OPEN_AP_STATUSES]).gte('due_date', from).lte('due_date', to).order('id').range(lo, hi)),
    paginateAll<Record<string, any>>((lo, hi) => sb.from('purchase_invoices')
      .select('id, invoice_number, supplier_id, due_date, total_sen, paid_sen, exchange_rate')
      .eq('company_id', companyId).in('status', [...OPEN_PI_STATUSES]).gte('due_date', from).lte('due_date', to).order('id').range(lo, hi)),
  ]);
  if (api.error) throw new Error(`AP invoices: ${api.error.message}`);
  if (pi.error) throw new Error(`purchase invoices: ${pi.error.message}`);
  /* One row per bill: due in the month, planned into it, or both. */
  const seen = new Set<string>();
  const rows: Rows = [];
  for (const [kind, list] of [['API', [...(api.data ?? []), ...apiPlanned.data]], ['PI', [...(pi.data ?? []), ...piPlanned.data]]] as const) {
    for (const r of list as Rows) {
      const key = `${kind}:${String(r.id)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ ...r, kind, planned: plans.byBill.get(key) ?? null, to: kind === 'API' ? `/scm/ap-invoices/${r.id}` : `/scm/purchase-invoices/${r.id}` });
    }
  }
  const names = await supplierNames(sb, companyId, rows.map((r) => String(r.supplier_id)).filter(Boolean));
  return rows
    .map((r) => {
      const owed = toMyrSen(Number(r.total_sen ?? 0) - Number(r.paid_sen ?? 0), r.exchange_rate);
      const who = names.get(String(r.supplier_id)) || 'Supplier';
      const due = r.due_date ? String(r.due_date).slice(0, 10) : null;
      const planned: string | null = r.planned;
      return {
        key: `bill:${r.invoice_number}`, day: planned ?? due ?? '', kind: 'pay' as const,
        label: `${who} · pay bill`, short: `${who.split(/\s+/)[0]} bill`,
        /* The design's words: the plan beside the supplier's own due date. */
        detail: planned
          ? `Planned ${fmtDate(planned)} · supplier due ${due ? fmtDate(due) : '—'} · ${r.invoice_number}`
          : `Supplier due ${due ? fmtDate(due) : '—'} · ${r.invoice_number}`,
        amountSen: owed, done: false, to: r.to, task: null,
        bill: { kind: r.kind as 'API' | 'PI', id: String(r.id), no: String(r.invoice_number), due, planned },
      };
    })
    .filter((e) => (e.amountSen ?? 0) > 0 && e.day >= from && e.day <= to);
}

/** Vouchers on their way through checking and approval, on their voucher day. */
async function voucherEvents(sb: any, companyId: number, from: string, to: string): Promise<CalEvent[]> {
  const r = await paginateAll<Record<string, any>>((lo, hi) => sb.from('payment_vouchers')
    .select('id, pv_number, payee_name, voucher_date, total_sen, exchange_rate, checked_at')
    .eq('company_id', companyId).eq('status', 'DRAFT').not('submitted_at', 'is', null).is('approved_at', null)
    .gte('voucher_date', from).lte('voucher_date', to).order('id').range(lo, hi));
  if (r.error) throw new Error(`payment vouchers: ${r.error.message}`);
  return ((r.data ?? []) as Rows).map((v) => ({
    key: `pv:${v.id}`, day: String(v.voucher_date).slice(0, 10), kind: 'pay' as const,
    label: `${v.payee_name ?? 'Payee'} · ${v.pv_number ?? 'voucher'}`, short: `${String(v.payee_name ?? 'Voucher').split(/\s+/)[0]} voucher`,
    detail: v.checked_at ? 'Checked · pays once approved' : 'Prepared · to be checked, then approved',
    amountSen: toMyrSen(Number(v.total_sen ?? 0), v.exchange_rate), done: false, to: `/scm/payment-vouchers/${v.id}`, task: null,
  }));
}

/** Customer invoices falling due in [from, to], one entry per day. */
async function invoiceEvents(sb: any, companyId: number, from: string, to: string): Promise<CalEvent[]> {
  const r = await paginateAll<Record<string, any>>((lo, hi) => sb.from('sales_invoices')
    .select('id, invoice_number, debtor_name, due_date, total_sen, paid_sen')
    .eq('company_id', companyId).in('status', [...OPEN_SI_STATUSES]).gte('due_date', from).lte('due_date', to).order('id').range(lo, hi));
  if (r.error) throw new Error(`sales invoices: ${r.error.message}`);
  const byDay = new Map<string, Rows>();
  for (const s of (r.data ?? []) as Rows) {
    if (Number(s.total_sen ?? 0) - Number(s.paid_sen ?? 0) <= 0) continue;
    const d = String(s.due_date).slice(0, 10);
    byDay.set(d, [...(byDay.get(d) ?? []), s]);
  }
  return [...byDay].map(([day, xs]) => ({
    key: `si:${day}`, day, kind: 'in' as const,
    label: xs.length === 1 ? `${xs[0]!.debtor_name ?? 'Customer'} · invoice due` : `${xs.length} customer invoices due`,
    short: xs.length === 1 ? 'Invoice due' : `${xs.length} invoices due`,
    detail: `${xs.slice(0, 3).map((s) => s.invoice_number).join(' · ')}${xs.length > 3 ? ` · +${xs.length - 3} more` : ''} · not paid yet`,
    amountSen: xs.reduce((n, s) => n + Number(s.total_sen ?? 0) - Number(s.paid_sen ?? 0), 0), done: false,
    to: '/scm/sales-invoices', task: null,
  }));
}

/** The calendar for one company and month, as of today — the handler's reads, and a rehearsal's. */
export async function readCalendarPage(sb: any, companyId: number, today: string, month: string, viewerId: number | null): Promise<CalendarPage> {
  const co = { companyId };
  const from = firstOf(month);
  const to = lastOf(month);
  /* The next 7 days may run past the month shown: read both. */
  const lo = from < today ? from : today;
  const hi = to > addDays(today, 6) ? to : addDays(today, 6);
  const problems: string[] = [];
  const safe = async (what: string, run: () => Promise<CalEvent[]>): Promise<CalEvent[]> => {
    try { return await run(); } catch (e) { problems.push(`${what} (${e instanceof Error ? e.message : String(e)})`); return []; }
  };

  const [tasks, bills, vouchers, invoices, late] = await Promise.all([
    safe('tasks', async () => {
      const r = await readTodoTaskFacts(sb, co.companyId);
      if (!r.ok) throw new Error(r.reason);
      const months = [...new Set([month, today.slice(0, 7), addDays(today, 6).slice(0, 7)])];
      const all = months.flatMap((m) => taskEvents(r.value.tasks, r.value.occurrences, m, { id: viewerId }));
      return [...new Map(all.map((e) => [e.key, e])).values()];
    }),
    SUPPLIER_BILLS_ON_CALENDAR ? safe('supplier bills', () => billEvents(sb, co.companyId, lo, hi)) : Promise.resolve([] as CalEvent[]),
    safe('payment vouchers', () => voucherEvents(sb, co.companyId, lo, hi)),
    safe('customer invoices', () => invoiceEvents(sb, co.companyId, lo, hi)),
    /* What went late, on the day it did: the To do's upload rules. */
    safe('late uploads', async () => {
      const facts = await readFinanceTodoFacts(sb, co.companyId, today, false);
      problems.push(...facts.problems);
      const { raised } = raiseJobs(facts, { id: viewerId, name: '', finance: true, checker: true, approver: true, checkerNames: [], approverNames: [] });
      return raised
        .filter((j) => (j.rule === 'card-missing' || j.rule === 'bank-missing') && j.since)
        .map((j) => ({
          key: `late:${j.key}`, day: j.since!, kind: 'late' as const, label: j.title.replace(/^Upload /, '').replace(/^./, (ch) => ch.toUpperCase()) + ' missing',
          short: j.title.replace(/^Upload /, ''), detail: j.detail, amountSen: null, done: false, to: j.action.to, task: null,
        }));
    }),
  ]);

  const all = [...late, ...bills, ...vouchers, ...invoices, ...tasks];
  return {
    month, today,
    events: all.filter((e) => e.day >= from && e.day <= to).sort((a, b) => a.day.localeCompare(b.day) || a.kind.localeCompare(b.kind)),
    next7: nextSeven(all, today),
    problems,
  };
}

export const todoCalendarHandler = async (c: any): Promise<Response> => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const today = todayMyt();
  const hu = c.get('houzsUser') as { id?: number } | undefined;
  const viewerId = Number(hu?.id) > 0 ? Number(hu?.id) : null;
  return c.json(await readCalendarPage(c.get('supabase'), co.companyId, today, monthOrToday(c.req.query('month'), today), viewerId));
};
