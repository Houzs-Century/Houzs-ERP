// ----------------------------------------------------------------------------
// acc/daily-bank — "today, where is the money, and how much can actually move"
// (brief §3.6, owner decision 2b: build it).
//
// Everything is computed LIVE from the ledger (§2.3: no balance caches), with
// the same posted-and-not-reversed predicate every balance view uses — so the
// board, the trial balance and the reconciliation pages can never disagree.
//
// The board's shape, one block per money account (owner 2026-09-29, his
// "BANK BALANCE AVAILABLE" sample in hand: 1 By bank · 2 pending = checked,
// not yet approved — approved 了就会扣钱 · 3 show what was paid · 4 keep the
// totals; then settlement in transit 放在相对应的银行, and 1 要 the line with
// the transit added):
//   Balance B/F (yesterday's closing)
//   + today's receipts (green, listed: who paid, the document, the note)
//   − today's payouts  (listed: who was paid, the document, the note)
//   = Bank Balance (the account's closing)
//   − the checked vouchers awaiting approval that will pay out of THIS account
//     (listed: payee, voucher, description)
//   = Available (after pending)
//   + the card money swiped for this account's acquirers, not yet remitted
//     (listed per acquirer — the bank each acquirer pays into is Settlement
//     Setup's) — shown, never counted as movable
//   = Available + in transit.
// An approved voucher leaves pending and posts its payment on the VOUCHER'S
// date (the posting gate's rule): a back-dated one lowers Balance B/F rather
// than joining today's payouts, so the board always ties to the ledger
// (owner 2026-09-29: 照你建议).
// Transit whose acquirer names no bank here (未标银行, the generic clearing
// account) and a voucher paying from an account the board does not carry
// stay in their own lists, still inside the totals.
//
// THE CASH BOOK — a second board beside this one (owner 2026-11-23: 先做一个daily
// bank的一开始直接，但不需要列实际差额。然后我每天会手动输入收到的金额; 付款就根据pv;
// then: 原版的daily bank还是要保留哦，我这算是新的daily bank). Given a cash book,
// the board carries only the accounts whose start is on or before the day, each
// reading the bank's real balance at the start of its start day, plus the
// receipts typed for it, less the approved (POSTED) vouchers paying out of it on
// the Malaysia day each was approved (owner 2026-11-24: 其实就是我approved了就当做一件过了
// 要扣; 照这样改) — what the voucher posts, its bank charge included. One approved
// before the start, or on the start day but dated before it, is inside the start; one
// Finance ticked as already in the starting balance (owner 2026-11-25: 要，加勾选) is
// listed on its day under `notDeducted` and never taken off. A voucher whose lines
// pay into another cash-book account (an internal transfer) adds them to it on the
// same day, by the same rules (owner 2026-11-27: hong leong 不会增加？). Pending
// counts only the vouchers paying out of those accounts. Card money not yet in a
// bank sits under none of them (owner, on its rows: 这个可以不要出现吗): the board
// still lists it once, as on its way, never counted. The rest wait in `notStarted`. Without one (cashbook null) the board is the
// original, untouched. No books-versus-bank difference is shown anywhere, and
// nothing here writes to the ledger.
// ----------------------------------------------------------------------------

import { fmtSen } from '../scm/shared/format';
import { mytDateOf } from '../scm/lib/my-time';

export type GlLine = {
  entry_date: string;
  je_no: string;
  source_type: string;
  source_doc_no: string | null;
  account_code: string;
  debit_sen: number;
  credit_sen: number;
  narration?: string | null;
  notes?: string | null;
  party?: string | null;
  method?: string | null;
  doc_no?: string | null;
};

export type MoneyAccount = { account_code: string; account_name: string };
/** A settlement transit account and the money account its acquirer remits into (Settlement Setup's bank; null = none named). */
export type TransitAccount = { acquirerCode: string; account_code: string; account_name: string; bankAccountCode?: string | null };

export type DailyBankMovement = {
  jeNo: string;
  sourceType: string;
  sourceDocNo: string | null;
  docNo: string;
  party: string | null;
  note: string;
  amountSen: number;
  method: string | null;
  typedBy?: string | null;
};

/** A checked voucher awaiting approval — money already asked for. */
export type DailyBankPending = {
  id: string | null;
  pvNumber: string | null;
  payee: string | null;
  description: string;
  voucherDate: string | null;
  accountCode: string | null;
  amountSen: number;
};

export type DailyBankTransit = { acquirerCode: string; accountCode: string; accountName: string; balanceSen: number; bankAccountCode: string | null };

export type DailyBankBlock = {
  accountCode: string;
  accountName: string;
  start: { date: string; balanceSen: number } | null;
  openingSen: number;
  inSen: number;
  outSen: number;
  closingSen: number;
  receipts: DailyBankMovement[];
  payouts: DailyBankMovement[];
  pending: DailyBankPending[];
  pendingSen: number;
  availableSen: number;
  transit: DailyBankTransit[];
  transitSen: number;
  availableWithTransitSen: number;
  notDeducted?: DailyBankNotDeducted[];
};

/** An approved voucher the cash book lists on its day but does not take off. */
export type DailyBankNotDeducted = {
  pvId: string; pvNumber: string; party: string | null; note: string; amountSen: number;
  tickedBy: string | null; tickedAt: string | null;
};

export type DailyBankBoard = {
  date: string;
  blocks: DailyBankBlock[];
  transit: DailyBankTransit[];
  totalClosingSen: number;
  totalTransitSen: number;
  pendingApprovalSen: number;
  availableSen: number;
  unassignedTransit: DailyBankTransit[];
  unassignedPending: DailyBankPending[];
  book: 'ledger' | 'cashbook';
  notStarted: Array<{ accountCode: string; accountName: string; startDate: string | null }>;
  note: string;
};

/** A voucher in the approval queue, as the route reads it. Only the money is required. */
export type PendingVoucherRow = {
  total_sen: number;
  exchange_rate: string | number | null;
  id?: string | null;
  pv_number?: string | null;
  payee_name?: string | null;
  notes?: string | null;
  description_text?: string | null;
  purpose?: string | null;
  credit_account_code?: string | null;
  voucher_date?: string | null;
};

/** A money account's cash-book start: the bank's real balance at the start of `start_date`. */
export type CashbookStart = { account_code: string; start_date: string; balance_sen: number };
/** Money received, as the owner typed it into the cash book. */
export type CashbookReceipt = { id: string; account_code: string; receipt_date: string; amount_sen: number; note: string; created_by?: string | null };
/** An approved (POSTED) voucher paying out of a cash-book account, with when it was
    approved and posted (timestamps; null when not stamped). */
export type CashbookPayout = PendingVoucherRow & {
  id: string; pv_number: string; voucher_date: string; credit_account_code: string; bank_charge_sen?: number | null;
  approved_at?: string | null; posted_at?: string | null;
};
/** An approved voucher Finance ticked as already in its bank's starting balance
    (owner 2026-11-25: 要，加勾选): who ticked it and when. */
export type CashbookSkip = { pv_id: string; ticked_by: string | null; ticked_at: string | null };
/** An approved voucher whose lines pay INTO a cash-book account (Dr that account): an
    internal transfer from another of the company's banks, or cash topped up from one
    (owner 2026-11-27: internal transfer maybank 转钱给 hong leong, hong leong 不会增加).
    `line_sen` is what its lines put into `to_account_code`, in the voucher's currency. */
export type CashbookTransferIn = CashbookPayout & { to_account_code: string; line_sen: number };
/** What the route read for the accounts that have a start. */
export type DailyBankCashbook = {
  starts: CashbookStart[]; receipts: CashbookReceipt[]; payouts: CashbookPayout[]; transfersIn: CashbookTransferIn[]; skips: CashbookSkip[];
};

const myrSen = (v: PendingVoucherRow): number => {
  const raw = Number(v.exchange_rate ?? 1);
  const rate = Number.isFinite(raw) && raw > 0 ? raw : 1;
  return Math.round(Number(v.total_sen) * rate);
};

/** What a pending line says: what the voucher pays for, as the PV list's Description says
    it (owner 2026-11-09: 只显示单上的费用, never the bill number); else its own remark,
    else its purpose in words. */
const pendingDescription = (v: PendingVoucherRow): string => {
  const described = String(v.description_text ?? '').replace(/\s+/g, ' ').trim();
  if (described) return described;
  const note = String(v.notes ?? '').replace(/\s+/g, ' ').trim();
  if (note) return note;
  const purpose = String(v.purpose ?? '').trim();
  return purpose ? purpose.replace(/_/g, ' ').toLowerCase().replace(/^./, (ch) => ch.toUpperCase()) : '';
};

/** What a POSTED voucher took out of its bank: its MYR total and the bank charge
    the same journal credits to the bank (DEV-75, in MYR as keyed). */
export const voucherPayoutSen = (v: CashbookPayout): number => {
  const charge = Number(v.bank_charge_sen ?? 0);
  return myrSen(v) + (Number.isFinite(charge) && charge > 0 ? Math.round(charge) : 0);
};

const transferInSen = (t: CashbookTransferIn): number => myrSen({ ...t, total_sen: t.line_sen });

const mytDay = (at: string | null | undefined): string | null => {
  const t = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(t) ? mytDateOf(t) : null;
};

/** The day an approved voucher comes off the cash book (owner 2026-11-24: 其实就是我
    approved了就当做一件过了要扣; 照这样改): the Malaysia day it was approved; without an
    approval stamp, the day it was posted; without either, its voucher date. */
export const payoutDay = (v: CashbookPayout): string => mytDay(v.approved_at) ?? mytDay(v.posted_at) ?? v.voucher_date;

/** Already inside the account's starting balance: approved before its start day, or
    on the start day for a voucher dated before it. */
export const insideStart = (v: CashbookPayout, start: CashbookStart): boolean => {
  const day = payoutDay(v);
  return day < start.start_date || (day === start.start_date && v.voucher_date < start.start_date);
};

function cashbookFigures(
  date: string, start: CashbookStart, receipts: CashbookReceipt[], payouts: CashbookPayout[],
  transfersIn: CashbookTransferIn[], skips: Map<string, CashbookSkip>, nameOf: (code: string) => string,
): { opening: number; inSen: number; outSen: number; received: DailyBankMovement[]; paid: DailyBankMovement[]; notDeducted: DailyBankNotDeducted[] } {
  let opening = Number(start.balance_sen);
  let inSen = 0;
  let outSen = 0;
  const received: DailyBankMovement[] = [];
  const paid: DailyBankMovement[] = [];
  const notDeducted: DailyBankNotDeducted[] = [];
  for (const r of receipts) {
    if (r.receipt_date < start.start_date || r.receipt_date > date) continue;
    const amount = Number(r.amount_sen);
    if (r.receipt_date < date) { opening += amount; continue; }
    inSen += amount;
    received.push({
      jeNo: '', sourceType: 'TYPED', sourceDocNo: r.id, docNo: '', party: null,
      note: r.note, amountSen: amount, method: null, typedBy: r.created_by ?? null,
    });
  }
  for (const v of payouts) {
    const day = payoutDay(v);
    if (insideStart(v, start) || day > date) continue;
    const amount = voucherPayoutSen(v);
    const skip = skips.get(v.id);
    if (day < date) { if (!skip) opening -= amount; continue; }
    const charge = amount - myrSen(v);
    /* Approved is paid (owner 2026-11-24: 过了就不需要显示了): the line reads like any
       other, never its own voucher date. */
    const note = [pendingDescription(v), charge > 0 ? `incl. bank charge ${fmtSen(charge)}` : ''].filter(Boolean).join(' · ');
    if (skip) {
      notDeducted.push({
        pvId: v.id, pvNumber: v.pv_number, party: v.payee_name ?? null, note, amountSen: amount,
        tickedBy: skip.ticked_by, tickedAt: skip.ticked_at,
      });
      continue;
    }
    outSen += amount;
    paid.push({
      jeNo: '', sourceType: 'PV', sourceDocNo: v.id, docNo: v.pv_number, party: v.payee_name ?? null,
      note, amountSen: amount, method: null,
    });
  }
  /* Owner 2026-11-27 (hong leong 不会增加？): a transfer arrives the day it comes off the
     bank that paid it, without that bank's charge; one inside this start, or ticked as
     already in a starting balance, is counted already. */
  for (const t of transfersIn) {
    const day = payoutDay(t);
    if (skips.has(t.id) || insideStart(t, start) || day > date) continue;
    const amount = transferInSen(t);
    if (day < date) { opening += amount; continue; }
    inSen += amount;
    received.push({
      jeNo: '', sourceType: 'PV', sourceDocNo: t.id, docNo: t.pv_number,
      party: `INTERNAL TRANSFER FROM ${t.credit_account_code} ${nameOf(t.credit_account_code)}`.trim(),
      note: pendingDescription(t), amountSen: amount, method: null,
    });
  }
  return { opening, inSen, outSen, received, paid, notDeducted };
}

/** Pure board computation over the account's ledger lines — testable without a
    database. `lines` must already be the POSTED, non-reversed lines of the
    accounts involved (any date range that covers ≤ the board date). */
export function computeDailyBank(
  date: string,
  moneyAccounts: MoneyAccount[],
  transitAccounts: TransitAccount[],
  lines: GlLine[],
  pendingVouchers: PendingVoucherRow[],
  cashbook: DailyBankCashbook | null,
): DailyBankBoard {
  const byAccount = new Map<string, GlLine[]>();
  for (const l of lines) {
    const arr = byAccount.get(l.account_code) ?? [];
    arr.push(l);
    byAccount.set(l.account_code, arr);
  }
  const startOf = new Map((cashbook?.starts ?? []).map((s) => [s.account_code, s]));
  const accountNames = new Map(moneyAccounts.map((a) => [a.account_code, a.account_name]));
  const nameOf = (code: string): string => accountNames.get(code) ?? '';
  const skipOf = new Map((cashbook?.skips ?? []).map((s) => [s.pv_id, s]));
  const onBoard = (a: MoneyAccount): boolean => {
    if (!cashbook) return true;
    const s = startOf.get(a.account_code);
    return s != null && s.start_date <= date;
  };
  const carried = moneyAccounts.filter(onBoard);
  const notStarted = moneyAccounts.filter((a) => !onBoard(a))
    .map((a) => ({ accountCode: a.account_code, accountName: a.account_name, startDate: startOf.get(a.account_code)?.start_date ?? null }));
  const blockCodes = new Set(carried.map((a) => a.account_code));

  const asked = cashbook ? pendingVouchers.filter((v) => v.credit_account_code != null && blockCodes.has(String(v.credit_account_code))) : pendingVouchers;
  const pendingAll: DailyBankPending[] = asked.map((v) => ({
    id: v.id ?? null,
    pvNumber: v.pv_number ?? null,
    payee: v.payee_name ?? null,
    description: pendingDescription(v),
    voucherDate: v.voucher_date ?? null,
    accountCode: v.credit_account_code ?? null,
    amountSen: myrSen(v),
  }));
  const pendingOf = (code: string): DailyBankPending[] => pendingAll.filter((p) => p.accountCode === code);
  const unassignedPending = pendingAll.filter((p) => p.accountCode == null || !blockCodes.has(p.accountCode));

  const transit: DailyBankTransit[] = transitAccounts.map((t) => {
    const ls = byAccount.get(t.account_code) ?? [];
    let bal = 0;
    for (const l of ls) {
      if (l.entry_date <= date) bal += Number(l.debit_sen) - Number(l.credit_sen);
    }
    return { acquirerCode: t.acquirerCode, accountCode: t.account_code, accountName: t.account_name, balanceSen: bal, bankAccountCode: t.bankAccountCode ?? null };
  });
  const unassignedTransit = cashbook ? [] : transit.filter((t) => t.bankAccountCode == null || !blockCodes.has(t.bankAccountCode));

  const blocks: DailyBankBlock[] = carried.map((a) => {
    let opening = 0;
    let inSen = 0;
    let outSen = 0;
    let receipts: DailyBankMovement[] = [];
    let payouts: DailyBankMovement[] = [];
    let notDeducted: DailyBankNotDeducted[] = [];
    const start = startOf.get(a.account_code) ?? null;
    if (cashbook && start) {
      const f = cashbookFigures(date, start,
        cashbook.receipts.filter((r) => r.account_code === a.account_code),
        cashbook.payouts.filter((v) => v.credit_account_code === a.account_code),
        cashbook.transfersIn.filter((t) => t.to_account_code === a.account_code), skipOf, nameOf);
      opening = f.opening;
      inSen = f.inSen;
      outSen = f.outSen;
      receipts = f.received;
      payouts = f.paid;
      notDeducted = f.notDeducted;
    } else {
      for (const l of byAccount.get(a.account_code) ?? []) {
        const net = Number(l.debit_sen) - Number(l.credit_sen);
        if (l.entry_date < date) {
          opening += net;
        } else if (l.entry_date === date) {
          const move: DailyBankMovement = {
            jeNo: l.je_no,
            sourceType: l.source_type,
            sourceDocNo: l.source_doc_no,
            docNo: l.doc_no ?? l.source_doc_no ?? l.je_no,
            party: l.party ?? null,
            note: l.notes ?? l.narration ?? '',
            amountSen: Math.abs(net),
            method: l.method ?? null,
          };
          if (net > 0) { inSen += net; receipts.push(move); }
          else if (net < 0) { outSen += -net; payouts.push(move); }
        }
      }
    }
    const closingSen = opening + inSen - outSen;
    const pending = pendingOf(a.account_code);
    const pendingSen = pending.reduce((s, p) => s + p.amountSen, 0);
    const own = cashbook ? [] : transit.filter((t) => t.bankAccountCode === a.account_code);
    const transitSen = own.reduce((s, t) => s + t.balanceSen, 0);
    return {
      accountCode: a.account_code,
      accountName: a.account_name,
      start: cashbook && start ? { date: start.start_date, balanceSen: Number(start.balance_sen) } : null,
      openingSen: opening,
      inSen,
      outSen,
      closingSen,
      receipts,
      payouts,
      pending,
      pendingSen,
      availableSen: closingSen - pendingSen,
      transit: own,
      transitSen,
      availableWithTransitSen: closingSen - pendingSen + transitSen,
      ...(cashbook ? { notDeducted } : {}),
    };
  });

  const totalClosingSen = blocks.reduce((s, b) => s + b.closingSen, 0);
  const totalTransitSen = transit.reduce((s, t) => s + t.balanceSen, 0);
  const pendingApprovalSen = pendingAll.reduce((s, p) => s + p.amountSen, 0);

  return {
    date,
    blocks,
    transit,
    totalClosingSen,
    totalTransitSen,
    pendingApprovalSen,
    availableSen: totalClosingSen - pendingApprovalSen,
    unassignedTransit,
    unassignedPending,
    book: cashbook ? 'cashbook' : 'ledger',
    notStarted,
    note: cashbook
      ? 'The cash book: each bank from its starting balance, plus the receipts typed for it and the approved transfers into it from another of the company\'s accounts, less the approved vouchers paying out of it on the day each was approved (bank charge included), except one ticked as already in the starting balance. Pending = checked vouchers awaiting approval, on the bank they pay from. Card money swiped but not yet remitted is listed once as on its way, never under a bank and never counted as movable.'
      : 'Computed live from the ledger (posted, non-reversed). Pending = checked vouchers awaiting approval, on the account they pay from; an approved one posts on its own date. Transit money is swiped but not yet remitted - shown under the bank its acquirer pays into, never counted as movable.',
  };
}
