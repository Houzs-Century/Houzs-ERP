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
// (posted, on neither side of a reversal pair — acc/reversal-pairs.ts) — the
// same as the P&L, the balance sheet and the
// trial balance beside it, so the four can never disagree. Nothing is
// stored; every request re-derives.
//
// Since docs/bugs/0912 the rows ALSO come back arranged on the report's
// LAYOUT (acc/report-layout.ts) — since 2026-09-18 the Cash Flow tree: one
// tree, every line with a direction, In/Out top categories with their own
// subtotal names, running subtotals, the unassigned at the foot — each row
// keeping its figure per money column, a category summing its rows per
// column, % of the side's total on every line. A transfer prints where the
// other money account sits on the tree; the supplier-advance row, which is
// no account, prints under Unassigned payments. The flat rows stay as they
// were: the screen's drill-down and the tests read them.
//
// BUILDER (2026-09-21, the Dashboard): buildReceiptsPayments is the report
// over an RpSources that says where the ledger lines and the layout come
// from — the route hands it the database, the Dashboard its preloaded
// window — so a Cash Flow card is the report's own figure.
// ----------------------------------------------------------------------------

import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import { resolveRoles, type RoleCodes } from '../../acc/rules';
import { countsInTheBooks } from '../../acc/reversal-pairs';
import { layOutCashFlow, type LaidLine, type LaidNode } from '../../acc/report-layout';
import { allowedIds, resolveLayout, type ResolvedLayout } from './accounting-report-layouts';

const requirePerm = (c: any): boolean => hasHouzsPerm(c, 'scm.payment_voucher.post');
const NO_PERM = { error: "You don't have permission to read the financial statements." };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type RpGlLine = {
  je_no: string; entry_date: string; source_type: string | null; source_doc_no: string | null;
  account_code: string; account_name: string | null; debit_sen: number; credit_sen: number;
  party_type: string | null; party_code?: string | null; party_name: string | null; notes: string | null;
  posted: boolean | null; reversed: boolean | null; reversed_by_je?: string | null;
};
type GlLine = RpGlLine;

export type RpRow = { key: string; code: string | null; name: string; cells: Record<string, number>; totalSen: number };
export type RpEntry = {
  jeNo: string; entryDate: string; sourceType: string | null; sourceDocNo: string | null;
  narration: string | null; party: string | null; side: 'R' | 'P'; rowKey: string; column: string; sen: number;
};
export type RpTotals = {
  receipts: Record<string, number>; payments: Record<string, number>; closing: Record<string, number>;
  openingTotalSen: number; receiptsTotalSen: number; paymentsTotalSen: number; closingTotalSen: number;
};
export type RpReport = {
  from: string; to: string; byParty: boolean;
  columns: Array<{ code: string; name: string }>;
  opening: Record<string, number>;
  receipts: RpRow[]; payments: RpRow[];
  layout?: { stored: boolean; tree: LaidNode[]; inSen: number; outSen: number };
  /** Empty when the company has no money account to report on. */
  totals: RpTotals | Record<string, never>;
  entries: RpEntry[];
};
export type RpQuery = { from: string; to: string; byParty: boolean; wanted: string[] };

const ADVANCE_KEY = 'ADV';
/* Neither side of a reversal pair is a receipt or a payment (docs/bugs/0923). */
const live = (l: GlLine) => countsInTheBooks(l);
const sen = (l: GlLine) => Number(l.debit_sen ?? 0) - Number(l.credit_sen ?? 0);

type Fail = { ok: false; reason: string };
/* The PostgREST client is untyped throughout the acc layer; borrow its type rather than write any. */
type Sb = Parameters<typeof resolveRoles>[0];
const failed = (e: unknown): string => String((e as { message?: string }).message ?? e);

/** Every posted line the company has on the MONEY accounts up to `to` (the
    opening is the ones before `from`), and every line inside [from, to]. */
async function loadLines(sb: any, companyId: number, moneyCodes: string[], from: string, to: string): Promise<{ ok: true; money: GlLine[]; period: GlLine[] } | Fail> {
  const money = await paginateAll<GlLine>((f, t) =>
    sb.from('v_gl_entries')
      .select('je_no, entry_date, source_type, source_doc_no, account_code, account_name, debit_sen, credit_sen, party_type, party_code, party_name, notes, posted, reversed, reversed_by_je')
      .eq('company_id', companyId).in('account_code', moneyCodes).lte('entry_date', to)
      .order('line_id').range(f, t));
  if (money.error) return { ok: false, reason: String((money.error as { message?: string }).message ?? money.error) };
  const period = await paginateAll<GlLine>((f, t) =>
    sb.from('v_gl_entries')
      .select('je_no, entry_date, source_type, source_doc_no, account_code, account_name, debit_sen, credit_sen, party_type, party_code, party_name, notes, posted, reversed, reversed_by_je')
      .eq('company_id', companyId).gte('entry_date', from).lte('entry_date', to)
      .order('line_id').range(f, t));
  if (period.error) return { ok: false, reason: String((period.error as { message?: string }).message ?? period.error) };
  return { ok: true, money: (money.data ?? []).filter(live), period: (period.data ?? []).filter(live) };
}

export type RpSplit = { code: string; name: string; sen: number };
type Split = RpSplit;

/** The supplier-payment vouchers among `period`'s journals: a PV (or its
    reversal) with a leg on a selected money account and a leg on a creditor
    control — the ones read through what they settled. One rule for its two
    readers: the report per period, the Dashboard once for its whole window. */
export function supplierVouchersOf(period: GlLine[], colSet: Set<string>, apControls: Set<string>): string[] {
  const byJe = new Map<string, GlLine[]>();
  for (const l of period) byJe.set(l.je_no, [...(byJe.get(l.je_no) ?? []), l]);
  const out: string[] = [];
  for (const lines of byJe.values()) {
    const first = lines[0]!;
    if (String(first.source_type ?? '').replace(/_REVERSAL$/, '') !== 'PV') continue;
    if (!lines.some((l) => colSet.has(l.account_code)) || !lines.some((l) => apControls.has(l.account_code))) continue;
    if (first.source_doc_no) out.push(first.source_doc_no);
  }
  return [...new Set(out)];
}

/** Where the report reads from. Every read the report needs is a source, so
    the Dashboard can answer all of them from one preloaded window
    (2026-09-22, the owner's "loading 很慢": the money accounts, the roles
    and the vouchers' purpose were read again for every period). */
export type RpSources = {
  lines: (moneyCodes: string[], from: string, to: string) => Promise<{ ok: true; money: GlLine[]; period: GlLine[] } | Fail>;
  layout: () => Promise<({ ok: true } & ResolvedLayout) | Fail>;
  /** The company's active money accounts, by code. */
  moneyAccounts: () => Promise<{ ok: true; accounts: Array<{ code: string; name: string }> } | Fail>;
  roles: () => Promise<RoleCodes>;
  /** What each named supplier-payment voucher settled (rule A), keyed by pv_number. */
  splits: (pvNumbers: string[], controlCodes: Set<string>) => Promise<{ ok: true; byPv: Map<string, RpSplit[]> } | Fail>;
};
/** The database, as the route reads it. */
export const rpDbSources = (sb: Sb, companyId: number, layoutIds: number[]): RpSources => ({
  lines: (codes, from, to) => loadLines(sb, companyId, codes, from, to),
  layout: () => resolveLayout(sb, layoutIds, 'rp'),
  moneyAccounts: async () => {
    const { data, error } = await sb.from('accounts')
      .select('account_code, account_name').eq('company_id', companyId).eq('acc_money', true).eq('is_active', true).order('account_code');
    if (error) return { ok: false, reason: failed(error) };
    const rows = (data ?? []) as Array<{ account_code: string; account_name: string | null }>;
    return { ok: true, accounts: rows.map((a) => ({ code: String(a.account_code), name: String(a.account_name ?? a.account_code) })) };
  },
  roles: () => resolveRoles(sb, companyId),
  splits: (pvNumbers, controlCodes) => supplierPurposeSplits(sb, companyId, pvNumbers, controlCodes),
});

/** What each supplier-payment voucher settled, read through the documents it
    settled — the purpose split (rule A). Keyed by pv_number. A voucher that
    settled nothing (a pure prepayment) yields [] and reads as an advance. */
async function supplierPurposeSplits(
  sb: any, companyId: number, pvNumbers: string[], controlCodes: Set<string>,
): Promise<{ ok: true; byPv: Map<string, Split[]> } | { ok: false; reason: string }> {
  const byPv = new Map<string, Split[]>();
  if (pvNumbers.length === 0) return { ok: true, byPv };
  /* Every in-list below is chunked to PostgREST's URL budget and every read paginated — the Dashboard names a whole window's vouchers at once. */
  const pvs = await chunkIn<{ id: string; pv_number: string }>(pvNumbers, (batch, f, t) =>
    sb.from('payment_vouchers').select('id, pv_number').eq('company_id', companyId).in('pv_number', batch).range(f, t));
  if (pvs.error) return { ok: false, reason: pvs.error.message };
  const numberById = new Map<string, string>();
  for (const p of pvs.data) numberById.set(String(p.id), String(p.pv_number));
  if (numberById.size === 0) return { ok: true, byPv };
  type Alloc = { pv_id: string; pi_id: string | null; ap_invoice_id: string | null; amount_sen: number; applied_sen: number | null; from_advance: boolean | null };
  const allocs = await chunkIn<Alloc>([...numberById.keys()], (batch, f, t) => sb.from('pv_allocations')
    .select('pv_id, pi_id, ap_invoice_id, amount_sen, applied_sen, from_advance')
    .eq('company_id', companyId).in('pv_id', batch).range(f, t));
  if (allocs.error) return { ok: false, reason: allocs.error.message };
  const rows = allocs.data.filter((a) => a.from_advance !== true);
  const piIds = [...new Set(rows.flatMap((a) => (a.pi_id ? [String(a.pi_id)] : [])))];
  const apiIds = [...new Set(rows.flatMap((a) => (a.ap_invoice_id ? [String(a.ap_invoice_id)] : [])))];

  /* A PI's purpose = its own journal's debit lines off the control (the
     periodic shape: one debit per product group). */
  const piSplit = new Map<string, Split[]>();
  if (piIds.length > 0) {
    const pis = await chunkIn<{ id: string; invoice_number: string }>(piIds, (batch, f, t) =>
      sb.from('purchase_invoices').select('id, invoice_number').eq('company_id', companyId).in('id', batch).range(f, t));
    if (pis.error) return { ok: false, reason: pis.error.message };
    const numbers = pis.data;
    const idByNumber = new Map(numbers.map((p) => [String(p.invoice_number), String(p.id)]));
    if (numbers.length > 0) {
      const jl = await chunkIn<GlLine>(numbers.map((p) => p.invoice_number), (batch, f, t) =>
        sb.from('v_gl_entries')
          .select('je_no, entry_date, source_type, source_doc_no, account_code, account_name, debit_sen, credit_sen, party_type, party_code, party_name, notes, posted, reversed, reversed_by_je')
          .eq('company_id', companyId).eq('source_type', 'PI').in('source_doc_no', batch)
          .order('line_id').range(f, t));
      if (jl.error) return { ok: false, reason: failed(jl.error) };
      for (const l of jl.data.filter(live)) {
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
    type ApLine = { invoice_id: string; debit_account_code: string; amount_sen: number };
    const lines = await chunkIn<ApLine>(apiIds, (batch, f, t) => sb.from('ap_invoice_lines')
      .select('invoice_id, debit_account_code, amount_sen').eq('company_id', companyId).in('invoice_id', batch).range(f, t));
    if (lines.error) return { ok: false, reason: lines.error.message };
    const codes = [...new Set(lines.data.map((l) => String(l.debit_account_code)))];
    const names = new Map<string, string>();
    if (codes.length > 0) {
      const accs = await chunkIn<{ account_code: string; account_name: string }>(codes, (batch, f, t) =>
        sb.from('accounts').select('account_code, account_name').eq('company_id', companyId).in('account_code', batch).range(f, t));
      if (accs.error) return { ok: false, reason: accs.error.message };
      for (const a of accs.data) names.set(String(a.account_code), String(a.account_name));
    }
    for (const l of lines.data) {
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

/** The Receipts & Payments report for [from, to] — the route's figures, and the Dashboard's. */
export async function buildReceiptsPayments(companyId: number, q: RpQuery, src: RpSources): Promise<{ ok: true; report: RpReport } | Fail> {
  const { from, to, byParty, wanted } = q;
  const money = await src.moneyAccounts();
  if (!money.ok) return { ok: false, reason: money.reason };
  const allMoney = money.accounts;
  const columns = wanted.length > 0 ? allMoney.filter((a) => wanted.includes(a.code)) : allMoney;
  const moneySet = new Set(allMoney.map((a) => a.code));
  const colSet = new Set(columns.map((a) => a.code));
  if (columns.length === 0) return { ok: true, report: { from, to, byParty, columns: [], opening: {}, receipts: [], payments: [], totals: {}, entries: [] } };

  const roles = await src.roles();
  const controlCodes = new Set([roles.AR, roles.AP, roles.AP_OTHER, roles.AR_OTHER].filter(Boolean) as string[]);
  const apControls = new Set([roles.AP, roles.AP_OTHER].filter(Boolean) as string[]);

  const loaded = await src.lines(columns.map((a) => a.code), from, to);
  if (!loaded.ok) return { ok: false, reason: loaded.reason };

  const opening: Record<string, number> = {};
  for (const col of columns) opening[col.code] = 0;
  for (const l of loaded.money) if (l.entry_date < from && colSet.has(l.account_code)) opening[l.account_code] = (opening[l.account_code] ?? 0) + sen(l);

  /* Group the period by journal; keep the ones with a selected money leg. */
  const byJe = new Map<string, GlLine[]>();
  for (const l of loaded.period) byJe.set(l.je_no, [...(byJe.get(l.je_no) ?? []), l]);
  const supplierPvs = supplierVouchersOf(loaded.period, colSet, apControls);
  const splits = byParty ? { ok: true as const, byPv: new Map<string, Split[]>() } : await src.splits(supplierPvs, controlCodes);
  if (!splits.ok) return { ok: false, reason: splits.reason };

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
  const totals: RpTotals = {
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

  const laid = await src.layout();
  if (!laid.ok) return { ok: false, reason: laid.reason };
  const tree = laid.layout.blocks.accounts ?? [];
  const cf = layOutCashFlow(tree, cashFlowLines(receiptRows), cashFlowLines(paymentRows), companyId);
  const layout = { stored: laid.stored, tree: cf.nodes, inSen: cf.inSen, outSen: cf.outSen };
  return { ok: true, report: { from, to, byParty, columns, opening, receipts: receiptRows, payments: paymentRows, layout, totals, entries } };
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
  const r = await buildReceiptsPayments(co.companyId, { from, to, byParty, wanted }, rpDbSources(sb, co.companyId, allowedIds(c)));
  if (!r.ok) return c.json({ error: 'load_failed', reason: r.reason }, 500);
  return c.json(r.report);
};

/** One side's rows as lines for the tree: a coded row sits where its code
    sits (a control account by party, or a transfer, as several rows under
    one code); a row with no account (supplier advances) is keyed by its own
    key, which no tree places, so it prints under Unassigned. */
export function cashFlowLines(rows: RpRow[]): LaidLine[] {
  return rows.map((r) => ({
    code: r.code ?? r.key, key: r.key, name: r.name,
    label: r.key === r.code ? `${r.code} · ${r.name}` : r.name,
    amountSen: r.totalSen, cells: { ...r.cells },
  }));
}
