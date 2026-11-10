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

import { useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Check, Download, Link2, Lock, Printer, Unlock } from 'lucide-react';
import {
  useBankSetup, useBankMonths, useBankMonth, useLockBankMonth, useUnlockBankMonth, useAutoMatchStatement, useTypeMonthClosing, useLeaveOutRepeats,
  type BankMonthAssembly, type BankMonthBalances, type BankMonthLock, type BankLine,
  type BankBalanceSource, type BankTypedBalance, type Reconciliation,
} from './bank-queries';
import { ICON, fmt, btn, softText, danger, good, panel, refusalText } from './settlement-ui';
import { ReconcilePickProvider, byDateThenLine } from './bank-reconcile-pick';
import {
  BankCards, DifferenceWalk, MissingBanner, MonthFigures, MonthStrip, MonthTracker, bankCards, defaultMonth, lockLabel, lockReasons, monthTitle,
  type MonthFacts,
} from './BankStatementsTop';
import { LineTabBody, LineTabs, firstOpenTab, openingTab, tabCounts, type LineTab } from './BankLineTabs';
import look from './BankStatements.module.css';
import { BankReconPrintModal, setAsideLines, setAsideSen } from './BankReconPrint';
import { useFinanceTodo } from './finance/finance-todo-queries';
import { PrintPreviewModal, usePrintPreview } from '../../components/scm-v2/PrintPreviewModal';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import grid from './MerchantRecon.module.css';
import { downloadCSV, toCSV } from '../../lib/csv';
import { fmtDate } from '../../vendor/shared/format';

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
  /* The redesign (owner's Claude Design, batch 3): a card per account, its
     months by statement month, and one month open below — the account and the
     month live in the address (?account=&month=), so To do lands on the right
     one. With none asked for, the account with lines to decide comes up, and
     its oldest month not yet locked: months are closed in order. */
  const [params, setParams] = useSearchParams();
  const setup = useBankSetup();
  const q = useBankMonths();
  const todo = useFinanceTodo();
  const months = q.data?.months ?? [];
  /* To do's own rule for a statement not uploaded (bank-missing): the day the uploads stop, per account. */
  const missing = useMemo(() => {
    const out: Record<string, string> = {};
    for (const j of [...(todo.data?.mine ?? []), ...(todo.data?.others ?? [])]) {
      if (j.rule === 'bank-missing' && j.since) out[j.key.replace(/^bank-missing:/, '')] = j.since;
    }
    return out;
  }, [todo.data]);
  const cards = bankCards(setup.data?.accounts ?? [], months, missing);
  const asked = params.get('account');
  const card = cards.find((c) => c.code === asked) ?? cards.find((c) => c.toDecide > 0) ?? cards.at(0) ?? null;
  const mine = card ? months.filter((m) => m.accountCode === card.code) : [];
  const askedMonth = params.get('month');
  const month = askedMonth != null && mine.some((m) => m.month === askedMonth) ? askedMonth : defaultMonth(mine);
  const setParam = (patch: Record<string, string | null>) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    for (const [k, v] of Object.entries(patch)) { if (v == null) next.delete(k); else next.set(k, v); }
    return next;
  });
  /* The Upload drawer, on this account (BankRecon mounts it). */
  const upload = () => setParam({ upload: '1', ...(card ? { account: card.code } : {}) });

  return (
    <div className={look.top}>
      {q.isLoading && <div className={look.muted}>Loading…</div>}
      {q.isError && <div className={look.refusal}><AlertTriangle {...ICON} /> {refusalText(q.error, 'The bank months did not load.')}</div>}
      {cards.length > 0 && <BankCards cards={cards} selected={card?.code ?? null} onSelect={(code) => setParam({ account: code, month: null, tab: null })} />}
      {/* Spoken only over lists that came back (the empty-state rule). */}
      {q.data && setup.data && cards.length === 0 && (
        <div className={look.empty}>
          No bank account takes statements in this company yet. Set one up under <Link to="/scm/settlement-setup">Recon setup</Link> and its card appears here.
        </div>
      )}
      {card && <MonthStrip bank={card.bank} months={mine} selected={month} onPick={(m) => setParam({ account: card.code, month: m, tab: null })} onUpload={upload} />}
      {card && q.data && mine.length === 0 && (
        <div className={look.empty}>No {card.bank} statement has been uploaded yet. Upload one and its months appear here.</div>
      )}
      {card && month && (
        <MonthView key={`${card.code}|${month}`} picked={{ accountCode: card.code, month }} bank={card.bank}
          missingSince={missing[card.code] ?? null} onUpload={upload} />
      )}
    </div>
  );
};

/* ── One month ────────────────────────────────────────────────────────────── */

/* "To decide" / "Matched" / "Set aside" — a line's state in the redesign's words. */
const stateWord = (state: BankLine['state']): string => (state === 'OPEN' ? 'To decide' : state === 'POSTED' ? 'Matched' : 'Set aside');

const MonthView = ({ picked, bank, missingSince, onUpload }: {
  picked: Picked; bank: string; missingSince: string | null; onUpload: () => void;
}) => {
  const q = useBankMonth(picked.accountCode, picked.month);
  const setup = useBankSetup();
  const account = setup.data?.accounts.find((x) => x.account_code === picked.accountCode) ?? null;
  const [params, setParams] = useSearchParams();
  /* The lines a person pressed "Not this" on under To match: they go to To
     choose. Nothing is unlinked — a To match line was never linked, only
     offered — so this lives on the screen and a reload offers it again. */
  const [chooseAnyway, setChooseAnyway] = useState<ReadonlySet<number>>(new Set());
  const typedRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  /* The A4 statement (BankReconPrint); the earlier PDF stays one release behind its "Old PDF" button. */
  const [printing, setPrinting] = useState(false);
  const goTo = (r: { current: HTMLDivElement | null }) => r.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  /* THE REPORT. Owner, 2026-09-08: 然后就是match 完了我要report.
     Built from exactly what is on the screen — the same assembly, the same
     reconciliation, the same lines — so the paper and the screen cannot
     disagree. The document refuses to call itself filable when its own walk
     does not arrive; that judgement is in the report, not here. */
  const data = q.data;
  const notify = useNotify();
  const print = usePrintPreview(async (action) => {
    if (!data) return;
    try {
      const { generateBankReconciliationPdf } = await import('../../vendor/scm/lib/bank-reconciliation-pdf');
      await generateBankReconciliationPdf({
        accountCode: data.accountCode,
        month: data.month,
        assembly: data.assembly,
        reconciliation: data.reconciliation,
        lines: data.lines,
        unmatchedEntries: data.unmatchedEntries,
      }, { action });
    } catch (e) {
      void notify({ title: 'PDF generation failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  });

  const lines = data?.lines ?? [];
  const open = lines.filter((l) => l.state === 'OPEN');
  /* In the order the statement reads — by the day the bank booked it, then
     the line — the file screen's own order (docs/bugs/0918). */
  const ordered = byDateThenLine(open);
  const entries = data?.unmatchedEntries ?? [];
  /* The redesign's six tabs; the tab lives in the address (?tab=) and a month
     opens on the first with lines to work. */
  const counts = tabCounts(lines, entries, chooseAnyway);
  const tab = openingTab(params.get('tab'), counts);
  const setTab = (t: LineTab) => setParams((prev) => { const next = new URLSearchParams(prev); next.set('tab', t); return next; }, { replace: true });
  const showTab = (t: LineTab) => { setTab(t); goTo(tabsRef); };

  if (q.isLoading) return <section className={look.panel}><span className={look.muted}>Assembling the month…</span></section>;
  if (!data) {
    return q.isError
      ? <section className={look.panel}><span className={look.refusal}><AlertTriangle {...ICON} /> {refusalText(q.error, 'This month did not load.')}</span></section>
      : null;
  }

  const a = data.assembly;
  const r = data.reconciliation;
  /* To do's missing days, where they fall inside this month. */
  const missing = missingSince != null && missingSince >= a.monthFrom && missingSince <= a.monthTo ? missingSince : null;
  const f: MonthFacts = {
    month: data.month, accountCode: data.accountCode, assembly: a, reconciliation: r, lock: data.lock,
    total: lines.length, open: open.length, missing,
    asideSen: setAsideSen(lines), asideCount: setAsideLines(lines).length,
  };
  const needsTyping = data.lock == null
    && (a.closingFrom == null || a.closingFrom.typed != null || a.openingFrom == null || a.openingFrom.typed != null);
  const exportCsv = () => downloadCSV(`${data.accountCode}-${data.month}-bank-lines.csv`, toCSV(byDateThenLine(lines), [
    { key: 'date', label: 'Date', getValue: (l) => l.booked_on },
    { key: 'desc', label: 'Description', getValue: (l) => l.description },
    { key: 'ref', label: 'Reference', getValue: (l) => l.reference ?? '' },
    { key: 'in', label: 'In', getValue: (l) => (l.amount_sen > 0 ? (l.amount_sen / 100).toFixed(2) : '') },
    { key: 'out', label: 'Out', getValue: (l) => (l.amount_sen < 0 ? (-l.amount_sen / 100).toFixed(2) : '') },
    { key: 'state', label: 'State', getValue: (l) => stateWord(l.state) },
    { key: 'entry', label: 'Entry', getValue: (l) => l.posted_je_no ?? l.matches.map((m) => m.je_no).join(', ') },
    { key: 'note', label: 'Note', getValue: (l) => l.note ?? '' },
    { key: 'file', label: 'File', getValue: (l) => l.file_name ?? '' },
  ]));

  return (
    <ReconcilePickProvider lines={ordered} entries={entries}>
    <section className={look.panel} aria-label={`${monthTitle(picked.month)} · ${picked.accountCode}`}>
      {missing && <MissingBanner bank={bank} a={a} from={missing} onUpload={onUpload} />}
      <MonthHeader data={data} picked={picked} bank={bank} open={open.length} asideSen={f.asideSen} onPrint={() => setPrinting(true)} onExport={exportCsv} />
      {printing && (
        <BankReconPrintModal onClose={() => setPrinting(false)} onOldPdf={() => { setPrinting(false); print.openPreview(); }}
          d={{
            accountCode: data.accountCode, month: data.month, monthTitle: monthTitle(data.month), bank,
            accountName: account?.account_name ?? null, accountNo: account?.account_no ?? null,
            assembly: a, reconciliation: r, lock: data.lock, files: data.statements.map((s) => s.file_name),
            lines, entries,
          }} />
      )}

      {/* MOUNTED ONLY WHILE OPEN. The dialog reads the company branding through
          react-query, so mounting it closed puts a live query on every month a
          person merely looks at. It has no entry state to preserve, so
          mounting on the press is the same dialog and one fewer subscription. */}
      {print.open && (
        <PrintPreviewModal
          open={print.open}
          onClose={print.close}
          docTitle="Bank Reconciliation Statement"
          docNo={`${data.accountCode} · ${monthLabel(data.month)}`}
          rows={[
            { label: 'Days covered', value: `${a.periodFrom} → ${a.periodTo}` },
            {
              label: 'Bank statement closes at',
              value: a.statementClosingSen == null
                ? 'not stated by any file — the statement cannot be drawn'
                : fmt(a.statementClosingSen),
            },
            { label: 'Per the books', value: fmt(r.closingLedgerSen) },
            {
              /* Said in the dialog, before the paper exists: printing a month
                 that is short a day is a decision, and it should be one the
                 operator makes knowingly rather than discovers on the sheet. */
              label: 'The month itself',
              value: a.complete
                ? 'covered end to end'
                : `not covered end to end — ${a.gaps.length} thing(s) missing, printed on the report`,
            },
          ]}
          {...print.handlers}
        />
      )}

      <MonthTracker f={f} />
      <MonthFigures f={f} onTypeClosing={needsTyping ? () => goTo(typedRef) : null} />
      <DifferenceWalk f={f} onLines={() => showTab(firstOpenTab(counts))} onLedger={() => showTab('not-on-bank')} onAside={() => showTab('set-aside')} />

      {/* The inconsistency comes before anything is read off the walk: a walk
          the numbers cannot account for looks like work has been done. */}
      {!r.consistent && (
        <div className={look.gaps}>
          <b><AlertTriangle {...ICON} /> These numbers do not add up</b>
          <div>{r.inconsistency}</div>
        </div>
      )}
      {/* WHAT THE MONTH IS MISSING, under the figures it makes wrong. */}
      {!a.complete && <WhatIsMissing a={a} />}
      <WhereTheFiguresCameFrom a={a} />

      {/* THE FIGURE HE TYPES, for a month no file prints a balance for
          (docs/bugs/0858). Keyed on what is stored so a saved figure re-seeds
          the boxes; hidden on a locked month, whose figures cannot move. */}
      {needsTyping && (
        <div ref={typedRef}>
          <TypedBalances
            key={`${data.balances?.closing?.typedAt ?? ''}|${data.balances?.previousClosing?.typedAt ?? ''}`}
            assembly={a} balances={data.balances} picked={picked} />
        </div>
      )}

      {/* HOW MUCH IS LEFT, and the rule that clears the obvious part of it —
          on the month, where he works (owner 2026-09-13: 我的 matching 在 bank
          statement，然后 lock 在 by month？不能做一起？). */}
      <StillToDecide open={open.length} locked={data.lock != null}
        statements={data.statements.map((s) => ({ id: s.id, fileName: s.file_name }))}
        repeats={data.repeats} />

      <div ref={tabsRef} className={look.section}>
        <LineTabs tab={tab} counts={counts} locked={data.lock != null} onTab={setTab} />
        <LineTabBody tab={tab} lines={byDateThenLine(lines)} entries={entries} locked={data.lock != null} periodTo={a.periodTo}
          chooseAnyway={chooseAnyway} onNotThis={(id) => setChooseAnyway((was) => new Set(was).add(id))} accountCode={data.accountCode} />
      </div>

      {data.statements.length > 0 && <TheFiles data={data} />}
    </section>
    </ReconcilePickProvider>
  );
};

/* ── The month's head: its name, the lock, print and export ─────────────────
   Owner, 2026-09-08: 还有lock 起来不可以随便碰. The button is on only when the
   month can lock (owner 2026-09-11: 当 closing bank statement amount 无法 tally
   就无法 lock) and otherwise names what is missing; the server judges again on
   the press. A locked month shows the figures it was locked at — the snapshot,
   not today's numbers — and unlocking takes the approve right and a reason. */

const MonthHeader = ({ data, picked, bank, open, asideSen, onPrint, onExport }: {
  data: { lock: BankMonthLock | null; assembly: BankMonthAssembly; reconciliation: Reconciliation; statements: unknown[] };
  picked: Picked; bank: string; open: number; asideSen: number; onPrint: () => void; onExport: () => void;
}) => {
  const lock = useLockBankMonth();
  const unlock = useUnlockBankMonth();
  const [note, setNote] = useState('');
  const [asking, setAsking] = useState(false);
  const held = data.lock;
  const a = data.assembly;
  const reasons = lockReasons(data.reconciliation, a, open, asideSen);
  const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;
  return (
    <>
      <div className={look.head}>
        <div className={look.headWho}>
          <div className={look.title}>{monthTitle(picked.month)}</div>
          <div className={look.meta}>
            {bank} · {picked.accountCode} · covers {fmtDate(a.periodFrom)} → {fmtDate(a.periodTo)} · {files(data.statements.length)}
          </div>
        </div>
        {held ? (
          <>
            <span className={look.lockedPill}><Lock size={12} strokeWidth={2.4} /> Locked {fmtDate(held.lockedAt)} by {held.lockedBy ?? 'somebody'}</span>
            <button type="button" className={look.btn} aria-expanded={asking} onClick={() => setAsking(!asking)}>Unlock…</button>
          </>
        ) : (
          <button type="button" className={`${look.btn} ${reasons.length === 0 ? look.lockOn : ''}`}
            disabled={reasons.length > 0 || lock.isPending} title={reasons.length > 0 ? `Not yet: ${reasons.join(' · ')}` : undefined}
            onClick={() => lock.mutate({ accountCode: picked.accountCode, month: picked.month })}>
            <Lock size={12} strokeWidth={2.4} /> {lock.isPending ? 'Locking…' : lockLabel(picked.month)}
          </button>
        )}
        <button type="button" className={look.btn} onClick={onPrint}><Printer size={13} /> Print reconciliation</button>
        <button type="button" className={look.btn} onClick={onExport}><Download size={13} /> Export</button>
      </div>
      {!held && (
        <div className={look.muted}>
          {reasons.length > 0
            ? `Can’t lock yet · ${reasons.join(' · ')}`
            : 'Locking fixes what this month says: nothing in it can be matched, set aside or undone afterwards without unlocking it.'}
        </div>
      )}
      {held && (
        <div className={look.muted}>
          Locked at {fmt(held.closingStatementSen)} per the bank against {fmt(held.closingLedgerSen)} in the ledger,{' '}
          {files(held.statementCount)}, {held.wasComplete ? 'covered end to end' : 'NOT covered end to end'}.
          {held.lockNote && <> Reason given: “{held.lockNote}”.</>}
          {' '}Nothing in it can be matched, set aside or undone, and no statement carrying its days can be loaded, until it is unlocked.
        </div>
      )}
      {held && asking && (
        <div className={look.ask}>
          <span>Unlocking needs the approve right and a reason. The month stays as it is until then.</span>
          {/* Required, and the server requires it too. A month that was locked
              and is open again with no explanation is the one state the lock
              table exists to make impossible. */}
          <input value={note} onChange={(e) => setNote(e.target.value)} aria-label="Why this month is being unlocked"
            placeholder="Why? e.g. the bank re-issued 12 Sep with a corrected charge" />
          <div>
            <button type="button" className={look.btn} disabled={!note.trim() || unlock.isPending}
              onClick={() => unlock.mutate(
                { accountCode: picked.accountCode, month: picked.month, note: note.trim() },
                { onSuccess: () => { setAsking(false); setNote(''); } },
              )}>
              <Unlock size={12} /> {unlock.isPending ? 'Unlocking…' : 'Unlock it'}
            </button>
          </div>
        </div>
      )}
      {lock.isError && <div className={look.refusal}><AlertTriangle {...ICON} /> {refusalText(lock.error, 'The month was not locked.')}</div>}
      {unlock.isError && <div className={look.refusal}><AlertTriangle {...ICON} /> {refusalText(unlock.error, 'The month was not unlocked.')}</div>}
    </>
  );
};

/* ── What this month does not have ────────────────────────────────────────── */

const WhatIsMissing = ({ a }: { a: BankMonthAssembly }) => (
  <div className={look.gaps}>
    <b><AlertTriangle {...ICON} /> This month is not covered end to end</b>
    <ul>
      {a.gaps.map((g) => <li key={g}>{g}</li>)}
    </ul>
    {a.breaks.length > 0 && (
      <div style={{ marginTop: 8 }}>
        {/* The amount, named, because it is the size of what he has not
            uploaded — and it is the number the difference below is short by. */}
        Upload the days between them and the month closes. Until then the difference above is missing{' '}
        <strong>{fmt(a.breaks.reduce((s, b) => s + Math.abs(b.gapSen), 0))}</strong> of movement.
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
  : src.carried
    ? `where ${monthLabel(src.carried.month)} closed, per ${src.fileName ?? ''} (${src.on})`
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

const StillToDecide = ({ open, locked, statements, repeats }: {
  open: number; locked: boolean; statements: Array<{ id: number; fileName: string }>;
  repeats?: { count: number; statementIds: number[] };
}) => (
  <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
    <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
      {open === 0
        ? <b style={{ color: good }}>Nothing left to decide</b>
        : <b style={{ color: danger }}>{open} still to decide</b>}
      {open > 0 && !locked && statements.length > 0 && <MatchTheObviousOnes statements={statements} />}
    </div>
    {!locked && repeats != null && repeats.count > 0 && (
      <LeaveOutRepeats count={repeats.count} statements={statements.filter((s) => repeats.statementIds.includes(s.id))} />
    )}
  </div>
);

/* WHAT AN EARLIER FILE ALREADY RECORDED (owner 2026-10-14: B，做). The month-end
   statement printed the any-day export's movements with more words ("… at KLM")
   and they came back as still to decide; the upload now knows them, and this
   files the ones already in the same way — one press, each file in turn. Undo
   on any one of them puts it back. */
const LeaveOutRepeats = ({ count, statements }: { count: number; statements: Array<{ id: number; fileName: string }> }) => {
  const run = useLeaveOutRepeats();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ leftOut: number; refused: string[] } | null>(null);
  const go = async () => {
    setBusy(true);
    const tally = { leftOut: 0, refused: [] as string[] };
    for (const s of statements) {
      try {
        tally.leftOut += (await run.mutateAsync(s.id)).leftOut;
      } catch (err) {
        tally.refused.push(`${s.fileName}: ${refusalText(err, 'nothing was left out.')}`);
      }
    }
    setResult(tally);
    setBusy(false);
  };
  return (
    <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
      <button type="button" style={{ ...btn(), padding: '2px 8px' }} disabled={busy} onClick={() => { void go(); }}>
        <Check {...ICON} /> {busy ? 'Leaving out…' : `Leave out ${count} already recorded`}
      </button>
      <span style={softText}>
        {count} movement{count === 1 ? '' : 's'} below {count === 1 ? 'is' : 'are'} already on a file uploaded earlier
        ({statements.map((s) => s.fileName).join(', ')} repeats {count === 1 ? 'it' : 'them'}, printed a little differently).
        They go under already dealt with, each naming where it is recorded; Undo puts any one back.
      </span>
      {result && (
        <span style={{ fontSize: 'var(--fs-13)', color: result.leftOut > 0 ? good : undefined }}>
          {result.leftOut} left out.
        </span>
      )}
      {result?.refused.map((r) => (
        <span key={r} style={{ fontSize: 'var(--fs-12)', color: danger }}>{r}</span>
      ))}
    </div>
  );
};

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
        The same rule as on the file screen, over every file that fed this month: a payment whose words carry a
        voucher's number (or the Draft number it went out under) is matched to that voucher when the amounts agree,
        however many days apart; otherwise a movement with exactly one entry of the same amount in the books, whose
        name the bank's line carries, is matched without asking. The rest stay below for you.
      </span>
      {result && (
        <span style={{ fontSize: 'var(--fs-13)', color: result.matched > 0 ? good : undefined }}>
          {result.matched} matched{result.matched > 0 ? ` — ${result.jeNos.join(', ')}` : ''}
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
  <details className={look.files}>
    <summary>{`Files (${data.statements.length})`} — what this month is made of</summary>
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
  </details>
);

