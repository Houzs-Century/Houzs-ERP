// ----------------------------------------------------------------------------
// FinanceTodo — Finance's home: what is waiting on you, on others, and what was
// done today, with the money that can move today and the month's checklist.
// The owner's Claude Design project "Finance 模块重新设计" (Finance-1a-To-do,
// 2026-11-02 —「帮我读这个和做」). Every job is raised on the server from the
// live books (backend acc/finance-todo.ts) by the design's built-in rules; each
// one says what it is, how long it has waited and where it is handled.
// ----------------------------------------------------------------------------

import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowUpRight, BookOpen, CalendarDays, CheckCheck, CheckCircle2, ChevronRight, CircleDot, CreditCard,
  FileText, HandCoins, Landmark, Layers, PenLine, Receipt, Send, Upload, Wallet, type LucideIcon,
} from 'lucide-react';
import { PageHeader } from '../../../components/Layout';
import { fmtDate, fmtSen, fmtSenPlain } from '../../../vendor/shared/format';
import styles from './FinanceTodo.module.css';
import { useFinanceTodo, type FinanceTodo, type TodoCheck, type TodoGroup, type TodoIcon, type TodoJob, type TodoTone } from './finance-todo-queries';

const ICON: Record<TodoIcon, LucideIcon> = {
  upload: Upload, 'credit-card': CreditCard, landmark: Landmark, send: Send, wallet: Wallet, receipt: Receipt,
  'alert-triangle': AlertTriangle, 'calendar-days': CalendarDays, 'pen-line': PenLine, 'file-text': FileText, 'hand-coins': HandCoins,
};

/** Tile colours by kind of job (the design's `tone` table) — the module's classes. */
const TILE: Record<TodoTone, string> = {
  routine: styles.tileRoutine, manual: styles.tileManual, cards: styles.tileCards, bank: styles.tileBank,
  money: styles.tileMoney, out: styles.tileOut, err: styles.tileErr,
};

const GROUPS: Array<{ id: TodoGroup; label: string; icon: LucideIcon }> = [
  { id: 'recon', label: 'Merchant reports & bank statements', icon: CheckCheck },
  { id: 'pay', label: 'Payments', icon: Wallet },
  { id: 'other', label: 'Receipts & books', icon: BookOpen },
  { id: 'misc', label: 'Others', icon: Layers },
];

/** Inside the recon group: merchant reports first, then bank statements; each runs upload → confirm → choose. */
const RECON_ORDER: Record<string, number> = {
  'card-missing': 0, 'card-matched': 1, 'card-choose': 2, 'bank-missing': 10, 'bank-decide': 11,
};

const dayNo = (ymd: string): number => Math.round(Date.parse(`${ymd}T00:00:00Z`) / 86_400_000);

/** How long a job has waited, as the design's tag: New, Waiting 1 day (calm), 2 days (warn), 3+ (late, with a dot). */
export function ageTag(since: string | null, today: string): { text: string; tone: 'late' | 'warn' | 'info' | 'calm'; dot: boolean } | null {
  if (!since) return null;
  const n = Math.max(0, dayNo(today) - dayNo(since));
  if (n === 0) return { text: 'New', tone: 'info', dot: false };
  const text = `Waiting ${n} day${n > 1 ? 's' : ''}`;
  if (n === 1) return { text, tone: 'calm', dot: false };
  if (n === 2) return { text, tone: 'warn', dot: false };
  return { text, tone: 'late', dot: true };
}

const TAG_CLASS = { late: styles.tagLate, warn: styles.tagWarn, info: styles.tagInfo, calm: styles.tagCalm };

function Tag({ since, today }: { since: string | null; today: string }) {
  const t = ageTag(since, today);
  if (!t) return null;
  return (
    <span className={`${styles.tag} ${TAG_CLASS[t.tone]}`}>
      {t.dot && <span className={styles.dot} />}
      {t.text}
    </span>
  );
}

function JobRow({ job, today, others = false }: { job: TodoJob; today: string; others?: boolean }) {
  const Icon = ICON[job.icon];
  return (
    <div className={styles.row} data-testid={`todo-job-${job.rule}`}>
      <span className={`${styles.tile} ${TILE[job.tone]}`}><Icon size={16} /></span>
      <div style={{ minWidth: 0 }}>
        <div className={styles.titleLine}>
          <span className={styles.title}>{job.title}</span>
          <Tag since={job.since} today={today} />
        </div>
        <div className={styles.detail} title={job.detail}>{job.detail}</div>
      </div>
      <div className={styles.amount}>{job.amountSen != null && job.amountSen !== 0 ? fmtSen(job.amountSen) : ''}</div>
      {others ? (
        <span className={styles.othersSide}>
          {job.who && <span className={styles.pill}>{job.who}</span>}
          <Link to={job.action.to} className={`${styles.action} ${styles.actionSecondary}`}>{job.action.label}<ChevronRight size={14} /></Link>
        </span>
      ) : (
        <Link to={job.action.to} className={`${styles.action} ${job.action.primary ? styles.actionPrimary : styles.actionSecondary}`}>
          {job.action.label}
          <ChevronRight size={14} />
        </Link>
      )}
    </div>
  );
}

function sortGroup(id: TodoGroup, jobs: TodoJob[]): TodoJob[] {
  const since = (j: TodoJob) => j.since ?? '9999-12-31';
  return [...jobs].sort((a, b) => (id === 'recon' ? (RECON_ORDER[a.rule] ?? 99) - (RECON_ORDER[b.rule] ?? 99) : 0)
    || since(a).localeCompare(since(b)) || a.title.localeCompare(b.title));
}

function Groups({ data }: { data: FinanceTodo }) {
  const uploads = data.mine.filter((j) => j.group === 'recon' && j.icon === 'upload').length;
  const note: Record<TodoGroup, string> = {
    recon: uploads ? `${uploads} file${uploads > 1 ? 's' : ''} to upload first` : 'all files in',
    pay: 'requests and vouchers', other: '', misc: '',
  };
  const shown = GROUPS.map((g) => ({ ...g, jobs: sortGroup(g.id, data.mine.filter((j) => j.group === g.id)) })).filter((g) => g.jobs.length > 0);
  if (shown.length === 0) {
    return <div className={styles.card}><div className={styles.empty}>Nothing is waiting on you.</div></div>;
  }
  return (
    <div className={styles.groups}>
      {shown.map((g) => (
        <div key={g.id} className={styles.card} aria-label={g.label}>
          <div className={styles.groupHead}>
            <g.icon size={14} />
            <span className={styles.groupLabel}>{g.label}</span>
            <span className={styles.groupCount}>{g.jobs.length}</span>
            <span className={styles.groupNote}>{note[g.id]}</span>
          </div>
          {g.jobs.map((j, i) => {
            const head = g.id === 'recon' && j.sub && (i === 0 || g.jobs[i - 1]!.sub !== j.sub);
            return (
              <div key={j.key}>
                {head && (
                  <div className={`${styles.subHead} ${i > 0 ? styles.subHeadRuled : ''}`}>
                    {j.sub === 'merchant' ? <CreditCard size={13} /> : <Landmark size={13} />}
                    {j.sub === 'merchant' ? 'Merchant reports' : 'Bank statements'}
                  </div>
                )}
                <JobRow job={j} today={data.today} />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function CheckRow({ c }: { c: TodoCheck }) {
  const icon = c.state === 'late'
    ? <AlertTriangle size={15} className={styles.checkLate} />
    : c.state === 'open' ? <CircleDot size={15} className={styles.checkOpen} /> : <CheckCircle2 size={15} className={styles.checkOk} />;
  const tone = c.state === 'late' ? styles.valueLate : c.state === 'open' ? styles.valueOpen : styles.valueOk;
  const body = (<>{icon}<span className={styles.checkLabel}>{c.label}</span><span className={`${styles.checkValue} ${tone}`}>{c.value}</span></>);
  return c.to ? <Link to={c.to} className={styles.checkRow}>{body}</Link> : <div className={styles.checkRow}>{body}</div>;
}

const monthName = (ym: string): string =>
  new Date(`${ym}-01T00:00:00Z`).toLocaleString('en-MY', { month: 'long', timeZone: 'UTC' });

export function FinanceTodoPage() {
  const q = useFinanceTodo();
  const data = q.data;
  const doneCount = data?.done.length ?? 0;
  const jobCount = doneCount + (data?.mine.length ?? 0);
  const pct = jobCount > 0 ? Math.round((doneCount / jobCount) * 100) : 0;
  const carried = data ? data.mine.filter((j) => j.since && j.since < data.today).length : 0;

  return (
    <div>
      <PageHeader
        eyebrow={`Finance · ${data ? fmtDate(data.today) : ''}`}
        title="To do"
        actions={data && (
          <div className={styles.headStats}>
            <span>{doneCount} of {jobCount} done today</span>
            <span className={styles.bar}><span className={styles.barFill} style={{ width: `${pct}%` }} /></span>
          </div>
        )}
      />
      {q.isError && <div className={styles.problem}>To do could not be read — {q.error instanceof Error ? q.error.message : 'try again'}.</div>}
      {data && data.problems.length > 0 && (
        <div className={styles.problem}>Some of it could not be read, so it is not listed: {data.problems.join(' · ')}.</div>
      )}
      {!data && !q.isError && <div className={styles.page} aria-busy="true"><div className={styles.card} style={{ height: 320 }} /><div className={styles.card} style={{ height: 240 }} /></div>}
      {data && (
        <div className={styles.page}>
          <div className={styles.column}>
            <section aria-label="Waiting on you">
              <div className={styles.sectionHead}>
                <span className={styles.sectionTitle}>Waiting on you</span>
                <span className={styles.sectionCount}>{data.mine.length}</span>
                {carried > 0 && <span className={styles.carried}>· {carried} from earlier days</span>}
              </div>
              <Groups data={data} />
            </section>

            {data.others.length > 0 && (
              <section aria-label="Waiting on others">
                <div className={styles.sectionHead}>
                  <span className={styles.sectionTitle}>Waiting on others</span>
                  <span className={styles.sectionCount}>{data.others.length}</span>
                </div>
                <div className={styles.card}>
                  {data.others.map((j) => <JobRow key={j.key} job={j} today={data.today} others />)}
                </div>
              </section>
            )}

            <section aria-label="Done today">
              <div className={styles.sectionHead}>
                <span className={styles.sectionTitle}>Done today</span>
                <span className={styles.sectionCount}>{data.done.length}</span>
              </div>
              <div className={styles.card}>
                {data.done.length === 0 && <div className={styles.empty}>Nothing done yet today.</div>}
                {data.done.map((d) => (
                  <div key={d.key} className={styles.doneRow}>
                    <CheckCircle2 size={16} />
                    <span className={styles.doneText}>{d.text}</span>
                    {d.je && <span className={styles.je}>{d.je}</span>}
                    <span className={styles.time}>{d.at}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <div className={styles.side}>
            {data.money && (
              <Link to="/scm/daily-bank" className={styles.moneyCard} aria-label="Can move today">
                <div className={styles.moneyHead}><span>Can move today</span><ArrowUpRight size={15} /></div>
                {/* Bank and cash less the vouchers awaiting approval (the Daily Bank board's own sum);
                    card money not paid out yet is shown under it, not counted in it. */}
                <div className={styles.moneyBig}>{fmtSen(data.money.bankCashSen - data.money.awaitingSen)}</div>
                <div className={styles.moneyLines}>
                  <div className={styles.moneyLine}><span>Bank &amp; cash</span><span>{fmtSenPlain(data.money.bankCashSen)}</span></div>
                  <div className={styles.moneyLine}><span>Awaiting approval</span><span className={styles.moneyOut}>−{fmtSenPlain(data.money.awaitingSen)}</span></div>
                  <div className={`${styles.moneyLine} ${styles.moneyAside}`}><span>On its way from card machines</span><span>{fmtSenPlain(data.money.onTheWaySen)}</span></div>
                </div>
              </Link>
            )}
            <div className={styles.checkCard} aria-label="Month checklist">
              <div className={styles.checkHead}>
                <span className={styles.checkTitle}>{monthName(data.checklist.month)} checklist</span>
                <span className={styles.checkDays}>{data.checklist.daysLeft === 0 ? 'last day' : `${data.checklist.daysLeft} day${data.checklist.daysLeft > 1 ? 's' : ''} left`}</span>
              </div>
              {data.checklist.items.map((c) => <CheckRow key={c.key} c={c} />)}
              <Link to="/scm/accounting?tab=close" className={styles.checkReview}>Review {monthName(data.checklist.month)}</Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
