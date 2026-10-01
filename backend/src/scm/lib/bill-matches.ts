// ----------------------------------------------------------------------------
// bill-matches.ts — the same bill asked for, or paid, twice (owner 2026-10-01:
// 同一张单上传两次 … 同收款人和同金额可能会出现，要认单号和日期比较稳妥; warn,
// never block — one bill paid as a deposit and then a balance is normal).
//
// A bill is known by what is PRINTED on it: its own number and its date, as the
// bill reader read them (acc/bill-extract.ts) or a person typed them. Three
// documents keep that pair — a payment request (bill_no, bill_date), a payment
// voucher (bill_ref, bill_date) and an AP invoice (supplier_invoice_ref,
// invoice_date) — and this module finds, for a bill, every OTHER live document
// carrying the same pair. A request and the voucher or AP invoice made from it
// are ONE payment, never a match of each other: the answer is named beside its
// request instead of listed on its own.
// ----------------------------------------------------------------------------

import { dateOrNull } from './date-coerce';

type Row = Record<string, any>;

export type BillMatch = {
  kind: 'PRQ' | 'PV' | 'API';
  id: string;
  number: string | null;
  amountSen: number;
  status: string;
  /** For a request: the voucher or AP invoice answering it, by number. */
  answeredBy: string | null;
};

/** "INV-0012", "inv 0012" and "INV0012" are one number. */
export const normalizeBillNo = (s: unknown): string => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '');

export type BillProbe = {
  key: string;
  billNo: unknown;
  billDate: unknown;
  /** The probing document itself and its own answer — never its own match. */
  exclude?: { requestIds?: Array<string | null | undefined>; pvIds?: Array<string | null | undefined>; apInvoiceIds?: Array<string | null | undefined> };
};

const ids = (list: Array<string | null | undefined> | undefined): Set<string> =>
  new Set((list ?? []).filter((v): v is string => typeof v === 'string' && v !== ''));

/** Every probe's matches, keyed as the probes were. A probe without both a
    number and a date matches nothing — the owner's rule is the PAIR. */
export async function findBillMatches(
  sb: any,
  companyId: number,
  probes: BillProbe[],
): Promise<{ ok: true; matches: Map<string, BillMatch[]> } | { ok: false; reason: string }> {
  const matches = new Map<string, BillMatch[]>();
  const live = probes
    .map((p) => ({ ...p, no: normalizeBillNo(p.billNo), date: dateOrNull(p.billDate) }))
    .filter((p) => p.no !== '' && p.date != null);
  for (const p of probes) matches.set(p.key, []);
  if (live.length === 0) return { ok: true, matches };
  const dates = [...new Set(live.map((p) => p.date as string))];

  const [reqs, pvs, apis] = await Promise.all([
    sb.from('acc_payment_requests').select('id, request_no, amount_sen, status, bill_no, bill_date, pv_id, ap_invoice_id')
      .eq('company_id', companyId).in('bill_date', dates),
    sb.from('payment_vouchers').select('id, pv_number, total_sen, status, bill_ref, bill_date')
      .eq('company_id', companyId).in('bill_date', dates),
    sb.from('ap_invoices').select('id, invoice_number, total_sen, status, supplier_invoice_ref, invoice_date')
      .eq('company_id', companyId).in('invoice_date', dates),
  ]);
  for (const r of [reqs, pvs, apis]) if (r.error) return { ok: false, reason: String(r.error.message ?? r.error) };
  const requests = ((reqs.data ?? []) as Row[]).filter((r) => r.status !== 'WITHDRAWN');
  const vouchers = ((pvs.data ?? []) as Row[]).filter((v) => v.status !== 'CANCELLED');
  const invoices = ((apis.data ?? []) as Row[]).filter((i) => i.status !== 'CANCELLED' && i.supplier_invoice_ref);

  /* A request's answer by number, for "PRQ-… → PV-…" — read for the matched
     requests whose answer did not come back with the same pair. */
  const pvNo = new Map(((pvs.data ?? []) as Row[]).map((v) => [String(v.id), v.pv_number == null ? null : String(v.pv_number)]));
  const apiNo = new Map(((apis.data ?? []) as Row[]).map((i) => [String(i.id), i.invoice_number == null ? null : String(i.invoice_number)]));
  const missingPv = [...new Set(requests.map((r) => r.pv_id).filter((v) => v && !pvNo.has(String(v))).map(String))];
  const missingApi = [...new Set(requests.map((r) => r.ap_invoice_id).filter((v) => v && !apiNo.has(String(v))).map(String))];
  if (missingPv.length > 0) {
    const { data, error } = await sb.from('payment_vouchers').select('id, pv_number, status').eq('company_id', companyId).in('id', missingPv);
    if (error) return { ok: false, reason: String(error.message ?? error) };
    for (const v of (data ?? []) as Row[]) pvNo.set(String(v.id), v.status === 'CANCELLED' ? null : (v.pv_number == null ? null : String(v.pv_number)));
  }
  if (missingApi.length > 0) {
    const { data, error } = await sb.from('ap_invoices').select('id, invoice_number, status').eq('company_id', companyId).in('id', missingApi);
    if (error) return { ok: false, reason: String(error.message ?? error) };
    for (const i of (data ?? []) as Row[]) apiNo.set(String(i.id), i.status === 'CANCELLED' ? null : (i.invoice_number == null ? null : String(i.invoice_number)));
  }

  for (const p of live) {
    const exReq = ids(p.exclude?.requestIds);
    const exPv = ids(p.exclude?.pvIds);
    const exApi = ids(p.exclude?.apInvoiceIds);
    /* A request answered by an excluded document is that document's own — and
       an excluded request's answer is the request's own. */
    for (const r of requests) {
      if ((r.pv_id && exPv.has(String(r.pv_id))) || (r.ap_invoice_id && exApi.has(String(r.ap_invoice_id)))) exReq.add(String(r.id));
    }
    for (const r of requests) {
      if (!exReq.has(String(r.id))) continue;
      if (r.pv_id) exPv.add(String(r.pv_id));
      if (r.ap_invoice_id) exApi.add(String(r.ap_invoice_id));
    }
    const same = (no: unknown, date: unknown) => normalizeBillNo(no) === p.no && dateOrNull(date) === p.date;
    const out: BillMatch[] = [];
    const answers = new Set<string>();
    for (const r of requests) {
      if (exReq.has(String(r.id)) || !same(r.bill_no, r.bill_date)) continue;
      const answer = r.pv_id ? pvNo.get(String(r.pv_id)) ?? null : r.ap_invoice_id ? apiNo.get(String(r.ap_invoice_id)) ?? null : null;
      if (r.pv_id) answers.add(`PV:${r.pv_id}`);
      if (r.ap_invoice_id) answers.add(`API:${r.ap_invoice_id}`);
      out.push({ kind: 'PRQ', id: String(r.id), number: String(r.request_no ?? ''), amountSen: Number(r.amount_sen ?? 0), status: String(r.status), answeredBy: answer });
    }
    for (const v of vouchers) {
      if (exPv.has(String(v.id)) || answers.has(`PV:${v.id}`) || !same(v.bill_ref, v.bill_date)) continue;
      out.push({ kind: 'PV', id: String(v.id), number: v.pv_number == null ? null : String(v.pv_number), amountSen: Number(v.total_sen ?? 0), status: String(v.status), answeredBy: null });
    }
    for (const i of invoices) {
      if (exApi.has(String(i.id)) || answers.has(`API:${i.id}`) || !same(i.supplier_invoice_ref, i.invoice_date)) continue;
      out.push({ kind: 'API', id: String(i.id), number: i.invoice_number == null ? null : String(i.invoice_number), amountSen: Number(i.total_sen ?? 0), status: String(i.status), answeredBy: null });
    }
    matches.set(p.key, out);
  }
  return { ok: true, matches };
}

/* ── The facts a request keeps about its bill ──────────────────────────────── */

export type RequestBillFacts = {
  bill_no: string | null;
  bill_date: string | null;
  bill_total_sen: number | null;
  event_bill: boolean;
  no_event_reason: string | null;
};

const text = (v: unknown, max: number): string | null => {
  const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
  return s ? s.slice(0, max) : null;
};

/** The bill facts as the body sends them (camel), checked. */
export function readBillFacts(body: Row): { facts: RequestBillFacts } | { error: string; message: string } {
  let total: number | null = null;
  if (body.billTotalSen !== undefined && body.billTotalSen !== null && body.billTotalSen !== '') {
    const n = Number(body.billTotalSen);
    if (!Number.isInteger(n) || n < 0) return { error: 'bill_total_invalid', message: 'The bill total must be a whole number of sen, zero or more.' };
    total = n;
  }
  return {
    facts: {
      bill_no: text(body.billNo, 80),
      bill_date: dateOrNull(body.billDate),
      bill_total_sen: total,
      event_bill: body.eventBill === true,
      no_event_reason: text(body.noEventReason, 300),
    },
  };
}

/** The one-line reason a requester gives when the event bill has no event. */
export const NO_EVENT_REASON_MIN = 5;

/** A bill printed for an event goes to Finance with its Event — or with the
    requester's reason why there is none (找不到这场活动). */
export function eventBillRefusal(f: { event_bill: boolean; project_id: number | null; no_event_reason: string | null }): { error: string; message: string } | null {
  if (!f.event_bill || f.project_id != null) return null;
  if ((f.no_event_reason ?? '').trim().length >= NO_EVENT_REASON_MIN) return null;
  return { error: 'event_required', message: 'This bill is for an event — pick the event, or say in a line why there is none.' };
}

/* ── The pair a voucher keeps ──────────────────────────────────────────────── */

/** What the body says, else what the request it answers read off the bill. */
export function pvBillFields(body: Row, request?: Row | null): { bill_ref: string | null; bill_date: string | null } {
  const ref = body.billRef !== undefined ? text(body.billRef, 80) : text(request?.bill_no, 80);
  const date = body.billDate !== undefined ? dateOrNull(body.billDate) : dateOrNull(request?.bill_date);
  return { bill_ref: ref, bill_date: date };
}

/** A draft voucher's edit: only the keys the body names. */
export function pvBillUpdates(body: Row): Row {
  const out: Row = {};
  if (body.billRef !== undefined) out.bill_ref = text(body.billRef, 80);
  if (body.billDate !== undefined) out.bill_date = dateOrNull(body.billDate);
  return out;
}
