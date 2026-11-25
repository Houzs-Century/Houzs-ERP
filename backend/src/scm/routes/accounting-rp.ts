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
//   · a bill from before the books (an opening paper, its own line the opening
//     clearing) → Finance's choice for it; else what it bought in AutoCount, by
//     product group, the same way as a PI; the rest → Finance's choice for its
//     supplier, else what that supplier's own bills in the ERP are for: the one
//     account they sit on, else the one Cash Flow category those accounts print
//     in (a line of its own there), else the creditor control (owner 2026-11-25);
//   · money the voucher paid beyond what it settled → the creditor control
//     itself (owner 2026-11-05), until the advance is knocked off against a
//     bill: then it reads as what it settled;
//   · paid out of a trade-finance account, or paid by a trade-finance drawdown
//     booked through another bank → its own line, TF-AP.
// The opening journal is Balance b/f, never a receipt or a payment.
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
// column, % of the side's total on every line. A transfer between two of the
// report's own columns is off the tree (it stays in the rows and the
// balances); one to an account left out prints where that account sits. TF-AP,
// which is no account, prints where the layout places it, else under
// Unassigned payments. The flat rows stay as they
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
import { cashFlowHomes, layOutCashFlow, type LaidLine, type LaidNode, type SplitTo } from '../../acc/report-layout';
import {
  goodsParts, loadGroupPurchaseAccounts, loadOpeningBillGoods, loadOpeningPlaces, loadSupplierBillAccounts, openingBillHome, placeOf,
  type GoodsParts, type OpeningPlace, type PlaceAccount, type StoredPlace,
} from '../../acc/opening-bill-places';
import { OPENING_CLEARING, OPENING_SOURCE } from '../../acc/opening-balance';
import { inBankShares, loadCardPayoutFacts, merchantMatched, paymentKey, type CardPayoutFacts } from '../../acc/card-in-bank';
import { loadOrderPaymentFacts, paymentKinds, type OrderPaymentFacts, type PaymentKind } from '../../acc/order-payment-kind';
import { loadAutoCountReceipts, type AutoCountReceipt } from '../../acc/autocount-receipts';
import { allowedIds, resolveLayout, type ResolvedLayout } from './accounting-report-layouts';
import { partyNameKey } from '../../acc/typed-text';

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

export type RpRow = {
  key: string; code: string | null; name: string; cells: Record<string, number>; totalSen: number;
  /** A sub-heading the row prints under, within its account's place on the tree (Deposit / Settlement). */
  group?: { id: string; label: string };
  /** The Settlement / Deposit column the row's money goes to whatever its category says
      (a customer's order payment by its kind, a refund to Deposit — owner 2026-11-09). */
  splitTo?: SplitTo;
  /** The Cash Flow category, by id, the row prints directly under — a row no account places
      (opening bills paid, read by their supplier's category). */
  category?: string;
};
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
  /** The card money the bank has not received (owner 2026-09-28). */
  card: RpCard;
  /** Customers' money AutoCount recorded after the books started, which no journal carries
      (owner 2026-11-08): named under the customer receipts, in no total. */
  autoCount: RpAutoCount;
};
export type RpAutoCount = { sen: number; count: number; entries: RpEntry[] };
const NO_AUTOCOUNT: RpAutoCount = { sen: 0, count: 0, entries: [] };
/** A swipe books Dr card-machine clearing / Cr the customer; the acquirer's payout
    Dr bank / Cr clearing. Since 2026-11-05 the swipes are Cash In in the Card column;
    these two figures stay for the API's readers: what was swiped in the period — every
    movement on the clearing accounts except the settlement module's own (fees,
    payouts, moves between the clearing accounts) — and what those accounts still
    hold at the period's end. `codes` names the accounts read. */
export type RpCard = { takingsSen: number; transitSen: number; codes: string[] };
export type RpQuery = { from: string; to: string; byParty: boolean; wanted: string[] };

const ADVANCE_KEY = 'ADV';
/* The card-machine clearing accounts as ONE money column (owner 2026-11-05): a swipe
   is Cash In on its own day, into this column; the acquirer's payout is a transfer
   from it to the bank (off the tree, as between any two of the report's columns), so
   it never counts twice; the fees it keeps are payments out of it. The bank columns
   still agree with the bank statements; this column's closing is the card money not
   yet in the bank. */
export const CARD_COLUMN = 'CARD';
const CARD_COLUMN_NAME = 'Card money not yet in the bank';
/* A swipe's receipt rows (owner 2026-11-06: 分多一个 condition): the share the acquirer
   has paid into a bank by the period's end, the rest by whether the merchant's report
   has matched the payment. Only the rows differ: Cash In and the Card column are the
   same whichever one a swipe reads. */
export const CARD_IN_BANK = 'CARD-BANK';
export const CARD_MATCHED = 'CARD-MATCHED';
export const CARD_NOT_MATCHED = 'CARD-UNMATCHED';
const CARD_IN_BANK_NAME = 'Card - in the bank';
const CARD_MATCHED_NAME = 'Card - merchant matched';
const CARD_NOT_MATCHED_NAME = 'Card - not matched yet';
/* The customers' money on the debtor control (owner 2026-11-05): an order's payments
   are Deposit or Settlement (acc/order-payment-kind.ts; "Balance" until 2026-11-09, his
   workbook's word is Settlement), each by how it came in; a refund to a customer is a
   negative receipt; what reaches the debtor control otherwise (a sales-invoice
   payment, a journal) is Other receipts. Not by party. */
const KIND_GROUP: Record<PaymentKind, { id: string; label: string }> = {
  DEP: { id: 'DEP', label: 'Deposit' },
  BAL: { id: 'BAL', label: 'Settlement' },
};
const CASH_PART = 'CASH';
const CASH_PART_NAME = 'Transfer / cash';
export const CUSTOMER_REFUND = 'REFUND';
export const CUSTOMER_OTHER = 'OTHER';
/* Where a debtor-control row prints among its siblings: Deposit's four, Balance's four, Refund, Other. */
const CUSTOMER_ORDER = (['DEP', 'BAL'] as const).flatMap((kind) => [CASH_PART, CARD_IN_BANK, CARD_MATCHED, CARD_NOT_MATCHED].map((part) => `${kind}:${part}`)).concat(CUSTOMER_REFUND, CUSTOMER_OTHER);
const customerRank = (r: RpRow): number => {
  const i = r.code === null ? -1 : CUSTOMER_ORDER.indexOf(r.key.slice(r.code.length + 1));
  return i < 0 ? -1 : i;
};
/* The settlement module's own journals (a fee, a payout, a move between the clearing accounts) — never a swipe. */
const settlementOwn = (l: { source_type: string | null }): boolean => String(l.source_type ?? '').replace(/_REVERSAL$/, '').startsWith('SETTLE');
/* What a supplier is paid out of a trade-finance account (owner 2026-11-05: its own line
   under Cost of funds, apart from Accounts payable). No chart account: the layout
   places this code like any account, under Unassigned payments until it does. */
export const TRADE_FINANCE_AP = 'TF-AP';
const TRADE_FINANCE_AP_NAME = 'Trade finance - Accounts payable & creditors';
/* Opening bills paid whose supplier's own bills spread over several accounts of ONE Cash Flow
   category (owner 2026-11-25): a line of that category's own, keyed by it, with no account. */
const OPENING_BILLS = 'OPENING-BILLS';
const OPENING_BILLS_NAME = 'Opening bills (AutoCount)';
/* A money account is a trade-finance one by its name (CASH AT BANK - MAYBANK (TRADE FINANCE)). */
const isTradeFinanceAccount = (name: string | null | undefined): boolean => /TRADE\s*FINANCE/i.test(String(name ?? ''));
/* Owner 2026-11-25 (不是应该和下面 drawdown 一样吗): a drawdown is the bank paying a supplier, so the
   same money is Drawdown in and TF-AP out, whichever bank Finance books it through. The facility
   is a liability named TRADE FINANCE that is no money account (460-0009). */
const DRAWDOWN_PAIR_DAYS = 7;
const dayNo = (d: string): number => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
const onFacility = (l: GlLine, moneySet: Set<string>): boolean => !moneySet.has(l.account_code) && isTradeFinanceAccount(l.account_name);

/** The supplier-payment vouchers a drawdown paid through a bank that is not a trade-finance one:
    a drawdown line (that bank debited in a journal crediting the facility) pairs with the voucher
    out of the same bank that puts the same amount on the creditor control, the nearest within
    DRAWDOWN_PAIR_DAYS days either way; each line and each voucher once. */
export function drawdownPaidVouchers(journals: Iterable<[string, GlLine[]]>, moneySet: Set<string>, tradeFinance: Set<string>, apControls: Set<string>): Set<string> {
  const draws: Array<{ day: number; account: string; sen: number }> = [];
  const vouchers: Array<{ jeNo: string; day: number; account: string; sen: number }> = [];
  for (const [jeNo, lines] of journals) {
    if (lines.some(isOpeningJournal)) continue; // the books' starting balances, not a drawdown
    if (lines.some((l) => onFacility(l, moneySet) && sen(l) < 0)) {
      for (const l of lines) {
        if (moneySet.has(l.account_code) && !tradeFinance.has(l.account_code) && sen(l) > 0) draws.push({ day: dayNo(l.entry_date), account: l.account_code, sen: sen(l) });
      }
      continue;
    }
    if (String(lines[0]?.source_type ?? '').replace(/_REVERSAL$/, '') !== 'PV') continue;
    const banks = [...new Set(lines.filter((l) => moneySet.has(l.account_code)).map((l) => l.account_code))];
    const owed = lines.filter((l) => apControls.has(l.account_code)).reduce((s, l) => s + sen(l), 0);
    if (banks.length === 1 && !tradeFinance.has(banks[0]!) && owed > 0) vouchers.push({ jeNo, day: dayNo(lines[0]!.entry_date), account: banks[0]!, sen: owed });
  }
  const paid = new Set<string>();
  for (const d of draws.sort((a, b) => a.day - b.day)) {
    let best: { jeNo: string; gap: number } | null = null;
    for (const v of vouchers) {
      if (paid.has(v.jeNo) || v.account !== d.account || v.sen !== d.sen) continue;
      const gap = Math.abs(v.day - d.day);
      if (gap <= DRAWDOWN_PAIR_DAYS && (best === null || gap < best.gap)) best = { jeNo: v.jeNo, gap };
    }
    if (best) paid.add(best.jeNo);
  }
  return paid;
}

/** A journal on the facility whose lines pair off into equal opposite amounts (a drawdown into one
    bank with a bank charge taken from another) is read pair by pair, so the charge does not shave
    the drawdown; any other journal is read whole. */
function facilityParts(lines: GlLine[], moneySet: Set<string>): GlLine[][] {
  if (lines.length < 4 || !lines.some((l) => onFacility(l, moneySet))) return [lines];
  const left = [...lines].sort((a, b) => Number(moneySet.has(b.account_code)) - Number(moneySet.has(a.account_code)));
  const parts: GlLine[][] = [];
  while (left.length > 0) {
    const a = left.shift()!;
    const i = left.findIndex((b) => sen(b) !== 0 && sen(b) === -sen(a));
    if (i < 0) return [lines];
    parts.push([a, left.splice(i, 1)[0]!]);
  }
  return parts;
}
/* The opening journal (acc/opening-balance) is the books' starting position, not a
   receipt or a payment: its money legs are Balance b/f whatever their date. */
const isOpeningJournal = (l: GlLine): boolean => String(l.source_type ?? '').replace(/_REVERSAL$/, '') === OPENING_SOURCE;
/* Neither side of a reversal pair is a receipt or a payment (docs/bugs/0923). */
const live = (l: GlLine) => countsInTheBooks(l);
const sen = (l: GlLine) => Number(l.debit_sen ?? 0) - Number(l.credit_sen ?? 0);

type Fail = { ok: false; reason: string };
/* The PostgREST client is untyped throughout the acc layer; borrow its type rather than write any. */
type Sb = Parameters<typeof resolveRoles>[0];
const failed = (e: unknown): string => String((e as { message?: string }).message ?? e);

/** Every posted line the company has on the MONEY accounts up to `to` (the
    opening is the ones before `from`), and every line inside [from, to]. */
async function loadLines(sb: any, companyId: number, moneyCodes: string[], clearingCodes: string[], from: string, to: string): Promise<{ ok: true; money: GlLine[]; period: GlLine[]; clearing: GlLine[] } | Fail> {
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
  /* Every line on the card-machine clearing accounts up to `to` — the memo's whole history. */
  const clearing = clearingCodes.length === 0 ? { data: [] as GlLine[], error: null } : await paginateAll<GlLine>((f, t) =>
    sb.from('v_gl_entries')
      .select('je_no, entry_date, source_type, source_doc_no, account_code, account_name, debit_sen, credit_sen, party_type, party_code, party_name, notes, posted, reversed, reversed_by_je')
      .eq('company_id', companyId).in('account_code', clearingCodes).lte('entry_date', to)
      .order('line_id').range(f, t));
  if (clearing.error) return { ok: false, reason: failed(clearing.error) };
  return { ok: true, money: (money.data ?? []).filter(live), period: (period.data ?? []).filter(live), clearing: (clearing.data ?? []).filter(live) };
}

/** The acquirers' own transit accounts (scm.acc_acquirers), active or retired — a retired acquirer's account can still hold money. */
async function loadAcquirerTransits(sb: Sb, companyId: number): Promise<{ ok: true; codes: string[] } | Fail> {
  const { data, error } = await sb.from('acc_acquirers').select('transit_account_code').eq('company_id', companyId);
  if (error) return { ok: false, reason: failed(error) };
  const codes = new Set<string>();
  for (const row of (data ?? []) as Array<{ transit_account_code: string | null }>) {
    const code = String(row.transit_account_code ?? '').trim();
    if (code) codes.add(code);
  }
  return { ok: true, codes: [...codes].sort() };
}

/** A share of an opening bill (owner 2026-11-25: 这个 other creditor 是还 booth setup 的，它应该在
    cashflow 的 exhibition & roadshow): Finance's choice for the bill or its supplier, and the
    accounts the supplier's own live bills in the ERP sit on (acc/opening-bill-places.ts). */
export type RpOpeningShare = { set: OpeningPlace | null; accounts: PlaceAccount[] };
export type RpSplit = { code: string; name: string; sen: number; opening?: RpOpeningShare };
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
  lines: (moneyCodes: string[], clearingCodes: string[], from: string, to: string) => Promise<{ ok: true; money: GlLine[]; period: GlLine[]; clearing: GlLine[] } | Fail>;
  /** The acquirers' transit accounts — with the chart's EDC transit role, the card-machine clearing accounts (the Card column). */
  acquirerTransits: () => Promise<{ ok: true; codes: string[] } | Fail>;
  layout: () => Promise<({ ok: true } & ResolvedLayout) | Fail>;
  /** The orders behind the named customer-payment rows (SOPAY source_doc_no), with all of each order's payments. */
  orderPayments: (paymentIds: string[]) => Promise<{ ok: true; facts: OrderPaymentFacts } | Fail>;
  /** The card settlement history: which statement claimed each card payment and what the bank has received on it. */
  cardPayouts: () => Promise<{ ok: true; facts: CardPayoutFacts } | Fail>;
  /** The company's active money accounts, by code. */
  moneyAccounts: () => Promise<{ ok: true; accounts: Array<{ code: string; name: string }> } | Fail>;
  roles: () => Promise<RoleCodes>;
  /** What each named supplier-payment voucher settled (rule A), keyed by pv_number. */
  splits: (pvNumbers: string[], controlCodes: Set<string>) => Promise<{ ok: true; byPv: Map<string, RpSplit[]> } | Fail>;
  /** Customers' money AutoCount recorded in the period after the books started; a source without it names none. */
  autoCountReceipts?: (from: string, to: string) => Promise<{ ok: true; payments: AutoCountReceipt[] } | Fail>;
};
/** The database, as the route reads it. */
export const rpDbSources = (sb: Sb, companyId: number, layoutIds: number[]): RpSources => ({
  lines: (codes, clearing, from, to) => loadLines(sb, companyId, codes, clearing, from, to),
  acquirerTransits: () => loadAcquirerTransits(sb, companyId),
  layout: () => resolveLayout(sb, layoutIds, 'rp'),
  cardPayouts: () => loadCardPayoutFacts(sb, companyId),
  orderPayments: (ids) => loadOrderPaymentFacts(sb, companyId, ids),
  moneyAccounts: async () => {
    const { data, error } = await sb.from('accounts')
      .select('account_code, account_name').eq('company_id', companyId).eq('acc_money', true).eq('is_active', true).order('account_code');
    if (error) return { ok: false, reason: failed(error) };
    const rows = (data ?? []) as Array<{ account_code: string; account_name: string | null }>;
    return { ok: true, accounts: rows.map((a) => ({ code: String(a.account_code), name: String(a.account_name ?? a.account_code) })) };
  },
  roles: () => resolveRoles(sb, companyId),
  splits: (pvNumbers, controlCodes) => supplierPurposeSplits(sb, companyId, pvNumbers, controlCodes),
  autoCountReceipts: (from, to) => loadAutoCountReceipts(sb, companyId, from, to),
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
  /* An advance knocked off against bills later (from_advance) is written on the voucher that
     paid it: what it settled is what that voucher's money was for (owner 2026-11-25: booth
     set-up paid ahead, knocked off against its opening bills a month on). */
  const rows = allocs.data;
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
  /* An AP invoice's purpose = its own lines. An opening bill's own line is the opening
     clearing, which says nothing of what was bought: Finance's choice for the bill comes
     first; else what the bill bought in AutoCount, by product group, splits it the way a
     purchase invoice splits, the rest of it carrying on; that share carries Finance's choice
     for its supplier and the accounts the supplier's own live bills in the ERP sit on (owner
     2026-11-25, acc/opening-bill-places.ts), which the report places. */
  const apiSplit = new Map<string, Split[]>();
  const openingShares = new Map<string, RpOpeningShare>();
  const goodsSplit = new Map<string, Split[]>();
  if (apiIds.length > 0) {
    type ApHead = { id: string; supplier_id: string | null; opening: boolean | null };
    const heads = await chunkIn<ApHead>(apiIds, (batch, f, t) => sb.from('ap_invoices')
      .select('id, supplier_id, opening').eq('company_id', companyId).in('id', batch).range(f, t));
    if (heads.error) return { ok: false, reason: heads.error.message };
    const supplierOfOpening = new Map<string, string>();
    for (const h of heads.data) if (h.opening === true && h.supplier_id) supplierOfOpening.set(String(h.id), String(h.supplier_id));
    const noOpening = supplierOfOpening.size === 0;
    const [own, places, goods, groups] = await Promise.all([
      loadSupplierBillAccounts(sb, companyId, [...supplierOfOpening.values()]),
      noOpening ? Promise.resolve({ ok: true as const, suppliers: new Map(), bills: new Map() }) : loadOpeningPlaces(sb, companyId),
      noOpening ? Promise.resolve({ ok: true as const, byBill: new Map() }) : loadOpeningBillGoods(sb, companyId, [...supplierOfOpening.keys()]),
      noOpening ? Promise.resolve({ ok: true as const, accountOf: new Map<string, string>() }) : loadGroupPurchaseAccounts(sb, companyId),
    ]);
    if (!own.ok) return own;
    if (!places.ok) return places;
    if (!goods.ok) return goods;
    if (!groups.ok) return groups;
    type ApLine = { invoice_id: string; debit_account_code: string; amount_sen: number };
    const lines = await chunkIn<ApLine>(apiIds, (batch, f, t) => sb.from('ap_invoice_lines')
      .select('invoice_id, debit_account_code, amount_sen').eq('company_id', companyId).in('invoice_id', batch).range(f, t));
    if (lines.error) return { ok: false, reason: lines.error.message };
    /* The bill's own choice, else its supplier's — for a bill read by its goods, the supplier's
       places only the rest of it. */
    const chosen = new Map<string, StoredPlace>();
    const goodsOf = new Map<string, GoodsParts>();
    for (const [id, supplier] of supplierOfOpening) {
      const billOwn = places.bills.get(id);
      const parts = billOwn ? null : goodsParts(goods.byBill.get(id), groups.accountOf);
      if (parts) goodsOf.set(id, parts);
      const p = billOwn ?? places.suppliers.get(supplier);
      if (p) chosen.set(id, p);
    }
    const codes = [...new Set([
      ...lines.data.map((l) => String(l.debit_account_code)),
      ...[...supplierOfOpening.values()].flatMap((s) => own.bySupplier.get(s) ?? []),
      ...[...chosen.values()].flatMap((p) => (p.account ? [p.account] : [])),
      ...[...goodsOf.values()].flatMap((g) => g.parts.map((p) => p.code)),
    ])];
    const names = new Map<string, string>();
    if (codes.length > 0) {
      const accs = await chunkIn<{ account_code: string; account_name: string }>(codes, (batch, f, t) =>
        sb.from('accounts').select('account_code, account_name').eq('company_id', companyId).in('account_code', batch).range(f, t));
      if (accs.error) return { ok: false, reason: accs.error.message };
      for (const a of accs.data) names.set(String(a.account_code), String(a.account_name));
    }
    const nameOf = (code: string): string => names.get(code) ?? code;
    for (const l of lines.data) {
      const list = apiSplit.get(String(l.invoice_id)) ?? [];
      list.push({ code: String(l.debit_account_code), name: nameOf(String(l.debit_account_code)), sen: Number(l.amount_sen ?? 0) });
      apiSplit.set(String(l.invoice_id), list);
    }
    for (const [id, supplier] of supplierOfOpening) {
      const p = chosen.get(id);
      const share: RpOpeningShare = {
        set: p ? placeOf(p, nameOf) : null,
        accounts: (own.bySupplier.get(supplier) ?? []).map((code) => ({ code, name: nameOf(code) })),
      };
      const g = goodsOf.get(id);
      if (g) {
        goodsSplit.set(id, [
          ...g.parts.map((x) => ({ code: x.code, name: nameOf(x.code), sen: x.sen })),
          ...(g.restSen > 0 ? [{ code: OPENING_CLEARING, name: OPENING_CLEARING, sen: g.restSen, opening: share }] : []),
        ]);
      } else openingShares.set(id, share);
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
      return { ...p, sen: share };
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
    const list = byPv.get(pv) ?? [];
    const billId = !a.pi_id && a.ap_invoice_id ? String(a.ap_invoice_id) : null;
    const goods = billId ? goodsSplit.get(billId) : undefined;
    const opening = billId ? openingShares.get(billId) : undefined;
    if (goods) {
      list.push(...proportion(settled, goods));
    } else if (opening) {
      list.push({ code: OPENING_CLEARING, name: OPENING_CLEARING, sen: settled, opening });
    } else {
      const parts = a.pi_id ? piSplit.get(String(a.pi_id)) : a.ap_invoice_id ? apiSplit.get(String(a.ap_invoice_id)) : undefined;
      list.push(...proportion(settled, parts ?? []));
    }
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
  const bankColumns = wanted.length > 0 ? allMoney.filter((a) => wanted.includes(a.code)) : allMoney;
  const moneySet = new Set(allMoney.map((a) => a.code));

  const roles = await src.roles();
  const controlCodes = new Set([roles.AR, roles.AP, roles.AP_OTHER, roles.AR_OTHER].filter(Boolean) as string[]);
  const apControls = new Set([roles.AP, roles.AP_OTHER].filter(Boolean) as string[]);

  const acquirers = await src.acquirerTransits();
  if (!acquirers.ok) return { ok: false, reason: acquirers.reason };
  const clearingCodes = [...new Set([String(roles.TRANSIT_EDC).trim(), ...acquirers.codes].filter(Boolean))].sort();
  const clearingSet = new Set(clearingCodes);
  if (bankColumns.length === 0) return { ok: true, report: { from, to, byParty, columns: [], opening: {}, receipts: [], payments: [], totals: {}, entries: [], card: { takingsSen: 0, transitSen: 0, codes: [] }, autoCount: NO_AUTOCOUNT } };
  const loaded = await src.lines(bankColumns.map((a) => a.code), clearingCodes, from, to);
  if (!loaded.ok) return { ok: false, reason: loaded.reason };
  /* The Card column shows once a clearing account has ever moved. */
  const cardOn = loaded.clearing.length > 0 && (wanted.length === 0 || wanted.includes(CARD_COLUMN));
  const columns = cardOn ? [...bankColumns, { code: CARD_COLUMN, name: CARD_COLUMN_NAME }] : bankColumns;
  const colSet = new Set(columns.map((a) => a.code));
  const payouts = cardOn ? await src.cardPayouts() : { ok: true as const, facts: { matches: [], rows: [], batches: [], receipts: [] } };
  if (!payouts.ok) return { ok: false, reason: payouts.reason };
  const inBank = inBankShares(payouts.facts, to);
  const matched = merchantMatched(payouts.facts);

  const opening: Record<string, number> = {};
  for (const col of columns) opening[col.code] = 0;
  for (const l of loaded.money) if ((l.entry_date < from || isOpeningJournal(l)) && colSet.has(l.account_code)) opening[l.account_code] = (opening[l.account_code] ?? 0) + sen(l);
  if (cardOn) for (const l of loaded.clearing) if (l.entry_date < from || isOpeningJournal(l)) opening[CARD_COLUMN] = (opening[CARD_COLUMN] ?? 0) + sen(l);
  const tradeFinance = new Set(allMoney.filter((a) => isTradeFinanceAccount(a.name)).map((a) => a.code));

  /* Group the period by journal; keep the ones with a selected money leg. With the
     Card column on, a journal's clearing-account lines are ONE leg of it (a move
     between two clearing accounts nets to nothing). */
  const byJe = new Map<string, GlLine[]>();
  for (const l of loaded.period) byJe.set(l.je_no, [...(byJe.get(l.je_no) ?? []), l]);
  if (cardOn) {
    for (const [jeNo, lines] of byJe) {
      const onCard = lines.filter((l) => clearingSet.has(l.account_code));
      if (onCard.length === 0) continue;
      const net = onCard.reduce((s, l) => s + sen(l), 0);
      const rest = lines.filter((l) => !clearingSet.has(l.account_code));
      byJe.set(jeNo, net === 0 ? rest : [...rest, { ...onCard[0]!, account_code: CARD_COLUMN, account_name: CARD_COLUMN_NAME, debit_sen: Math.max(net, 0), credit_sen: Math.max(-net, 0) }]);
    }
  }
  const drawdownPaid = drawdownPaidVouchers(byJe, moneySet, tradeFinance, apControls);
  const readable: Array<[string, GlLine[]]> = [...byJe].flatMap(([jeNo, lines]) => facilityParts(lines, moneySet).map((part): [string, GlLine[]] => [jeNo, part]));
  const supplierPvs = supplierVouchersOf(loaded.period, colSet, apControls);
  const splits = byParty ? { ok: true as const, byPv: new Map<string, Split[]>() } : await src.splits(supplierPvs, controlCodes);
  const customerPayments = [...new Set([...byJe.values()].flatMap((ls) => {
    const f = ls[0];
    return f && String(f.source_type ?? '').replace(/_REVERSAL$/, '') === 'SOPAY' && f.source_doc_no && ls.some((l) => colSet.has(l.account_code)) ? [f.source_doc_no] : [];
  }))];
  const orderFacts = byParty || !roles.AR ? { ok: true as const, facts: { orders: [], payments: [] } } : await src.orderPayments(customerPayments);
  if (!orderFacts.ok) return { ok: false, reason: orderFacts.reason };
  const kinds = paymentKinds(orderFacts.facts);
  if (!splits.ok) return { ok: false, reason: splits.reason };
  /* The tree, read before the rows: an opening bill's payment reads by where its supplier's accounts sit on it. */
  const laid = await src.layout();
  if (!laid.ok) return { ok: false, reason: laid.reason };
  const tree = laid.layout.blocks.accounts ?? [];
  const homes = cashFlowHomes(tree, companyId);

  const receipts = new Map<string, RpRow>();
  const payments = new Map<string, RpRow>();
  const entries: RpEntry[] = [];
  const add = (side: 'R' | 'P', key: string, code: string | null, name: string, column: string, amount: number, e: { jeNo: string; entryDate: string; sourceType: string | null; sourceDocNo: string | null; narration: string | null; party: string | null }, group?: RpRow['group'], splitTo?: SplitTo, category?: string) => {
    if (amount === 0) return;
    const book = side === 'R' ? receipts : payments;
    const row: RpRow = book.get(key) ?? { key, code, name, cells: {}, totalSen: 0, ...(group ? { group } : {}), ...(splitTo ? { splitTo } : {}), ...(category ? { category } : {}) };
    row.cells[column] = (row.cells[column] ?? 0) + amount;
    row.totalSen += amount;
    book.set(key, row);
    entries.push({ ...e, side, rowKey: key, column, sen: amount });
  };

  /* The rows a leg was read as must move its column by exactly the leg. A gap no
     bigger than one sen per row is the rounding of the shares: it goes onto the
     leg's largest row. A bigger gap is not rounding and is left to show. */
  const settleRounding = (from: number, legSen: number, column: string): void => {
    const mine = entries.slice(from);
    if (mine.length === 0) return;
    const gap = legSen - mine.reduce((s, e) => s + (e.side === 'R' ? e.sen : -e.sen), 0);
    if (gap === 0 || Math.abs(gap) > mine.length) return;
    const e = mine.reduce((a, b) => (Math.abs(b.sen) > Math.abs(a.sen) ? b : a));
    const d = e.side === 'R' ? gap : -gap;
    e.sen += d;
    const row = (e.side === 'R' ? receipts : payments).get(e.rowKey);
    if (!row) return;
    row.cells[column] = (row.cells[column] ?? 0) + d;
    row.totalSen += d;
  };

  for (const [jeNo, lines] of readable) {
    const moneyLegs = lines.filter((l) => colSet.has(l.account_code));
    if (moneyLegs.length === 0) continue;
    if (lines.some(isOpeningJournal)) continue; // counted in Balance b/f above
    const first = lines[0]!;
    const meta = { jeNo, entryDate: first.entry_date, sourceType: first.source_type, sourceDocNo: first.source_doc_no, narration: first.notes, party: null as string | null };
    const others = lines.filter((l) => !colSet.has(l.account_code));
    const base = String(first.source_type ?? '').replace(/_REVERSAL$/, '');

    /* One money leg read as its rows. Each row's share is rounded on its own, so the
       shares can miss the leg by a sen; settleRounding puts that sen back (owner
       2026-11-05: 310-0060 read 5,708.18 against the ledger's 5,708.17). */
    const readLeg = (leg: GlLine): void => {
      const legSen = sen(leg);              // > 0 money in, < 0 money out
      if (legSen === 0) return;
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
        const control = counterparts.find((l) => apControls.has(l.account_code))!;
        const supplierMeta = { ...meta, party: control.party_name ?? null };
        /* Owner 2026-11-05: what a trade-finance account pays a supplier is its own line, as is
           (2026-11-25) what a drawdown paid through another bank; money paid ahead of a bill
           reads as the creditor control. */
        const toControl = (amt: number) => add(side, control.account_code, control.account_code, String(control.account_name ?? control.account_code), leg.account_code, amt, supplierMeta);
        /* Owner 2026-11-25: an opening bill reads as Finance set it for the bill or its supplier,
           else by the supplier's own bills in the ERP, else the creditor control. */
        const toOpeningHome = (o: RpOpeningShare, amt: number): void => {
          const home = o.set ?? openingBillHome(o.accounts, side === 'R' ? homes.in : homes.out);
          if (home === null) toControl(amt);
          else if (home.kind === 'account') add(side, home.code, home.code, home.name, leg.account_code, amt, supplierMeta);
          else add(side, `${OPENING_BILLS}:${home.id}`, null, OPENING_BILLS_NAME, leg.account_code, amt, supplierMeta, undefined, undefined, home.id);
        };
        const tf = tradeFinance.has(leg.account_code) || drawdownPaid.has(jeNo);
        for (const x of split) {
          const amt = Math.round(x.sen * scale);
          placed += amt;
          if (tf) add(side, TRADE_FINANCE_AP, TRADE_FINANCE_AP, TRADE_FINANCE_AP_NAME, leg.account_code, amt, supplierMeta);
          else if (x.opening) toOpeningHome(x.opening, amt);
          else if (x.code === OPENING_CLEARING) toControl(amt);
          else add(side, x.code, x.code, x.name, leg.account_code, amt, supplierMeta);
        }
        const advance = controlShare - placed;
        if (advance !== 0 || settled === 0) {
          if (tf) add(side, TRADE_FINANCE_AP, TRADE_FINANCE_AP, TRADE_FINANCE_AP_NAME, leg.account_code, advance, supplierMeta);
          else toControl(advance);
        }
        for (const l of counterparts.filter((l) => !apControls.has(l.account_code))) {
          add(side, l.account_code, l.account_code, String(l.account_name ?? l.account_code), leg.account_code, shareOf(Math.abs(sen(l))), { ...meta, party: l.party_name ?? null });
        }
        return;
      }

      /* A swipe into the Card column: the share its statement has paid into a bank by
         the period's end (a payment no statement claims: none), and the rest, by whether
         its report has matched it. */
      const swipe = leg.account_code === CARD_COLUMN && !settlementOwn(first);
      const payment = swipe && first.source_doc_no ? paymentKey(base, first.source_doc_no) : null;
      const bankShare = payment ? (inBank.get(payment) ?? 0) : 0;
      const rest = payment && matched.has(payment) ? { part: CARD_MATCHED, name: CARD_MATCHED_NAME } : { part: CARD_NOT_MATCHED, name: CARD_NOT_MATCHED_NAME };
      for (const l of counterparts) {
        const amt = shareOf(Math.abs(sen(l)));
        const onControl = controlCodes.has(l.account_code);
        /* The party keys on its CODE where the line carries one (owner 2026-09-08:
           one customer, one code — two customers can share a name), the name
           still being what the row reads. */
        /* A name keys the row case-blind: Finance's words are upper case from 2026-11-09, older lines are not. */
        const key = byParty && onControl ? `${l.account_code}:${l.party_code ?? partyNameKey(l.party_name) ?? '—'}` : l.account_code;
        const name = byParty && onControl ? `${l.party_name ?? '(no party)'} · ${l.account_name ?? l.account_code}` : String(l.account_name ?? l.account_code);
        const lineMeta = { ...meta, party: l.party_name ?? null };
        if (!byParty && l.account_code === roles.AR) {
          /* A customer's money, always a receipt: money back out of the bank is a negative one. */
          const signed = side === 'R' ? amt : -amt;
          const kind = base === 'SOPAY' && first.source_doc_no ? kinds.get(first.source_doc_no) : undefined;
          const put = (part: string, partName: string, value: number, group?: RpRow['group'], to?: SplitTo) =>
            add('R', `${l.account_code}:${part}`, l.account_code, partName, leg.account_code, value, lineMeta, group, to);
          if (!kind) {
            /* A refund is a deposit given back (his workbook: Sales returns/refunds under Deposit). */
            if (side === 'P') put(CUSTOMER_REFUND, '(-) Refund', signed, undefined, 'deposit');
            else put(CUSTOMER_OTHER, 'Other receipts (not order payments)', signed);
            continue;
          }
          const g = KIND_GROUP[kind];
          const to: SplitTo = kind === 'DEP' ? 'deposit' : 'settlement';
          if (!swipe) { put(`${kind}:${CASH_PART}`, CASH_PART_NAME, signed, g, to); continue; }
          const banked = Math.round(signed * bankShare);
          put(`${kind}:${CARD_IN_BANK}`, CARD_IN_BANK_NAME, banked, g, to);
          put(`${kind}:${rest.part}`, rest.name, signed - banked, g, to);
          continue;
        }
        if (!swipe) { add(side, key, l.account_code, name, leg.account_code, amt, lineMeta); continue; }
        const banked = Math.round(amt * bankShare);
        const cardName = (part: string) => (byParty && onControl ? `${name} · ${part}` : part);
        add(side, `${key}:${CARD_IN_BANK}`, l.account_code, cardName(CARD_IN_BANK_NAME), leg.account_code, banked, lineMeta);
        add(side, `${key}:${rest.part}`, l.account_code, cardName(rest.name), leg.account_code, amt - banked, lineMeta);
      }
    };
    for (const leg of moneyLegs) {
      const from = entries.length;
      readLeg(leg);
      settleRounding(from, sen(leg), leg.account_code);
    }
  }

  const sortRows = (m: Map<string, RpRow>): RpRow[] => [...m.values()].sort((a, b) => {
    const pa = a.key === ADVANCE_KEY ? 2 : a.key.startsWith('XFER:') ? 1 : 0;
    const pb = b.key === ADVANCE_KEY ? 2 : b.key.startsWith('XFER:') ? 1 : 0;
    return pa - pb || String(a.code ?? '').localeCompare(String(b.code ?? '')) || customerRank(a) - customerRank(b) || a.name.localeCompare(b.name);
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

  /* The card money the bank has not received (RpCard): the period's swipes are the
     clearing accounts' movements that are not the settlement module's own — a
     SETTLE fee, a SETTLEBANK payout, a SETTLEMOVE between the clearing accounts
     — less their reversals; the transit is the accounts' balance at `to`. */
  const card: RpCard = {
    takingsSen: loaded.clearing.filter((l) => l.entry_date >= from && !settlementOwn(l)).reduce((s, l) => s + sen(l), 0),
    transitSen: loaded.clearing.reduce((s, l) => s + sen(l), 0),
    codes: clearingCodes,
  };

  /* A transfer between two of the report's own columns is neither cash in nor out
     (owner 2026-11-05: 完全不显示): off the tree, kept in the rows and the per-column
     balances. A transfer to an account left out of the columns still shows. */
  const ownTransfer = (r: RpRow) => r.key.startsWith('XFER:') && r.code !== null && colSet.has(r.code);
  const cf = layOutCashFlow(tree, cashFlowLines(receiptRows.filter((r) => !ownTransfer(r))), cashFlowLines(paymentRows.filter((r) => !ownTransfer(r))), companyId);
  const layout = { stored: laid.stored, tree: cf.nodes, inSen: cf.inSen, outSen: cf.outSen };
  const ac = src.autoCountReceipts ? await src.autoCountReceipts(from, to) : { ok: true as const, payments: [] };
  if (!ac.ok) return { ok: false, reason: ac.reason };
  const autoCount: RpAutoCount = ac.payments.length === 0 ? NO_AUTOCOUNT : {
    sen: ac.payments.reduce((s, p) => s + p.amountSen, 0),
    count: ac.payments.length,
    entries: ac.payments.map((p) => ({
      jeNo: '', entryDate: p.paidOn, sourceType: 'AUTOCOUNT', sourceDocNo: p.docNo, narration: p.note,
      party: p.party, side: 'R' as const, rowKey: 'AUTOCOUNT', column: 'AUTOCOUNT', sen: p.amountSen,
    })),
  };
  return { ok: true, report: { from, to, byParty, columns, opening, receipts: receiptRows, payments: paymentRows, layout, totals, entries, card, autoCount } };
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
    ...(r.group ? { group: r.group } : {}),
    ...(r.splitTo ? { splitTo: r.splitTo } : {}),
    ...(r.category ? { category: r.category } : {}),
  }));
}
