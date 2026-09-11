/* The Collection report (owner 2026-09-12): per salesman, two views —
   DEPOSIT: of the orders opened in the period (by SO date), how much deposit
   came in against the order value, and which orders sit under the threshold
   (他 50% 以下的我也需要知道); BALANCE: of those orders already delivered, how
   much of the balance after deposit has come in. "Collected" is read from the
   payments recorded on the order — the SO's own balance columns are not
   maintained — so a deposit topped up later, or paid in several pieces,
   counts whenever it was paid. GET /accounting/reports/collection; see
   accounting.md (docs/bugs/0825). */

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { paginateAll } from '../lib/paginate-all';
import { absorbsOrderDeposit } from '../lib/si-order-deposit';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
const requirePerm = (c: Ctx): boolean => hasHouzsPerm(c, 'scm.payment_voucher.post');
const NO_PERM = { error: "You don't have permission to read the financial statements." };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Orders that never became orders, or were taken back, are not collection. */
const NOT_AN_ORDER = new Set(['DRAFT', 'CANCELLED']);
/** Delivered or beyond: the balance stage by STATUS. An order with a live
    sales invoice is at the balance stage whatever its status says, and its
    balance is measured against what was BILLED — the invoice's total — not
    the order's (docs/bugs/0831: the owner's "balance paid / convert to sales
    invoice"). Until every delivery raises its invoice, the status keeps the
    delivered-but-uninvoiced orders in view. */
const DELIVERED = new Set(['DELIVERED', 'INVOICED', 'CLOSED']);
type SiRow = { so_doc_no: string | null; invoice_number: string; status: string | null; total_sen: number | null };

type SoRow = {
  doc_no: string; so_date: string; status: string; debtor_name: string | null;
  local_total_sen: number | null; salesperson_id: string | null; agent: string | null;
};
type PayRow = { so_doc_no: string; amount_sen: number | null; is_deposit: boolean | null };

export type CollectionOrder = {
  docNo: string; soDate: string; status: string; customer: string | null;
  totalSen: number; depositSen: number; balancePaidSen: number; collectedSen: number; outstandingSen: number;
  depositPct: number; balanceDueSen: number; balancePct: number; delivered: boolean; belowThreshold: boolean;
  /** The live sales invoice on the order, when one exists, and what was billed (the invoice's total, else the order's). */
  invoiceNumber: string | null; billedSen: number;
};
export type CollectionRow = {
  salespersonId: string | null; salesperson: string;
  orders: number; totalSen: number; depositSen: number; depositPct: number; belowCount: number;
  delivered: { orders: number; totalSen: number; billedSen: number; depositSen: number; balanceDueSen: number; balancePaidSen: number; balancePct: number; outstandingSen: number };
  sos: CollectionOrder[];
};

const pct = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);
const sum = <T,>(rows: readonly T[], pick: (r: T) => number): number => rows.reduce((s, r) => s + pick(r), 0);

export const collectionReport = async (c: Ctx): Promise<Response> => {
  if (!requirePerm(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const from = String(c.req.query('from') ?? '').trim();
  const to = String(c.req.query('to') ?? '').trim();
  if (!DATE.test(from) || !DATE.test(to) || from > to) {
    return c.json({ error: 'bad_range', message: 'from and to must be YYYY-MM-DD, from on or before to.' }, 400);
  }
  const thresholdRaw = Number(c.req.query('threshold') ?? 50);
  const thresholdPct = Number.isFinite(thresholdRaw) && thresholdRaw > 0 && thresholdRaw <= 100 ? thresholdRaw : 50;
  const onlySalesperson = String(c.req.query('salesperson') ?? '').trim() || null;
  const sb = c.get('supabase');
  const companyId = co.companyId;

  const sos = await paginateAll<SoRow>((f, t) =>
    sb.from('mfg_sales_orders')
      .select('doc_no, so_date, status, debtor_name, local_total_sen, salesperson_id, agent')
      .eq('company_id', companyId).gte('so_date', from).lte('so_date', to)
      .order('so_date').order('doc_no').range(f, t));
  if (sos.error) return c.json({ error: 'load_failed', reason: String((sos.error as { message?: string }).message ?? sos.error) }, 500);
  /* Status is an enum the fake client cannot be trusted to compare; the
     filter is in code so both readers agree. */
  const orders = ((sos.data ?? []) as SoRow[])
    .filter((s) => !NOT_AN_ORDER.has(String(s.status)))
    .filter((s) => onlySalesperson == null || String(s.salesperson_id ?? '') === onlySalesperson);

  /* The payments on those orders, in chunks — a quarter is a few hundred
     orders and PostgREST's `in` list has a length limit. */
  const paid = new Map<string, { deposit: number; balance: number }>();
  const docs = orders.map((s) => s.doc_no);
  for (let i = 0; i < docs.length; i += 150) {
    const chunk = docs.slice(i, i + 150);
    const pays = await paginateAll<PayRow>((f, t) =>
      sb.from('mfg_sales_order_payments')
        .select('so_doc_no, amount_sen, is_deposit')
        .eq('company_id', companyId).in('so_doc_no', chunk)
        .order('id').range(f, t));
    if (pays.error) return c.json({ error: 'load_failed', reason: String((pays.error as { message?: string }).message ?? pays.error) }, 500);
    for (const p of (pays.data ?? []) as PayRow[]) {
      const at = paid.get(p.so_doc_no) ?? { deposit: 0, balance: 0 };
      if (p.is_deposit === true) at.deposit += Number(p.amount_sen ?? 0); else at.balance += Number(p.amount_sen ?? 0);
      paid.set(p.so_doc_no, at);
    }
  }

  /* The final invoice, when one exists: several live invoices on one order
     add up; the first number is the one named. */
  const invoiceOf = new Map<string, { number: string; totalSen: number }>();
  for (let i = 0; i < docs.length; i += 150) {
    const chunk = docs.slice(i, i + 150);
    const sis = await paginateAll<SiRow>((f, t) =>
      sb.from('sales_invoices')
        .select('so_doc_no, invoice_number, status, total_sen')
        .eq('company_id', companyId).in('so_doc_no', chunk)
        .order('invoice_number').range(f, t));
    if (sis.error) return c.json({ error: 'load_failed', reason: String((sis.error as { message?: string }).message ?? sis.error) }, 500);
    for (const inv of (sis.data ?? []) as SiRow[]) {
      if (!inv.so_doc_no || !absorbsOrderDeposit(inv.status)) continue;
      const at = invoiceOf.get(inv.so_doc_no);
      invoiceOf.set(inv.so_doc_no, at
        ? { number: at.number, totalSen: at.totalSen + Number(inv.total_sen ?? 0) }
        : { number: String(inv.invoice_number), totalSen: Number(inv.total_sen ?? 0) });
    }
  }

  /* Who sold it: the staff row by id, else the agent text, else unassigned. */
  const staffIds = [...new Set(orders.map((s) => s.salesperson_id).filter((x): x is string => typeof x === 'string' && x !== ''))];
  const nameOf = new Map<string, string>();
  for (let i = 0; i < staffIds.length; i += 150) {
    const chunk = staffIds.slice(i, i + 150);
    const { data: staff, error: stErr } = await sb.from('staff').select('id, name').in('id', chunk);
    if (stErr) return c.json({ error: 'load_failed', reason: stErr.message }, 500);
    for (const s of (Array.isArray(staff) ? staff : []) as Array<{ id: string; name: string | null }>) nameOf.set(String(s.id), String(s.name ?? s.id));
  }

  const perOrder: CollectionOrder[] = orders.map((s) => {
    const p = paid.get(s.doc_no) ?? { deposit: 0, balance: 0 };
    const totalSen = Number(s.local_total_sen ?? 0);
    const inv = invoiceOf.get(s.doc_no) ?? null;
    const billedSen = inv ? inv.totalSen : totalSen;
    const collectedSen = p.deposit + p.balance;
    const balanceDueSen = Math.max(billedSen - p.deposit, 0);
    return {
      docNo: s.doc_no, soDate: String(s.so_date).slice(0, 10), status: String(s.status), customer: s.debtor_name ?? null,
      totalSen, depositSen: p.deposit, balancePaidSen: p.balance, collectedSen, outstandingSen: billedSen - collectedSen,
      depositPct: pct(p.deposit, totalSen), balanceDueSen, balancePct: pct(p.balance, balanceDueSen),
      delivered: inv != null || DELIVERED.has(String(s.status)), belowThreshold: totalSen > 0 && pct(p.deposit, totalSen) < thresholdPct,
      invoiceNumber: inv?.number ?? null, billedSen,
    };
  });

  const bySeller = new Map<string, { id: string | null; name: string; sos: CollectionOrder[] }>();
  orders.forEach((s, i) => {
    const id = s.salesperson_id ? String(s.salesperson_id) : null;
    const name = id ? (nameOf.get(id) ?? (s.agent ?? id)) : (s.agent ?? 'Unassigned');
    const key = id ?? `agent:${name}`;
    const at = bySeller.get(key) ?? { id, name, sos: [] };
    at.sos.push(perOrder[i]!);
    bySeller.set(key, at);
  });

  const rowOf = (id: string | null, name: string, sos: CollectionOrder[]): CollectionRow => {
    const dl = sos.filter((o) => o.delivered);
    const totalSen = sum(sos, (o) => o.totalSen);
    const depositSen = sum(sos, (o) => o.depositSen);
    const dlDue = sum(dl, (o) => o.balanceDueSen);
    const dlPaid = sum(dl, (o) => o.balancePaidSen);
    return {
      salespersonId: id, salesperson: name,
      orders: sos.length, totalSen, depositSen, depositPct: pct(depositSen, totalSen), belowCount: sos.filter((o) => o.belowThreshold).length,
      delivered: {
        orders: dl.length, totalSen: sum(dl, (o) => o.totalSen), billedSen: sum(dl, (o) => o.billedSen), depositSen: sum(dl, (o) => o.depositSen),
        balanceDueSen: dlDue, balancePaidSen: dlPaid, balancePct: pct(dlPaid, dlDue), outstandingSen: sum(dl, (o) => o.outstandingSen),
      },
      sos,
    };
  };
  const rows = [...bySeller.values()]
    .map((g) => rowOf(g.id, g.name, g.sos))
    .sort((a, b) => b.totalSen - a.totalSen || a.salesperson.localeCompare(b.salesperson));
  const totals = rowOf(null, 'Total', perOrder);
  return c.json({ from, to, thresholdPct, rows, totals: { ...totals, sos: [] } });
};
