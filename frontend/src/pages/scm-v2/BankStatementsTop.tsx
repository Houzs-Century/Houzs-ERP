// ----------------------------------------------------------------------------
// BankStatementsTop — the top of Bank statements (the owner's Claude Design
// redesign, batch 3; "same layout as Merchant reports"): a card per bank
// account — the lines left to decide on it and where its statements stand —
// and, for the chosen one, its months by statement month. Then the month's own
// head: the four steps it walks (statement in, matched, tallied, locked),
// Statement closes at − Per the ledger = Difference, and what that difference
// is made of. Every figure is the server's (GET /bank/months and
// /bank/months/:a/:m); nothing here decides whether a month may lock.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { AlertCircle, BookOpen, Check, CheckCircle2, ChevronDown, ChevronRight, EyeOff, Landmark, Lock, Upload } from 'lucide-react';
import { fmtDate } from '../../vendor/shared/format';
import { fmt } from './settlement-ui';
import type { BankAccountSetup, BankMonth, BankMonthAssembly, BankMonthLock, Reconciliation } from './bank-queries';
import styles from './BankStatements.module.css';

export type BankTone = 'late' | 'warn' | 'info' | 'calm' | 'ok';
export const TONE: Record<BankTone, string> = {
  late: styles.toneLate, warn: styles.toneWarn, info: styles.toneInfo, calm: styles.toneCalm, ok: styles.toneOk,
};

/** 2026-10 → "2026/10": the house's date digits (fmtDate), a month long. */
export const monthShort = (ym: string): string => fmtDate(`${ym}-01`).slice(0, 7);
/** 2026-10 → "October 2026". */
export const monthTitle = (ym: string): string =>
  new Date(`${ym}-01T00:00:00Z`).toLocaleString('en-MY', { month: 'long', year: 'numeric', timeZone: 'UTC' });
/* "Sep", not en-MY's "Sept": the design's three letters ("Lock Oct"). */
const monthWord = (ym: string, month: 'long' | 'short'): string =>
  new Date(`${ym}-01T00:00:00Z`).toLocaleString('en-US', { month, timeZone: 'UTC' });
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const signed = (sen: number): string => `${sen > 0 ? '+' : sen < 0 ? '−' : ''}${fmt(Math.abs(sen))}`;

/* ── A card per bank account ─────────────────────────────────────────────── */

export type BankCard = { code: string; name: string; bank: string; sub: string; toDecide: number; status: { text: string; tone: BankTone } };

/** One card per bank account set up here, and any with statements. `missingFrom`
    is To do's own "upload the statement" rule — the day the uploads stop. */
export function bankCards(setup: BankAccountSetup[], months: BankMonth[], missingFrom: Record<string, string>): BankCard[] {
  const codes = [...new Set([...setup.filter((a) => a.is_active).map((a) => a.account_code), ...months.map((m) => m.accountCode)])].sort();
  return codes.map((code) => {
    const a = setup.find((x) => x.account_code === code);
    const bank = a?.bank_name ?? a?.bank_code ?? '';
    const mine = months.filter((m) => m.accountCode === code);
    const decide = mine.reduce((n, m) => n + m.openCount, 0);
    const latest = [...mine].sort((x, y) => y.month.localeCompare(x.month)).at(0);
    const tail = a?.account_no ? ` ···· ${a.account_no.slice(-4)}` : '';
    const status: BankCard['status'] = latest == null ? { text: 'No statement uploaded yet', tone: 'late' }
      : missingFrom[code] ? { text: `${fmtDate(missingFrom[code])} onward not uploaded`, tone: 'late' }
        : decide > 0 ? { text: `${plural(decide, 'line')} to decide`, tone: 'warn' }
          : latest.locked ? { text: `All matched · ${monthShort(latest.month)} locked`, tone: 'ok' }
            : { text: `All matched · ${monthShort(latest.month)} not locked yet`, tone: 'ok' };
    return { code, bank: bank || code, name: a?.account_name || bank || code, sub: [`${bank}${tail}`, code].filter(Boolean).join(' · '), toDecide: decide, status };
  });
}

export function BankCards({ cards, selected, onSelect }: { cards: BankCard[]; selected: string | null; onSelect: (code: string) => void }) {
  return (
    <div className={styles.cards} role="group" aria-label="Bank accounts">
      {cards.map((c) => (
        <button key={c.code} type="button" className={`${styles.card} ${selected === c.code ? styles.cardOn : ''}`} aria-pressed={selected === c.code} onClick={() => onSelect(c.code)}>
          <span className={styles.cardHead}>
            <span className={styles.cardWho}><span className={styles.cardName}>{c.name}</span><span className={styles.cardSub}>{c.sub}</span></span>
            <span className={styles.cardCount}><b className={c.toDecide === 0 ? styles.countZero : undefined}>{c.toDecide}</b><span>to decide</span></span>
          </span>
          <span className={styles.status}><span className={`${styles.dot} ${TONE[c.status.tone]}`} /><span>{c.status.text}</span></span>
        </button>
      ))}
    </div>
  );
}

/* ── The months of one account ───────────────────────────────────────────── */

/** A month's pill: a closed month says so; then what keeps it from closing. */
export function monthPill(m: BankMonth): { text: string; tone: BankTone; dot?: boolean; lock?: boolean } {
  if (m.locked) return { text: 'Locked', tone: 'calm', lock: true };
  if (m.openingBalanceSen == null || m.closingBalanceSen == null) return { text: 'No balance', tone: 'late', dot: true };
  if (!m.complete) return { text: 'Missing days', tone: 'late', dot: true };
  if (m.openCount > 0) return { text: `${m.openCount} to decide`, tone: 'warn' };
  return { text: 'All decided', tone: 'info' };
}

const Pill = ({ m }: { m: BankMonth }) => {
  const p = monthPill(m);
  return (
    <span className={`${styles.pill} ${TONE[p.tone]}`}>
      {p.dot && <span className={styles.pillDot} />}{p.lock && <Lock size={10} strokeWidth={2.6} />}{p.text}
    </span>
  );
};

/** The month the page opens on: the oldest still open — he closes them in order — else the newest. */
export function defaultMonth(months: BankMonth[]): string | null {
  const open = months.filter((m) => !m.locked).sort((a, b) => a.month.localeCompare(b.month));
  return open.at(0)?.month ?? [...months].sort((a, b) => b.month.localeCompare(a.month)).at(0)?.month ?? null;
}

export function MonthStrip({ bank, months, selected, onPick, onUpload }: {
  bank: string; months: BankMonth[]; selected: string | null; onPick: (month: string) => void; onUpload: () => void;
}) {
  const [allOpen, setAllOpen] = useState(false);
  const newest = [...months].sort((a, b) => b.month.localeCompare(a.month));
  let chips = newest.slice(0, 3);
  const picked = newest.find((m) => m.month === selected);
  if (picked && !chips.includes(picked)) chips = [...newest.slice(0, 2), picked];
  const years = new Map<string, BankMonth[]>();
  for (const m of newest) years.set(m.month.slice(0, 4), [...(years.get(m.month.slice(0, 4)) ?? []), m]);
  return (
    <div className={styles.strip} aria-label={`${bank} statements`}>
      <span className={styles.stripLabel}><b>{bank} statements</b><span>by statement month</span></span>
      {chips.map((m) => (
        <button key={m.month} type="button" className={`${styles.chip} ${m.month === selected ? styles.chipOn : ''}`} aria-pressed={m.month === selected}
          title={monthTitle(m.month)} onClick={() => onPick(m.month)}>
          {monthShort(m.month)} <Pill m={m} />
        </button>
      ))}
      <span className={styles.popWrap}>
        <button type="button" className={`${styles.chip} ${styles.allBtn}`} aria-expanded={allOpen} onClick={() => setAllOpen(!allOpen)}>
          All months <span>{months.length}</span><ChevronDown size={13} />
        </button>
        {allOpen && (
          <div className={styles.popover} role="dialog" aria-label="All months">
            {[...years].map(([year, ms]) => (
              <div key={year}>
                <div className={styles.yearHead}>{year}</div>
                {ms.map((m) => (
                  <button key={m.month} type="button" className={`${styles.popRow} ${m.month === selected ? styles.popRowOn : ''}`}
                    onClick={() => { setAllOpen(false); onPick(m.month); }}>
                    <span>{monthWord(m.month, 'long')}</span>
                    <span className={styles.popSub}>{plural(m.lineCount, 'movement')}</span>
                    <Pill m={m} />
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </span>
      <span className={styles.grow} />
      <button type="button" className={styles.upload} onClick={onUpload}><Upload size={14} /> Upload statement</button>
    </div>
  );
}

/* ── One month: where it stands ──────────────────────────────────────────── */

/** `from` is To do's own "upload the statement" day, where it falls inside this month. */
export function MissingBanner({ bank, a, from, onUpload }: { bank: string; a: BankMonthAssembly; from: string; onUpload: () => void }) {
  return (
    <div className={styles.missing}>
      <Upload size={16} />
      <div>
        <b>The {bank} statement stops at {fmtDate(a.periodTo)} · {fmtDate(from)} onward missing</b>
        <span>Download it from the bank's portal and drop it here. Days already uploaded are skipped, never doubled.</span>
      </div>
      <button type="button" className={styles.solid} onClick={onUpload}><Upload size={13} /> Upload</button>
    </div>
  );
}

/** Why the month cannot lock yet — the server's own rule (acc/bank-lock.ts), short; empty when it can. */
export function lockReasons(r: Reconciliation, a: BankMonthAssembly, open: number, asideSen = 0): string[] {
  const out: string[] = [];
  if (!r.consistent) out.push('its figures do not add up');
  if (open > 0) out.push(`${plural(open, 'line')} to decide`);
  if (!a.complete) out.push('not covered end to end');
  if (r.closingStatementSen == null) out.push('no closing balance to tally against');
  else if (r.consistent && !r.tallies) {
    /* The server's unexplained holds the set-aside lines too; said apart. */
    if (asideSen !== 0) out.push(`set-aside lines change the balance by ${fmt(Math.abs(asideSen))}`);
    const rest = (r.unexplainedSen ?? 0) - asideSen;
    if (rest !== 0) out.push(`${fmt(Math.abs(rest))} unexplained`);
  }
  return out;
}

export type MonthFacts = {
  month: string;
  accountCode: string;
  assembly: BankMonthAssembly;
  reconciliation: Reconciliation;
  lock: BankMonthLock | null;
  total: number;
  open: number;
  missing: string | null;
  /** What the lines set aside move the balance by — out of the ledger, on the statement. */
  asideSen: number;
  asideCount: number;
};

const outstandingCount = (r: Reconciliation): number => r.outstandingPayments.count + r.outstandingReceipts.count;
/** What the ledger entries not on the bank yet move the difference by (statement − ledger). */
const outstandingEffect = (r: Reconciliation): number => -(r.outstandingPayments.sen + r.outstandingReceipts.sen);
const isTallied = (f: MonthFacts): boolean => f.reconciliation.tallies && f.open === 0;

export function MonthTracker({ f }: { f: MonthFacts }) {
  const { assembly: a, reconciliation: r, lock } = f;
  const n = outstandingCount(r);
  const reasons = lockReasons(r, a, f.open, f.asideSen);
  const rest = (r.unexplainedSen ?? 0) - f.asideSen;
  const steps: Array<{ label: string; sub: string; done: boolean }> = [
    {
      label: 'Statement in', done: a.complete && f.missing == null,
      sub: `Covers ${fmtDate(a.periodFrom)} → ${fmtDate(a.periodTo)}${f.missing ? ` · ${fmtDate(f.missing)} onward missing` : !a.complete ? ' · not covered end to end' : ''}`,
    },
    { label: 'Matched', done: f.open === 0, sub: `${f.total - f.open} of ${plural(f.total, 'line')}${f.open ? ` · ${f.open} to go` : ''}` },
    {
      label: 'Tallied', done: isTallied(f),
      sub: isTallied(f) ? (n ? `Agrees, allowing for ${plural(n, 'entry', 'entries')} not on the bank yet` : 'Statement and ledger agree to the sen')
        : r.closingStatementSen == null ? 'No closing balance to tally against'
          : f.open > 0 ? `Waiting on ${plural(f.open, 'bank line')}`
            : rest === 0 && f.asideSen !== 0 ? `Set-aside lines change the balance by ${fmt(Math.abs(f.asideSen))}`
              : `${fmt(Math.abs(rest))} unexplained`,
    },
    {
      label: 'Locked', done: lock != null,
      sub: lock ? `${fmtDate(lock.lockedAt)} by ${lock.lockedBy ?? 'somebody'}`
        : reasons.length === 0 ? 'Ready to lock'
          : f.missing ? `After ${fmtDate(a.monthTo)}, once the statement reaches it`
            : 'Ready once every bank line is decided and it tallies',
    },
  ];
  const current = steps.findIndex((s) => !s.done);
  return (
    <ol className={styles.tracker} aria-label="Where this month stands">
      {steps.map((s, i) => (
        <li key={s.label} className={`${styles.step} ${s.done ? styles.stepDone : i === current ? styles.stepCurrent : ''}`}>
          <div className={styles.stepTop}>
            <span className={styles.stepDot}>{s.done && <Check size={12} strokeWidth={3} />}</span>
            {i < steps.length - 1 && <span className={`${styles.stepLine} ${steps[i + 1]!.done || i + 1 === current ? styles.stepLineOn : ''}`} />}
          </div>
          <div className={styles.stepLabel}>{s.label}</div>
          <div className={styles.stepSub}>{s.sub}</div>
        </li>
      ))}
    </ol>
  );
}

export function MonthFigures({ f, onTypeClosing }: { f: MonthFacts; onTypeClosing: (() => void) | null }) {
  const { assembly: a, reconciliation: r } = f;
  const tallied = isTallied(f);
  const typed = a.closingFrom?.typed;
  const diff = r.differenceSen;
  return (
    <div className={styles.figures}>
      <div className={styles.figure}>
        <div className={styles.figLabel}>Statement closes at</div>
        <div className={styles.figValue}>{r.closingStatementSen == null ? '—' : fmt(r.closingStatementSen)}</div>
        <div className={styles.figSub}>
          {r.closingStatementSen == null ? 'No file prints it' : `on ${fmtDate(a.periodTo)} · ${typed ? `typed${typed.by ? ` by ${typed.by}` : ''}` : 'printed on the file'}`}
          {onTypeClosing && <> · <button type="button" className={styles.typeIt} onClick={onTypeClosing}>Type it ›</button></>}
        </div>
      </div>
      <div className={styles.figure}>
        <span className={styles.op} aria-hidden>−</span>
        <div className={styles.figLabel}>Per the ledger</div>
        <div className={styles.figValue}>{fmt(r.closingLedgerSen)}</div>
        <div className={styles.figSub}>{f.accountCode} on {fmtDate(a.periodTo)}</div>
      </div>
      <div className={`${styles.figure} ${diff == null ? '' : tallied ? styles.figOk : styles.figWarn}`}>
        <span className={styles.op} aria-hidden>=</span>
        <div className={styles.figLabel}>Difference</div>
        <div className={`${styles.figValue} ${diff == null ? '' : tallied ? styles.toneOk : styles.toneWarn}`}>
          {diff == null ? '—' : `${diff < 0 ? '−' : ''}${fmt(Math.abs(diff))}`}
          {tallied && diff != null && <CheckCircle2 size={15} aria-label="Tallied" />}
        </div>
        <div className={styles.figSub}>
          {diff == null ? 'Nothing to compare with yet'
            : diff === 0 && tallied ? 'Statement and ledger agree'
              : tallied ? 'All from entries not on the bank yet'
                : f.open > 0 ? `${plural(f.open, 'bank line')} not matched yet`
                  : `${fmt(Math.abs(r.unexplainedSen ?? 0))} unexplained`}
        </div>
      </div>
    </div>
  );
}

/** What the difference is made of: the bank lines not matched yet, the ledger entries not on the bank yet, and what nobody explains. */
export function DifferenceWalk({ f, onLines, onLedger, onAside }: { f: MonthFacts; onLines: () => void; onLedger: () => void; onAside: () => void }) {
  const r = f.reconciliation;
  if (r.differenceSen == null) return null;
  const n = outstandingCount(r);
  /* The set-aside lines are said apart; what is left nobody has accounted for. */
  const unexplained = (r.unexplainedSen ?? 0) - f.asideSen;
  return (
    <div className={styles.walk}>
      <span>The difference is made of</span>
      {r.bankNotInBooks.count > 0 && (
        <button type="button" className={styles.walkChip} onClick={onLines}>
          <Landmark size={13} /> {plural(r.bankNotInBooks.count, 'bank line')} not matched yet <b>{signed(r.bankNotInBooks.sen)}</b><ChevronRight size={12} />
        </button>
      )}
      {n > 0 && (
        <button type="button" className={styles.walkChip} onClick={onLedger}>
          <BookOpen size={13} /> {plural(n, 'ledger entry', 'ledger entries')} not on the bank yet <b>{signed(outstandingEffect(r))}</b><ChevronRight size={12} />
        </button>
      )}
      {f.asideSen !== 0 && (
        <button type="button" className={styles.walkChip} onClick={onAside}>
          <EyeOff size={13} /> {plural(f.asideCount, 'line')} set aside <b>{signed(f.asideSen)}</b><ChevronRight size={12} />
        </button>
      )}
      <span className={`${styles.unexplained} ${unexplained !== 0 ? styles.toneLate : styles.toneOk}`}>
        {unexplained !== 0 ? <AlertCircle size={14} /> : <CheckCircle2 size={14} />}
        {unexplained !== 0 ? `${fmt(Math.abs(unexplained))} unexplained` : r.bankNotInBooks.count > 0 || n > 0 || f.asideSen !== 0 ? 'Nothing unexplained' : 'Nothing to explain'}
      </span>
    </div>
  );
}

/** "Lock Oct" / "Locked 2026/10/31 by Chew". */
export const lockLabel = (month: string): string => `Lock ${monthWord(month, 'short')}`;
