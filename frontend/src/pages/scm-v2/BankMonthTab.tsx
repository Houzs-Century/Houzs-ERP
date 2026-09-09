// ----------------------------------------------------------------------------
// THE MONTH — the same bank reconciliation, asked of September rather than of
// one file.
//
// Owner, 2026-09-08: 每天我上传bank statement 和 merchant report 测试，但是有办法
// 选这个是几月的？因为我发现好像没有.
//
// He was right. Layer 4 gave him one reconciliation per FILE, and Hong Leong's
// any-day export is a file per day — so a month was thirty separate answers,
// each one true about its own day and none of them the answer to the question a
// month asks. This screen is that question.
//
// Two things it must never do, and both are the server's rules showing through:
//
//   • take a balance off a file that straddles the month end. Such a file's
//     movements inside the month count; its printed balances belong to the
//     month it starts and ends in, and the screen SAYS so rather than quietly
//     leaving them out.
//
//   • hide a day he has not uploaded. The chain of files is checked, and a
//     break is shown with both file names, both dates, and the amount that
//     moved between them — "your month does not add up" is not something
//     anybody can act on.
//
// The reconciliation panel and the line rows are the file screen's own, imported
// rather than reimplemented: one movement has one set of buttons wherever it is
// looked at, and a second copy of "Money received" is a second thing to keep
// right.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { AlertTriangle, ArrowLeft, CalendarDays } from 'lucide-react';
import {
  useBankMonths, useBankMonth,
  type BankMonth, type BankMonthAssembly, type BankLine,
} from './bank-queries';
import { ICON, fmt, btn, softText, danger, panel } from './settlement-ui';
import { ReconciliationPanel, OpenLine, DoneLine } from './BankStatementTab';
import styles from './Suppliers.module.css';
import grid from './MerchantRecon.module.css';

/** 2026-09 → 09/2026 — a month in the house's own numeric, unambiguous shape,
    one field shorter than fmtDate's 16/08/2026.
    Spelt out rather than named ("September 2026") deliberately: a month-name
    array is a third home for a vocabulary this tree already keeps twice, and
    the whole reason the date rule is numeric is that a written month is a
    second way to say the same thing. Anything that is not a month is shown as
    it arrived rather than guessed at. */
export const monthLabel = (month: string): string => {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  return m ? `${m[2]}/${m[1]}` : month;
};

type Picked = { accountCode: string; month: string };

export const BankMonthTab = () => {
  const [picked, setPicked] = useState<Picked | null>(null);
  if (picked) return <MonthView picked={picked} onBack={() => setPicked(null)} />;
  return <MonthList onOpen={setPicked} />;
};

/* ── Every month that has anything in it ──────────────────────────────────── */

const MonthList = ({ onOpen }: { onOpen: (p: Picked) => void }) => {
  const q = useBankMonths();
  const months = q.data?.months ?? [];

  return (
    <div className="space-y-3">
      <div style={softText}>
        A movement belongs to the month its own date falls in, whichever file it arrived in — so uploading
        daily, monthly, or both builds the same month.
      </div>

      {q.isLoading && <div style={{ fontSize: 'var(--fs-13)' }}>Loading…</div>}
      {/* Spoken only over a list that came back and was empty (the empty-state
          rule): an absence is never evidence. */}
      {q.data && months.length === 0 && (
        <div style={softText}>
          No bank statement has been uploaded yet. Upload one under “Bank statement” and its month appears here.
        </div>
      )}

      {months.length > 0 && (
        <table className={grid.grid}>
          <thead>
            <tr>
              <th>Month</th><th>Account</th><th>Files</th><th>Days covered</th>
              <th className={grid.num}>In</th><th className={grid.num}>Out</th>
              <th>Still to decide</th><th>The month itself</th><th />
            </tr>
          </thead>
          <tbody>
            {months.map((m) => <MonthRow key={`${m.accountCode}|${m.month}`} m={m} onOpen={onOpen} />)}
          </tbody>
        </table>
      )}
    </div>
  );
};

const MonthRow = ({ m, onOpen }: { m: BankMonth; onOpen: (p: Picked) => void }) => (
  <tr>
    <td><b>{monthLabel(m.month)}</b></td>
    <td><span className={styles.codeChip}>{m.accountCode}</span></td>
    <td>
      {m.statementCount} file{m.statementCount === 1 ? '' : 's'}
      <div className={grid.sub}>{m.lineCount} movement{m.lineCount === 1 ? '' : 's'}</div>
    </td>
    <td>
      {m.periodFrom === m.periodTo ? m.periodFrom : `${m.periodFrom} → ${m.periodTo}`}
    </td>
    <td className={grid.num}>{fmt(m.inSen)}</td>
    <td className={grid.num}>{fmt(m.outSen)}</td>
    <td className={m.openCount === 0 ? grid.good : undefined}>
      {m.openCount === 0
        ? 'nothing'
        : `${m.openCount} of ${m.lineCount}`
          + (m.openPayoutCount > 0 ? ` · ${m.openPayoutCount} card payout(s)` : '')}
    </td>
    <td>
      {/* Whether the month can be trusted, before he opens it. A month missing
          a day is not a month that is nearly right — its closing figure is
          somebody else's. */}
      {m.complete
        ? <span className={grid.good}>covered end to end</span>
        : <span className={grid.bad}>
            {m.gapCount} thing{m.gapCount === 1 ? '' : 's'} missing
          </span>}
    </td>
    <td>
      <button type="button" style={btn(m.openCount > 0)}
        onClick={() => onOpen({ accountCode: m.accountCode, month: m.month })}>
        <CalendarDays {...ICON} /> {m.openCount > 0 ? 'Reconcile' : 'Open'}
      </button>
    </td>
  </tr>
);

/* ── One month ────────────────────────────────────────────────────────────── */

const MonthView = ({ picked, onBack }: { picked: Picked; onBack: () => void }) => {
  const q = useBankMonth(picked.accountCode, picked.month);
  const [showDone, setShowDone] = useState(false);

  const lines = q.data?.lines ?? [];
  const open = lines.filter((l) => l.state === 'OPEN');
  const done = lines.filter((l) => l.state !== 'OPEN');
  /* Most consequential first, then biggest — the file screen's own order, for
     the same reason: a card payout books money, a plain movement is
     bookkeeping. */
  const ordered = [...open].sort((a, b) => {
    const rank = (l: BankLine) => (l.kind === 'PAYOUT' ? 0 : l.kind === 'PAYOUT_SPLIT' ? 1
      : l.kind === 'PAYOUT_UNSURE' ? 2 : l.kind === 'PAYOUT_NO_BATCH' ? 3 : 4);
    return rank(a) - rank(b) || Math.abs(b.amount_sen) - Math.abs(a.amount_sen);
  });

  return (
    <section className="space-y-3">
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <button type="button" style={btn()} onClick={onBack}><ArrowLeft {...ICON} /> All months</button>
        <b>{picked.accountCode} · {monthLabel(picked.month)}</b>
        {q.data && (
          <span style={softText}>
            {q.data.assembly.periodFrom} → {q.data.assembly.periodTo}
            {' · '}{q.data.statements.length} file{q.data.statements.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {q.isLoading && <div style={{ fontSize: 'var(--fs-13)' }}>Assembling the month…</div>}

      {/* WHAT THE MONTH IS MISSING, before the verdict. A reconciliation of a
          month with a day missing from it is a reconciliation of a different
          month, and reading the difference first would be reading the wrong
          number carefully. */}
      {q.data && !q.data.assembly.complete && <WhatIsMissing a={q.data.assembly} />}
      {q.data && <ReconciliationPanel r={q.data.reconciliation} />}
      {q.data && <WhereTheFiguresCameFrom a={q.data.assembly} />}

      {open.length > 0 && (
        <section className="space-y-2">
          <b>{`Still to decide (${open.length})`}</b>
          <table className={grid.grid}>
            <thead>
              <tr>
                <th>On the bank statement</th>
                <th className={grid.num}>Amount</th>
                <th>What it looks like</th>
                <th>What to do</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((l) => <OpenLine key={l.id} line={l} />)}
            </tbody>
          </table>
        </section>
      )}

      {done.length > 0 && (
        <div style={softText}>
          {done.length} movement{done.length === 1 ? '' : 's'} already dealt with.{' '}
          <button type="button" style={{ ...btn(), padding: '2px 8px' }} onClick={() => setShowDone(!showDone)}>
            {showDone ? 'Hide' : 'Show'}
          </button>
        </div>
      )}
      {showDone && done.length > 0 && (
        <table className={grid.grid}>
          <thead>
            <tr>
              <th>On the bank statement</th><th className={grid.num}>Amount</th><th>What happened</th><th />
            </tr>
          </thead>
          <tbody>
            {done.map((l) => <DoneLine key={l.id} line={l} />)}
          </tbody>
        </table>
      )}

      {q.data && q.data.unmatchedEntries.length > 0 && (
        <section className="space-y-2">
          <b>{`In the books, not on this month's statements (${q.data.unmatchedEntries.length})`}</b>
          <div style={softText}>
            Posted in these days and the bank has not shown it: an uncleared cheque, a deposit still on its
            way, or an entry belonging to a day not uploaded yet.
          </div>
          <table className={grid.grid}>
            <thead>
              <tr><th>Entry</th><th>Date</th><th>Source</th><th className={grid.num}>Amount</th></tr>
            </thead>
            <tbody>
              {q.data.unmatchedEntries.map((e) => (
                <tr key={e.jeNo}>
                  <td>{e.jeNo}</td>
                  <td>{e.entryDate}</td>
                  <td>{[e.sourceType, e.sourceDocNo].filter(Boolean).join(' · ') || '—'}</td>
                  <td className={grid.num}>{fmt(e.debitSen - e.creditSen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {q.data && q.data.statements.length > 0 && <TheFiles data={q.data} />}
    </section>
  );
};

/* ── What this month does not have ────────────────────────────────────────── */

const WhatIsMissing = ({ a }: { a: BankMonthAssembly }) => (
  <div style={{ ...panel('plain'), border: `1px solid ${danger}` }}>
    <b style={{ color: danger, display: 'flex', gap: 6, alignItems: 'center' }}>
      <AlertTriangle {...ICON} /> This month is not covered end to end
    </b>
    <ul style={{ margin: '6px 0 0 0', paddingLeft: 18, fontSize: 'var(--fs-13)' }}>
      {a.gaps.map((g) => <li key={g}>{g}</li>)}
    </ul>
    {a.breaks.length > 0 && (
      <div style={{ fontSize: 'var(--fs-13)', marginTop: 8 }}>
        {/* The amount, named, because it is the size of what he has not
            uploaded — and it is the number the difference below is short by. */}
        Upload the days between them and the month closes. Until then the difference below is missing{' '}
        <b>{fmt(a.breaks.reduce((s, b) => s + Math.abs(b.gapSen), 0))}</b> of movement.
      </div>
    )}
  </div>
);

/* ── Which file each figure was taken off ─────────────────────────────────── */

const WhereTheFiguresCameFrom = ({ a }: { a: BankMonthAssembly }) => {
  /* A balance with no provenance is a number nobody can check. Both ends are
     named with the file and the day, so a reader can open that file and look. */
  if (a.openingFrom == null && a.closingFrom == null) return null;
  return (
    <div style={softText}>
      {a.openingFrom && (
        <>Opened at <b>{fmt(a.statementOpeningSen)}</b> per {a.openingFrom.fileName} ({a.openingFrom.on}). </>
      )}
      {a.closingFrom && (
        <>Closed at <b>{fmt(a.statementClosingSen)}</b> per {a.closingFrom.fileName} ({a.closingFrom.on}).</>
      )}
    </div>
  );
};

/* ── The files that fed the month ─────────────────────────────────────────── */

const TheFiles = ({ data }: {
  data: { statements: Array<{ id: number; file_name: string; period_from: string | null; period_to: string | null; opening_balance_sen: number | null; closing_balance_sen: number | null; spanning: boolean }> };
}) => (
  <section className="space-y-2">
    <b>{`The files this month is made of (${data.statements.length})`}</b>
    <table className={grid.grid}>
      <thead>
        <tr>
          <th>File</th><th>Covers</th>
          <th className={grid.num}>Opening balance</th><th className={grid.num}>Closing balance</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {data.statements.map((s) => (
          <tr key={s.id}>
            <td style={{ wordBreak: 'break-all' }}>{s.file_name}</td>
            <td>{s.period_from} → {s.period_to}</td>
            <td className={grid.num}>{s.opening_balance_sen == null ? '—' : fmt(s.opening_balance_sen)}</td>
            <td className={grid.num}>{s.closing_balance_sen == null ? '—' : fmt(s.closing_balance_sen)}</td>
            <td>
              {/* Said out loud rather than silently ignored: its movements in
                  this month DO count, and its balances belong to another. */}
              {s.spanning
                ? <span style={{ color: danger, fontSize: 'var(--fs-12)' }}>
                    crosses the month edge — its movements here count, its balances do not
                  </span>
                : <span className={grid.sub}>inside this month</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </section>
);

