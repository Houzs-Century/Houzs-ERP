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
import { AlertTriangle, ArrowLeft, CalendarDays, Check, Link2, Lock, Printer, Unlock } from 'lucide-react';
import {
  useBankMonths, useBankMonth, useLockBankMonth, useUnlockBankMonth, useAutoMatchStatement, useTypeMonthClosing,
  type BankMonth, type BankMonthAssembly, type BankMonthBalances, type BankMonthLock, type BankLine,
  type BankBalanceSource, type BankTypedBalance, type Reconciliation,
} from './bank-queries';
import { ICON, fmt, btn, softText, danger, good, panel, refusalText } from './settlement-ui';
import { ReconciliationPanel, OpenLines, DoneLine, BooksNotOnBank } from './BankStatementTab';
import { BankAccountTabs, currentAccount } from './BankAccountTabs';
import { PrintPreviewModal, usePrintPreview } from '../../components/scm-v2/PrintPreviewModal';
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

/** The month before a YYYY-MM — the one whose closing this month opens at.
    Anything that is not a month gives null. */
export const previousMonthOf = (month: string): string | null => {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) return null;
  return mon === 1 ? `${Number(m[1]) - 1}-12` : `${m[1]}-${String(mon - 1).padStart(2, '0')}`;
};

/** "19,840.54" → 1984054 sen; a minus sign is allowed, because an overdrawn
    account closes below zero. Anything that is not a money amount is null. */
export const parseRm = (text: string): number | null => {
  const t = text.trim().replace(/,/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
};

type Picked = { accountCode: string; month: string };

export const BankMonthTab = () => {
  const [picked, setPicked] = useState<Picked | null>(null);
  /* Which account's months are on the list — kept HERE, above the list, so
     coming back from a month lands on the same account (owner 2026-09-13:
     by month 这里我无法分辨什么也会). */
  const [account, setAccount] = useState<string | null>(null);
  if (picked) return <MonthView picked={picked} onBack={() => setPicked(null)} />;
  return (
    <MonthList account={account} onAccount={setAccount}
      onOpen={(p) => { setAccount(p.accountCode); setPicked(p); }} />
  );
};

/* ── Every month that has anything in it ──────────────────────────────────── */

const MonthList = ({ account, onAccount, onOpen }: {
  account: string | null; onAccount: (code: string) => void; onOpen: (p: Picked) => void;
}) => {
  const q = useBankMonths();
  const months = q.data?.months ?? [];
  /* One account at a time. The codes come off the months themselves, so an
     account with nothing uploaded has no tab — a tab over an empty list is a
     question with no answer. */
  const codes = [...new Set(months.map((m) => m.accountCode))].sort();
  const current = currentAccount(codes, account);
  const shown = months.filter((m) => m.accountCode === current);

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

      <BankAccountTabs codes={codes} value={current} onChange={onAccount} ariaLabel="Bank account" />

      {shown.length > 0 && (
        <table className={grid.grid}>
          <thead>
            <tr>
              <th>Month</th><th>Files</th><th>Days covered</th>
              <th className={grid.num}>In</th><th className={grid.num}>Out</th>
              <th>Still to decide</th><th>The month itself</th><th />
            </tr>
          </thead>
          <tbody>
            {shown.map((m) => <MonthRow key={`${m.accountCode}|${m.month}`} m={m} onOpen={onOpen} />)}
          </tbody>
        </table>
      )}
    </div>
  );
};

const MonthRow = ({ m, onOpen }: { m: BankMonth; onOpen: (p: Picked) => void }) => (
  <tr>
    <td><b>{monthLabel(m.month)}</b></td>
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
      {/* CLOSED replaces the verdict rather than sitting beside it: a closed
          month's answer is fixed, so how clean it looks today is no longer the
          thing to tell somebody about it. */}
      {m.locked
        ? <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <Lock {...ICON} /> closed by {m.locked.lockedBy ?? 'somebody'} on {m.locked.lockedAt.slice(0, 10)}
          </span>
        : m.complete
          ? <span className={grid.good}>covered end to end</span>
          : <span className={grid.bad}>
              {m.gapCount} thing{m.gapCount === 1 ? '' : 's'} missing
            </span>}
    </td>
    <td>
      <button type="button" style={btn(!m.locked && m.openCount > 0)}
        onClick={() => onOpen({ accountCode: m.accountCode, month: m.month })}>
        <CalendarDays {...ICON} /> {m.locked ? 'Open' : m.openCount > 0 ? 'Reconcile' : 'Open'}
      </button>
    </td>
  </tr>
);

/* ── One month ────────────────────────────────────────────────────────────── */

const MonthView = ({ picked, onBack }: { picked: Picked; onBack: () => void }) => {
  const q = useBankMonth(picked.accountCode, picked.month);
  const [showDone, setShowDone] = useState(false);

  /* THE REPORT. Owner, 2026-09-08: 然后就是match 完了我要report.
     Built from exactly what is on the screen — the same assembly, the same
     reconciliation, the same lines — so the paper and the screen cannot
     disagree. The document refuses to call itself filable when its own walk
     does not arrive; that judgement is in the report, not here. */
  const data = q.data;
  const print = usePrintPreview(async (action) => {
    if (!data) return;
    const { generateBankReconciliationPdf } = await import('../../vendor/scm/lib/bank-reconciliation-pdf');
    await generateBankReconciliationPdf({
      accountCode: data.accountCode,
      month: data.month,
      assembly: data.assembly,
      reconciliation: data.reconciliation,
      lines: data.lines,
      unmatchedEntries: data.unmatchedEntries,
    }, { action });
  });

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
        <span style={{ flex: 1 }} />
        <button type="button" style={btn(true, !q.data)} disabled={!q.data} onClick={print.openPreview}>
          <Printer {...ICON} /> Reconciliation statement
        </button>
      </div>

      {/* HOW MUCH IS LEFT, and the rule that clears the obvious part of it —
          on the month, where he works (owner 2026-09-13: 我的 matching 在 bank
          statement，然后 lock 在 by month？不能做一起？). */}
      {q.data && (
        <StillToDecide open={open.length} locked={q.data.lock != null}
          statements={q.data.statements.map((s) => ({ id: s.id, fileName: s.file_name }))} />
      )}

      {/* MOUNTED ONLY WHILE OPEN. The dialog reads the company branding through
          react-query, so mounting it closed puts a live query on every month a
          person merely looks at — and, more sharply, makes this whole screen
          require a QueryClientProvider that BankRecon's own tests do not set up.
          It has no entry state to preserve, so mounting on the press is the same
          dialog and one fewer subscription. */}
      {q.data && print.open && (
        <PrintPreviewModal
          open={print.open}
          onClose={print.close}
          docTitle="Bank Reconciliation Statement"
          docNo={`${q.data.accountCode} · ${monthLabel(q.data.month)}`}
          rows={[
            { label: 'Days covered', value: `${q.data.assembly.periodFrom} → ${q.data.assembly.periodTo}` },
            {
              label: 'Bank statement closes at',
              value: q.data.assembly.statementClosingSen == null
                ? 'not stated by any file — the statement cannot be drawn'
                : fmt(q.data.assembly.statementClosingSen),
            },
            { label: 'Per the books', value: fmt(q.data.reconciliation.closingLedgerSen) },
            {
              /* Said in the dialog, before the paper exists: printing a month
                 that is short a day is a decision, and it should be one the
                 operator makes knowingly rather than discovers on the sheet. */
              label: 'The month itself',
              value: q.data.assembly.complete
                ? 'covered end to end'
                : `not covered end to end — ${q.data.assembly.gaps.length} thing(s) missing, printed on the report`,
            },
          ]}
          {...print.handlers}
        />
      )}

      {q.isLoading && <div style={{ fontSize: 'var(--fs-13)' }}>Assembling the month…</div>}

      {/* CLOSED OR NOT, above everything. A person looking at a month needs to
          know whether what he is reading can still move before he reads it —
          and if it cannot, the row that says so has to name who closed it. */}
      {q.data && <TheLock data={q.data} picked={picked} />}

      {/* WHAT THE MONTH IS MISSING, before the verdict. A reconciliation of a
          month with a day missing from it is a reconciliation of a different
          month, and reading the difference first would be reading the wrong
          number carefully. */}
      {q.data && !q.data.assembly.complete && <WhatIsMissing a={q.data.assembly} />}
      {q.data && <ReconciliationPanel r={q.data.reconciliation} />}
      {q.data && <WhereTheFiguresCameFrom a={q.data.assembly} />}

      {/* THE FIGURE HE TYPES, for a month no file prints a balance for
          (docs/bugs/0858). Keyed on what is stored so a saved figure re-seeds
          the boxes; hidden on a closed month, whose figures cannot move. */}
      {q.data && q.data.lock == null && (
        <TypedBalances
          key={`${q.data.balances?.closing?.typedAt ?? ''}|${q.data.balances?.previousClosing?.typedAt ?? ''}`}
          assembly={q.data.assembly} balances={q.data.balances} picked={picked} />
      )}

      {open.length > 0 && <OpenLines lines={ordered} entries={q.data?.unmatchedEntries ?? []} />}

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
              <th>On the bank statement</th><th className={grid.num}>Deposit</th><th className={grid.num}>Withdrawal</th><th>What happened</th><th />
            </tr>
          </thead>
          <tbody>
            {done.map((l) => <DoneLine key={l.id} line={l} />)}
          </tbody>
        </table>
      )}

      {q.data && <BooksNotOnBank entries={q.data.unmatchedEntries} />}

      {q.data && q.data.statements.length > 0 && <TheFiles data={q.data} />}
    </section>
  );
};

/* ── Closed, or the button that closes it ─────────────────────────────────── */

const TheLock = ({ data, picked }: {
  data: { lock: BankMonthLock | null; assembly: BankMonthAssembly; reconciliation: Reconciliation };
  picked: Picked;
}) => {
  const lock = useLockBankMonth();
  const unlock = useUnlockBankMonth();
  const [note, setNote] = useState('');
  const [asking, setAsking] = useState(false);

  const held = data.lock;

  if (held) {
    return (
      <div style={{ ...panel('good'), display: 'grid', gap: 'var(--space-2)' }}>
        <b style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <Lock {...ICON} /> Closed by {held.lockedBy ?? 'somebody'} on {held.lockedAt.slice(0, 10)}
        </b>
        <div style={{ fontSize: 'var(--fs-13)' }}>
          {/* THE SNAPSHOT, not today's figures. A lock exists to fix a claim,
              and showing live numbers here would quietly rewrite it. */}
          Closed at {fmt(held.closingStatementSen)} per the bank against {fmt(held.closingLedgerSen)} in the
          books, {held.statementCount} file{held.statementCount === 1 ? '' : 's'},{' '}
          {held.wasComplete ? 'covered end to end' : 'NOT covered end to end'}.
          {held.lockNote && <> Reason given: “{held.lockNote}”.</>}
        </div>
        <div style={softText}>
          Nothing in this month can be booked, matched, left out or undone, and no statement carrying its
          days can be loaded, until it is reopened.
        </div>
        {!asking && (
          <button type="button" style={{ ...btn(), justifySelf: 'start' }} onClick={() => setAsking(true)}>
            <Unlock {...ICON} /> Reopen this month
          </button>
        )}
        {asking && (
          <div style={{ display: 'grid', gap: 4, justifyItems: 'start' }}>
            {/* Required, and the server requires it too. A month that was closed
                and is open again with no explanation is the one state the lock
                table exists to make impossible. */}
            <input value={note} onChange={(e) => setNote(e.target.value)}
              aria-label="Why this month is being reopened"
              placeholder="Why? e.g. the bank re-issued 12 Sep with a corrected charge"
              style={{ padding: '5px 8px', fontSize: 'var(--fs-13)', minWidth: 340 }} />
            <button type="button" style={btn(false, !note.trim() || unlock.isPending)}
              disabled={!note.trim() || unlock.isPending}
              onClick={() => unlock.mutate(
                { accountCode: picked.accountCode, month: picked.month, note: note.trim() },
                { onSuccess: () => { setAsking(false); setNote(''); } },
              )}>
              <Unlock {...ICON} /> {unlock.isPending ? 'Reopening…' : 'Reopen it'}
            </button>
          </div>
        )}
        {unlock.isError && (
          <div style={{ fontSize: 'var(--fs-13)', color: danger, display: 'flex', gap: 6 }}>
            <AlertTriangle {...ICON} />
            <span>{refusalText(unlock.error, 'The month was not reopened.')}</span>
          </div>
        )}
      </div>
    );
  }

  /* OPEN. The button is on only when the month can close — it tallies, is
     whole, and has nothing left to decide (owner 2026-09-11: 当 closing bank
     statement amount 无法 tally 就无法 lock) — and otherwise says which of those
     is missing. There is no reason box: no sentence makes a month tally. The
     server judges again on the press; its refusal is the sentence below. */
  const r = data.reconciliation;
  const open = r.bankNotInBooks.count;
  const why = !r.consistent
    ? 'Cannot close: these numbers do not add up.'
    : open > 0
      ? `Cannot close: ${open} movement${open === 1 ? '' : 's'} still to decide.`
      : !data.assembly.complete
        ? 'Cannot close: this month is not covered end to end by the files uploaded.'
        : r.closingStatementSen == null
          ? 'Cannot close: no file printed a closing balance to tally against.'
          : !r.tallies
            ? `Cannot close: it does not tally — the books and the outstanding items reach ${fmt(r.computedClosingSen)}, the bank statement says ${fmt(r.closingStatementSen)}.`
            : null;

  return (
    <div style={{ display: 'grid', gap: 4, justifyItems: 'start' }}>
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" style={btn(false, why != null || lock.isPending)} disabled={why != null || lock.isPending}
          onClick={() => lock.mutate({ accountCode: picked.accountCode, month: picked.month })}>
          <Lock {...ICON} /> {lock.isPending ? 'Closing…' : 'Close this month'}
        </button>
        {why && <span style={{ fontSize: 'var(--fs-13)', color: danger }}>{why}</span>}
      </div>
      <div style={softText}>
        Closing fixes what this month says. Nothing in it can be booked, left out or undone afterwards
        without reopening it.
      </div>
      {lock.isError && (
        <div style={{ fontSize: 'var(--fs-13)', color: danger, display: 'flex', gap: 6 }}>
          <AlertTriangle {...ICON} />
          <span>{refusalText(lock.error, 'The month was not closed.')}</span>
        </div>
      )}
    </div>
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

/* "per d01.csv (2026-09-01)", or — for a figure nobody's file printed — who
   typed it, for which month, and when (docs/bugs/0858). */
const figureSource = (src: BankBalanceSource): string => (src.typed
  ? `the closing balance typed for ${monthLabel(src.typed.month)}${src.typed.by ? ` by ${src.typed.by}` : ''} on ${src.typed.at.slice(0, 10)}`
    + (src.typed.note ? ` (“${src.typed.note}”)` : '')
    + ' — no file prints it'
  : `per ${src.fileName ?? ''} (${src.on})`);

const WhereTheFiguresCameFrom = ({ a }: { a: BankMonthAssembly }) => {
  /* A balance with no provenance is a number nobody can check. Both ends are
     named with the file and the day, so a reader can open that file and look
     — or with the person who typed it, so a reader knows whom to ask. */
  if (a.openingFrom == null && a.closingFrom == null) return null;
  return (
    <div style={softText}>
      {a.openingFrom && (
        <>Opened at <b>{fmt(a.statementOpeningSen)}</b> {figureSource(a.openingFrom)}. </>
      )}
      {a.closingFrom && (
        <>Closed at <b>{fmt(a.statementClosingSen)}</b> {figureSource(a.closingFrom)}.</>
      )}
    </div>
  );
};

/* ── How much is left, and the rule that clears the obvious part ──────────── */

const StillToDecide = ({ open, locked, statements }: {
  open: number; locked: boolean; statements: Array<{ id: number; fileName: string }>;
}) => (
  <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
    {open === 0
      ? <b style={{ color: good }}>Nothing left to decide</b>
      : <b style={{ color: danger }}>{open} still to decide</b>}
    {open > 0 && !locked && statements.length > 0 && <MatchTheObviousOnes statements={statements} />}
  </div>
);

/* The file screen's rule, run over EVERY file that fed this month, one after
   the other; the answer is the sum. A file the server refuses (one crossing
   into a closed month, say) is named and the rest still run — one refusal
   must not stop the other files being matched. */
const MatchTheObviousOnes = ({ statements }: { statements: Array<{ id: number; fileName: string }> }) => {
  const run = useAutoMatchStatement();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ matched: number; jeNos: string[]; contraPairs: number; refused: string[] } | null>(null);

  const go = async () => {
    setBusy(true);
    const tally = { matched: 0, jeNos: [] as string[], contraPairs: 0, refused: [] as string[] };
    for (const s of statements) {
      try {
        const r = await run.mutateAsync(s.id);
        tally.matched += r.matched;
        tally.jeNos.push(...r.jeNos);
        tally.contraPairs += r.contraPairs;
      } catch (err) {
        tally.refused.push(`${s.fileName}: ${refusalText(err, 'the rule did not run.')}`);
      }
    }
    setResult(tally);
    setBusy(false);
  };

  return (
    <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
      <button type="button" style={{ ...btn(), padding: '2px 8px' }} disabled={busy} onClick={() => { void go(); }}>
        <Link2 {...ICON} /> {busy ? 'Matching…' : 'Match the obvious ones now'}
      </button>
      <span style={softText}>
        The same rule as on the file screen, over every file that fed this month: a movement with exactly one
        entry of the same amount in the books, whose name the bank's line carries, is matched without asking.
        The rest stay below for you.
      </span>
      {result && (
        <span style={{ fontSize: 'var(--fs-13)', color: result.matched > 0 ? good : undefined }}>
          {result.matched} matched by amount and name{result.matched > 0 ? ` — ${result.jeNos.join(', ')}` : ''}
          {result.contraPairs > 0 ? `; ${result.contraPairs} pair${result.contraPairs === 1 ? '' : 's'} the bank reversed left out` : ''}.
        </span>
      )}
      {result?.refused.map((r) => (
        <span key={r} style={{ fontSize: 'var(--fs-12)', color: danger }}>{r}</span>
      ))}
    </div>
  );
};

/* ── The month-end figure typed off the bank's own statement (docs/bugs/0858) ── */

/* Shown only where a figure is NOT printed by any file: Maybank's Account
   Activity Report lists movements and no balance, so without a typed figure
   the month has nothing to tally against and can never close. A file that
   prints the balance always wins, so the box is not offered where one did. */
const TypedBalances = ({ assembly, balances, picked }: {
  assembly: BankMonthAssembly; balances?: BankMonthBalances; picked: Picked;
}) => {
  const save = useTypeMonthClosing();
  const needClosing = assembly.closingFrom == null || assembly.closingFrom.typed != null;
  const needOpening = assembly.openingFrom == null || assembly.openingFrom.typed != null;
  const prev = previousMonthOf(picked.month);
  if (!needClosing && !needOpening) return null;
  return (
    <div style={{ ...panel('plain'), display: 'grid', gap: 'var(--space-2)' }}>
      <b>Month-end balance per the bank</b>
      <div style={softText}>
        No file uploaded for this month prints a balance — Maybank's Account Activity Report lists movements
        only. Type the closing balance off the bank's own month-end statement; the month opens where the previous
        one closed, and the reconciliation statement names who typed each figure. A file that prints a balance
        always wins over a typed one.
      </div>
      {needClosing && (
        <TypedFigure label={`Closing balance of ${monthLabel(picked.month)}`}
          ariaLabel="Closing balance per the bank statement"
          month={picked.month} current={balances?.closing ?? null} picked={picked} save={save} />
      )}
      {needOpening && prev != null && (
        <TypedFigure label={`Closing balance of ${monthLabel(prev)} — ${monthLabel(picked.month)} opens there`}
          ariaLabel="Closing balance of the previous month"
          month={prev} current={balances?.previousClosing ?? null} picked={picked} save={save} />
      )}
      {save.isError && (
        <div style={{ fontSize: 'var(--fs-13)', color: danger, display: 'flex', gap: 6 }}>
          <AlertTriangle {...ICON} />
          <span>{refusalText(save.error, 'The figure was not saved.')}</span>
        </div>
      )}
    </div>
  );
};

const TypedFigure = ({ label, ariaLabel, month, current, picked, save }: {
  label: string; ariaLabel: string; month: string; current: BankTypedBalance | null; picked: Picked;
  save: ReturnType<typeof useTypeMonthClosing>;
}) => {
  const [text, setText] = useState(current ? (current.closingSen / 100).toFixed(2) : '');
  const [note, setNote] = useState(current?.note ?? '');
  const sen = parseRm(text);
  const bad = text.trim() !== '' && sen == null;
  const dirty = sen !== (current?.closingSen ?? null) || (note.trim() || null) !== (current?.note ?? null);
  const cannot = sen == null || !dirty || save.isPending;
  return (
    <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 'var(--fs-13)', fontWeight: 600, minWidth: 260 }}>{label}</span>
      <span style={{ fontSize: 'var(--fs-13)' }}>RM</span>
      <input value={text} onChange={(e) => setText(e.target.value)} inputMode="decimal" aria-label={ariaLabel}
        placeholder="0.00" style={{ padding: '5px 8px', fontSize: 'var(--fs-13)', width: 140, textAlign: 'right' }} />
      <input value={note} onChange={(e) => setNote(e.target.value)} aria-label={`Note on the ${ariaLabel.toLowerCase()}`}
        placeholder="Note, e.g. per the June e-statement" style={{ padding: '5px 8px', fontSize: 'var(--fs-13)', minWidth: 240 }} />
      <button type="button" style={btn(true, cannot)} disabled={cannot}
        onClick={() => save.mutate({ accountCode: picked.accountCode, month, closingSen: sen, note: note.trim() || null })}>
        <Check {...ICON} /> {save.isPending ? 'Saving…' : 'Save'}
      </button>
      {bad && <span style={{ fontSize: 'var(--fs-12)', color: danger }}>Not a money amount — 19840.54, or -120.00 for an overdrawn account.</span>}
      {current && (
        <>
          <span style={softText}>typed{current.typedBy ? ` by ${current.typedBy}` : ''} on {current.typedAt.slice(0, 10)}</span>
          <button type="button" style={{ ...btn(), padding: '2px 8px' }} disabled={save.isPending}
            onClick={() => save.mutate({ accountCode: picked.accountCode, month, closingSen: null, note: null })}>
            Clear
          </button>
        </>
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

