// ----------------------------------------------------------------------------
// DailyBankBoard — the Daily Bank's Board (the owner's Claude Design redesign,
// batch 3, "Money today"): how much can move today, how the day got there, each
// bank and cash account with the day's movements, the card money on its way,
// and the vouchers awaiting approval. Reads the same board the Accounts sheet
// does (GET /accounting/daily-bank), so the two never disagree. The cash book's
// page (2026-11-23) draws its own board here too, and says which banks it does
// not carry yet.
// ----------------------------------------------------------------------------

import { Link } from 'react-router-dom';
import { ArrowRight, Hourglass } from 'lucide-react';
import { fmtDate, fmtSen } from '../../vendor/shared/format';
import styles from './DailyBank.module.css';
import type { DailyBankBlock, DailyBankBoard, DailyBankMovement, DailyBankPending } from './accounting-phase1-queries';

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

/** On the cash book: the banks it does not carry yet, and why — none of them is in its totals. */
export function notStartedNote(b: DailyBankBoard): string | null {
  if (b.book !== 'cashbook' || b.notStarted.length === 0) return null;
  const names = b.notStarted.map((a) => (a.startDate ? `${a.accountName} (starts ${fmtDate(a.startDate)})` : a.accountName)).join(', ');
  return b.blocks.length === 0
    ? `No bank is on the cash book yet for this day. Set a bank's starting balance in Receipts & starts. Not started: ${names}.`
    : `Not on the cash book yet, so not in these totals: ${names}.`;
}

/** A cash-book bank's tag: the day its cash book starts. */
export const sinceLabel = (start: { date: string }): string => `Cash book since ${fmtDate(start.date)}`;

/** What a day's line is called on a card: who, else (a typed receipt) its note, else its document. */
const lineWho = (m: DailyBankMovement): string => m.party ?? (m.sourceType === 'TYPED' ? m.note : m.docNo);

/** Every voucher checked and awaiting approval: per bank, then those paying from an account the board does not carry. */
export const awaitingVouchers = (b: DailyBankBoard): DailyBankPending[] => [...b.blocks.flatMap((x) => x.pending), ...b.unassignedPending];

function AccountCard({ block, onOpen }: { block: DailyBankBlock; onOpen: (accountCode: string) => void }) {
  const lines = [
    ...block.receipts.map((m, i) => ({ key: `in:${m.jeNo}:${m.docNo}:${m.sourceDocNo ?? i}`, who: lineWho(m), sen: m.amountSen, dir: 'in' as const, dated: null })),
    ...block.payouts.map((m, i) => ({ key: `out:${m.jeNo}:${m.docNo}:${m.sourceDocNo ?? i}`, who: lineWho(m), sen: m.amountSen, dir: 'out' as const, dated: m.voucherDate ?? null })),
  ];
  return (
    <button type="button" className={styles.accountCard} title="See every movement of this account" onClick={() => onOpen(block.accountCode)}>
      <div className={styles.accountHead}>
        <span className={styles.accountName}>{block.accountName}</span>
        <span className={styles.accountCode}>{block.accountCode}</span>
      </div>
      {block.start && <span><span className={`${styles.srcTag} ${styles.srcCash}`}>{sinceLabel(block.start)}</span></span>}
      <div className={`${styles.accountClosing} ${block.closingSen < 0 ? styles.negative : ''}`}>{fmtSen(block.closingSen)}</div>
      <div className={styles.accountLines}>
        {lines.length === 0 && <span className={styles.muted}>No movement today</span>}
        {lines.slice(0, 5).map((l) => (
          <span key={l.key} className={styles.accountLine}>
            <span className={styles.lineWho}>{l.who}</span>
            {/* A voucher approved on another day than its own date says that date
                (owner 2026-11-24: it comes off on the day it is approved); the name
                gives way first, never the date. */}
            {l.dated && <span className={styles.lineDated}>dated {fmtDate(l.dated)}</span>}
            <span className={l.dir === 'in' ? styles.moneyIn : styles.moneyOut}>{l.dir === 'in' ? '+' : '−'}{fmtSen(l.sen).replace(/^RM\s*/, '')}</span>
          </span>
        ))}
        {lines.length > 5 && <span className={styles.muted}>+{lines.length - 5} more</span>}
      </div>
    </button>
  );
}

export function DailyBankBoardView({ board, onOpenAccount, cashbook }: {
  board: DailyBankBoard; onOpenAccount: (accountCode: string) => void;
  /** The cash book's page: where its banks' starts and receipts are typed. null on the original. */
  cashbook: { onOpenEntries: () => void } | null;
}) {
  const bridge = bridgeRows(board);
  const waiting = notStartedNote(board);
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

      {cashbook && waiting && (
        <div className={styles.sourceNote} role="note">
          <span>{waiting}</span>
          <button type="button" className={styles.linkButton} onClick={cashbook.onOpenEntries}>Open Receipts &amp; starts</button>
        </div>
      )}

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

      <div className={styles.footnote}>{board.book === 'cashbook'
        ? `Your cash book; the original Daily Bank is unchanged. Drafts are not counted. ${board.note}`
        : `Live from the ledger. Money already paid out is inside the bank figures; drafts are not counted. ${board.note}`}</div>
    </div>
  );
}
