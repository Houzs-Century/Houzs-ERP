// ----------------------------------------------------------------------------
// DailyBankBoard — the Daily Bank's Board (the owner's Claude Design redesign,
// batch 3, "Money today"): how much can move today, how the day got there, each
// bank and cash account with the day's movements, the card money on its way,
// and the vouchers awaiting approval. Reads the same board the Accounts sheet
// does (GET /accounting/daily-bank), so the two never disagree.
// ----------------------------------------------------------------------------

import { Link } from 'react-router-dom';
import { ArrowRight, Hourglass } from 'lucide-react';
import { fmtSen } from '../../vendor/shared/format';
import styles from './DailyBank.module.css';
import type { DailyBankBlock, DailyBankBoard, DailyBankPending } from './accounting-phase1-queries';

const sum = (xs: number[]): number => xs.reduce((n, x) => n + x, 0);

/** The design's bridge: yesterday's balance, the day's in and out, then what can move. */
export function bridgeRows(b: DailyBankBoard): Array<{ key: string; label: string; sen: number; tone: string; strong?: boolean }> {
  return [
    { key: 'yesterday', label: 'Yesterday', sen: sum(b.blocks.map((x) => x.openingSen)), tone: styles.barPlain },
    { key: 'in', label: '+ In today', sen: sum(b.blocks.map((x) => x.inSen)), tone: styles.barIn },
    { key: 'out', label: '− Out today', sen: sum(b.blocks.map((x) => x.outSen)), tone: styles.barOut },
    { key: 'now', label: 'Bank & cash now', sen: b.totalClosingSen, tone: styles.barNow, strong: true },
    { key: 'awaiting', label: '− Awaiting approval', sen: b.pendingApprovalSen, tone: styles.barAwaiting },
    { key: 'move', label: 'Can move today', sen: b.availableSen, tone: styles.barMove, strong: true },
  ];
}

/** Every voucher checked and awaiting approval: per bank, then those paying from an account the board does not carry. */
export const awaitingVouchers = (b: DailyBankBoard): DailyBankPending[] => [...b.blocks.flatMap((x) => x.pending), ...b.unassignedPending];

function AccountCard({ block, onOpen }: { block: DailyBankBlock; onOpen: (accountCode: string) => void }) {
  const lines = [
    ...block.receipts.map((m) => ({ key: `in:${m.jeNo}:${m.docNo}`, who: m.party ?? m.docNo, sen: m.amountSen, dir: 'in' as const })),
    ...block.payouts.map((m) => ({ key: `out:${m.jeNo}:${m.docNo}`, who: m.party ?? m.docNo, sen: m.amountSen, dir: 'out' as const })),
  ];
  return (
    <button type="button" className={styles.accountCard} title="See every movement of this account" onClick={() => onOpen(block.accountCode)}>
      <div className={styles.accountHead}>
        <span className={styles.accountName}>{block.accountName}</span>
        <span className={styles.accountCode}>{block.accountCode}</span>
      </div>
      <div className={`${styles.accountClosing} ${block.closingSen < 0 ? styles.negative : ''}`}>{fmtSen(block.closingSen)}</div>
      <div className={styles.accountLines}>
        {lines.length === 0 && <span className={styles.muted}>No movement today</span>}
        {lines.slice(0, 5).map((l) => (
          <span key={l.key} className={styles.accountLine}>
            <span className={styles.lineWho}>{l.who}</span>
            <span className={l.dir === 'in' ? styles.moneyIn : styles.moneyOut}>{l.dir === 'in' ? '+' : '−'}{fmtSen(l.sen).replace(/^RM\s*/, '')}</span>
          </span>
        ))}
        {lines.length > 5 && <span className={styles.muted}>+{lines.length - 5} more</span>}
      </div>
    </button>
  );
}

export function DailyBankBoardView({ board, onOpenAccount }: { board: DailyBankBoard; onOpenAccount: (accountCode: string) => void }) {
  const bridge = bridgeRows(board);
  /* Bars start at zero; a negative figure draws no bar and reads red. */
  const top = Math.max(1, ...bridge.map((r) => r.sen));
  const awaiting = awaitingVouchers(board);
  const transit = [...board.transit].sort((a, b) => b.balanceSen - a.balanceSen);
  return (
    <div className={styles.board}>
      <div className={styles.boardTop}>
        <section className={styles.hero} aria-label="Can move today">
          <div className={styles.heroLabel}>Can move today</div>
          <div className={`${styles.heroAmount} ${board.availableSen < 0 ? styles.negative : ''}`}>{fmtSen(board.availableSen)}</div>
          <div className={styles.heroChips}>
            <span className={styles.chipBank}>Bank &amp; cash <b>{fmtSen(board.totalClosingSen)}</b></span>
            <span className={styles.chipAwaiting}>− Awaiting approval <b>{fmtSen(board.pendingApprovalSen)}</b></span>
          </div>
          <div className={styles.heroTransit}>
            <Hourglass size={14} />
            <span><b>{fmtSen(board.totalTransitSen)}</b> is on its way from card machines. Not spendable until it lands.</span>
          </div>
        </section>

        <section className={styles.bridge} aria-label="How the day got here">
          {bridge.map((r) => (
            <div key={r.key} className={`${styles.bridgeRow} ${r.strong ? styles.bridgeStrong : ''}`}>
              <span className={styles.bridgeLabel}>{r.label}</span>
              <span className={styles.bridgeTrack}><span className={`${styles.bridgeBar} ${r.tone}`} style={{ width: `${Math.max(0, (r.sen / top) * 100)}%` }} /></span>
              <span className={`${styles.bridgeValue} ${r.tone} ${r.sen < 0 ? styles.negative : ''}`}>{fmtSen(r.sen).replace(/^RM\s*/, '')}</span>
            </div>
          ))}
        </section>
      </div>

      <section aria-label="Accounts" className={styles.accountGrid}>
        {board.blocks.map((b) => <AccountCard key={b.accountCode} block={b} onOpen={onOpenAccount} />)}
      </section>

      <div className={styles.boardBottom}>
        <section className={styles.listCard} aria-label="On its way · card machines">
          <div className={styles.listTitle}>On its way · card machines</div>
          {transit.length === 0 && <div className={styles.muted}>No card money on its way.</div>}
          {transit.map((t) => (
            <div key={`${t.acquirerCode}:${t.accountCode}`} className={styles.listRow}>
              <span className={styles.acq}>{t.acquirerCode}</span>
              <span className={styles.listDetail}>{t.accountName}{t.bankAccountCode ? '' : ' · names no bank'}</span>
              <span className={styles.listAmount}>{fmtSen(t.balanceSen)}</span>
            </div>
          ))}
        </section>

        <section className={styles.listCard} aria-label="Awaiting your approval">
          <div className={styles.listTitleRow}>
            <span className={styles.listTitle}>Awaiting your approval</span>
            <Link to="/scm/payment-vouchers?status=CHECKED" className={styles.listLink}>Review vouchers <ArrowRight size={13} /></Link>
          </div>
          {awaiting.length === 0 && <div className={styles.muted}>No voucher is waiting for approval.</div>}
          {awaiting.map((p, i) => (
            <div key={p.id ?? `${p.pvNumber ?? 'pv'}:${i}`} className={styles.listRow}>
              <span className={styles.listDetail}><b>{p.payee ?? 'Payee'}</b>{p.description ? ` · ${p.description}` : ''}{p.pvNumber ? ` · ${p.pvNumber}` : ''}</span>
              <span className={styles.listAmount}>{fmtSen(p.amountSen)}</span>
            </div>
          ))}
        </section>
      </div>

      <div className={styles.footnote}>Live from the ledger. Money already paid out is inside the bank figures; drafts are not counted. {board.note}</div>
    </div>
  );
}
