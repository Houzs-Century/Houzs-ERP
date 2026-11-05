// ----------------------------------------------------------------------------
// DailyBankAccounts — the Daily Bank's Accounts tab (the owner's Claude Design
// redesign, batch 3): one block per bank and cash account — its opening, the
// day's money in (one line per way it was paid) and out (one line per
// document), the subtotal and the closing — then all of them together. Under
// each block, what the owner asked for on 2026-09-29 stays: the vouchers
// awaiting approval, what is left after them, and the card money on its way
// into that bank with the line it adds up to.
// ----------------------------------------------------------------------------

import { useEffect, useRef } from 'react';
import { fmtDate, fmtSenPlain } from '../../vendor/shared/format';
import styles from './DailyBank.module.css';
import type { DailyBankBlock, DailyBankBoard, DailyBankMovement } from './accounting-phase1-queries';

const money = (sen: number): string => fmtSenPlain(sen);
const sum = (xs: number[]): number => xs.reduce((n, x) => n + x, 0);

/** How a customer payment was made, as a line names it. */
export function methodLabel(method: string | null | undefined): string {
  if (!method) return 'Customer payment';
  if (method.startsWith('online:')) return `Online · ${method.slice('online:'.length)}`;
  const m: Record<string, string> = {
    cash: 'Cash', transfer: 'Bank transfer', online: 'Online', cheque: 'Cheque', merchant: 'Card', installment: 'Instalment',
  };
  return m[method] ?? method.charAt(0).toUpperCase() + method.slice(1);
}

export type AccountLine = { key: string; who: string; doc: string; description: string; journal: string; inSen: number | null; outSen: number | null };

/** The day's lines for one account: customer payments one line per way they were paid; everything else one line per document. */
export function accountLines(block: DailyBankBlock): AccountLine[] {
  const isPayment = (m: DailyBankMovement) => m.sourceType === 'SOPAY' || m.sourceType === 'SIPAY';
  const groups = new Map<string, DailyBankMovement[]>();
  for (const m of block.receipts.filter(isPayment)) groups.set(methodLabel(m.method), [...(groups.get(methodLabel(m.method)) ?? []), m]);
  const paid: AccountLine[] = [...groups].map(([label, ms]) => {
    const names = [...new Set(ms.map((m) => m.party).filter((x): x is string => !!x))];
    const few = names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
    return ms.length === 1
      ? { key: `in:${label}`, who: ms[0]!.party ?? '', doc: ms[0]!.docNo, description: `${label}${ms[0]!.party ? ` · ${ms[0]!.party}` : ''}`, journal: ms[0]!.jeNo, inSen: ms[0]!.amountSen, outSen: null }
      : { key: `in:${label}`, who: `${ms.length} customers`, doc: `${ms.length} receipts`, description: `${label} · ${ms.length} sales${few ? ` · ${few}` : ''}`, journal: '', inSen: sum(ms.map((m) => m.amountSen)), outSen: null };
  });
  const other = (m: DailyBankMovement, dir: 'in' | 'out'): AccountLine => ({
    key: `${dir}:${m.jeNo}:${m.docNo}`, who: m.party ?? '', doc: m.docNo, description: [m.party, m.note].filter(Boolean).join(' · '), journal: m.jeNo,
    inSen: dir === 'in' ? m.amountSen : null, outSen: dir === 'out' ? m.amountSen : null,
  });
  return [...paid, ...block.receipts.filter((m) => !isPayment(m)).map((m) => other(m, 'in')), ...block.payouts.map((m) => other(m, 'out'))];
}

function AccountBlock({ block, date, focused }: { block: DailyBankBlock; date: string; focused: boolean }) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- jsdom (the tests) has no scrollIntoView
    if (focused) ref.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [focused]);
  const lines = accountLines(block);
  return (
    <section ref={ref} className={`${styles.acctBlock} ${focused ? styles.focused : ''}`} aria-label={`${block.accountCode} ${block.accountName}`} data-account={block.accountCode}>
      <div className={styles.acctStrip}>
        <span className={styles.acctTitle}><span className={styles.accountCode}>{block.accountCode}</span> {block.accountName}</span>
        <span className={styles.acctOpening}>Opening balance <b>{money(block.openingSen)}</b></span>
      </div>
      {lines.length === 0 ? <div className={styles.acctEmpty}>No movement this day.</div> : (
        <div className={styles.tableWrap}>
          <table className={styles.acctTable}>
            <thead>
              <tr><th>Date</th><th>Document</th><th>Description</th><th>Journal</th><th className={styles.num}>In</th><th className={styles.num}>Out</th></tr>
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
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className={styles.subtotal}><td colSpan={4}>Subtotal</td><td className={styles.num}>{money(block.inSen)}</td><td className={styles.num}>{money(block.outSen)}</td></tr>
            </tfoot>
          </table>
        </div>
      )}
      <div className={styles.closingStrip}>
        <span>Closing balance <span className={styles.closingSum}>{money(block.openingSen)} + {money(block.inSen)} − {money(block.outSen)}</span></span>
        <b className={block.closingSen < 0 ? styles.negative : ''}>{money(block.closingSen)}</b>
      </div>
      {(block.pendingSen !== 0 || block.transitSen !== 0) && (
        <div className={styles.afterStrip}>
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
  if (future) return <div className={styles.acctEmpty}>This day hasn’t happened yet.</div>;
  const opening = sum(board.blocks.map((b) => b.openingSen));
  const inSen = sum(board.blocks.map((b) => b.inSen));
  const outSen = sum(board.blocks.map((b) => b.outSen));
  const movements = sum(board.blocks.map((b) => b.receipts.length + b.payouts.length));
  const loose = [...board.unassignedTransit.map((t) => ({ key: `t:${t.acquirerCode}`, text: `In transit · ${t.acquirerCode} card money · ${t.accountName}`, sen: t.balanceSen })),
    ...board.unassignedPending.map((p, i) => ({ key: `p:${p.id ?? i}`, text: `Awaiting approval · ${p.payee ?? 'Payee'}${p.pvNumber ? ` · ${p.pvNumber}` : ''}`, sen: -p.amountSen }))];
  return (
    <div className={styles.accounts}>
      {board.blocks.map((b) => <AccountBlock key={b.accountCode} block={b} date={board.date} focused={b.accountCode === focus} />)}
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
        Live from the ledger, posted entries only. Card money not paid out yet sits in the settlement accounts (Board › On its way); vouchers awaiting approval have not left the bank. {board.note}
      </div>
    </div>
  );
}
