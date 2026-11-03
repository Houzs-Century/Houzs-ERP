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
import {
  addDays, pendingOccurrence, repeatText, ROUTINE_ACTION_LABEL,
  type TaskAction, type TaskLink, type TaskOccurrence, type TodoTask,
} from './todo-tasks';

export { addDays };

export type TodoRule =
  | 'card-missing' | 'card-matched' | 'card-choose'
  | 'bank-missing' | 'bank-decide'
  | 'requests' | 'pv-check' | 'pv-approve'
  | 'transfers' | 'selfcheck' | 'overdue'
  | 'task' | 'routine' | 'custom';

/** The rules a switch in Setup › To do rules can turn off (tasks and routines have their own). */
export const BUILT_IN_RULES = [
  'card-missing', 'card-matched', 'card-choose', 'bank-missing', 'bank-decide',
  'requests', 'pv-check', 'pv-approve', 'transfers', 'overdue',
] as const satisfies readonly TodoRule[];

/** One of the four piles ('recon' | 'pay' | 'other' | 'misc'), or a group Finance added (its id). */
export type TodoGroup = string;
export const BUILT_IN_GROUPS = ['recon', 'pay', 'other', 'misc'] as const;

/** What a task or routine row carries beyond a rule's job. */
export type TodoTaskRef = {
  id: string;
  occursOn: string;
  /** The day it falls, moved or not. */
  due: string;
  kind: 'task' | 'routine';
  action: TaskAction;
  remarkCount: number;
  link: TaskLink | null;
  repeats: boolean;
  /** Waiting on others only: the one-off task is done. */
  done: boolean;
};
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
  task: TodoTaskRef | null;
};

/** `task` is set for a task or routine done today — the page can reopen it. */
export type TodoDone = { key: string; text: string; je: string | null; at: string; task?: { id: string; occursOn: string } | null };
export type TodoCheck = { key: string; label: string; value: string; state: 'ok' | 'open' | 'late'; to: string | null };

export type FinanceTodo = {
  today: string;
  mine: TodoJob[];
  others: TodoJob[];
  done: TodoDone[];
  money: { bankCashSen: number; awaitingSen: number; onTheWaySen: number } | null;
  checklist: { month: string; daysLeft: number; items: TodoCheck[] };
  problems: string[];
  /** Groups Finance added beside the four, in the order they were added. */
  groups: TodoGroupDef[];
  viewer: { id: number | null; name: string };
};

export type TodoGroupDef = { id: string; label: string };

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
/** `month` is the month the bank booked the line in (YYYY-MM) — the Bank statements month it is decided in. */
export type TodoBankLine = { accountCode: string; statementId: number; amountSen: number; periodTo: string | null; uploadedOn: string; month: string };

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
  /** Tasks and routines, with the occurrences somebody touched and how many remarks each has. */
  tasks: TodoTask[];
  occurrences: Record<string, TaskOccurrence[]>;
  remarkCounts: Record<string, number>;
  /** Setup › To do rules: the built-in rules switched off, and Finance's own groups. */
  rulesOff: string[];
  groups: TodoGroupDef[];
  /** Finance's own rules (from a template) that are on, with what each found. */
  customRules: CustomRuleFacts[];
};

/** A rule Finance added from a template (Setup › To do rules › New rule). */
export type CustomRule = { id: string; tpl: CustomTemplate; param: number; group: string };
export type CustomTemplate = 'bills' | 'drafts' | 'big';
export const CUSTOM_TEMPLATES: readonly CustomTemplate[] = ['bills', 'drafts', 'big'];
/** One thing a custom rule found: a bill, a draft, a payment. */
export type CustomItem = { no: string; name: string; amountSen: number | null; day: string | null };
export type CustomRuleFacts = { rule: CustomRule; items: CustomItem[] };

export type TodoViewer = {
  /** public.users id and name — whose tasks are "mine", and how "done by" reads. */
  id: number | null;
  name: string;
  /** Works Finance (prepares or posts vouchers): the Finance rules are theirs. */
  finance: boolean;
  /** Whose desk checking / approving is on, and the names to show when it is not the viewer's. */
  checker: boolean;
  approver: boolean;
  checkerNames: string[];
  approverNames: string[];
};

/* ── Small helpers ───────────────────────────────────────────────────────── */

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

/** A job opens Merchant reports at its acquirer, at the report when its lines
    are all one report, on the tab they sit in (the redesign's ?acq=&batch=&tab=). */
const merchantLink = (acquirer: string, batchIds: number[], tab: 'to-confirm' | 'to-choose' | 'no-sale'): string => {
  const ids = [...new Set(batchIds)];
  return `${MERCHANT_PAGE}?acq=${encodeURIComponent(acquirer)}${ids.length === 1 ? `&batch=${ids[0]}` : ''}&tab=${tab}`;
};
/** A job opens Bank statements at its account — on a month, or on the files to upload one. */
const bankLink = (accountCode: string, at: { month: string } | 'upload'): string =>
  `${BANK_PAGE}?account=${encodeURIComponent(accountCode)}${at === 'upload' ? '&view=files' : `&month=${at.month}`}`;

/* ── The rules ───────────────────────────────────────────────────────────── */

type Raised = Omit<TodoJob, 'who' | 'task'> & { desk: 'finance' | 'checker' | 'approver' };

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
        action: { label: 'Upload', to: `${MERCHANT_PAGE}?acq=${encodeURIComponent(a.code)}`, primary: true }, desk: 'finance',
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
        action: { label: 'Confirm', to: merchantLink(a.code, matched.map((r) => r.batchId), 'to-confirm'), primary: true }, desk: 'finance',
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
        action: {
          label: 'Open', primary: false,
          /* Lines with no sale at all sit under No sale found; any with one to pick, under To choose. */
          to: merchantLink(a.code, choose.map((r) => r.batchId), choose.every((r) => r.bucket === 'UNMATCHED') ? 'no-sale' : 'to-choose'),
        }, desk: 'finance',
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
      action: { label: 'Upload', to: bankLink(b.accountCode, 'upload'), primary: true }, desk: 'finance',
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
      /* The oldest month with a line to decide: months are closed in order. */
      action: { label: 'Match', to: bankLink(b.accountCode, { month: lines.map((l) => l.month).sort()[0]! }), primary: false }, desk: 'finance',
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
      /* Review opens To do's Payment requests drawer (the redesign, batch 4 step 10). */
      action: { label: 'Review', to: '/scm/finance?drawer=requests', primary: true }, desk: 'finance',
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
      /* Receipts, opened on the drafts of every month (the merged page, batch 5 §2). */
      action: { label: 'Review', to: '/scm/receipts?kind=official&status=draft&month=all', primary: false }, desk: 'finance',
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

/* ── Tasks and routines ─────────────────────────────────────────────────── */

const DAY_MS = 86_400_000;
const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
/** A done one-off task stays under "Waiting on others" this many days, so whoever asked sees it was done. */
const DONE_SHOWN_DAYS = 3;

function taskRef(f: TodoFacts, t: TodoTask, occursOn: string, due: string, done = false): TodoTaskRef {
  return {
    id: t.id, occursOn, due, kind: t.kind, action: t.action, remarkCount: f.remarkCounts[t.id] ?? 0,
    link: t.link, repeats: t.repeat !== 'none', done,
  };
}

/** The tasks and routines waiting now: a routine is Finance's, a task its assignee's; whoever asked sees it waiting on them. */
function taskJobs(f: TodoFacts, v: TodoViewer): { mine: TodoJob[]; others: TodoJob[] } {
  const mine: TodoJob[] = [];
  const others: TodoJob[] = [];
  for (const t of f.tasks) {
    if (t.isOff) continue;
    const occ = f.occurrences[t.id] ?? [];
    const p = pendingOccurrence(t, occ, f.today);
    const repeats = t.repeat !== 'none' ? ` · ${repeatText(t).toLowerCase()}` : '';
    const linked = t.link ? ` · ${t.link.no}` : '';
    if (t.kind === 'routine') {
      if (!p) continue;
      const job: TodoJob = {
        key: `task:${t.id}:${p.occursOn}`, rule: 'routine', group: t.groupKey, sub: t.groupKey === 'recon' ? 'bank' : null,
        tone: 'routine', icon: 'calendar-days', title: t.payee ? `${t.title} · ${t.payee}` : t.title,
        detail: repeatText(t), amountSen: t.amountSen, since: null,
        action: {
          label: ROUTINE_ACTION_LABEL[t.action],
          to: t.action === 'voucher' ? '/scm/payment-vouchers/new' : t.actionTo ?? '',
          primary: t.action === 'voucher',
        },
        who: null, task: taskRef(f, t, p.occursOn, p.due),
      };
      if (v.finance) mine.push(job); else others.push({ ...job, who: 'Finance' });
      continue;
    }
    const base = {
      rule: 'task' as const, group: t.groupKey, sub: null, tone: 'manual' as const, icon: 'pen-line' as const,
      title: t.title, amountSen: null, since: null,
    };
    if (p && v.id != null && t.assigneeId === v.id) {
      const from = t.createdById === v.id ? 'Added by you' : `From ${t.createdByName ?? 'Finance'}`;
      mine.push({
        ...base, key: `task:${t.id}:${p.occursOn}`, detail: `${from}${repeats}${linked}`,
        action: { label: 'Mark done', to: '', primary: false }, who: null, task: taskRef(f, t, p.occursOn, p.due),
      });
      continue;
    }
    if (v.id == null || t.createdById !== v.id || t.assigneeId === v.id) continue;
    if (p) {
      others.push({
        ...base, key: `task:${t.id}:${p.occursOn}`, detail: `You asked · due ${showDate(p.due)}${repeats}${linked}`,
        action: { label: 'Open', to: '', primary: false }, who: t.assigneeName ?? '—', task: taskRef(f, t, p.occursOn, p.due),
      });
      continue;
    }
    /* A one-off task done lately: whoever asked sees it was done. */
    const doneOcc = t.repeat === 'none' ? occ.find((o) => o.occursOn === t.dueDate && o.doneAt) : undefined;
    if (doneOcc?.doneAt && daysBetween(doneOcc.doneAt.slice(0, 10), f.today) <= DONE_SHOWN_DAYS) {
      others.push({
        ...base, key: `task:${t.id}:${t.dueDate}`, detail: `Done by ${doneOcc.doneBy ?? t.assigneeName ?? '—'}${linked}`,
        action: { label: 'Open', to: '', primary: false }, who: 'Done', task: taskRef(f, t, t.dueDate, t.dueDate, true),
      });
    }
  }
  return { mine, others };
}

/** Tasks and routines marked done today, by anyone in Finance. */
function tasksDoneToday(f: TodoFacts, v: TodoViewer, doneToday: (iso: string) => boolean, clock: (iso: string) => string): TodoDone[] {
  const out: TodoDone[] = [];
  for (const t of f.tasks) {
    for (const o of f.occurrences[t.id] ?? []) {
      if (!o.doneAt || !doneToday(o.doneAt)) continue;
      const mineDone = !o.doneBy || o.doneBy === v.name;
      const what = t.kind === 'routine' ? `${t.title} · due ${showDate(o.movedTo ?? o.occursOn)}` : t.title;
      out.push({
        key: `task:${t.id}:${o.occursOn}`,
        text: mineDone ? `${t.kind === 'routine' ? 'Routine done' : 'Task done'} · ${what}` : `${o.doneBy} marked done · ${what}`,
        je: null, at: clock(o.doneAt), task: { id: t.id, occursOn: o.occursOn },
      });
    }
  }
  return out;
}

/* ── Finance's own rules ─────────────────────────────────────────────── */

const rm = (sen: number): string => (sen / 100).toLocaleString('en-MY', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** What each template's job says, and where it is handled (the design's TEMPLATES). */
function customJobs(f: TodoFacts): Raised[] {
  const out: Raised[] = [];
  for (const { rule, items } of f.customRules) {
    const n = items.length;
    if (n === 0) continue;
    const amount = items.reduce((s, i) => s + (i.amountSen ?? 0), 0);
    const earliest = minDay(items.map((i) => i.day));
    const base = { key: `custom:${rule.id}`, rule: 'custom' as const, group: rule.group, sub: null, desk: 'finance' as const };
    if (rule.tpl === 'bills') {
      out.push({
        ...base, tone: 'out', icon: 'file-text', title: `Pay ${n} supplier ${plural(n, 'bill')} due within ${rule.param} days`,
        detail: firstFew(items.map((i) => i.name)), amountSen: amount, since: null,
        action: { label: 'Open', to: '/scm/ap-invoices', primary: false },
      });
    } else if (rule.tpl === 'drafts') {
      out.push({
        ...base, tone: 'money', icon: 'file-text', title: `${n} ${plural(n, 'draft')} older than ${rule.param} days`,
        detail: firstFew(items.map((i) => i.no)), amountSen: null,
        /* A draft joins the list the day it turns too old. */
        since: earliest ? addDays(earliest, rule.param + 1) : null,
        action: { label: 'Open', to: '/scm/payment-vouchers?status=DRAFT', primary: false },
      });
    } else {
      out.push({
        ...base, tone: 'money', icon: 'receipt', title: `${n} ${plural(n, 'payment')} over RM ${rm(rule.param * 100)}`,
        detail: `${firstFew(items.map((i) => `${i.no} · ${i.name}`.trim()), 2)} · each needs its own e-invoice`, amountSen: amount, since: earliest,
        action: { label: 'Open', to: '/scm/receipts?kind=official', primary: false },
      });
    }
  }
  return out;
}

/** Every job the rules raise, split by whose desk it is on. A rule switched off raises nothing. */
export function raiseJobs(f: TodoFacts, viewer: TodoViewer): { mine: TodoJob[]; others: TodoJob[]; raised: Raised[] } {
  const off = new Set(f.rulesOff);
  const raised = [...cardJobs(f), ...bankJobs(f), ...paymentJobs(f), ...otherJobs(f), ...customJobs(f)]
    .filter((j) => !off.has(j.rule) && !off.has(j.key.replace(/^custom:/, '')));
  const mine: TodoJob[] = [];
  const others: TodoJob[] = [];
  for (const { desk, ...job } of raised) {
    const d = whoseDesk(desk, viewer);
    if (d.mine) mine.push({ ...job, who: null, task: null });
    else others.push({ ...job, who: d.who, task: null });
  }
  const tasks = taskJobs(f, viewer);
  return { mine: [...mine, ...tasks.mine], others: [...others, ...tasks.others], raised };
}

/** The Malaysian day and HH:MM of an instant. */
const mytOf = (iso: string): string => new Date(new Date(iso).getTime() + 8 * 3_600_000).toISOString();

export function buildFinanceTodo(f: TodoFacts, viewer: TodoViewer): FinanceTodo {
  const { mine, others, raised } = raiseJobs(f, viewer);
  const taskDone = tasksDoneToday(f, viewer, (iso) => mytOf(iso).slice(0, 10) === f.today, (iso) => mytOf(iso).slice(11, 16));
  return {
    today: f.today,
    mine,
    others,
    done: [...f.done, ...taskDone].sort((a, b) => b.at.localeCompare(a.at)),
    money: f.money,
    checklist: checklist(f, raised),
    problems: f.problems,
    groups: f.groups,
    viewer: { id: viewer.id, name: viewer.name },
  };
}
