// ----------------------------------------------------------------------------
// accounting-rp — the Receipts & Payments report (owner 2026-09-06/07:
// 我希望做一个 receipt & Payment 版式 … 做).
//
// AutoCount's shape: each cash/bank account is a COLUMN, a Total column beside
// them, RECEIPTS above and PAYMENTS below, opening and closing per column.
// Every row is the OTHER side of the money movement, in the owner's own
// accounts (这个目前我有分 account, 你可以先不要自己分类 — no invented
// categories; the big groups come later, dragged onto rows on this page).
//
// The one rule that is not "the other side's account": a SUPPLIER PAYMENT.
// Its journal debits the creditor control, which says nothing about what was
// bought — so it is read through what the voucher settled (rule A, his):
//   · a purchase invoice → the PI's own purchase accounts (601-0003 sofa,
//     601-0001 bedding…), the allocation split in the proportion of the PI's
//     own debit lines (a single-group PI is simply that group);
//   · an AP invoice → the bill's own lines' accounts, the same way;
//   · money the voucher paid beyond what it settled → "Supplier advances".
// With `party=1` (AutoCount's "display trade debtor/creditor in details") the
// control-account rows are named by the party instead and are not split.
//
// A transfer between two money accounts shows as "Transfer to/from <other>",
// never as an unexplained receipt. The report reads ONE source, v_gl_entries
// (posted, not reversed) — the same as the P&L, the balance sheet and the
// trial balance beside it, so the four can never disagree. Nothing is
// stored; every request re-derives.
// ----------------------------------------------------------------------------

import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { paginateAll } from '../lib/paginate-all';
import { resolveRoles } from '../../acc/rules';

const requirePerm = (c: any): boolean => hasHouzsPerm(c, 'scm.payment_voucher.post');
const NO_PERM = { error: "You don't have permission to read the financial statements." };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type GlLine = {
  je_no: string; entry_date: string; source_type: string | null; source_doc_no: string | null;
  account_code: string; account_name: string | null; debit_sen: number; credit_sen: number;
  party_type: string | null; party_code?: string | null; party_name: string | null; notes: string | null;
  posted: boolean | null; reversed: boolean | null;
};

export type RpRow = { key: string; code: string | null; name: string; cells: Record<string, number>; totalSen: number };
export type RpEntry = {
  jeNo: string; entryDate: string; sourceType: string | null; sourceDocNo: string | null;
  narration: string | null; party: string | null; side: 'R' | 'P'; rowKey: string; column: string; sen: number;
};

const ADVANCE_KEY = 'ADV';
const live = (l: GlLine) => l.posted === true && l.reversed !== true;
const sen = (l: GlLine) => Number(l.debit_sen ?? 0) - Number(l.credit_sen ?? 0);

/** Every posted line the company has on the MONEY accounts up to `to` (the
    opening is the ones before `from`), and every line inside [from, to]. */
async function loadLines(sb: any, companyId: number, moneyCodes: string[], from: string, to: string) {
  const money = await paginateAll<GlLine>((f, t) =>
    sb.from('v_gl_entries')
      .select('je_no, entry_date, source_type, source_doc_no, account_code, account_name, debit_sen, credit_sen, party_type, party_code, party_name, notes, posted, reversed')
      .eq('company_id', companyId).in('account_code', moneyCodes).lte('entry_date', to)
      .order('line_id').range(f, t));
  if (money.error) return { ok: false as const, reason: String((money.error as { message?: string }).message ?? money.error) };
  const period = await paginateAll<GlLine>((f, t) =>
    sb.from('v_gl_entries')
      .select('je_no, entry_date, source_type, source_doc_no, account_code, account_name, debit_sen, credit_sen, party_type, party_code, party_name, notes, posted, reversed')
      .eq('company_id', companyId).gte('entry_date', from).lte('entry_date', to)
      .order('line_id').range(f, t));
  if (period.error) return { ok: false as const, reason: String((period.error as { message?: string }).message ?? period.error) };
  return { ok: true as const, money: (money.data ?? []).filter(live), period: (period.data ?? []).filter(live) };
}

type Split = { code: string; name: string; sen: number };

/** What each supplier-payment voucher settled, read through the documents it
    settled — the purpose split (rule A). Keyed by pv_number. A voucher that
    settled nothing (a pure prepayment) yields [] and reads as an advance. */
async function supplierPurposeSplits(
  sb: any, companyId: number, pvNumbers: string[], controlCodes: Set<string>,
): Promise<{ ok: true; byPv: Map<string, Split[]> } | { ok: false; reason: string }> {
  const byPv = new Map<string, Split[]>();
  if (pvNumbers.length === 0) return { ok: true, byPv };
  const { data: pvs, error: pvErr } = await sb.from('payment_vouchers').select('id, pv_number').eq('company_id', companyId).in('pv_number', pvNumbers);
  if (pvErr) return { ok: false, reason: pvErr.message };
  const numberById = new Map<string, string>();
  for (const p of (pvs ?? []) as Array<{ id: string; pv_number: string }>) numberById.set(String(p.id), String(p.pv_number));
  if (numberById.size === 0) return { ok: true, byPv };
  const { data: allocs, error: aErr } = await sb.from('pv_allocations')
    .select('pv_id, pi_id, ap_invoice_id, amount_sen, applied_sen, from_advance')
    .eq('company_id', companyId).in('pv_id', [...numberById.keys()]);
  if (aErr) return { ok: false, reason: aErr.message };
  type Alloc = { pv_id: string; pi_id: string | null; ap_invoice_id: string | null; amount_sen: number; applied_sen: number | null; from_advance: boolean | null };
  const rows = ((allocs ?? []) as Alloc[]).filter((a) => a.from_advance !== true);
  const piIds = [...new Set(rows.flatMap((a) => (a.pi_id ? [String(a.pi_id)] : [])))];
  const apiIds = [...new Set(rows.flatMap((a) => (a.ap_invoice_id ? [String(a.ap_invoice_id)] : [])))];

  /* A PI's purpose = its own journal's debit lines off the control (the
     periodic shape: one debit per product group). */
  const piSplit = new Map<string, Split[]>();
  if (piIds.length > 0) {
    const { data: pis, error: piErr } = await sb.from('purchase_invoices').select('id, invoice_number').eq('company_id', companyId).in('id', piIds);
    if (piErr) return { ok: false, reason: piErr.message };
    const numbers = ((pis ?? []) as Array<{ id: string; invoice_number: string }>);
    const idByNumber = new Map(numbers.map((p) => [String(p.invoice_number), String(p.id)]));
    if (numbers.length > 0) {
      const jl = await paginateAll<GlLine>((f, t) =>
        sb.from('v_gl_entries')
          .select('je_no, entry_date, source_type, source_doc_no, account_code, account_name, debit_sen, credit_sen, party_type, party_code, party_name, notes, posted, reversed')
          .eq('company_id', companyId).eq('source_type', 'PI').in('source_doc_no', numbers.map((p) => p.invoice_number))
          .order('line_id').range(f, t));
      if (jl.error) return { ok: false, reason: String((jl.error as { message?: string }).message ?? jl.error) };
      for (const l of (jl.data ?? []).filter(live)) {
        if (Number(l.debit_sen ?? 0) <= 0 || controlCodes.has(l.account_code)) continue;
        const id = idByNumber.get(String(l.source_doc_no ?? ''));
        if (!id) continue;
        const list = piSplit.get(id) ?? [];
        list.push({ code: l.account_code, name: String(l.account_name ?? l.account_code), sen: Number(l.debit_sen) });
        piSplit.set(id, list);
      }
    }
  }
  /* An AP invoice's purpose = its own lines. */
  const apiSplit = new Map<string, Split[]>();
  if (apiIds.length > 0) {
    const { data: lines, error: lErr } = await sb.from('ap_invoice_lines')
      .select('invoice_id, debit_account_code, amount_sen').eq('company_id', companyId).in('invoice_id', apiIds);
    if (lErr) return { ok: false, reason: lErr.message };
    const codes = [...new Set(((lines ?? []) as Array<{ debit_account_code: string }>).map((l) => String(l.debit_account_code)))];
    const names = new Map<string, string>();
    if (codes.length > 0) {
      const { data: accs, error: accErr } = await sb.from('accounts').select('account_code, account_name').eq('company_id', companyId).in('account_code', codes);
      if (accErr) return { ok: false, reason: accErr.message };
      for (const a of (accs ?? []) as Array<{ account_code: string; account_name: string }>) names.set(String(a.account_code), String(a.account_name));
    }
    for (const l of (lines ?? []) as Array<{ invoice_id: string; debit_account_code: string; amount_sen: number }>) {
      const list = apiSplit.get(String(l.invoice_id)) ?? [];
      list.push({ code: String(l.debit_account_code), name: names.get(String(l.debit_account_code)) ?? String(l.debit_account_code), sen: Number(l.amount_sen ?? 0) });
      apiSplit.set(String(l.invoice_id), list);
    }
  }

  /* Each allocation, in the proportion of its document's own lines — exact
     when the document is settled in full (rule A). Sen stay integers; the
     rounding remainder rides on the largest line. */
  const proportion = (amount: number, parts: Split[]): Split[] => {
    const total = parts.reduce((s, p) => s + p.sen, 0);
    if (total <= 0 || parts.length === 0) return [];
    let left = amount;
    const out = parts.map((p) => {
      const share = Math.floor((amount * p.sen) / total);
      left -= share;
      return { code: p.code, name: p.name, sen: share };
    });
    const biggest = out.reduce((b, x, i) => (x.sen > out[b]!.sen ? i : b), 0);
    out[biggest]!.sen += left;
    return out.filter((x) => x.sen !== 0);
  };
  for (const a of rows) {
    const pv = numberById.get(String(a.pv_id));
    if (!pv) continue;
    const settled = Number(a.applied_sen ?? 0) > 0 ? Number(a.applied_sen) : Number(a.amount_sen ?? 0);
    if (settled <= 0) continue;
    const parts = a.pi_id ? piSplit.get(String(a.pi_id)) : a.ap_invoice_id ? apiSplit.get(String(a.ap_invoice_id)) : undefined;
    const list = byPv.get(pv) ?? [];
    list.push(...proportion(settled, parts ?? []));
    byPv.set(pv, list);
  }
  return { ok: true, byPv };
}

/* ── GET /accounting/reports/receipts-payments?from&to&accounts=a,b&party=1 ── */
export const receiptsPaymentsReport = async (c: any): Promise<Response> => {
  if (!requirePerm(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const from = String(c.req.query('from') ?? '').trim();
  const to = String(c.req.query('to') ?? '').trim();
  if (!DATE.test(from) || !DATE.test(to) || from > to) {
    return c.json({ error: 'bad_range', message: 'from and to must be YYYY-MM-DD, from on or before to.' }, 400);
  }
  const byParty = String(c.req.query('party') ?? '') === '1';
  const wanted = String(c.req.query('accounts') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const sb = c.get('supabase');
  const companyId = co.companyId;

  const { data: moneyRaw, error: mErr } = await sb.from('accounts')
    .select('account_code, account_name').eq('company_id', companyId).eq('acc_money', true).eq('is_active', true).order('account_code');
  if (mErr) return c.json({ error: 'load_failed', reason: mErr.message }, 500);
  const allMoney = ((moneyRaw ?? []) as Array<{ account_code: string; account_name: string }>).map((a) => ({ code: String(a.account_code), name: String(a.account_name ?? a.account_code) }));
  const columns = wanted.length > 0 ? allMoney.filter((a) => wanted.includes(a.code)) : allMoney;
  const moneySet = new Set(allMoney.map((a) => a.code));
  const colSet = new Set(columns.map((a) => a.code));
  if (columns.length === 0) return c.json({ from, to, byParty, columns: [], opening: {}, receipts: [], payments: [], totals: {}, entries: [] });

  const roles = await resolveRoles(sb, companyId);
  const controlCodes = new Set([roles.AR, roles.AP, roles.AP_OTHER, roles.AR_OTHER].filter(Boolean) as string[]);
  const apControls = new Set([roles.AP, roles.AP_OTHER].filter(Boolean) as string[]);

  const loaded = await loadLines(sb, companyId, columns.map((a) => a.code), from, to);
  if (!loaded.ok) return c.json({ error: 'load_failed', reason: loaded.reason }, 500);

  const opening: Record<string, number> = {};
  for (const col of columns) opening[col.code] = 0;
  for (const l of loaded.money) if (l.entry_date < from && colSet.has(l.account_code)) opening[l.account_code] = (opening[l.account_code] ?? 0) + sen(l);

  /* Group the period by journal; keep the ones with a selected money leg. */
  const byJe = new Map<string, GlLine[]>();
  for (const l of loaded.period) byJe.set(l.je_no, [...(byJe.get(l.je_no) ?? []), l]);
  const supplierPvs: string[] = [];
  for (const lines of byJe.values()) {
    const first = lines[0]!;
    if (String(first.source_type ?? '').replace(/_REVERSAL$/, '') !== 'PV') continue;
    if (!lines.some((l) => colSet.has(l.account_code)) || !lines.some((l) => apControls.has(l.account_code))) continue;
    if (first.source_doc_no) supplierPvs.push(first.source_doc_no);
  }
  const splits = byParty ? { ok: true as const, byPv: new Map<string, Split[]>() } : await supplierPurposeSplits(sb, companyId, [...new Set(supplierPvs)], controlCodes);
  if (!splits.ok) return c.json({ error: 'load_failed', reason: splits.reason }, 500);

  const receipts = new Map<string, RpRow>();
  const payments = new Map<string, RpRow>();
  const entries: RpEntry[] = [];
  const add = (side: 'R' | 'P', key: string, code: string | null, name: string, column: string, amount: number, e: { jeNo: string; entryDate: string; sourceType: string | null; sourceDocNo: string | null; narration: string | null; party: string | null }) => {
    if (amount === 0) return;
    const book = side === 'R' ? receipts : payments;
    const row = book.get(key) ?? { key, code, name, cells: {}, totalSen: 0 };
    row.cells[column] = (row.cells[column] ?? 0) + amount;
    row.totalSen += amount;
    book.set(key, row);
    entries.push({ ...e, side, rowKey: key, column, sen: amount });
  };

  for (const [jeNo, lines] of byJe) {
    const moneyLegs = lines.filter((l) => colSet.has(l.account_code));
    if (moneyLegs.length === 0) continue;
    const first = lines[0]!;
    const meta = { jeNo, entryDate: first.entry_date, sourceType: first.source_type, sourceDocNo: first.source_doc_no, narration: first.notes, party: null as string | null };
    const others = lines.filter((l) => !colSet.has(l.account_code));
    const base = String(first.source_type ?? '').replace(/_REVERSAL$/, '');

    for (const leg of moneyLegs) {
      const legSen = sen(leg);              // > 0 money in, < 0 money out
      if (legSen === 0) continue;
      const side: 'R' | 'P' = legSen > 0 ? 'R' : 'P';
      const magnitude = Math.abs(legSen);
      /* The other money legs of this journal (a transfer): each is the other
         side of THIS leg in proportion; the non-money lines share the rest. */
      const otherMoney = moneyLegs.filter((l) => l !== leg && Math.sign(sen(l)) !== Math.sign(legSen));
      const otherMoneyAbs = otherMoney.reduce((s, l) => s + Math.abs(sen(l)), 0);
      const unselectedMoney = others.filter((l) => moneySet.has(l.account_code));
      const counterparts = others.filter((l) => !moneySet.has(l.account_code));
      const cpAbs = counterparts.reduce((s, l) => s + Math.abs(sen(l)), 0) + unselectedMoney.reduce((s, l) => s + Math.abs(sen(l)), 0);
      const totalOther = otherMoneyAbs + cpAbs;
      const shareOf = (part: number) => (totalOther > 0 ? Math.round((magnitude * part) / totalOther) : 0);

      for (const om of [...otherMoney, ...unselectedMoney]) {
        const amt = shareOf(Math.abs(sen(om)));
        const label = side === 'R' ? `Transfer from ${om.account_code} · ${om.account_name ?? ''}` : `Transfer to ${om.account_code} · ${om.account_name ?? ''}`;
        add(side, `XFER:${om.account_code}`, om.account_code, label.trim(), leg.account_code, amt, meta);
      }

      /* A supplier payment read through what it settled (rule A). */
      const isSupplierPayment = base === 'PV' && counterparts.some((l) => apControls.has(l.account_code)) && !byParty;
      if (isSupplierPayment) {
        const split = splits.byPv.get(String(first.source_doc_no ?? '')) ?? [];
        const controlAbs = counterparts.filter((l) => apControls.has(l.account_code)).reduce((s, l) => s + Math.abs(sen(l)), 0);
        const controlShare = shareOf(controlAbs);
        const settled = split.reduce((s, x) => s + x.sen, 0);
        const scale = controlAbs > 0 ? controlShare / controlAbs : 0;
        let placed = 0;
        for (const x of split) {
          const amt = Math.round(x.sen * scale);
          placed += amt;
          add(side, x.code, x.code, x.name, leg.account_code, amt, { ...meta, party: counterparts.find((l) => apControls.has(l.account_code))?.party_name ?? null });
        }
        const advance = controlShare - placed;
        if (advance !== 0 || settled === 0) add(side, ADVANCE_KEY, null, 'Supplier advances (预付)', leg.account_code, advance, { ...meta, party: counterparts.find((l) => apControls.has(l.account_code))?.party_name ?? null });
        for (const l of counterparts.filter((l) => !apControls.has(l.account_code))) {
          add(side, l.account_code, l.account_code, String(l.account_name ?? l.account_code), leg.account_code, shareOf(Math.abs(sen(l))), { ...meta, party: l.party_name ?? null });
        }
        continue;
      }

      for (const l of counterparts) {
        const amt = shareOf(Math.abs(sen(l)));
        const onControl = controlCodes.has(l.account_code);
        /* The party keys on its CODE where the line carries one (owner 2026-09-08:
           one customer, one code — two customers can share a name), the name
           still being what the row reads. */
        const key = byParty && onControl ? `${l.account_code}:${l.party_code ?? l.party_name ?? '—'}` : l.account_code;
        const name = byParty && onControl ? `${l.party_name ?? '(no party)'} · ${l.account_name ?? l.account_code}` : String(l.account_name ?? l.account_code);
        add(side, key, l.account_code, name, leg.account_code, amt, { ...meta, party: l.party_name ?? null });
      }
    }
  }

  const sortRows = (m: Map<string, RpRow>): RpRow[] => [...m.values()].sort((a, b) => {
    const pa = a.key === ADVANCE_KEY ? 2 : a.key.startsWith('XFER:') ? 1 : 0;
    const pb = b.key === ADVANCE_KEY ? 2 : b.key.startsWith('XFER:') ? 1 : 0;
    return pa - pb || String(a.code ?? '').localeCompare(String(b.code ?? '')) || a.name.localeCompare(b.name);
  });
  const receiptRows = sortRows(receipts);
  const paymentRows = sortRows(payments);
  const sumCol = (rows: RpRow[], code: string) => rows.reduce((s, r) => s + (r.cells[code] ?? 0), 0);
  const totals = {
    receipts: Object.fromEntries(columns.map((col) => [col.code, sumCol(receiptRows, col.code)])) as Record<string, number>,
    payments: Object.fromEntries(columns.map((col) => [col.code, sumCol(paymentRows, col.code)])) as Record<string, number>,
    closing: {} as Record<string, number>,
    openingTotalSen: 0, receiptsTotalSen: 0, paymentsTotalSen: 0, closingTotalSen: 0,
  };
  for (const col of columns) {
    totals.closing[col.code] = (opening[col.code] ?? 0) + totals.receipts[col.code]! - totals.payments[col.code]!;
    totals.openingTotalSen += opening[col.code] ?? 0;
    totals.receiptsTotalSen += totals.receipts[col.code]!;
    totals.paymentsTotalSen += totals.payments[col.code]!;
    totals.closingTotalSen += totals.closing[col.code]!;
  }
  entries.sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.jeNo.localeCompare(b.jeNo));
  return c.json({ from, to, byParty, columns, opening, receipts: receiptRows, payments: paymentRows, totals, entries });
};
