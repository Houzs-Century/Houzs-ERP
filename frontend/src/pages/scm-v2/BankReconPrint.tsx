// ----------------------------------------------------------------------------
// BankReconPrint — the Bank Reconciliation Statement on A4, printed by the
// browser (the owner's Claude Design, batch 3; owner question d6, built as
// designed): the walk from the ledger to the bank statement, then the three
// lists — bank lines not in the ledger yet, ledger entries not on the bank yet,
// and lines set aside. Matched lines are not printed. Marked Draft until the
// month is locked, Final after. Built from exactly what the month screen holds,
// so the paper and the screen cannot disagree; the old PDF stays one release.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { FileDown, Printer, X } from 'lucide-react';
import { fmtDate, fmtDateTime, fmtSenPlain } from '../../vendor/shared/format';
import { useBranding } from '../../hooks/useBranding';
import { useAuth } from '../../auth/AuthContext';
import { byDateThenLine } from './bank-reconcile-pick';
import type { BankLine, BankMonthAssembly, BankMonthLock, LedgerEntry, Reconciliation } from './bank-queries';
import styles from './DailyBankPrint.module.css';
import look from './BankStatements.module.css';

/** Lines set aside that change the balance: a person left them out of the
    ledger. A repeat of a line already recorded on another file is not one of
    them — it was never this statement's money twice. */
export const setAsideLines = <T extends Pick<BankLine, 'state' | 'kind'>>(lines: T[]): T[] =>
  lines.filter((l) => l.state === 'IGNORED' && l.kind !== 'DUPLICATE');
export const setAsideSen = (lines: Array<Pick<BankLine, 'state' | 'kind' | 'amount_sen'>>): number =>
  setAsideLines(lines).reduce((n, l) => n + l.amount_sen, 0);

export type ReconSheetData = {
  accountCode: string; month: string; monthTitle: string;
  bank: string; accountName: string | null; accountNo: string | null;
  assembly: BankMonthAssembly; reconciliation: Reconciliation; lock: BankMonthLock | null;
  files: string[]; lines: BankLine[]; entries: LedgerEntry[];
};

/** A bank line on the sheet: the same four columns in both of its lists. */
const LINE_HEAD = ['Date', 'Description', 'In (RM)', 'Out (RM)'];

const money = (sen: number | null): string => (sen == null ? '—' : fmtSenPlain(sen));
const signed = (sen: number): string => (sen < 0 ? `(${fmtSenPlain(-sen)})` : fmtSenPlain(sen));

export function BankReconSheet({ d, companyName, printedBy, printedAt }: { d: ReconSheetData; companyName: string; printedBy: string; printedAt: string }) {
  const r = d.reconciliation;
  const a = d.assembly;
  const open = byDateThenLine(d.lines.filter((l) => l.state === 'OPEN'));
  const aside = byDateThenLine(setAsideLines(d.lines));
  const asideSen = aside.reduce((n, l) => n + l.amount_sen, 0);
  /* The server's unexplained holds the set-aside lines too (they are out of
     the ledger and on the statement); printed apart, what is left is what
     nobody has accounted for. */
  const unexplained = r.unexplainedSen == null ? null : r.unexplainedSen - asideSen;
  const lock = d.lock;
  const final = lock != null;
  const walk: Array<{ label: string; count?: number; sen: number | null; strong?: boolean; bad?: boolean }> = [
    { label: `Balance per the ledger on ${fmtDate(a.periodTo)}`, sen: r.closingLedgerSen, strong: true },
    { label: 'Add: payments in the ledger the bank has not paid yet', count: r.outstandingPayments.count, sen: -r.outstandingPayments.sen },
    { label: 'Less: receipts in the ledger the bank has not credited yet', count: r.outstandingReceipts.count, sen: -r.outstandingReceipts.sen },
    { label: 'Bank lines not in the ledger yet · still to decide', count: r.bankNotInBooks.count, sen: r.bankNotInBooks.sen },
    { label: 'Bank lines set aside · left out of the ledger', count: aside.length, sen: asideSen },
    { label: 'Unexplained · on the statement, in neither list', sen: unexplained, bad: unexplained != null && unexplained !== 0 },
    { label: `Balance per bank statement on ${fmtDate(a.periodTo)}`, sen: r.closingStatementSen, strong: true },
  ];
  const stillOpen = [
    ...(r.bankNotInBooks.count > 0 ? [`${r.bankNotInBooks.count} bank line${r.bankNotInBooks.count === 1 ? '' : 's'} to decide`] : []),
    ...(asideSen !== 0 ? [`set-aside lines change the balance by ${fmtSenPlain(Math.abs(asideSen))}`] : []),
    ...(unexplained != null && unexplained !== 0 ? [`${fmtSenPlain(Math.abs(unexplained))} unexplained`] : []),
  ];
  return (
    <div className={`${styles.sheet} print-area`} aria-label="Bank reconciliation statement">
      <div className={styles.letterhead}>
        <span className={styles.company}>{companyName}</span>
        <span className={styles.docBlock}>
          <b>BANK RECONCILIATION STATEMENT</b>
          <span>{d.bank} · {d.accountName ?? d.accountCode} · {d.accountCode}{d.accountNo ? ` · ${d.accountNo}` : ''}</span>
          <span>{d.monthTitle}</span>
        </span>
      </div>
      <div className={look.sheetMeta}>
        <span><i>Days covered</i>{fmtDate(a.periodFrom)} → {fmtDate(a.periodTo)}</span>
        <span><i>Statement file{d.files.length === 1 ? '' : 's'}</i>{d.files.length <= 2 ? d.files.join(', ') : `${d.files.length} files`}</span>
        <span><i>Closing per statement</i>{money(r.closingStatementSen)}</span>
      </div>
      <div className={final ? look.sheetFinal : look.sheetDraft}>
        {lock
          ? `Final · locked ${fmtDate(lock.lockedAt)} by ${lock.lockedBy ?? 'somebody'}. Nothing in this month can change.`
          : `Draft · not locked. ${stillOpen.length > 0 ? `Still open: ${stillOpen.join(' · ')}.` : 'Every line is decided and nothing is unexplained; ready to lock.'}`}
      </div>
      {!r.consistent && <div className={look.sheetDraft}>These numbers do not add up: {r.inconsistency}</div>}

      <table className={styles.sheetTable}>
        <tbody>
          {walk.map((w) => (
            <tr key={w.label} className={w.strong ? look.sheetStrong : undefined}>
              <td>{w.label}</td>
              <td className={styles.num}>{w.count != null ? w.count : ''}</td>
              <td className={`${styles.num} ${w.bad ? look.sheetBad : ''}`}>{w.sen == null ? '—' : signed(w.sen)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <SheetList title="Bank lines not in the ledger yet" note="on the statement, not matched to an entry"
        head={LINE_HEAD} numFrom={2}
        rows={open.map((l) => [fmtDate(l.booked_on), [l.reference, l.description].filter(Boolean).join(' · '), l.amount_sen > 0 ? fmtSenPlain(l.amount_sen) : '', l.amount_sen < 0 ? fmtSenPlain(-l.amount_sen) : ''])}
        foot={['', `${open.length} line${open.length === 1 ? '' : 's'}`, fmtSenPlain(open.filter((l) => l.amount_sen > 0).reduce((n, l) => n + l.amount_sen, 0)), fmtSenPlain(-open.filter((l) => l.amount_sen < 0).reduce((n, l) => n + l.amount_sen, 0))]} />
      <SheetList title="Ledger entries not on the bank yet" note="carried until the bank shows them"
        head={['Date', 'Entry', 'Document', 'Party', 'In (RM)', 'Out (RM)']} numFrom={4}
        rows={d.entries.map((e) => [fmtDate(e.entryDate), `${e.jeNo}${e.carried ? ' · earlier month' : ''}`, e.reference ?? ([e.sourceType, e.sourceDocNo].filter(Boolean).join(' · ') || '—'), e.who ?? e.partyName ?? '—', e.debitSen > 0 ? fmtSenPlain(e.debitSen) : '', e.creditSen > 0 ? fmtSenPlain(e.creditSen) : ''])}
        foot={['', `${d.entries.length} entr${d.entries.length === 1 ? 'y' : 'ies'}`, '', '', fmtSenPlain(d.entries.reduce((n, e) => n + e.debitSen, 0)), fmtSenPlain(d.entries.reduce((n, e) => n + e.creditSen, 0))]} />
      <SheetList title="Bank lines set aside" note="kept on the statement with a note, nothing posted"
        head={[...LINE_HEAD, 'Note']} numFrom={2} numTo={3}
        rows={aside.map((l) => [fmtDate(l.booked_on), [l.reference, l.description].filter(Boolean).join(' · '), l.amount_sen > 0 ? fmtSenPlain(l.amount_sen) : '', l.amount_sen < 0 ? fmtSenPlain(-l.amount_sen) : '', l.note ?? ''])}
        foot={null} />

      <div className={styles.footer}>
        <span>Reconciliation statement · {d.monthTitle} · {final ? 'Final' : 'Draft'}</span>
        <span>Printed {fmtDateTime(printedAt)}{printedBy ? ` by ${printedBy}` : ''}</span>
      </div>
    </div>
  );
}

function SheetList({ title, note, head, rows, foot, numFrom, numTo }: {
  title: string; note: string; head: string[]; rows: string[][]; foot: string[] | null; numFrom: number; numTo?: number;
}) {
  const isNum = (i: number) => i >= numFrom && i <= (numTo ?? head.length - 1);
  return (
    <section className={look.sheetSection}>
      <div className={look.sheetSectionHead}><b>{title}</b><span>{note}</span></div>
      {rows.length === 0 ? <div className={styles.note}>None.</div> : (
        <table className={styles.sheetTable}>
          <thead><tr>{head.map((h, i) => <th key={h} className={isNum(i) ? styles.num : undefined}>{h.toUpperCase()}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, n) => <tr key={n}>{r.map((c, i) => <td key={i} className={isNum(i) ? styles.num : undefined}>{c}</td>)}</tr>)}
            {foot && <tr className={styles.subtotal}>{foot.map((c, i) => <td key={i} className={isNum(i) ? styles.num : undefined}>{c}</td>)}</tr>}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function BankReconPrintModal({ d, onClose, onOldPdf }: { d: ReconSheetData; onClose: () => void; onOldPdf: () => void }) {
  const branding = useBranding();
  const { user } = useAuth();
  const [hint, setHint] = useState(false);
  const printedAt = useMemo(() => new Date().toISOString(), []);
  return (
    <div className={styles.backdrop} role="dialog" aria-label="Print the reconciliation">
      <div className={styles.modal}>
        <div className={`${styles.modalHead} no-print`}>
          <Printer size={16} />
          <div className={styles.modalTitles}>
            <b>Bank reconciliation · {d.monthTitle}</b>
            <span>A4 portrait · {d.lock ? 'Final, locked' : `Marked Draft until ${d.monthTitle} is locked`} · matched lines are not printed</span>
          </div>
          <button type="button" className={styles.secondary} onClick={onOldPdf} title="The earlier PDF, kept for one more release">Old PDF</button>
          <button type="button" className={styles.secondary} onClick={() => { setHint(true); window.print(); }}><FileDown size={14} />Save as PDF</button>
          <button type="button" className={styles.primary} onClick={() => window.print()}><Printer size={14} />Print</button>
          <button type="button" className={styles.iconButton} onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>
        {hint && <div className={`${styles.hint} no-print`}>In the print dialog, choose “Save as PDF”.</div>}
        <div className={styles.preview}>
          <BankReconSheet d={d} companyName={branding.companyName} printedBy={user?.name ?? user?.email ?? ''} printedAt={printedAt} />
        </div>
      </div>
    </div>
  );
}
