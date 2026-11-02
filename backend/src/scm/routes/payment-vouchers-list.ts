// ----------------------------------------------------------------------------
// GET /payment-vouchers — the list, its search and its counts (the owner's
// Claude Design redesign, batch 4). Its own file because payment-vouchers.ts
// sits at the file-size cap.
//
//   • the list: the newest 500, each row with what remains of its ADVANCE
//     (owner 2026-09-06) and the journal its approval posted (je_no);
//   • ?q= — any voucher, every stage and month (the design: "Find any voucher
//     · number, payee, bill, amount"): the voucher and bill numbers, payee,
//     notes, the supplier's name or code, an amount typed as money, the
//     journal number, and the numbers of the bills it pays. At most 200;
//   • ?counts=1 — how many vouchers sit at each stage, over the whole
//     company, not the 500 the page holds.
//
// Read only. Every read is company-scoped and a failed read fails the request.
// ----------------------------------------------------------------------------

import { scopeToCompany, type CompanyScopeCtx } from '../lib/companyScope';
import { paginateAll } from '../lib/paginate-all';

export const HEADER =
  'id, pv_number, voucher_date, payee_name, supplier_id, credit_account_code, currency, exchange_rate, purpose, notes, total_sen, status, posted_at, created_at, created_by, updated_at, company_id, submitted_at, submitted_by, checked_at, checked_by, approved_at, approved_by, refund_source_type, refund_source_doc_no, customer_id, debtor_code, bill_ref, bill_date, official_doc, official_doc_note, official_doc_at, official_doc_by, bank_charge_sen';

const LIST_CAP = 500;
const SEARCH_CAP = 200;

type Fail = { ok: false; reason: string };
type Rows = Array<Record<string, unknown>>;

/** "1,234.50" / "1234.5" / "RM 1234" → sen; anything else null. */
export const moneyQuery = (q: string): number | null => {
  const t = q.replace(/^rm\s*/i, '').replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
};

/** A read over `values` 100 at a time: the URL stays short, and each caller
    bounds what one batch can return (newest SEARCH_CAP, or a handful per key)
    so no batch reaches PostgREST's row cap. */
async function inBatches(values: string[], read: (batch: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<{ ok: true; rows: Rows } | Fail> {
  const rows: Rows = [];
  for (let i = 0; i < values.length; i += 100) {
    const r = await read(values.slice(i, i + 100));
    if (r.error) return { ok: false, reason: r.error.message };
    rows.push(...((r.data ?? []) as Rows));
  }
  return { ok: true, rows };
}

/** The ids of every voucher the words find, newest first is the caller's job. */
async function searchVoucherIds(sb: any, c: CompanyScopeCtx, term: string): Promise<{ ok: true; ids: string[] } | Fail> {
  /* ilike's own wildcards are the user's literal characters here. */
  const like = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const pv = () => scopeToCompany(sb.from('payment_vouchers').select('id'), c);
  const sen = moneyQuery(term);
  /* One column a read: an .or() string would carry the words unescaped. */
  type Read = PromiseLike<{ data: unknown; error: { message: string } | null }>;
  const scoped = (table: string, cols: string) => scopeToCompany(sb.from(table).select(cols), c);
  const reads: Array<[string, Read]> = [
    ['vouchers', pv().ilike('pv_number', like).limit(SEARCH_CAP)],
    ['bills', pv().ilike('bill_ref', like).limit(SEARCH_CAP)],
    ['payees', pv().ilike('payee_name', like).limit(SEARCH_CAP)],
    ['notes', pv().ilike('notes', like).limit(SEARCH_CAP)],
    ['supplier names', scoped('suppliers', 'id').ilike('name', like).limit(SEARCH_CAP)],
    ['supplier codes', scoped('suppliers', 'id').ilike('code', like).limit(SEARCH_CAP)],
    ['journals', scoped('journal_entries', 'source_doc_no').in('source_type', ['PV', 'PV_REVERSAL']).ilike('je_no', like).limit(SEARCH_CAP)],
    ['purchase invoices', scoped('purchase_invoices', 'id').ilike('invoice_number', like).limit(SEARCH_CAP)],
    ['purchase invoice refs', scoped('purchase_invoices', 'id').ilike('supplier_invoice_ref', like).limit(SEARCH_CAP)],
    ['AP invoices', scoped('ap_invoices', 'id').ilike('invoice_number', like).limit(SEARCH_CAP)],
    ['AP invoice refs', scoped('ap_invoices', 'id').ilike('supplier_invoice_ref', like).limit(SEARCH_CAP)],
  ];
  if (sen != null) reads.push(['amounts', pv().eq('total_sen', sen).limit(SEARCH_CAP)]);
  const results = await Promise.all(reads.map(([, r]) => r));
  const got = new Map<string, Rows>();
  for (let i = 0; i < reads.length; i += 1) {
    const r = results[i]!;
    if (r.error) return { ok: false, reason: `${reads[i]![0]}: ${r.error.message}` };
    got.set(reads[i]![0], (r.data ?? []) as Rows);
  }
  const idsOf = (...keys: string[]) => [...new Set(keys.flatMap((k) => (got.get(k) ?? []).map((x) => String(x.id))))];
  const ids = new Set<string>(idsOf('vouchers', 'bills', 'payees', 'notes', 'amounts'));

  const supplierIds = idsOf('supplier names', 'supplier codes');
  if (supplierIds.length > 0) {
    const r = await inBatches(supplierIds, (batch) => pv().in('supplier_id', batch).order('voucher_date', { ascending: false }).limit(SEARCH_CAP));
    if (!r.ok) return { ok: false, reason: `suppliers' vouchers: ${r.reason}` };
    for (const x of r.rows) ids.add(String(x.id));
  }
  const numbers = [...new Set((got.get('journals') ?? []).map((x) => String(x.source_doc_no ?? '')).filter(Boolean))];
  if (numbers.length > 0) {
    const r = await inBatches(numbers, (batch) => pv().in('pv_number', batch));
    if (!r.ok) return { ok: false, reason: `journals' vouchers: ${r.reason}` };
    for (const x of r.rows) ids.add(String(x.id));
  }
  const billIds: Array<['pi_id' | 'ap_invoice_id', string[]]> = [
    ['pi_id', idsOf('purchase invoices', 'purchase invoice refs')],
    ['ap_invoice_id', idsOf('AP invoices', 'AP invoice refs')],
  ];
  for (const [col, list] of billIds) {
    if (list.length === 0) continue;
    const r = await inBatches(list, (batch) => scopeToCompany(sb.from('pv_allocations').select('pv_id'), c).in(col, batch));
    if (!r.ok) return { ok: false, reason: `bills' vouchers: ${r.reason}` };
    for (const x of r.rows) ids.add(String(x.pv_id));
  }
  return { ok: true, ids: [...ids] };
}

/** How many vouchers sit at each stage — the chips' counts — over the whole company. */
async function stageCounts(sb: any, c: CompanyScopeCtx): Promise<{ ok: true; counts: Record<string, number> } | Fail> {
  const head = () => scopeToCompany(sb.from('payment_vouchers').select('id', { count: 'exact', head: true }), c);
  const [all, draft, prepared, checked, approved, cancelled] = await Promise.all([
    head(),
    head().eq('status', 'DRAFT').is('submitted_at', null),
    head().eq('status', 'DRAFT').not('submitted_at', 'is', null).is('checked_at', null),
    head().eq('status', 'DRAFT').not('checked_at', 'is', null),
    head().eq('status', 'POSTED'),
    head().eq('status', 'CANCELLED'),
  ]);
  for (const r of [all, draft, prepared, checked, approved, cancelled]) if (r.error) return { ok: false, reason: `counts: ${r.error.message}` };
  /* An advance is open while what was paid ahead exceeds what bills used. */
  const adv = await paginateAll<Record<string, unknown>>((f, t) => scopeToCompany(sb.from('acc_supplier_advances').select('pv_id, amount_sen, applied_sen'), c).order('pv_id').range(f, t));
  if (adv.error) return { ok: false, reason: `advances: ${adv.error.message}` };
  const open = new Set<string>();
  for (const a of adv.data ?? []) if (Number(a.amount_sen) - Number(a.applied_sen) > 0) open.add(String(a.pv_id));
  /* The company's advances are few; paged all the same, because a silent cut is how a count lies. */
  return {
    ok: true,
    counts: {
      all: all.count ?? 0, DRAFT: draft.count ?? 0, PREPARED: prepared.count ?? 0, CHECKED: checked.count ?? 0,
      POSTED: approved.count ?? 0, ADVANCE: open.size, CANCELLED: cancelled.count ?? 0,
    },
  };
}

/** Each voucher's journal: the entry its approval posted, the live one when it was reversed and re-posted. */
async function journalNumbers(sb: any, c: CompanyScopeCtx, pvNumbers: string[]): Promise<{ ok: true; byPv: Map<string, string> } | Fail> {
  const byPv = new Map<string, string>();
  if (pvNumbers.length === 0) return { ok: true, byPv };
  /* A voucher has one journal, two when its approval was reversed and re-posted. */
  const r = await inBatches(pvNumbers, (batch) => scopeToCompany(sb.from('journal_entries')
    .select('je_no, source_doc_no, reversed'), c).eq('source_type', 'PV').in('source_doc_no', batch));
  if (!r.ok) return { ok: false, reason: `journals: ${r.reason}` };
  for (const j of r.rows) {
    const no = String(j.source_doc_no ?? '');
    if (!no) continue;
    if (!j.reversed || !byPv.has(no)) byPv.set(no, String(j.je_no));
  }
  return { ok: true, byPv };
}

export const listPaymentVouchersHandler = async (c: any): Promise<Response> => {
  const sb = c.get('supabase');
  const term = String(c.req.query('q') ?? '').trim();
  type Row = Record<string, unknown> & { id: string; pv_number: string; voucher_date?: string | null };
  let rows: Row[];
  if (term) {
    /* The search reads its rows in URL-sized batches, newest first, at most 200. */
    const found = await searchVoucherIds(sb, c, term);
    if (!found.ok) return c.json({ error: 'load_failed', reason: found.reason }, 500);
    const read = await inBatches(found.ids, (batch) => scopeToCompany(sb.from('payment_vouchers')
      .select(`${HEADER}, supplier:suppliers(id, code, name)`), c).in('id', batch));
    if (!read.ok) return c.json({ error: 'load_failed', reason: read.reason }, 500);
    rows = [...(read.rows as Row[])].sort((x, y) => String(y.voucher_date ?? '').localeCompare(String(x.voucher_date ?? ''))).slice(0, SEARCH_CAP);
  } else {
    let q = sb.from('payment_vouchers')
      .select(`${HEADER}, supplier:suppliers(id, code, name)`)
      .order('voucher_date', { ascending: false })
      // Bound the result so PostgREST's default 1000-row cap can't silently
      // truncate the list — matches the PI/SI/DO list convention.
      .limit(LIST_CAP);
    const status = c.req.query('status'); if (status) q = q.eq('status', status);
    q = scopeToCompany(q, c); // multi-company: isolate to the active company
    const { data, error } = await q;
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    rows = (data ?? []) as Row[];
  }
  const remaining = new Map<string, number>();
  if (rows.length > 0) {
    const { data: adv, error: advErr } = await scopeToCompany(
      sb.from('acc_supplier_advances').select('pv_id, amount_sen, applied_sen').in('pv_id', rows.map((r) => r.id)), c,
    );
    if (advErr) return c.json({ error: 'load_failed', reason: advErr.message }, 500);
    for (const a of (adv ?? []) as Array<{ pv_id: string; amount_sen: number; applied_sen: number }>) {
      const left = Number(a.amount_sen) - Number(a.applied_sen);
      if (left > 0) remaining.set(a.pv_id, (remaining.get(a.pv_id) ?? 0) + left);
    }
  }
  const journals = await journalNumbers(sb, c, rows.map((r) => r.pv_number));
  if (!journals.ok) return c.json({ error: 'load_failed', reason: journals.reason }, 500);
  const counted = c.req.query('counts') === '1' && !term ? await stageCounts(sb, c) : null;
  if (counted && !counted.ok) return c.json({ error: 'load_failed', reason: counted.reason }, 500);
  return c.json({
    paymentVouchers: rows.map((r) => ({ ...r, advance_remaining_sen: remaining.get(r.id) ?? 0, je_no: journals.byPv.get(r.pv_number) ?? null })),
    ...(term ? { q: term, capped: rows.length >= SEARCH_CAP } : {}),
    ...(counted?.ok ? { counts: counted.counts } : {}),
  });
};
