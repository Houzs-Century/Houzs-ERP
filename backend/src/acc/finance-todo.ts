// ----------------------------------------------------------------------------
// acc/finance-todo — Finance's To do, built from facts already read (the
// owner's Claude Design project "Finance 模块重新设计", Finance-1a-To-do,
// 2026-11-02 —「帮我读这个和做」).
//
// The design's built-in rules raise every job from the live books; nobody
// types them. This file is the rules and nothing else: the reads live in
// scm/routes/accounting-todo.ts, so a test can hand the facts in and read the
// page back. Each job says what it is, how long it has waited (`since`) and
// where it is handled.
//
// Whose desk a job is on: the Finance rules (merchant reports, bank
// statements, payment requests, transfers, overdue invoices) are on anyone who
// works Finance. A voucher to check or approve is on the people whose ROLE
// grants that key (the owner's 2026-09-09 rule — the `*` wildcard can do it
// but is not told it is theirs), unless nobody in the company holds it that
// way, when it is on whoever may do it. Everyone else sees it under
// "Waiting on others", with who it waits for.
// ----------------------------------------------------------------------------

import { fmtDate } from '../scm/shared/format';

export type TodoRule =
  | 'card-missing' | 'card-matched' | 'card-choose'
  | 'bank-missing' | 'bank-decide'
  | 'requests' | 'pv-check' | 'pv-approve'
  | 'transfers' | 'selfcheck' | 'overdue';

export type TodoGroup = 'recon' | 'pay' | 'other' | 'misc';
export type TodoTone = 'cards' | 'bank' | 'out' | 'money' | 'err' | 'routine' | 'manual';
export type TodoIcon =
  | 'upload' | 'credit-card' | 'landmark' | 'send' | 'wallet' | 'receipt'
  | 'alert-triangle' | 'calendar-days' | 'pen-line' | 'file-text' | 'hand-coins';

export type TodoJob = {
  key: string;
  rule: TodoRule;
  group: TodoGroup;
  sub: 'merchant' | 'bank' | null;
  tone: TodoTone;
  icon: TodoIcon;
  title: string;
  detail: string;
  amountSen: number | null;
  since: string | null;
  action: { label: string; to: string; primary: boolean };
  who: string | null;
};

export type TodoDone = { key: string; text: string; je: string | null; at: string };
export type TodoCheck = { key: string; label: string; value: string; state: 'ok' | 'open' | 'late'; to: string | null };

export type FinanceTodo = {
  today: string;
  mine: TodoJob[];
  others: TodoJob[];
  done: TodoDone[];
  money: { bankCashSen: number; awaitingSen: number; onTheWaySen: number } | null;
  checklist: { month: string; daysLeft: number; items: TodoCheck[] };
  problems: string[];
};

/* ── The facts the rules read ─────────────────────────────────────────────── */

export type TodoAcquirer = { code: string; name: string; hasUniqueRef: boolean };

/** A merchant-report line nobody has confirmed yet. */
export type TodoCardRow = {
  acquirer: string;
  batchId: number;
  bucket: 'MATCHED' | 'NEEDS_CONFIRM' | 'UNMATCHED';
  byReference: boolean;
  grossSen: number;
  txnDate: string;
  /** The day its report was uploaded (MYT). */
  uploadedOn: string;
};

export type TodoBankAccount = { accountCode: string; bankCode: string; accountName: string; createdOn: string };

/** A statement line still OPEN, in a month that is not locked. */
export type TodoBankLine = { accountCode: string; statementId: number; amountSen: number; periodTo: string | null; uploadedOn: string };

export type TodoRequest = { payee: string; amountSen: number; createdOn: string };
export type TodoVoucher = { stage: 'check' | 'approve'; payee: string; amountSen: number; since: string; by: string | null };
export type TodoTransfer = { amountSen: number; paidOn: string | null };
export type TodoOverdue = { invoiceNo: string; debtor: string; outstandingSen: number; dueDate: string };

export type TodoFacts = {
  today: string;
  acquirers: TodoAcquirer[];
  /** Each active acquirer's last report day, or null when none was ever uploaded. */
  lastReportTo: Record<string, string | null>;
  /** The days before today, after its last report, a card payment was keyed under the acquirer's name. */
  keyedCardDays: Record<string, string[]>;
  cardRows: TodoCardRow[];
  bankAccounts: TodoBankAccount[];
  lastStatementTo: Record<string, string | null>;
  bankLines: TodoBankLine[];
  /** Accounts whose LAST month is locked. */
  lockedLastMonth: string[];
  requests: TodoRequest[];
  vouchers: TodoVoucher[];
  transfers: TodoTransfer[];
  overdue: TodoOverdue[];
  money: FinanceTodo['money'];
  done: TodoDone[];
  problems: string[];
};

export type TodoViewer = {
  /** Works Finance (prepares or posts vouchers): the Finance rules are theirs. */
  finance: boolean;
  /** Whose desk checking / approving is on, and the names to show when it is not the viewer's. */
  checker: boolean;
  approver: boolean;
  checkerNames: string[];
  approverNames: string[];
};

/* ── Small helpers ───────────────────────────────────────────────────────── */

const DAY_MS = 86_400_000;
export const addDays = (ymd: string, n: number): string =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/** YYYY/MM/DD — the ERP's date everywhere. */
/** The ERP's one date format (YYYY/MM/DD). */
export const showDate = (ymd: string): string => fmtDate(ymd);
const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);
const minDay = (days: Array<string | null | undefined>): string | null =>
  days.filter((d): d is string => !!d).sort()[0] ?? null;
const sum = (xs: number[]): number => xs.reduce((n, x) => n + x, 0);
const dayRange = (days: string[]): string => {
  const s = [...new Set(days)].sort();
  if (s.length === 0) return '';
  return s.length === 1 ? showDate(s[0]!) : `${showDate(s[0]!)} – ${showDate(s[s.length - 1]!)}`;
};
/** A month by its name ("October") — a period, not a date. */
const monthOf = (ymd: string): string =>
  new Date(`${ymd.slice(0, 7)}-01T00:00:00Z`).toLocaleString('en-MY', { month: 'long', timeZone: 'UTC' });
/** The first three, then how many more — a detail line stays one line. */
const firstFew = (names: string[], n = 3): string => {
  const uniq = [...new Set(names.filter(Boolean))];
  return uniq.length > n ? `${uniq.slice(0, n).join(' · ')} · +${uniq.length - n} more` : uniq.join(' · ');
};

/** How the bank names itself to the people who use it (the setup carries only its code). */
const BANK_NAMES: Record<string, string> = {
  MBB: 'Maybank', MAYBANK: 'Maybank', HLB: 'Hong Leong', PBB: 'Public Bank', PBE: 'Public Bank',
  CIMB: 'CIMB', UOB: 'UOB', ALLIANCE: 'Alliance', ABB: 'Alliance', ABMB: 'Alliance', RHB: 'RHB',
  AMB: 'AmBank', AMBANK: 'AmBank', OCBC: 'OCBC', HSBC: 'HSBC', BIMB: 'Bank Islam', BSN: 'BSN',
  AFFIN: 'Affin', MUAMALAT: 'Muamalat', AGRO: 'Agrobank', RAKYAT: 'Bank Rakyat', SCB: 'Standard Chartered',
};
export const bankName = (code: string): string => BANK_NAMES[code.trim().toUpperCase()] ?? code.trim();

const MERCHANT_PAGE = '/scm/merchant-recon';
const BANK_PAGE = '/scm/bank-recon';

/** A report's lines open in Merchant reports at that report when they are all one report. */
const merchantLink = (batchIds: number[]): string => {
  const ids = [...new Set(batchIds)];
  return ids.length === 1 ? `${MERCHANT_PAGE}?batch=${ids[0]}` : MERCHANT_PAGE;
};

/* ── The rules ───────────────────────────────────────────────────────────── */

type Raised = Omit<TodoJob, 'who'> & { desk: 'finance' | 'checker' | 'approver' };

function cardJobs(f: TodoFacts): Raised[] {
  const out: Raised[] = [];
  for (const a of f.acquirers) {
    /* card-missing — swipes keyed on an order with no report after them by the next morning. */
    const days = [...new Set(f.keyedCardDays[a.code] ?? [])].sort();
    if (days.length > 0) {
      out.push({
        key: `card-missing:${a.code}`, rule: 'card-missing', group: 'recon', sub: 'merchant', tone: 'cards', icon: 'upload',
        title: `Upload ${a.name} merchant report`,
        detail: `Swipes of ${dayRange(days)} not in yet · their lines appear here after upload`,
        amountSen: null, since: addDays(days[0]!, 1),
        action: { label: 'Upload', to: MERCHANT_PAGE, primary: true }, desk: 'finance',
      });
    }
    const rows = f.cardRows.filter((r) => r.acquirer === a.code);
    /* card-matched — lines matched to an order, waiting for a confirm. */
    const matched = rows.filter((r) => r.bucket === 'MATCHED');
    if (matched.length > 0) {
      const byRef = matched.every((r) => r.byReference);
      out.push({
        key: `card-matched:${a.code}`, rule: 'card-matched', group: 'recon', sub: 'merchant', tone: 'cards', icon: 'credit-card',
        title: `Confirm ${matched.length} merchant ${plural(matched.length, 'line')}`,
        detail: `${a.name} report · swiped ${dayRange(matched.map((r) => r.txnDate))} · ${byRef ? 'every line matched by reference' : 'every line matched to an order'}`,
        amountSen: sum(matched.map((r) => r.grossSen)), since: minDay(matched.map((r) => r.uploadedOn)),
        action: { label: 'Confirm', to: merchantLink(matched.map((r) => r.batchId)), primary: true }, desk: 'finance',
      });
    }
    /* card-choose — lines that fit more than one order, or none. */
    const choose = rows.filter((r) => r.bucket !== 'MATCHED');
    if (choose.length > 0) {
      out.push({
        key: `card-choose:${a.code}`, rule: 'card-choose', group: 'recon', sub: 'merchant', tone: 'cards', icon: 'credit-card',
        title: `Choose payments for ${choose.length} ${a.name} merchant ${plural(choose.length, 'line')}`,
        detail: `${a.name} report · swiped ${dayRange(choose.map((r) => r.txnDate))} · ${a.hasUniqueRef
          ? 'lines that fit more than one order, or none'
          : `${a.name} lines never match on their own, so each one is picked by amount and date`}`,
        amountSen: sum(choose.map((r) => r.grossSen)), since: minDay(choose.map((r) => r.uploadedOn)),
        action: { label: 'Open', to: merchantLink(choose.map((r) => r.batchId)), primary: false }, desk: 'finance',
      });
    }
  }
  return out;
}

/** A bank account with no statement for 3 days (the design's rule). */
export const STATEMENT_GRACE_DAYS = 3;

function bankMissing(f: TodoFacts): TodoBankAccount[] {
  const cutoff = addDays(f.today, -STATEMENT_GRACE_DAYS);
  return f.bankAccounts.filter((b) => {
    const last = f.lastStatementTo[b.accountCode] ?? null;
    return last == null || last < cutoff;
  });
}

function bankJobs(f: TodoFacts): Raised[] {
  const out: Raised[] = [];
  for (const b of bankMissing(f)) {
    const last = f.lastStatementTo[b.accountCode] ?? null;
    out.push({
      key: `bank-missing:${b.accountCode}`, rule: 'bank-missing', group: 'recon', sub: 'bank', tone: 'bank', icon: 'upload',
      title: `Upload ${bankName(b.bankCode)} statement`,
      detail: last
        ? `${b.accountCode} ${b.accountName} · the last upload stops at ${showDate(last)} · ${showDate(addDays(last, 1))} onward is missing`
        : `${b.accountCode} ${b.accountName} · no statement uploaded yet`,
      amountSen: null, since: last ? addDays(last, 1) : b.createdOn,
      action: { label: 'Upload', to: BANK_PAGE, primary: true }, desk: 'finance',
    });
  }
  for (const b of f.bankAccounts) {
    const lines = f.bankLines.filter((l) => l.accountCode === b.accountCode);
    if (lines.length === 0) continue;
    const statements = [...new Set(lines.map((l) => l.statementId))];
    const months = [...new Set(lines.map((l) => l.periodTo).filter((d): d is string => !!d).map(monthOf))];
    const first = lines.find((l) => l.statementId === statements[0])!;
    out.push({
      key: `bank-decide:${b.accountCode}`, rule: 'bank-decide', group: 'recon', sub: 'bank', tone: 'bank', icon: 'landmark',
      title: `Decide ${lines.length} ${bankName(b.bankCode)} ${plural(lines.length, 'line')}`,
      detail: statements.length === 1
        ? `${b.accountCode} · ${first.periodTo ? `${monthOf(first.periodTo)} statement` : 'statement'} · uploaded ${showDate(first.uploadedOn)}`
        : `${b.accountCode} · ${statements.length} statements${months.length ? ` · ${months.join(', ')}` : ''}`,
      amountSen: sum(lines.map((l) => Math.abs(l.amountSen))), since: minDay(lines.map((l) => l.uploadedOn)),
      action: { label: 'Match', to: BANK_PAGE, primary: false }, desk: 'finance',
    });
  }
  return out;
}

function paymentJobs(f: TodoFacts): Raised[] {
  const out: Raised[] = [];
  const n = f.requests.length;
  if (n > 0) {
    out.push({
      key: 'requests', rule: 'requests', group: 'pay', sub: null, tone: 'out', icon: 'send',
      title: n === 1 ? 'Turn 1 payment request into a voucher' : `Turn ${n} payment requests into vouchers`,
      detail: firstFew(f.requests.map((r) => r.payee)),
      amountSen: sum(f.requests.map((r) => r.amountSen)), since: minDay(f.requests.map((r) => r.createdOn)),
      action: { label: 'Review', to: '/scm/payment-requests?filter=waiting', primary: true }, desk: 'finance',
    });
  }
  const check = f.vouchers.filter((v) => v.stage === 'check');
  if (check.length > 0) {
    const by = [...new Set(check.map((v) => v.by).filter((x): x is string => !!x))];
    out.push({
      key: 'pv-check', rule: 'pv-check', group: 'pay', sub: null, tone: 'out', icon: 'wallet',
      title: `Check ${check.length} payment ${plural(check.length, 'voucher')}`,
      detail: `${by.length ? `Prepared by ${by.join(', ')}` : 'Prepared'} · ${firstFew(check.map((v) => v.payee))}`,
      amountSen: sum(check.map((v) => v.amountSen)), since: minDay(check.map((v) => v.since)),
      action: { label: 'Check', to: '/scm/payment-vouchers?status=PREPARED', primary: false }, desk: 'checker',
    });
  }
  const approve = f.vouchers.filter((v) => v.stage === 'approve');
  if (approve.length > 0) {
    const by = [...new Set(approve.map((v) => v.by).filter((x): x is string => !!x))];
    out.push({
      key: 'pv-approve', rule: 'pv-approve', group: 'pay', sub: null, tone: 'out', icon: 'wallet',
      title: `Approve ${approve.length} payment ${plural(approve.length, 'voucher')}`,
      detail: `${by.length ? `Checked by ${by.join(', ')}` : 'Checked'} · ${firstFew(approve.map((v) => v.payee))}`,
      amountSen: sum(approve.map((v) => v.amountSen)), since: minDay(approve.map((v) => v.since)),
      action: { label: 'Approve', to: '/scm/payment-vouchers?status=CHECKED', primary: true }, desk: 'approver',
    });
  }
  return out;
}

function otherJobs(f: TodoFacts): Raised[] {
  const out: Raised[] = [];
  const t = f.transfers.length;
  if (t > 0) {
    out.push({
      key: 'transfers', rule: 'transfers', group: 'other', sub: null, tone: 'money', icon: 'receipt',
      title: `Confirm ${t} ${plural(t, 'transfer')} arrived`,
      detail: 'Official receipts stay draft until the money is seen',
      amountSen: sum(f.transfers.map((x) => x.amountSen)), since: minDay(f.transfers.map((x) => x.paidOn)),
      action: { label: 'Review', to: '/scm/official-receipts', primary: false }, desk: 'finance',
    });
  }
  const o = f.overdue.length;
  if (o > 0) {
    out.push({
      key: 'overdue', rule: 'overdue', group: 'other', sub: null, tone: 'money', icon: 'hand-coins',
      title: `${o} customer ${plural(o, 'invoice')} more than ${OVERDUE_DAYS} days overdue`,
      detail: firstFew([...f.overdue].sort((a, b) => a.dueDate.localeCompare(b.dueDate)).map((x) => `${x.invoiceNo} ${x.debtor}`.trim())),
      amountSen: sum(f.overdue.map((x) => x.outstandingSen)),
      /* An invoice joins the list the day it passes 30 days late. */
      since: addDays(minDay(f.overdue.map((x) => x.dueDate))!, OVERDUE_DAYS + 1),
      action: { label: 'Open', to: '/scm/accounting?tab=ar', primary: false }, desk: 'finance',
    });
  }
  return out;
}

/** Customer invoices more than this many days past due (the design's rule). */
export const OVERDUE_DAYS = 30;

/* ── The month's checklist ──────────────────────────────────────────────── */

const lastDayOfMonth = (ymd: string): number => {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

function checklist(f: TodoFacts, jobs: Raised[]): FinanceTodo['checklist'] {
  const missingReports = jobs.filter((j) => j.rule === 'card-missing').length;
  const cardOpen = f.cardRows.length;
  const accounts = f.bankAccounts.length;
  const statementsIn = accounts - bankMissing(f).length;
  const bankOpen = f.bankLines.length;
  const prevMonth = addDays(`${f.today.slice(0, 7)}-01`, -1);
  const locked = f.bankAccounts.filter((b) => f.lockedLastMonth.includes(b.accountCode)).length;
  const toCheck = f.vouchers.filter((v) => v.stage === 'check').length;
  const toApprove = f.vouchers.filter((v) => v.stage === 'approve').length;
  const items: TodoCheck[] = [
    { key: 'reports-in', label: 'Merchant reports in', value: missingReports ? `${missingReports} missing` : 'all in', state: missingReports ? 'open' : 'ok', to: MERCHANT_PAGE },
    { key: 'card-open', label: 'Merchant lines open', value: String(cardOpen), state: cardOpen ? 'open' : 'ok', to: MERCHANT_PAGE },
    { key: 'statements-in', label: 'Bank statements in', value: `${statementsIn} / ${accounts}`, state: statementsIn < accounts ? 'open' : 'ok', to: BANK_PAGE },
    { key: 'bank-open', label: 'Bank lines open', value: String(bankOpen), state: bankOpen ? 'open' : 'ok', to: BANK_PAGE },
    {
      key: 'months-locked', label: `${monthOf(prevMonth)} locked`, value: `${locked} / ${accounts}`,
      /* Last month should be shut by mid-month; until then it is simply still open. */
      state: locked >= accounts ? 'ok' : Number(f.today.slice(8, 10)) > 15 ? 'late' : 'open', to: BANK_PAGE,
    },
    {
      key: 'vouchers', label: 'Vouchers in progress',
      value: toCheck + toApprove === 0 ? 'none' : [toCheck && `${toCheck} to check`, toApprove && `${toApprove} to approve`].filter(Boolean).join(' · '),
      state: toCheck + toApprove ? 'open' : 'ok', to: '/scm/payment-vouchers',
    },
  ];
  return { month: f.today.slice(0, 7), daysLeft: lastDayOfMonth(f.today) - Number(f.today.slice(8, 10)), items };
}

/* ── The page ───────────────────────────────────────────────────────────── */

function whoseDesk(desk: Raised['desk'], v: TodoViewer): { mine: boolean; who: string } {
  if (desk === 'checker') return { mine: v.checker, who: v.checkerNames.join(', ') || 'Checker' };
  if (desk === 'approver') return { mine: v.approver, who: v.approverNames.join(', ') || 'Approver' };
  return { mine: v.finance, who: 'Finance' };
}

/** Every job the rules raise, split by whose desk it is on. */
export function raiseJobs(f: TodoFacts, viewer: TodoViewer): { mine: TodoJob[]; others: TodoJob[]; raised: Raised[] } {
  const raised = [...cardJobs(f), ...bankJobs(f), ...paymentJobs(f), ...otherJobs(f)];
  const mine: TodoJob[] = [];
  const others: TodoJob[] = [];
  for (const { desk, ...job } of raised) {
    const d = whoseDesk(desk, viewer);
    if (d.mine) mine.push({ ...job, who: null });
    else others.push({ ...job, who: d.who });
  }
  return { mine, others, raised };
}

export function buildFinanceTodo(f: TodoFacts, viewer: TodoViewer): FinanceTodo {
  const { mine, others, raised } = raiseJobs(f, viewer);
  return {
    today: f.today,
    mine,
    others,
    done: [...f.done].sort((a, b) => b.at.localeCompare(a.at)),
    money: f.money,
    checklist: checklist(f, raised),
    problems: f.problems,
  };
}
