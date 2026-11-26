// ----------------------------------------------------------------------------
// DailyBankAccounts — the Daily Bank's Accounts tab (the owner's Claude Design
// redesign, batch 3): one block per bank and cash account — its opening, the
// day's money in (one line per way it was paid) and out (one line per
// document), the subtotal and the closing — then all of them together. Under
// each block, what the owner asked for on 2026-09-29 stays: the vouchers
// awaiting approval, what is left after them, and the card money on its way
// into that bank with the line it adds up to. On the cash book's page
// (2026-11-23) a bank lists the receipts typed for it and the approved vouchers;
// Finance may tick a voucher as already in the starting balance (owner 2026-11-25:
// 这个是例外 … 要，加勾选): it stays on its line, marked, and is not taken off.
// ----------------------------------------------------------------------------

import { useEffect, useRef, useState } from 'react';
import { History } from 'lucide-react';
import { fmtDate, fmtDateTime, fmtSenPlain } from '../../../../shared/src/vendor/shared/format';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import type { AuditLabelDictionary } from '../../components/audit/audit-labels';
import { EntityHistoryPanel } from './EntityHistoryPanel';
import styles from './DailyBank.module.css';
import { sinceLabel } from './DailyBankBoard';
import type { DailyBankBlock, DailyBankBoard, DailyBankMovement, DailyBankNotDeducted } from './accounting-phase1-queries';
import { useSkipCashbookVoucher, useUnskipCashbookVoucher } from './daily-bank-cashbook-queries';

const money = (sen: number): string => fmtSenPlain(sen);
const sum = (xs: number[]): number => xs.reduce((n, x) => n + x, 0);
const ICON = { size: 13, strokeWidth: 1.75 } as const;

/** How a customer payment was made, as a line names it. */
export function methodLabel(method: string | null | undefined): string {
  if (!method) return 'Customer payment';
  if (method.startsWith('online:')) return `Online · ${method.slice('online:'.length)}`;
  const m: Record<string, string> = {
    cash: 'Cash', transfer: 'Bank transfer', online: 'Online', cheque: 'Cheque', merchant: 'Card', installment: 'Instalment',
  };
  return m[method] ?? method.charAt(0).toUpperCase() + method.slice(1);
}

export type AccountLine = {
  key: string; who: string; doc: string; description: string; journal: string; inSen: number | null; outSen: number | null;
  voucherId: string | null;
};

/** The day's lines for one account: customer payments one line per way they were paid; everything else one line per document. */
export function accountLines(block: DailyBankBlock): AccountLine[] {
  const isPayment = (m: DailyBankMovement) => m.sourceType === 'SOPAY' || m.sourceType === 'SIPAY';
  const groups = new Map<string, DailyBankMovement[]>();
  for (const m of block.receipts.filter(isPayment)) groups.set(methodLabel(m.method), [...(groups.get(methodLabel(m.method)) ?? []), m]);
  const paid: AccountLine[] = [...groups].map(([label, ms]) => {
    const names = [...new Set(ms.map((m) => m.party).filter((x): x is string => !!x))];
    const few = names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
    return ms.length === 1
      ? { key: `in:${label}`, who: ms[0]!.party ?? '', doc: ms[0]!.docNo, description: `${label}${ms[0]!.party ? ` · ${ms[0]!.party}` : ''}`, journal: ms[0]!.jeNo, inSen: ms[0]!.amountSen, outSen: null, voucherId: null }
      : { key: `in:${label}`, who: `${ms.length} customers`, doc: `${ms.length} receipts`, description: `${label} · ${ms.length} sales${few ? ` · ${few}` : ''}`, journal: '', inSen: sum(ms.map((m) => m.amountSen)), outSen: null, voucherId: null };
  });
  const other = (m: DailyBankMovement, dir: 'in' | 'out'): AccountLine => (m.sourceType === 'TYPED'
    ? { key: `${dir}:typed:${m.sourceDocNo ?? ''}`, who: '', doc: '', description: [m.note, m.typedBy ? `typed by ${m.typedBy}` : null].filter(Boolean).join(' · '), journal: '',
      inSen: dir === 'in' ? m.amountSen : null, outSen: dir === 'out' ? m.amountSen : null, voucherId: null }
    : {
      key: `${dir}:${m.jeNo}:${m.docNo}:${m.sourceDocNo ?? ''}`, who: m.party ?? '', doc: m.docNo, description: [m.party, m.note].filter(Boolean).join(' · '), journal: m.jeNo,
      inSen: dir === 'in' ? m.amountSen : null, outSen: dir === 'out' ? m.amountSen : null,
      voucherId: dir === 'out' && m.sourceType === 'PV' ? m.sourceDocNo : null,
    });
  return [...paid, ...block.receipts.filter((m) => !isPayment(m)).map((m) => other(m, 'in')), ...block.payouts.map((m) => other(m, 'out'))];
}

/** The cash book's tick on its page (owner 2026-11-25: 要，加勾选); null on the original. */
type Ticks = { canWrite: boolean; onHistory: (n: { pvId: string; pvNumber: string }) => void };

const TICK_LABELS: AuditLabelDictionary = {
  actions: { CREATE: 'Ticked: not deducted', DELETE: 'Unticked: deducted again' },
  fields: { deducted: 'Taken off the cash book' },
};

function DontDeductTick({ line, voucherId, block }: { line: AccountLine; voucherId: string; block: DailyBankBlock }) {
  const skip = useSkipCashbookVoucher();
  const confirm = useConfirm();
  const ask = async () => {
    const ok = await confirm({
      title: `Don't deduct ${line.doc} from ${block.accountCode}?`,
      body: `Tick it only when its money left the bank before ${block.start ? fmtDate(block.start.date) : 'the start'}, when this bank's cash book starts: then it is already inside the starting balance. The cash book stops taking RM ${money(line.outSen ?? 0)} off ${block.accountName}; the voucher and the books do not change. Kept in its history with your name; untick to deduct it again.`,
      confirmLabel: "Don't deduct",
    });
    if (ok) skip.mutate({ pvId: voucherId });
  };
  return (
    <label className={styles.tickLabel} title="Already in the starting balance: don't take it off">
      <input type="checkbox" checked={false} disabled={skip.isPending} onChange={() => { void ask(); }} aria-label={`Don't deduct ${line.doc}`} />
      Don&apos;t deduct
    </label>
  );
}

function NotDeductedRow({ n, block, date, ticks }: { n: DailyBankNotDeducted; block: DailyBankBlock; date: string; ticks: Ticks }) {
  const unskip = useUnskipCashbookVoucher();
  const confirm = useConfirm();
  const ask = async () => {
    const ok = await confirm({
      title: `Deduct ${n.pvNumber} again?`,
      body: `The cash book takes RM ${money(n.amountSen)} off ${block.accountName} on ${fmtDate(date)} again. Kept in its history with your name.`,
      confirmLabel: 'Deduct again',
    });
    if (ok) unskip.mutate({ pvId: n.pvId });
  };
  return (
    <tr className={styles.notDeductedRow}>
      <td className={styles.muted}>{fmtDate(date)}</td>
      <td className={styles.docCell}>{n.pvNumber}</td>
      <td>{[n.party, n.note].filter(Boolean).join(' · ')}
        <div className={styles.notDeductedTag}>Not deducted: already in the starting balance · ticked by {n.tickedBy ?? 'someone'}{n.tickedAt ? ` · ${fmtDateTime(n.tickedAt)}` : ''}</div></td>
      <td />
      <td />
      <td className={`${styles.num} ${styles.notDeductedAmount}`}>{money(n.amountSen)}</td>
      {ticks.canWrite && (
        <td className={styles.cbActions}>
          <label className={styles.tickLabel} title="Untick to take it off the bank again">
            <input type="checkbox" checked disabled={unskip.isPending} onChange={() => { void ask(); }} aria-label={`Don't deduct ${n.pvNumber}`} />
            Don&apos;t deduct
          </label>
        </td>
      )}
      <td className={styles.cbActions}>
        <button type="button" className={styles.iconButton} onClick={() => ticks.onHistory(n)} aria-label={`History of ${n.pvNumber} on the cash book`}><History {...ICON} /></button>
      </td>
    </tr>
  );
}

function AccountBlock({ block, date, focused, ruled, ticks }: {
  block: DailyBankBlock; date: string; focused: boolean;
  /** A line between the rows under the closing (the cash book's page, owner 2026-11-23: 我要有线条). */
  ruled: boolean;
  ticks: Ticks | null;
}) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- jsdom (the tests) has no scrollIntoView
    if (focused) ref.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [focused]);
  const lines = accountLines(block);
  const notDeducted = ticks ? (block.notDeducted ?? []) : [];
  const tickCol = ticks?.canWrite === true;
  const historyCol = notDeducted.length > 0;
  const extra = (tickCol ? 1 : 0) + (historyCol ? 1 : 0);
  return (
    <section ref={ref} className={`${styles.acctBlock} ${focused ? styles.focused : ''}`} aria-label={`${block.accountCode} ${block.accountName}`} data-account={block.accountCode}>
      <div className={styles.acctStrip}>
        <span className={styles.acctTitle}><span className={styles.accountCode}>{block.accountCode}</span> {block.accountName}
          {block.start && <> <span className={`${styles.srcTag} ${styles.srcCash}`}>{sinceLabel(block.start)}</span></>}</span>
        <span className={styles.acctOpening}>Opening balance <b>{money(block.openingSen)}</b></span>
      </div>
      {lines.length + notDeducted.length === 0 ? <div className={styles.acctEmpty}>No movement this day.</div> : (
        <div className={styles.tableWrap}>
          <table className={styles.acctTable}>
            <thead>
              <tr><th>Date</th><th>Document</th><th>Description</th><th>Journal</th><th className={styles.num}>In</th><th className={styles.num}>Out</th>
                {Array.from({ length: extra }, (_, i) => <th key={i} />)}</tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td className={styles.muted}>{fmtDate(date)}</td>
                  <td className={styles.docCell}>{l.doc}</td>
                  <td>{l.description}</td>
                  <td className={styles.muted}>{l.journal}</td>
                  <td className={`${styles.num} ${styles.moneyIn}`}>{l.inSen == null ? '' : money(l.inSen)}</td>
                  <td className={`${styles.num} ${styles.moneyOut}`}>{l.outSen == null ? '' : money(l.outSen)}</td>
                  {tickCol && <td className={styles.cbActions}>{l.voucherId && <DontDeductTick line={l} voucherId={l.voucherId} block={block} />}</td>}
                  {historyCol && <td />}
                </tr>
              ))}
              {ticks && notDeducted.map((n) => <NotDeductedRow key={n.pvId} n={n} block={block} date={date} ticks={ticks} />)}
            </tbody>
            <tfoot>
              <tr className={styles.subtotal}><td colSpan={4}>Subtotal</td><td className={styles.num}>{money(block.inSen)}</td><td className={styles.num}>{money(block.outSen)}</td>
                {extra > 0 && <td colSpan={extra} />}</tr>
            </tfoot>
          </table>
        </div>
      )}
      <div className={styles.closingStrip}>
        <span>Closing balance <span className={styles.closingSum}>{money(block.openingSen)} + {money(block.inSen)} − {money(block.outSen)}</span></span>
        <b className={block.closingSen < 0 ? styles.negative : ''}>{money(block.closingSen)}</b>
      </div>
      {(block.pendingSen !== 0 || block.transitSen !== 0) && (
        <div className={`${styles.afterStrip} ${ruled ? styles.afterRuled : ''}`}>
          {block.pending.map((p, i) => (
            <div key={p.id ?? `${p.pvNumber ?? 'pv'}:${i}`} className={styles.afterRow}>
              <span className={styles.awaitingText}>· Awaiting approval · {p.payee ?? 'Payee'}{p.pvNumber ? ` · ${p.pvNumber}` : ''}</span>
              <span className={styles.moneyOut}>−{money(p.amountSen)}</span>
            </div>
          ))}
          <div className={`${styles.afterRow} ${styles.availableRow}`}><span>Available (after pending)</span><b>{money(block.availableSen)}</b></div>
          {block.transit.map((t) => (
            <div key={`${t.acquirerCode}:${t.accountCode}`} className={styles.afterRow}>
              <span className={styles.muted}>· In transit · {t.acquirerCode} card money, not yet in this bank</span>
              <span>{money(t.balanceSen)}</span>
            </div>
          ))}
          {block.transitSen !== 0 && <div className={styles.afterRow}><span>Available + in transit</span><b>{money(block.availableWithTransitSen)}</b></div>}
        </div>
      )}
    </section>
  );
}

export function DailyBankAccounts({ board, focus, future }: { board: DailyBankBoard; focus: string | null; future: boolean }) {
  const [history, setHistory] = useState<{ pvId: string; pvNumber: string } | null>(null);
  if (future) return <div className={styles.acctEmpty}>This day hasn’t happened yet.</div>;
  const ticks: Ticks | null = board.book === 'cashbook' ? { canWrite: board.canWrite === true, onHistory: setHistory } : null;
  const opening = sum(board.blocks.map((b) => b.openingSen));
  const inSen = sum(board.blocks.map((b) => b.inSen));
  const outSen = sum(board.blocks.map((b) => b.outSen));
  const movements = sum(board.blocks.map((b) => b.receipts.length + b.payouts.length));
  const loose = [...board.unassignedTransit.map((t) => ({ key: `t:${t.acquirerCode}`, text: `In transit · ${t.acquirerCode} card money · ${t.accountName}`, sen: t.balanceSen })),
    ...board.unassignedPending.map((p, i) => ({ key: `p:${p.id ?? i}`, text: `Awaiting approval · ${p.payee ?? 'Payee'}${p.pvNumber ? ` · ${p.pvNumber}` : ''}`, sen: -p.amountSen }))];
  return (
    <div className={styles.accounts}>
      {board.blocks.map((b) => <AccountBlock key={b.accountCode} block={b} date={board.date} focused={b.accountCode === focus} ruled={board.book === 'cashbook'} ticks={ticks} />)}
      <section className={styles.allCard} aria-label="Closing · all bank & cash">
        <span className={styles.allLabel}>Closing · all bank &amp; cash</span>
        <span className={styles.allSum}>Opening {money(opening)} + In {money(inSen)} − Out {money(outSen)} · {movements} movement{movements === 1 ? '' : 's'}</span>
        <b className={board.totalClosingSen < 0 ? styles.negative : ''}>{money(board.totalClosingSen)}</b>
      </section>
      {loose.length > 0 && (
        <section className={styles.listCard} aria-label="Not tied to a bank">
          <div className={styles.listTitle}>Not tied to a bank</div>
          {loose.map((l) => (
            <div key={l.key} className={styles.listRow}><span className={styles.listDetail}>{l.text}</span><span className={styles.listAmount}>{money(l.sen)}</span></div>
          ))}
        </section>
      )}
      <div className={styles.footnote}>
        {board.book === 'cashbook'
          ? `Your cash book; the original Daily Bank is unchanged. ${board.note}`
          : `Live from the ledger, posted entries only. Card money not paid out yet sits in the settlement accounts (Board › On its way); vouchers awaiting approval have not left the bank. ${board.note}`}
      </div>
      {history && (
        <EntityHistoryPanel entityType="DAILY_BANK_SKIP" entityId={history.pvId} recordLabel={`${history.pvNumber} on the cash book`}
          entityName="Cash book tick" labels={TICK_LABELS} statusDocType="pv" onClose={() => setHistory(null)} />
      )}
    </div>
  );
}
