// ----------------------------------------------------------------------------
// DailyBankPrint — the Daily Bank's Print and Export image (the owner's Claude
// Design redesign, batch 3). Print opens the day as an A4 sheet — BANK BALANCE
// AVAILABLE: each account's balance brought forward, the day's money in and
// out, the vouchers awaiting approval, what is available, then the payments
// already planned after the day — or the Daily close count sheet with its
// signatures; the browser prints it (or saves it as a PDF). Export image is the
// day's picture for WhatsApp: copy it, or download the PNG.
// The sheet carries `print-area`, the one class the app's print stylesheet lets
// through (index.css), so window.print() prints the sheet and nothing else.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react';
import { Copy, Download, Printer, X } from 'lucide-react';
import { fmtDate, fmtDateTime, fmtSenPlain } from '../../vendor/shared/format';
import { useBranding } from '../../hooks/useBranding';
import { useAuth } from '../../auth/AuthContext';
import styles from './DailyBankPrint.module.css';
import { accountLines } from './DailyBankAccounts';
import { closeNote } from './DailyBankClose';
import { drawDailyBankCanvas } from './daily-bank-report';
import { useDailyClose, type DailyBankBoard, type DailyCloseRow } from './accounting-phase1-queries';
import { useTodoCalendar, type CalEvent } from './finance/finance-todo-queries';

const money = (sen: number): string => fmtSenPlain(sen);
const dayLabel = (ymd: string): string =>
  `${new Date(`${ymd}T00:00:00Z`).toLocaleString('en-MY', { weekday: 'short', timeZone: 'UTC' })} · ${fmtDate(ymd)}`;
const nextMonth = (ym: string): string => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 1)).toISOString().slice(0, 7);

export type Upcoming = { key: string; day: string; ref: string; who: string; amountSen: number };

/** Payments already planned after the day — bills and vouchers by their date, routines with an amount. */
export function upcomingPayments(events: CalEvent[], after: string): Upcoming[] {
  return events
    .filter((e) => !e.done && e.day > after && (e.kind === 'pay' || (e.kind === 'routine' && (e.amountSen ?? 0) > 0)))
    .map((e) => ({
      key: e.key, day: e.day, amountSen: e.amountSen ?? 0,
      ref: e.kind === 'routine' ? 'Monthly routine' : (e.detail.split(' · ')[0] ?? ''),
      who: e.label.split(' · ')[0] ?? e.label,
    }))
    .sort((a, b) => a.day.localeCompare(b.day) || a.ref.localeCompare(b.ref));
}

export function DailyBankSheet({ board, upcoming, companyName, printedBy, printedAt }: {
  board: DailyBankBoard; upcoming: Upcoming[] | null; companyName: string; printedBy: string; printedAt: string;
}) {
  const movements = board.blocks.reduce((n, b) => n + b.receipts.length + b.payouts.length, 0);
  const future = (upcoming ?? []).reduce((n, u) => n + u.amountSen, 0);
  return (
    <div className={`${styles.sheet} print-area`} aria-label="Daily Bank sheet">
      <div className={styles.letterhead}>
        <span className={styles.company}>{companyName}</span>
        <span className={styles.docBlock}><b>DAILY BANK</b><span>Date: {fmtDate(board.date)}</span><span>{board.blocks.length} accounts · {movements} movements</span></span>
      </div>
      <div className={styles.inkBar}><b>BANK BALANCE AVAILABLE</b><span>{dayLabel(board.date)}</span></div>
      {board.blocks.map((b) => (
        <table key={b.accountCode} className={styles.sheetTable}>
          <thead>
            <tr className={styles.bankHead}><th colSpan={3}>{b.accountName} <span className={styles.code}>{b.accountCode}</span></th><th colSpan={2} className={styles.num}>Bank balance {money(b.closingSen)}</th></tr>
            <tr><th>PAY TO / FROM</th><th>DOCUMENT</th><th>DESCRIPTION</th><th className={styles.num}>RECEIVED (RM)</th><th className={styles.num}>PAYMENT (RM)</th></tr>
          </thead>
          <tbody>
            <tr className={styles.muted}><td>Balance B/F</td><td /><td /><td className={styles.num}>{money(b.openingSen)}</td><td /></tr>
            {accountLines(b).map((l) => (
              <tr key={l.key}>
                <td>{l.who}</td><td>{l.doc}</td><td>{l.description}</td>
                <td className={styles.num}>{l.inSen == null ? '' : money(l.inSen)}</td><td className={styles.num}>{l.outSen == null ? '' : money(l.outSen)}</td>
              </tr>
            ))}
            {b.pending.map((p, i) => (
              <tr key={p.id ?? `p${i}`} className={styles.pending}>
                <td>· {p.payee ?? 'Payee'}</td><td>{p.pvNumber ?? ''}</td><td>{p.description} · awaiting approval</td><td /><td className={styles.num}>{money(p.amountSen)}</td>
              </tr>
            ))}
            <tr className={styles.subtotal}><td colSpan={3}>Subtotal</td><td className={styles.num}>{money(b.inSen)}</td><td className={styles.num}>{money(b.outSen + b.pendingSen)}</td></tr>
            <tr className={styles.available}><td colSpan={4}>Available (after pending)</td><td className={styles.num}>{money(b.availableSen)}</td></tr>
            {b.transit.map((t) => (
              <tr key={t.acquirerCode} className={styles.muted}><td colSpan={4}>In transit · {t.acquirerCode} card money, not yet in this bank</td><td className={styles.num}>{money(t.balanceSen)}</td></tr>
            ))}
            {b.transitSen !== 0 && <tr><td colSpan={4}>Available + in transit</td><td className={styles.num}>{money(b.availableWithTransitSen)}</td></tr>}
          </tbody>
        </table>
      ))}
      <div className={styles.band}><b>CURRENT CASH AVAILABLE</b><b>{money(board.availableSen)}</b></div>
      <div className={styles.upcomingTitle}>Upcoming payments (future) — pre-planned, not yet due</div>
      {upcoming == null && <div className={styles.muted}>Reading what is planned…</div>}
      {upcoming && upcoming.length === 0 && <div className={styles.muted}>Nothing planned after this day.</div>}
      {upcoming && upcoming.length > 0 && (
        <table className={styles.sheetTable}>
          <tbody>
            {upcoming.map((u) => (
              <tr key={u.key}><td>{fmtDate(u.day)}</td><td>{u.ref}</td><td>{u.who}</td><td className={styles.num}>{money(u.amountSen)}</td></tr>
            ))}
            <tr className={styles.subtotal}><td colSpan={3}>Future payments total</td><td className={styles.num}>({money(future)})</td></tr>
            <tr className={styles.available}><td colSpan={3}>Projected available (after future)</td><td className={styles.num}>{money(board.availableSen - future)}</td></tr>
          </tbody>
        </table>
      )}
      <div className={styles.note}>= Current cash available {money(board.availableSen)} − future {money(future)}. Bills fall on their planned payment date, else their due date. Plan them in Money out › Supplier bills and the To do calendar.</div>
      <div className={styles.footer}><span>{companyName} · DAILY BANK · {fmtDate(board.date)}</span><span>Printed {fmtDateTime(printedAt)} by {printedBy}</span></div>
    </div>
  );
}

export function DailyCloseSheet({ date, today, rows, meta, companyName }: {
  date: string; today: string; rows: DailyCloseRow[]; companyName: string;
  meta: { confirmedBy?: string | null; confirmedAt?: string | null; cashJeNo?: string | null };
}) {
  const closed = rows.length > 0 && rows.every((r) => r.status === 'CONFIRMED');
  const state = date > today ? 'ahead' : closed ? 'closed' : 'open';
  const cash = rows.find((r) => r.bucket === 'cash');
  const note = closeNote({
    state, day: date, cashCounted: cash?.countedSen != null, cashDiff: cash?.diffSen ?? null,
    confirmedBy: meta.confirmedBy ?? null, confirmedAt: meta.confirmedAt ?? null, cashJeNo: meta.cashJeNo ?? null,
  });
  return (
    <div className={`${styles.sheet} print-area`} aria-label="Daily close sheet">
      <div className={styles.letterhead}>
        <span className={styles.company}>{companyName}</span>
        <span className={styles.docBlock}><b>DAILY CLOSE</b><span>Date: {fmtDate(date)}</span><span>Status: {state === 'closed' ? 'Closed' : state === 'ahead' ? 'Ahead' : 'Open'}</span></span>
      </div>
      <table className={styles.sheetTable}>
        <thead><tr><th>BUCKET</th><th className={styles.num}>SYSTEM (RM)</th><th className={styles.num}>COUNTED (RM)</th><th className={styles.num}>DIFFERENCE (RM)</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.bucket}>
              <td>{r.bucket === 'cash' ? 'Cash' : r.bucket === 'transfer' ? 'Transfer' : `Card · ${r.bucket}`}</td>
              <td className={styles.num}>{money(r.systemSen)}</td>
              <td className={styles.num}>{r.countedSen == null ? '' : money(r.countedSen)}</td>
              <td className={styles.num}>{r.diffSen == null ? '—' : money(r.diffSen)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className={styles.note}>{note}</div>
      <div className={styles.signatures}><span>Counted by</span><span>Checked by</span></div>
    </div>
  );
}

/** Print: the sheet on screen first, then the browser's print dialog (which also saves a PDF). */
export function DailyBankPrintModal({ kind, board, date, today, onClose }: {
  kind: 'bank' | 'close'; board: DailyBankBoard | null; date: string; today: string; onClose: () => void;
}) {
  const branding = useBranding();
  const { user } = useAuth();
  const [hint, setHint] = useState(false);
  const thisMonth = useTodoCalendar(date.slice(0, 7));
  const after = useTodoCalendar(nextMonth(date.slice(0, 7)));
  const close = useDailyClose(date);
  const upcoming = useMemo(() => (thisMonth.data && after.data
    ? upcomingPayments([...thisMonth.data.events, ...after.data.events], date) : null), [thisMonth.data, after.data, date]);
  const printedAt = useMemo(() => new Date().toISOString(), []);
  return (
    <div className={styles.backdrop} role="dialog" aria-label={kind === 'bank' ? 'Print the day' : 'Print the count sheet'}>
      <div className={styles.modal}>
        <div className={`${styles.modalHead} no-print`}>
          <Printer size={16} />
          <div className={styles.modalTitles}>
            <b>{kind === 'bank' ? `Daily Bank · ${fmtDate(date)}` : `Daily close · ${fmtDate(date)}`}</b>
            <span>{kind === 'bank'
              ? 'A4 portrait · bank balance available: each account’s B/F, the day’s money in and out, pending vouchers, available, then upcoming payments'
              : 'A4 portrait · count sheet with Counted by / Checked by'}</span>
          </div>
          <button type="button" className={styles.secondary} onClick={() => { setHint(true); window.print(); }}>Save as PDF</button>
          <button type="button" className={styles.primary} onClick={() => window.print()}><Printer size={14} />Print</button>
          <button type="button" className={styles.iconButton} onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>
        {hint && <div className={`${styles.hint} no-print`}>In the print dialog, choose “Save as PDF”.</div>}
        <div className={styles.preview}>
          {kind === 'bank' && board && (
            <DailyBankSheet board={board} upcoming={upcoming} companyName={branding.companyName} printedBy={user?.name ?? user?.email ?? ''} printedAt={printedAt} />
          )}
          {kind === 'close' && close.data && (
            <DailyCloseSheet date={date} today={today} rows={close.data.rows} meta={close.data} companyName={branding.companyName} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Export image: the day's picture, to copy into WhatsApp or download as a PNG. */
export function DailyBankImageModal({ board, onClose }: { board: DailyBankBoard; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => {
    try {
      const c = drawDailyBankCanvas(board);
      setCanvas(c);
      setUrl(c.toDataURL('image/png'));
    } catch { setSaid('The picture could not be drawn.'); }
  }, [board]);
  const fileName = `Bank balance available ${board.date}.png`;
  const download = () => {
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setSaid(`Saved ${fileName}`);
  };
  const copy = async () => {
    if (!canvas) return;
    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob || !('write' in navigator.clipboard) || typeof ClipboardItem === 'undefined') throw new Error('no clipboard');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setSaid('Copied — paste into WhatsApp');
    } catch {
      setSaid('This preview blocks copying · use Download PNG');
    }
  };
  return (
    <div className={`${styles.backdrop} no-print`} role="dialog" aria-label="Export image">
      <div className={styles.modal}>
        <div className={styles.modalHead}>
          <div className={styles.modalTitles}><b>Bank balance available · {dayLabel(board.date)}</b><span>PNG · ready for WhatsApp</span></div>
          <button type="button" className={styles.secondary} onClick={() => { void copy(); }} disabled={!canvas}><Copy size={14} />Copy image</button>
          <button type="button" className={styles.primary} onClick={download} disabled={!url}><Download size={14} />Download PNG</button>
          <button type="button" className={styles.iconButton} onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>
        {said && <div className={styles.hint} role="status">{said}</div>}
        <div className={styles.preview}>{url && <img src={url} alt="Bank balance available" className={styles.image} />}</div>
      </div>
    </div>
  );
}
