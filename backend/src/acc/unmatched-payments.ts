// ----------------------------------------------------------------------------
// unmatched-payments — every customer payment that is not matched yet, card
// and transfer on ONE list (owner 2026-09-30: 我现在可以看到的是 card payment
// 哪些还没 match 罢了，如果 online transfer 那些呢？我有没有一个表是显示全部
// 还没 match 的 → 做).
//
// "Matched" means what the two reconciliation screens already mean by it:
//   card     — a merchant report line claims the payment AND that line is
//              CONFIRMED (its fee booked). The link alone is the matcher's
//              word, not a reconciliation (docs/bugs/0821).
//   transfer — the payment's live journal entry is claimed by a POSTED bank
//              statement line: its own posted_je_no, or a match row on it. A
//              match row on a line that is not POSTED is nobody's claim
//              (docs/bugs/0802).
//
// A card payment its merchant matched is not done until the report's money is
// in a bank (owner 2026-11-10: 如果merchant 对的上但bank 还有没有对的上要分开 …
// 因为可以是另外一笔卡着 → 做): booked bank credits must cover the report — Cash
// Flow's own rule, acc/card-in-bank inBankShares, so the two screens agree on
// what is in the bank. Until then it is CARD_NOT_IN_BANK, naming its report:
// still holding lines to reconcile (no bank line is offered it until every
// line is done — acc/bank loadPayableBatches), or done and its credit not
// matched, or paid in part.
//
// Not listed, on purpose:
//   cash      — it books to the cash account, which takes no statement, so
//               there is nothing to match it against;
//   imported  — AutoCount carry-overs, never booked here;
//   converted — money moved between two orders, not money received;
//   cancelled orders — the watch list's rule (owner 2026-09-12: cancel SO 就
//               cancel 不显示; docs/bugs/0837).
//
// The decision is `classifyUnmatched`, a pure function; `loadUnmatchedPayments`
// only gathers the facts it decides from. Every read fails CLOSED — a list
// that came back short because a read failed would say "matched" about money
// nobody has looked at.
// ----------------------------------------------------------------------------

import { chunkIn, paginateAll } from '../scm/lib/paginate-all';
import { PAYMENT_METHOD_CODES, type PaymentMethodCode } from '../scm/shared/payment-methods';
import { jeNosOf } from './bank';
import { inBankShares, paymentKey } from './card-in-bank';
import { keyedAs, merchantNamesOf } from './merchant-names';

export type PaymentSource = 'SOPAY' | 'SIPAY';

/** Where an unmatched payment is stuck — the screen words each one. */
export type UnmatchedState =
  /** No merchant report has reported it yet. */
  | 'CARD_NOT_REPORTED'
  /** A merchant report line claims it; nobody has confirmed that line. */
  | 'CARD_TO_CONFIRM'
  /** The merchant matched it (a confirmed line); the report's money is not in a bank yet. */
  | 'CARD_NOT_IN_BANK'
  /** Its bank is not one of this company's active merchants, so no report can ever claim it. */
  | 'CARD_NO_MERCHANT'
  /** The transfer has no live journal entry — the Self-check card's business. */
  | 'TRANSFER_NOT_BOOKED'
  /** The bank statement for its day is uploaded; no line is matched to it. */
  | 'TRANSFER_NOT_MATCHED'
  /** No bank statement covering its day has been uploaded yet. */
  | 'TRANSFER_NO_STATEMENT';

/** The merchant report a card payment's line is on, as the bank side sees it. */
export type UnmatchedReport = {
  batchId: number;
  fileName: string | null;
  acquirerCode: string;
  /** Its lines nobody has confirmed or set aside — while any, no bank line is offered it. */
  waitingLines: number;
  /** The share (0..1) of its money booked bank credits hold today. */
  bankShare: number;
};

export type UnmatchedPayment = {
  source: PaymentSource;
  paymentId: string;
  docNo: string;
  customerName: string | null;
  salespersonName: string | null;
  /** Who took the money — the payment's own collected_by (owner 2026-11-09: sales person
      应该不太对，应该是collected by 的人); null when nobody was recorded. */
  collectedByName: string | null;
  paidOn: string;
  kind: 'card' | 'transfer';
  /** card: the bank the payment was keyed with (null = none, 未标);
      transfer: its sub-type (TNG, Bank Transfer …). */
  channel: string | null;
  amountSen: number;
  /** The approval code or transfer reference keyed with it. */
  reference: string | null;
  ageDays: number;
  state: UnmatchedState;
  /** transfer: the money account its entry debits, and the last day that
      account's uploaded statements reach (null = none uploaded). */
  bankAccountCode: string | null;
  statementUpTo: string | null;
  /** card: the report its line is on, when a line claims it. */
  report: UnmatchedReport | null;
};

/** One recorded payment, as the classifier needs it. */
export type PaymentFact = {
  source: PaymentSource;
  id: string;
  docNo: string;
  customerName: string | null;
  salespersonName: string | null;
  collectedByName?: string | null;
  paidOn: string;
  method: string;
  merchantProvider: string | null;
  onlineType: string | null;
  amountSen: number;
  approvalCode: string | null;
};

/** What the two reconciliations have said, keyed `${source}:${id}` where a payment is meant. */
export type MatchFacts = {
  /** The merchant report line claiming a card payment: whether it is confirmed,
      its report, and the share of that report's money booked in a bank (absent
      = all of it, for a caller that does not read the bank). */
  cardClaims: Map<string, { confirmed: boolean; batchId?: number | null; bankShare?: number }>;
  /** The reports those lines are on, by batch id. */
  reports?: Map<number, Omit<UnmatchedReport, 'batchId' | 'bankShare'>>;
  /** Every name this company's ACTIVE merchants answer to — display names and
      their other names (Pinelabs, Public) — compared without case. */
  activeMerchants: Set<string>;
  /** A payment's live journal entry: its number and the money account it debits. */
  entries: Map<string, { jeNo: string; accountCode: string | null }>;
  /** Entry numbers a POSTED bank statement line claims. */
  onTheBank: Set<string>;
  /** Money account → the last day its uploaded statements cover. */
  statementUpTo: Map<string, string>;
};

const CARD_METHODS: ReadonlySet<string> = new Set<PaymentMethodCode>(['merchant', 'installment']);
/** The methods this list reads: every payment method (the ONE vocabulary,
    scm/shared/payment-methods) but cash, which has nothing to match — see the
    header. imported / converted are not payment methods there at all. */
export const LISTED_METHODS: readonly PaymentMethodCode[] = PAYMENT_METHOD_CODES.filter((m) => m !== 'cash');

export const dayGap = (from: string, to: string): number =>
  Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));

const tagOf = (v: string | null | undefined): string | null => {
  const t = String(v ?? '').trim();
  return t === '' ? null : t;
};

/** Every payment below that is not matched, oldest first — the one that has
    waited longest is the one to chase. */
export function classifyUnmatched(payments: readonly PaymentFact[], facts: MatchFacts, today: string): UnmatchedPayment[] {
  const out: UnmatchedPayment[] = [];
  for (const p of payments) {
    if (!(p.amountSen > 0)) continue;
    const key = `${p.source}:${p.id}`;
    const base = {
      source: p.source,
      paymentId: p.id,
      docNo: p.docNo,
      customerName: p.customerName,
      salespersonName: p.salespersonName,
      collectedByName: p.collectedByName ?? null,
      paidOn: p.paidOn,
      amountSen: p.amountSen,
      reference: tagOf(p.approvalCode),
      ageDays: dayGap(p.paidOn, today),
      report: null,
    };
    if (CARD_METHODS.has(p.method)) {
      const claim = facts.cardClaims.get(key);
      const tag = tagOf(p.merchantProvider);
      const on = claim?.batchId == null ? undefined : facts.reports?.get(claim.batchId);
      const report: UnmatchedReport | null = claim?.batchId != null && on
        ? { batchId: claim.batchId, ...on, bankShare: claim.bankShare ?? 1 }
        : null;
      if (claim?.confirmed) {
        if ((claim.bankShare ?? 1) >= 1) continue;
        out.push({ ...base, kind: 'card', channel: tag, state: 'CARD_NOT_IN_BANK', bankAccountCode: null, statementUpTo: null, report });
        continue;
      }
      /* A line already claims it: that decides, whatever the tag says now. An
         untagged payment is every merchant's candidate (couldBeAcquirers), so
         only a tag NO active merchant carries means no report can ever take it. */
      const state: UnmatchedState = claim ? 'CARD_TO_CONFIRM'
        : tag !== null && !keyedAs(tag, [...facts.activeMerchants]) ? 'CARD_NO_MERCHANT'
        : 'CARD_NOT_REPORTED';
      out.push({ ...base, kind: 'card', channel: tag, state, bankAccountCode: null, statementUpTo: null, report: claim ? report : null });
      continue;
    }
    if (p.method !== 'transfer') continue;
    const entry = facts.entries.get(key);
    if (!entry) {
      out.push({ ...base, kind: 'transfer', channel: tagOf(p.onlineType), state: 'TRANSFER_NOT_BOOKED', bankAccountCode: null, statementUpTo: null });
      continue;
    }
    if (facts.onTheBank.has(entry.jeNo)) continue;
    const upTo = entry.accountCode ? (facts.statementUpTo.get(entry.accountCode) ?? null) : null;
    out.push({
      ...base,
      kind: 'transfer',
      channel: tagOf(p.onlineType),
      state: upTo != null && upTo >= p.paidOn ? 'TRANSFER_NOT_MATCHED' : 'TRANSFER_NO_STATEMENT',
      bankAccountCode: entry.accountCode,
      statementUpTo: upTo,
    });
  }
  return out.sort((a, b) => b.ageDays - a.ageDays || a.docNo.localeCompare(b.docNo));
}

/* ── The reads ──────────────────────────────────────────────────────────── */

type Fail = { ok: false; reason: string };
type Rows = Array<Record<string, any>>;

const isoDay = (v: unknown): string => String(v ?? '').slice(0, 10);

/** Both payment tables, in the window, the listed methods only — paged, so
    the 1000-row ceiling cannot quietly shorten the list. */
async function readPayments(sb: any, companyId: number, from: string, to: string): Promise<{ ok: true; so: Rows; si: Rows } | Fail> {
  const cols = 'id, paid_at, amount_sen, approval_code, method, merchant_provider, online_type, collected_by';
  const so = await paginateAll<Record<string, any>>((lo, hi) => sb.from('mfg_sales_order_payments')
    .select(`${cols}, so_doc_no`)
    .eq('company_id', companyId)
    .in('method', [...LISTED_METHODS])
    .gte('paid_at', from).lte('paid_at', `${to}T23:59:59.999`)
    .order('id').range(lo, hi));
  if (so.error) return { ok: false, reason: `SO payments: ${so.error.message}` };
  const si = await paginateAll<Record<string, any>>((lo, hi) => sb.from('sales_invoice_payments')
    .select(`${cols}, sales_invoice_id`)
    .eq('company_id', companyId)
    .in('method', [...LISTED_METHODS])
    .gte('paid_at', from).lte('paid_at', `${to}T23:59:59.999`)
    .order('id').range(lo, hi));
  if (si.error) return { ok: false, reason: `SI payments: ${si.error.message}` };
  return { ok: true, so: so.data ?? [], si: si.data ?? [] };
}

/** Whose sale each payment is — the order's customer, status and salesperson,
    the invoice's number and customer — and the names of the salespeople and of
    whoever collected each payment (the payment's own collected_by). */
async function readParties(sb: any, companyId: number, so: Rows, si: Rows): Promise<{
  ok: true; orders: Map<string, { customer: string | null; cancelled: boolean; salesperson: string | null }>;
  invoices: Map<string, { number: string | null; customer: string | null }>;
  staffName: Map<string, string>;
} | Fail> {
  const docs = [...new Set(so.map((r) => String(r.so_doc_no ?? '')).filter(Boolean))];
  const orderRows = await chunkIn<Record<string, any>>(docs, (batch, lo, hi) => sb.from('mfg_sales_orders')
    .select('doc_no, debtor_name, status, salesperson_id') // debtor_name — docs/bugs/0655
    .eq('company_id', companyId).in('doc_no', batch).order('doc_no').range(lo, hi));
  if (orderRows.error) return { ok: false, reason: `orders: ${orderRows.error.message}` };

  const staffIds = [...new Set([
    ...orderRows.data.map((r) => String(r.salesperson_id ?? '')),
    ...[...so, ...si].map((r) => String(r.collected_by ?? '')),
  ].filter(Boolean))];
  const staffRows = await chunkIn<Record<string, any>>(staffIds, (batch, lo, hi) => sb.from('staff')
    .select('id, name').in('id', batch).order('id').range(lo, hi));
  if (staffRows.error) return { ok: false, reason: `staff: ${staffRows.error.message}` };
  const nameOf = new Map(staffRows.data.filter((r) => r.name).map((r) => [String(r.id), String(r.name)]));

  const orders = new Map<string, { customer: string | null; cancelled: boolean; salesperson: string | null }>();
  for (const r of orderRows.data) {
    orders.set(String(r.doc_no), {
      customer: r.debtor_name ?? null,
      cancelled: String(r.status ?? '').toUpperCase() === 'CANCELLED',
      salesperson: nameOf.get(String(r.salesperson_id ?? '')) ?? null,
    });
  }

  const invoiceIds = [...new Set(si.map((r) => String(r.sales_invoice_id ?? '')).filter(Boolean))];
  const invoiceRows = await chunkIn<Record<string, any>>(invoiceIds, (batch, lo, hi) => sb.from('sales_invoices')
    .select('id, invoice_number, debtor_name')
    .eq('company_id', companyId).in('id', batch).order('id').range(lo, hi));
  if (invoiceRows.error) return { ok: false, reason: `invoices: ${invoiceRows.error.message}` };
  const invoices = new Map(invoiceRows.data.map((r) => [String(r.id), { number: r.invoice_number ?? null, customer: r.debtor_name ?? null }]));
  return { ok: true, orders, invoices, staffName: nameOf };
}

/** What Merchant Recon has said about the card payments: which line claims
    each one, whether that line is confirmed, and which merchants are active —
    and, for the report each line is on, its lines still waiting and the share
    of its money booked in a bank by `today` (Cash Flow's rule). */
async function readCardFacts(sb: any, companyId: number, cardIds: string[], today: string): Promise<{
  ok: true; cardClaims: MatchFacts['cardClaims']; activeMerchants: MatchFacts['activeMerchants']; reports: NonNullable<MatchFacts['reports']>;
} | Fail> {
  const { data: acq, error: acqErr } = await sb.from('acc_acquirers')
    .select('display_name, so_names').eq('company_id', companyId).eq('is_active', true);
  if (acqErr) return { ok: false, reason: `merchants: ${acqErr.message}` };
  /* Every name an active merchant answers to — a payment keyed "Pinelabs" is
     AEON's, not "a merchant nobody set up" (owner 2026-10-21). */
  const activeMerchants = new Set(((acq ?? []) as Rows).flatMap((a) => merchantNamesOf({
    display_name: String(a.display_name ?? ''),
    so_names: Array.isArray(a.so_names) ? (a.so_names as string[]) : [],
  })));

  const links = await chunkIn<Record<string, any>>(cardIds, (batch, lo, hi) => sb.from('acc_settlement_matches')
    .select('payment_source, payment_id, settlement_row_id')
    .eq('company_id', companyId).in('payment_id', batch).order('payment_id').range(lo, hi));
  if (links.error) return { ok: false, reason: `settlement links: ${links.error.message}` };
  const rowIds = [...new Set(links.data.map((l) => Number(l.settlement_row_id)).filter((n) => Number.isInteger(n)))];
  const lines = await chunkIn<Record<string, any>, number>(rowIds, (batch, lo, hi) => sb.from('acc_settlement_rows')
    .select('id, batch_id, confirmed_at, posted_je_no')
    .eq('company_id', companyId).in('id', batch).order('id').range(lo, hi));
  if (lines.error) return { ok: false, reason: `settlement lines: ${lines.error.message}` };
  /* Confirmed = its fee is booked: confirmed_at, or the entry it posted —
     the same test acc/payment-reconciled applies before it locks a payment. */
  const confirmedLine = new Set(lines.data
    .filter((r) => r.confirmed_at != null || r.posted_je_no != null)
    .map((r) => Number(r.id)));
  const batchOfLine = new Map(lines.data.map((r) => [Number(r.id), Number(r.batch_id)]));

  /* The reports those lines are on: their own lines (what still waits), what
     each pays and the bank credits booked against it. */
  const batchIds = [...new Set([...batchOfLine.values()].filter((n) => Number.isInteger(n)))];
  const [batchRows, receiptRows, reportLines, dayRows] = await Promise.all([
    chunkIn<Record<string, any>, number>(batchIds, (batch, lo, hi) => sb.from('acc_settlement_batches')
      .select('id, file_name, acquirer_code, stated_net_sen, net_sen')
      .eq('company_id', companyId).in('id', batch).order('id').range(lo, hi)),
    chunkIn<Record<string, any>, number>(batchIds, (batch, lo, hi) => sb.from('acc_settlement_receipts')
      .select('id, batch_id, received_on, amount_sen, charge_sen, je_no')
      .eq('company_id', companyId).in('batch_id', batch).order('id').range(lo, hi)),
    chunkIn<Record<string, any>, number>(batchIds, (batch, lo, hi) => sb.from('acc_settlement_rows')
      .select('id, batch_id, confirmed_at, bucket')
      .eq('company_id', companyId).in('batch_id', batch).order('id').range(lo, hi)),
    /* What the bank kept off a payout, booked on its advice day (acc/card-in-bank). */
    chunkIn<Record<string, any>, number>(batchIds, (batch, lo, hi) => sb.from('acc_settlement_payout_batches')
      .select('id, batch_id, charge_sen, charge_je_no')
      .eq('company_id', companyId).in('batch_id', batch).order('id').range(lo, hi)),
  ]);
  if (batchRows.error) return { ok: false, reason: `merchant reports: ${batchRows.error.message}` };
  if (receiptRows.error) return { ok: false, reason: `merchant report credits: ${receiptRows.error.message}` };
  if (reportLines.error) return { ok: false, reason: `merchant report lines: ${reportLines.error.message}` };
  if (dayRows.error) return { ok: false, reason: `merchant advice days: ${dayRows.error.message}` };
  const shares = inBankShares({
    matches: links.data.map((l) => ({ payment_source: String(l.payment_source), payment_id: String(l.payment_id), settlement_row_id: Number(l.settlement_row_id) })),
    rows: lines.data.map((r) => ({ id: Number(r.id), batch_id: Number(r.batch_id), confirmed_at: r.confirmed_at ?? null })),
    batches: batchRows.data.map((b) => ({
      id: Number(b.id),
      stated_net_sen: b.stated_net_sen == null ? null : Number(b.stated_net_sen),
      net_sen: b.net_sen == null ? null : Number(b.net_sen),
    })),
    receipts: receiptRows.data.map((r) => ({
      batch_id: Number(r.batch_id), received_on: String(r.received_on ?? ''), amount_sen: Number(r.amount_sen ?? 0),
      charge_sen: r.charge_sen == null ? null : Number(r.charge_sen), je_no: r.je_no ?? null,
    })),
    dayCharges: dayRows.data.map((d) => ({
      batch_id: Number(d.batch_id), charge_sen: d.charge_sen == null ? null : Number(d.charge_sen), charge_je_no: d.charge_je_no ?? null,
    })),
  }, today);
  const waiting = new Map<number, number>();
  for (const r of reportLines.data) {
    if (r.confirmed_at != null || String(r.bucket ?? '') === 'IGNORED') continue;
    waiting.set(Number(r.batch_id), (waiting.get(Number(r.batch_id)) ?? 0) + 1);
  }
  const reports: NonNullable<MatchFacts['reports']> = new Map(batchRows.data.map((b) => [Number(b.id), {
    fileName: b.file_name == null ? null : String(b.file_name),
    acquirerCode: String(b.acquirer_code ?? ''),
    waitingLines: waiting.get(Number(b.id)) ?? 0,
  }]));

  const cardClaims: MatchFacts['cardClaims'] = new Map();
  for (const l of links.data) {
    const key = `${String(l.payment_source)}:${String(l.payment_id)}`;
    const confirmed = confirmedLine.has(Number(l.settlement_row_id));
    const had = cardClaims.get(key);
    /* Two links for one payment would be a data fault; either confirmed wins. */
    if (had?.confirmed && !confirmed) continue;
    const batchId = batchOfLine.get(Number(l.settlement_row_id));
    cardClaims.set(key, {
      confirmed: confirmed || (had?.confirmed ?? false),
      batchId: batchId === undefined || !Number.isInteger(batchId) ? null : batchId,
      bankShare: shares.get(paymentKey(String(l.payment_source), String(l.payment_id))) ?? 0,
    });
  }
  return { ok: true, cardClaims, activeMerchants, reports };
}

/** What Bank Recon has said about the transfers: each one's live entry and
    money account, which entries a POSTED statement line claims, and how far
    each account's uploaded statements reach. */
async function readTransferFacts(sb: any, companyId: number, transferKeys: Array<{ source: PaymentSource; id: string }>): Promise<{
  ok: true; entries: MatchFacts['entries']; onTheBank: MatchFacts['onTheBank']; statementUpTo: MatchFacts['statementUpTo'];
} | Fail> {
  const ids = [...new Set(transferKeys.map((k) => k.id))];
  const jeRows = await chunkIn<Record<string, any>>(ids, (batch, lo, hi) => sb.from('journal_entries')
    .select('id, je_no, source_type, source_doc_no, reversed')
    .eq('company_id', companyId).in('source_type', ['SOPAY', 'SIPAY']).in('source_doc_no', batch)
    .eq('posted', true).order('je_no').range(lo, hi));
  if (jeRows.error) return { ok: false, reason: `entries: ${jeRows.error.message}` };
  /* `reversed` is read in JavaScript, not filtered in the query: it is absent
     on a freshly inserted row in the fake client (see acc/payment-reconciled). */
  const live = jeRows.data.filter((r) => !r.reversed);

  const lineRows = await chunkIn<Record<string, any>>(live.map((r) => String(r.id)), (batch, lo, hi) => sb.from('journal_entry_lines')
    .select('journal_entry_id, account_code, debit_sen')
    .in('journal_entry_id', batch).order('journal_entry_id').range(lo, hi));
  if (lineRows.error) return { ok: false, reason: `entry lines: ${lineRows.error.message}` };
  /* The MONEY leg is the debit — the credit is Trade Debtors, never a bank. */
  const moneyOf = new Map<string, string>();
  for (const l of lineRows.data) {
    const id = String(l.journal_entry_id);
    if (Number(l.debit_sen ?? 0) > 0 && !moneyOf.has(id)) moneyOf.set(id, String(l.account_code));
  }
  const entries: MatchFacts['entries'] = new Map();
  for (const r of live) {
    entries.set(`${String(r.source_type)}:${String(r.source_doc_no)}`, { jeNo: String(r.je_no), accountCode: moneyOf.get(String(r.id)) ?? null });
  }

  /* Claimed by a POSTED line — through a match row, or named on the line itself. */
  const jeNos = [...new Set(live.map((r) => String(r.je_no)))];
  const matchRows = await chunkIn<Record<string, any>>(jeNos, (batch, lo, hi) => sb.from('acc_bank_statement_matches')
    .select('je_no, bank_line_id').eq('company_id', companyId).in('je_no', batch).order('bank_line_id').range(lo, hi));
  if (matchRows.error) return { ok: false, reason: `bank matches: ${matchRows.error.message}` };
  const matchedLineIds = [...new Set(matchRows.data.map((m) => Number(m.bank_line_id)).filter((n) => Number.isInteger(n)))];
  const matchedLines = await chunkIn<Record<string, any>, number>(matchedLineIds, (batch, lo, hi) => sb.from('acc_bank_statement_lines')
    .select('id, state').eq('company_id', companyId).in('id', batch).order('id').range(lo, hi));
  if (matchedLines.error) return { ok: false, reason: `bank lines: ${matchedLines.error.message}` };
  const postedLine = new Set(matchedLines.data.filter((l) => String(l.state) === 'POSTED').map((l) => Number(l.id)));
  const onTheBank = new Set<string>();
  for (const m of matchRows.data) if (postedLine.has(Number(m.bank_line_id))) onTheBank.add(String(m.je_no));

  const named = await paginateAll<Record<string, any>>((lo, hi) => sb.from('acc_bank_statement_lines')
    .select('posted_je_no').eq('company_id', companyId).eq('state', 'POSTED').not('posted_je_no', 'is', null)
    .order('id').range(lo, hi));
  if (named.error) return { ok: false, reason: `bank lines: ${named.error.message}` };
  for (const l of named.data ?? []) for (const n of jeNosOf(l.posted_je_no)) onTheBank.add(n);

  const statements = await paginateAll<Record<string, any>>((lo, hi) => sb.from('acc_bank_statements')
    .select('account_code, period_to').eq('company_id', companyId).order('id').range(lo, hi));
  if (statements.error) return { ok: false, reason: `bank statements: ${statements.error.message}` };
  const statementUpTo: MatchFacts['statementUpTo'] = new Map();
  for (const s of statements.data ?? []) {
    const account = String(s.account_code ?? '');
    const to = isoDay(s.period_to);
    if (!account || !/^\d{4}-\d{2}-\d{2}$/.test(to)) continue;
    const had = statementUpTo.get(account);
    if (had == null || to > had) statementUpTo.set(account, to);
  }
  return { ok: true, entries, onTheBank, statementUpTo };
}

/** Every card and transfer payment dated in [from, to] that is not matched yet. */
export async function loadUnmatchedPayments(
  sb: any,
  companyId: number,
  window: { from: string; to: string; today: string },
): Promise<{ ok: true; rows: UnmatchedPayment[] } | Fail> {
  const pay = await readPayments(sb, companyId, window.from, window.to);
  if (!pay.ok) return pay;
  const parties = await readParties(sb, companyId, pay.so, pay.si);
  if (!parties.ok) return parties;

  const facts: PaymentFact[] = [];
  const take = (source: PaymentSource, r: Record<string, any>, docNo: string, customer: string | null, salesperson: string | null) => {
    const paidOn = isoDay(r.paid_at);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) return;
    facts.push({
      source, id: String(r.id), docNo, customerName: customer, salespersonName: salesperson,
      collectedByName: parties.staffName.get(String(r.collected_by ?? '')) ?? null, paidOn,
      method: String(r.method ?? ''), merchantProvider: r.merchant_provider ?? null, onlineType: r.online_type ?? null,
      amountSen: Number(r.amount_sen ?? 0), approvalCode: r.approval_code ?? null,
    });
  };
  for (const r of pay.so) {
    const doc = String(r.so_doc_no ?? '');
    const order = parties.orders.get(doc);
    if (order?.cancelled) continue;
    take('SOPAY', r, doc, order?.customer ?? null, order?.salesperson ?? null);
  }
  for (const r of pay.si) {
    const inv = parties.invoices.get(String(r.sales_invoice_id ?? ''));
    /* The invoice NUMBER when it resolves — a uuid is nobody's document reference. */
    take('SIPAY', r, inv?.number ?? String(r.sales_invoice_id ?? ''), inv?.customer ?? null, null);
  }

  const cardIds = [...new Set(facts.filter((f) => CARD_METHODS.has(f.method)).map((f) => f.id))];
  const transferKeys = facts.filter((f) => f.method === 'transfer').map((f) => ({ source: f.source, id: f.id }));
  const card = cardIds.length > 0
    ? await readCardFacts(sb, companyId, cardIds, window.today)
    : { ok: true as const, cardClaims: new Map(), activeMerchants: new Set<string>(), reports: new Map() };
  if (!card.ok) return card;
  const bank = transferKeys.length > 0
    ? await readTransferFacts(sb, companyId, transferKeys)
    : { ok: true as const, entries: new Map(), onTheBank: new Set<string>(), statementUpTo: new Map() };
  if (!bank.ok) return bank;

  return {
    ok: true,
    rows: classifyUnmatched(facts, {
      cardClaims: card.cardClaims,
      activeMerchants: card.activeMerchants,
      reports: card.reports,
      entries: bank.entries,
      onTheBank: bank.onTheBank,
      statementUpTo: bank.statementUpTo,
    }, window.today),
  };
}
