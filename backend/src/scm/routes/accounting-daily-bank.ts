
import type { Variables } from '../env';
import { requireActiveCompanyId } from '../lib/companyScope';
import { mytDayWindow, todayMyt } from '../lib/my-time';
import { paginateAll } from '../lib/paginate-all';
import {
  computeDailyBank, payoutDay, type CashbookPayout, type CashbookReceipt, type CashbookSkip, type CashbookStart, type CashbookTransferIn,
  type DailyBankCashbook, type PendingVoucherRow,
} from '../../acc/daily-bank';
import { canWriteCashbook } from './accounting-daily-bank-cashbook';
import { describeVouchers } from './payment-vouchers-describe';
import { resolveRoles } from '../../acc/rules';
import { isReversalPair } from '../../acc/reversal-pairs';

/** The board for one company and day — the handler's reads and the To do's
    "Can move today" (acc/finance-todo) share it, so the two never disagree.
    `withNames` false skips the names the board prints for the day's lines.
    `book` 'ledger' is the original board; 'cashbook' is the owner's cash book
    (2026-11-23: 原版的daily bank还是要保留哦，我这算是新的daily bank), read
    through the same transit and pending reads but none of the banks' ledger lines. */
export async function loadDailyBankBoard(
  sb: any, companyId: number, date: string, opts: { withNames: boolean; book: 'ledger' | 'cashbook' },
): Promise<{ ok: true; board: ReturnType<typeof computeDailyBank> } | { ok: false; reason: string }> {
  const co = { companyId };

  const { data: moneyRaw, error: mErr } = await sb.from('accounts')
    .select('account_code, account_name')
    .eq('company_id', co.companyId).eq('acc_money', true).eq('is_active', true)
    .order('account_code');
  if (mErr) return { ok: false, reason: mErr.message };
  const money = (moneyRaw ?? []) as Array<{ account_code: string; account_name: string }>;

  const { data: acqRaw, error: aErr } = await sb.from('acc_acquirers')
    .select('code, transit_account_code, bank_account_code')
    .eq('company_id', co.companyId).eq('is_active', true).order('code');
  if (aErr) return { ok: false, reason: aErr.message };
  /* One transit account may serve several acquirers until 决定4 assigns each
     its own - collapse duplicates so the board does not count a balance twice. */
  const transitByAccount = new Map<string, string>();
  /* The bank each transit account's money lands in — Settlement Setup's, per
     acquirer (owner 2026-09-29: settlement in transit 放在相对应的银行). Two
     acquirers sharing one transit account but naming different banks leave it
     unassigned rather than guess. */
  const bankByTransit = new Map<string, string | null>();
  for (const a of (acqRaw ?? []) as Array<{ code: string; transit_account_code: string; bank_account_code: string | null }>) {
    const existing = transitByAccount.get(a.transit_account_code);
    transitByAccount.set(a.transit_account_code, existing ? `${existing}/${a.code}` : a.code);
    const bank = a.bank_account_code ? String(a.bank_account_code) : null;
    const seen = bankByTransit.has(a.transit_account_code);
    bankByTransit.set(a.transit_account_code, seen && bankByTransit.get(a.transit_account_code) !== bank ? null : bank);
  }
  /* The GENERIC clearing account (role TRANSIT_EDC, 326-0000) stays on the
     board once the acquirers have their own accounts (owner 2026-09-07: 我想要
     拆账户): a card payment recorded without a bank still lands there, and
     money the board cannot see is money nobody chases. Named 未标银行 so the
     line reads as what it is, not as a machine. */
  const genericTransit = (await resolveRoles(sb, co.companyId)).TRANSIT_EDC;
  if (!transitByAccount.has(genericTransit)) transitByAccount.set(genericTransit, 'Untagged bank');
  const transitCodes = [...transitByAccount.keys()];
  const { data: transitNamesRaw, error: tErr } = await sb.from('accounts')
    .select('account_code, account_name')
    .eq('company_id', co.companyId).in('account_code', transitCodes.length ? transitCodes : ['—none—']);
  if (tErr) return { ok: false, reason: tErr.message };
  const nameOf = new Map(((transitNamesRaw ?? []) as Array<{ account_code: string; account_name: string }>)
    .map((r) => [r.account_code, r.account_name]));
  const transitAccounts = transitCodes.map((code) => ({
    acquirerCode: transitByAccount.get(code) ?? code,
    account_code: code,
    account_name: nameOf.get(code) ?? code,
    bankAccountCode: bankByTransit.get(code) ?? null,
  }));

  const { data: pendingRaw, error: pErr } = await sb.from('payment_vouchers')
    /* Each voucher's payee, number, note and Paid From ride along: the board
       lists them under the bank they will pay out of (owner 2026-09-29). */
    .select('id, pv_number, payee_name, notes, purpose, credit_account_code, voucher_date, total_sen, exchange_rate')
    /* daily bank 的pending 就是第一层的checked (the owner, 2026-09-02): a
       voucher reserves the board's money once the FIRST yes is on it — a
       merely prepared one is still the preparer's business. */
    .eq('company_id', co.companyId).eq('status', 'DRAFT')
    .not('checked_at', 'is', null)
    .lt('checked_at', new Date(Date.parse(`${date}T00:00:00+08:00`) + 86_400_000).toISOString());
  if (pErr) return { ok: false, reason: pErr.message };
  let pending = (pendingRaw ?? []) as PendingVoucherRow[];

  let cashbook: DailyBankCashbook | null = null;
  if (opts.book === 'cashbook') {
    const cash = await loadCashbook(sb, co.companyId, date, money.map((m) => m.account_code));
    if (!cash.ok) return cash;
    cashbook = cash.cashbook;
    const carried = new Set(cashbook.starts.filter((s) => s.start_date <= date).map((s) => s.account_code));
    pending = pending.filter((v) => carried.has(String(v.credit_account_code ?? '')));
  }

  /* Each listed voucher reads as the PV list's Description does: what it pays for,
     never its bill number (owner 2026-11-09) — the pending ones and, on the cash
     book, the day's payouts, in one read. The To do's sum needs no words. */
  const paidToday = (cashbook?.payouts ?? []).filter((v) => payoutDay(v) === date);
  const paidIds = new Set(paidToday.map((v) => v.id));
  const inToday = (cashbook?.transfersIn ?? []).filter((v) => payoutDay(v) === date && !paidIds.has(v.id));
  if (opts.withNames && pending.length + paidToday.length + inToday.length > 0) {
    const described = await describeVouchers(sb, { get: (k: string) => (k === 'companyId' ? co.companyId : undefined) },
      [...pending, ...paidToday, ...inToday].map((v) => ({ ...v, id: String(v.id) })));
    if (!described.ok) return { ok: false, reason: described.reason };
    const wordsOf = (id: unknown): string | null => described.byId.get(String(id))?.description_text ?? null;
    pending = pending.map((v) => ({ ...v, description_text: wordsOf(v.id) }));
    if (cashbook) {
      cashbook.payouts = cashbook.payouts.map((v) => (payoutDay(v) === date ? { ...v, description_text: wordsOf(v.id) } : v));
      cashbook.transfersIn = cashbook.transfersIn.map((v) => (payoutDay(v) === date ? { ...v, description_text: wordsOf(v.id) } : v));
    }
  }

  const ledgerMoney = cashbook ? [] : money;
  const allCodes = [...ledgerMoney.map((m) => m.account_code), ...transitCodes];
  const { data: lines, error: lErr } = await paginateAll<Record<string, unknown>>((from, to) =>
    sb.from('v_gl_entries').select('entry_date, je_no, source_type, source_doc_no, account_code, debit_sen, credit_sen, notes, reversed, reversed_by_je')
      .eq('company_id', co.companyId)
      .in('account_code', allCodes.length ? allCodes : ['—none—'])
      .lte('entry_date', date)
      .order('line_id')
      .range(from, to));
  if (lErr) return { ok: false, reason: lErr.message };

  /* The board reads the ledger the reconciliation reads: neither side of a
     reversal pair is money that moved (docs/bugs/0923). */
  const counted = (lines ?? []).filter((l) => !isReversalPair(l as { reversed?: boolean | null; reversed_by_je?: string | null }));

  /* Who paid or was paid, and the number the board prints, for the day's
     money lines (owner 2026-09-29 — the sample's PAY TO and number columns):
     the entry's party off its own lines, and for a customer payment its
     official receipt (the order when none was issued) in place of the
     payment's internal id. Both reads are bound: a failed one answers 500,
     never a board of nameless lines. */
  const moneyCodes = new Set(ledgerMoney.map((m) => m.account_code));
  type BoardLine = { entry_date: string; je_no: string; source_type: string; source_doc_no: string | null; account_code: string };
  const isTodayMoney = (l: BoardLine): boolean => l.entry_date === date && moneyCodes.has(String(l.account_code));
  const todays = (counted as unknown as BoardLine[]).filter(isTodayMoney);
  const partyOf = new Map<string, string>();
  const receiptOf = new Map<string, string>();
  const methodOf = new Map<string, string>();
  const jeNos = [...new Set(todays.map((l) => String(l.je_no)))];
  if (opts.withNames && jeNos.length > 0) {
    const { data: partyRows, error: prErr } = await sb.from('v_gl_entries').select('je_no, party_name')
      .eq('company_id', co.companyId).in('je_no', jeNos).not('party_name', 'is', null);
    if (prErr) return { ok: false, reason: prErr.message };
    for (const r of (partyRows ?? []) as Array<{ je_no: string; party_name: string | null }>) {
      if (r.party_name && !partyOf.has(r.je_no)) partyOf.set(r.je_no, r.party_name);
    }
    const payIds = [...new Set(todays.filter((l) => (l.source_type === 'SOPAY' || l.source_type === 'SIPAY') && l.source_doc_no).map((l) => String(l.source_doc_no)))];
    if (payIds.length > 0) {
      const { data: orRows, error: orErr } = await sb.from('acc_official_receipts').select('payment_id, or_number, doc_no')
        .eq('company_id', co.companyId).neq('status', 'CANCELLED').in('payment_id', payIds);
      if (orErr) return { ok: false, reason: orErr.message };
      for (const r of (orRows ?? []) as Array<{ payment_id: string; or_number: string | null; doc_no: string | null }>) {
        const shown = r.or_number ?? r.doc_no;
        if (shown) receiptOf.set(String(r.payment_id), shown);
      }
      const soIds = [...new Set(todays.filter((l) => l.source_type === 'SOPAY' && l.source_doc_no).map((l) => String(l.source_doc_no)))];
      const siIds = [...new Set(todays.filter((l) => l.source_type === 'SIPAY' && l.source_doc_no).map((l) => String(l.source_doc_no)))];
      const [soPays, siPays] = await Promise.all([
        soIds.length ? sb.from('mfg_sales_order_payments').select('id, so_doc_no, method, online_type').eq('company_id', co.companyId).in('id', soIds) : { data: [], error: null },
        siIds.length ? sb.from('sales_invoice_payments').select('id, method').eq('company_id', co.companyId).in('id', siIds) : { data: [], error: null },
      ]);
      if (soPays.error) return { ok: false, reason: soPays.error.message };
      if (siPays.error) return { ok: false, reason: siPays.error.message };
      for (const r of (soPays.data ?? []) as Array<{ id: string; so_doc_no: string | null; method: string | null; online_type: string | null }>) {
        if (r.so_doc_no && !receiptOf.has(String(r.id))) receiptOf.set(String(r.id), r.so_doc_no);
        if (r.method) methodOf.set(String(r.id), r.method === 'online' && r.online_type ? `online:${r.online_type}` : r.method);
      }
      for (const r of (siPays.data ?? []) as Array<{ id: string; method: string | null }>) {
        if (r.method) methodOf.set(String(r.id), r.method);
      }
    }
  }
  const docOf = (l: BoardLine): string | null => {
    if (l.source_type === 'SOPAY' || l.source_type === 'SIPAY') return receiptOf.get(String(l.source_doc_no ?? '')) ?? l.je_no;
    return null;
  };
  const stamped = (counted as unknown as BoardLine[]).map((l) => (isTodayMoney(l)
    ? { ...l, party: partyOf.get(String(l.je_no)) ?? null, doc_no: docOf(l), method: methodOf.get(String(l.source_doc_no ?? '')) ?? null }
    : l));
  return { ok: true, board: computeDailyBank(date, money, transitAccounts, stamped as never, pending, cashbook) };
}

/** The cash book behind the board (owner 2026-11-23): every money account's
    start, and — for the accounts whose start is on or before the day — the
    receipts typed for them (deleted ones left out) and the approved vouchers
    paying out of them, approved from the earliest such start to the day (owner
    2026-11-24: a voucher comes off on the day it is approved). Every read is
    bound: a failed or cut-short one answers 500, never a board that quietly fell
    back to the ledger or dropped a receipt. */
export async function loadCashbook(
  sb: Variables['supabase'], companyId: number, date: string, moneyCodes: string[],
): Promise<{ ok: true; cashbook: DailyBankCashbook } | { ok: false; reason: string }> {
  const { data: startsRaw, error: sErr } = await sb.from('acc_daily_bank_starts')
    .select('account_code, start_date, balance_sen')
    .eq('company_id', companyId);
  if (sErr) return { ok: false, reason: sErr.message };
  const isMoney = new Set(moneyCodes);
  const starts: CashbookStart[] = (startsRaw as Array<Record<string, unknown>>)
    .map((s) => ({ account_code: String(s.account_code), start_date: String(s.start_date).slice(0, 10), balance_sen: Number(s.balance_sen) }))
    .filter((s) => isMoney.has(s.account_code));
  const live = starts.filter((s) => s.start_date <= date);
  if (live.length === 0) return { ok: true, cashbook: { starts, receipts: [], payouts: [], transfersIn: [], skips: [] } };
  const codes = live.map((s) => s.account_code);
  const since = live.reduce((first, s) => (s.start_date < first ? s.start_date : first), date);
  const days = mytDayWindow(since, date);
  if (!days?.startUtc || !days.endUtc) return { ok: false, reason: `not a day: ${since} to ${date}` };
  const PV_COLS = 'id, pv_number, payee_name, notes, purpose, credit_account_code, voucher_date, total_sen, exchange_rate, bank_charge_sen, approved_at, posted_at';
  const [rq, pq, uq, kq, lq] = await Promise.all([
    paginateAll<Record<string, unknown>>((from, to) => sb.from('acc_daily_bank_receipts')
      .select('id, account_code, receipt_date, amount_sen, note, created_by')
      .eq('company_id', companyId).in('account_code', codes).is('deleted_at', null)
      .gte('receipt_date', since).lte('receipt_date', date)
      .order('receipt_date').order('created_at').order('id')
      .range(from, to)),
    paginateAll<Record<string, unknown>>((from, to) => sb.from('payment_vouchers')
      .select(PV_COLS)
      .eq('company_id', companyId).eq('status', 'POSTED').in('credit_account_code', codes)
      .gte('approved_at', days.startUtc).lt('approved_at', days.endUtc)
      .order('approved_at').order('pv_number').order('id')
      .range(from, to)),
    paginateAll<Record<string, unknown>>((from, to) => sb.from('payment_vouchers')
      .select(PV_COLS)
      .eq('company_id', companyId).eq('status', 'POSTED').in('credit_account_code', codes)
      .is('approved_at', null)
      .order('voucher_date').order('pv_number').order('id')
      .range(from, to)),
    /* The vouchers Finance ticked as already in the starting balance (owner
       2026-11-25: 要，加勾选), still ticked. */
    paginateAll<Record<string, unknown>>((from, to) => sb.from('acc_daily_bank_voucher_skips')
      .select('id, pv_id, ticked_by, ticked_at')
      .eq('company_id', companyId).is('unticked_at', null)
      .order('ticked_at').order('id')
      .range(from, to)),
    /* The voucher lines paying INTO these accounts — internal transfers (owner
       2026-11-27: maybank 转钱给 hong leong, hong leong 不会增加？); their vouchers below. */
    paginateAll<Record<string, unknown>>((from, to) => sb.from('payment_voucher_lines')
      .select('id, pv_id, debit_account_code, amount_sen')
      .eq('company_id', companyId).in('debit_account_code', codes)
      .order('pv_id').order('id')
      .range(from, to)),
  ]);
  if (rq.error) return { ok: false, reason: rq.error.message };
  if (pq.error) return { ok: false, reason: pq.error.message };
  if (uq.error) return { ok: false, reason: uq.error.message };
  if (kq.error) return { ok: false, reason: kq.error.message };
  if (lq.error) return { ok: false, reason: lq.error.message };
  if (rq.truncated || pq.truncated || uq.truncated || kq.truncated || lq.truncated) return { ok: false, reason: 'the cash book is too long to read in one go' };
  const receipts: CashbookReceipt[] = (rq.data ?? []).map((r) => ({
    id: String(r.id), account_code: String(r.account_code), receipt_date: String(r.receipt_date).slice(0, 10),
    amount_sen: Number(r.amount_sen), note: String(r.note ?? ''), created_by: (r.created_by as string | null) ?? null,
  }));
  const asVoucher = (v: Record<string, unknown>): CashbookPayout => ({
    ...v, id: String(v.id), pv_number: String(v.pv_number), credit_account_code: String(v.credit_account_code),
    voucher_date: String(v.voucher_date).slice(0, 10),
    approved_at: (v.approved_at as string | null) ?? null, posted_at: (v.posted_at as string | null) ?? null,
  }) as unknown as CashbookPayout;
  const inWindow = (v: CashbookPayout): boolean => payoutDay(v) >= since && payoutDay(v) <= date;
  const byDay = (a: CashbookPayout, b: CashbookPayout): number =>
    payoutDay(a).localeCompare(payoutDay(b)) || a.pv_number.localeCompare(b.pv_number) || a.id.localeCompare(b.id);
  const payouts = [...(pq.data ?? []), ...(uq.data ?? [])].map(asVoucher).filter(inWindow).sort(byDay);

  const intoOf = new Map<string, Map<string, number>>();
  for (const l of lq.data ?? []) {
    const per = intoOf.get(String(l.pv_id)) ?? new Map<string, number>();
    const to = String(l.debit_account_code);
    per.set(to, (per.get(to) ?? 0) + Number(l.amount_sen));
    intoOf.set(String(l.pv_id), per);
  }
  const ids = [...intoOf.keys()];
  const transferVouchers: CashbookPayout[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await sb.from('payment_vouchers').select(PV_COLS)
      .eq('company_id', companyId).eq('status', 'POSTED').in('id', ids.slice(i, i + 100));
    if (error) return { ok: false, reason: error.message };
    transferVouchers.push(...(data as Array<Record<string, unknown>>).map(asVoucher));
  }
  const transfersIn: CashbookTransferIn[] = transferVouchers.filter(inWindow).sort(byDay)
    .flatMap((v) => [...(intoOf.get(v.id) ?? new Map<string, number>())].map(([to, sen]) => ({ ...v, to_account_code: to, line_sen: sen })));

  const paying = new Set(payouts.map((v) => v.id));
  const skips: CashbookSkip[] = (kq.data ?? [])
    .map((k) => ({ pv_id: String(k.pv_id), ticked_by: (k.ticked_by as string | null) ?? null, ticked_at: (k.ticked_at as string | null) ?? null }))
    .filter((k) => paying.has(k.pv_id));
  return { ok: true, cashbook: { starts, receipts, payouts, transfersIn, skips } };
}

/** GET /daily-bank (the original board) and GET /daily-bank/cashbook/board (the
    owner's cash book, 2026-11-23): the same handler, a different book. The cash
    book's also says whether the caller may tick a voucher off it. */
const boardHandler = (book: 'ledger' | 'cashbook') => async (c: any) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const dateQ = c.req.query('date') ?? todayMyt();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateQ) ? dateQ : todayMyt();
  const r = await loadDailyBankBoard(c.get('supabase'), co.companyId, date, { withNames: true, book });
  if (!r.ok) return c.json({ error: 'load_failed', reason: r.reason }, 500);
  return c.json(book === 'cashbook' ? { ...r.board, canWrite: canWriteCashbook(c) } : r.board);
};
export const dailyBankHandler = boardHandler('ledger');
export const cashbookBoardHandler = boardHandler('cashbook');
