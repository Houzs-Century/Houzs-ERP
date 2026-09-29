// ----------------------------------------------------------------------------
// Daily Bank — "today, where is the money, and how much can actually move"
// (accounting module phase 2B; brief §3.6, owner decision 2b).
//
// Reads one live endpoint (/accounting/daily-bank) computed from the ledger —
// no cache, so this board, the Trial Balance and the GL can never disagree.
//
// By bank since 2026-09-29 (owner, his "BANK BALANCE AVAILABLE" sample: 1 By
// bank · 2 pending = checked, not yet approved — approved 了就会扣钱 · 3 show
// what was paid · 4 keep the three totals; then settlement in transit 放在相对应
// 的银行, and 要 the line with it added): the three totals stay on top; under a
// dark bar, one table per money account with its Bank Balance in the header —
// Balance B/F, Received today, Paid today, Pending payment, Available (after
// pending), In transit per acquirer, Available + in transit. The table model
// is ONE (daily-bank-report.ts), read by this page, the image and the PDF.
// Get image copies a PNG to the clipboard for WhatsApp (download fallback);
// PNG saves it; PDF saves the same table on the letterhead.
// ----------------------------------------------------------------------------

import { Fragment, useEffect, useMemo, useState } from 'react';
import { Calendar, Camera, ChevronLeft, ChevronRight, FileDown, ImageDown } from 'lucide-react';
import { useDailyBank, useDailyClose, useSaveDailyClose, useConfirmDailyClose, type DailyBankBoard } from './accounting-phase1-queries';
import { fmtSen, fmtSenPlain } from '../../vendor/shared/format';
import styles from './Suppliers.module.css';
import { PageHeader } from '../../components/Layout';
import { DateField } from "../../vendor/scm/components/DateField";
import { DAILY_BANK_HEAD, DB_COLORS, boardDayLabel, cellMoney, dailyBankSections, drawDailyBankCanvas, isDetailRow, rowColor, type DailyBankRow } from './daily-bank-report';
import { generateDailyBankPdf } from './daily-bank-pdf';

const fmt = (sen: number | null | undefined) => fmtSen(sen);
const ICON = { size: 16, strokeWidth: 1.75 } as const;

const todayLocal = (): string => {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
};

const shiftDate = (date: string, days: number): string => {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
};

const btnStyle = (primary?: boolean): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '6px 14px',
  border: '1px solid var(--c-ink)',
  borderRadius: 'var(--radius-md)',
  background: primary ? 'var(--c-ink)' : 'transparent',
  color: primary ? 'var(--c-cream)' : 'var(--c-ink)',
  fontSize: 'var(--fs-13)',
  fontWeight: 600,
  cursor: 'pointer',
});

/* The table's dress — the sample's: a dark bar, a beige band per bank, small
   grey column heads, monospace figures, received green, paid red, pending
   orange, the available row on a green band, transit grey. */
const thCell: React.CSSProperties = { padding: '8px 10px', fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.05em', color: DB_COLORS.soft, textAlign: 'left', borderBottom: `1px solid ${DB_COLORS.rule}`, whiteSpace: 'nowrap' };
const tdCell: React.CSSProperties = { padding: '7px 10px', fontSize: 'var(--fs-13)', borderBottom: `1px solid ${DB_COLORS.rule}`, verticalAlign: 'top' };
const moneyCell: React.CSSProperties = { ...tdCell, textAlign: 'right', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };

/** One row of a bank's table, coloured by what it is. */
const BoardRow = ({ r }: { r: DailyBankRow }) => {
  const color = rowColor(r.kind);
  const detail = isDetailRow(r.kind);
  const strong = r.kind === 'available' || r.kind === 'withTransit' || r.kind === 'bf' || r.kind.endsWith('Head');
  const band = r.kind === 'available' ? { background: DB_COLORS.band } : undefined;
  const lastColor = (r.kind === 'available' || r.kind === 'withTransit') && (r.lastSen ?? 0) < 0 ? DB_COLORS.red : color;
  return (
    <tr data-row={r.kind} style={band}>
      <td style={{ ...tdCell, color, fontWeight: strong ? 600 : undefined, paddingLeft: detail ? 22 : 10 }}>{detail ? `· ${r.who}` : r.who}</td>
      <td style={{ ...tdCell, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-11)', color: DB_COLORS.soft, whiteSpace: 'nowrap' }}>{r.doc}</td>
      <td style={{ ...tdCell, color: detail ? DB_COLORS.soft : color }}>{r.description}</td>
      <td data-col="received" style={{ ...moneyCell, color: DB_COLORS.green, fontWeight: r.kind === 'receivedHead' ? 600 : undefined }}>{cellMoney(r.receivedSen)}</td>
      <td data-col="paid" style={{ ...moneyCell, color: DB_COLORS.red, fontWeight: r.kind === 'paidHead' ? 600 : undefined }}>{cellMoney(r.paidSen)}</td>
      <td data-col="last" style={{ ...moneyCell, color: lastColor, fontWeight: strong ? 700 : undefined }}>{cellMoney(r.lastSen)}</td>
    </tr>
  );
};

/** The board as the sample lays it out: the dark bar, then a table per bank. */
const BoardTable = ({ board }: { board: DailyBankBoard }) => {
  const sections = useMemo(() => dailyBankSections(board), [board]);
  return (
    <section aria-label="Bank balance available" style={{ border: `1px solid ${DB_COLORS.rule}`, borderRadius: 'var(--radius-md)', overflow: 'hidden', background: 'var(--c-paper, #fff)' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '12px 18px', background: DB_COLORS.bar, color: DB_COLORS.barText }}>
        <b style={{ letterSpacing: '0.12em', fontSize: 'var(--fs-14)' }}>BANK BALANCE AVAILABLE</b>
        <span style={{ flex: 1 }} />
        <b style={{ fontSize: 'var(--fs-13)' }}>{boardDayLabel(board.date)}</b>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 860 }}>
          <tbody>
            {sections.map((sec) => (
              <Fragment key={sec.key}>
                <tr data-section={sec.key} style={{ background: DB_COLORS.sectionBg }}>
                  <td colSpan={4} style={{ ...tdCell, fontWeight: 700 }}>
                    {sec.title}
                    {sec.code && <span className={styles.codeChip} style={{ marginLeft: 8 }}>{sec.code}</span>}
                  </td>
                  <td colSpan={2} style={{ ...moneyCell, fontWeight: 700 }}>
                    {sec.bankBalanceSen != null && (
                      <>
                        <span style={{ fontFamily: 'inherit', fontWeight: 500, color: DB_COLORS.soft, marginRight: 10 }}>Bank Balance</span>
                        <span data-bank-balance={sec.key} style={{ color: sec.bankBalanceSen < 0 ? DB_COLORS.red : DB_COLORS.ink }}>{fmtSenPlain(sec.bankBalanceSen)}</span>
                      </>
                    )}
                  </td>
                </tr>
                <tr>
                  {DAILY_BANK_HEAD.map((h, i) => <th key={h} scope="col" style={{ ...thCell, textAlign: i >= 3 ? 'right' : 'left' }}>{h}</th>)}
                </tr>
                {sec.rows.map((r, i) => <BoardRow key={`${sec.key}:${String(i)}`} r={r} />)}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};

export const DailyBank = () => {
  const [date, setDate] = useState(todayLocal());
  const q = useDailyBank(date);
  const board = q.data ?? null;
  const [shot, setShot] = useState<'idle' | 'copied' | 'downloaded' | 'pdf' | 'failed'>('idle');
  const [view, setView] = useState<'board' | 'close'>('board');

  const savePng = (canvas: HTMLCanvasElement, day: string) => {
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `daily-bank-${day}.png`;
    a.click();
  };
  /* Get image: the PNG onto the clipboard for WhatsApp, saved when the clipboard refuses. */
  const getImage = async () => {
    if (!board) return;
    const canvas = drawDailyBankCanvas(board);
    setShot('idle');
    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('no blob');
      // Clipboard first — the owner pastes straight into WhatsApp.
      if ('write' in navigator.clipboard && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        setShot('copied');
        return;
      }
      throw new Error('clipboard unavailable');
    } catch {
      try {
        savePng(canvas, board.date);
        setShot('downloaded');
      } catch {
        setShot('failed');
      }
    }
  };
  const getPng = () => {
    if (!board) return;
    try { savePng(drawDailyBankCanvas(board), board.date); setShot('downloaded'); } catch { setShot('failed'); }
  };
  const getPdf = () => {
    if (!board) return;
    setShot('idle');
    void generateDailyBankPdf(board).then(() => setShot('pdf')).catch(() => setShot('failed'));
  };

  const totals = useMemo(() => board ?? null, [board]);

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Finance" title="Daily Bank" />

      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <button type="button" style={btnStyle(view === 'board')} onClick={() => setView('board')}>Board</button>
        <button type="button" style={btnStyle(view === 'close')} onClick={() => setView('close')}>Daily close</button>
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" style={btnStyle()} onClick={() => setDate((d) => shiftDate(d, -1))} aria-label="Previous day"><ChevronLeft {...ICON} /></button>
        <DateField
          value={date}
          onChange={(iso) => iso && setDate(iso)}
          style={{ padding: '6px 10px', border: '1px solid var(--c-line, rgba(34,31,32,0.2))', borderRadius: 6, fontSize: 'var(--fs-13)' }}
        />
        <button type="button" style={btnStyle()} onClick={() => setDate((d) => shiftDate(d, 1))} aria-label="Next day"><ChevronRight {...ICON} /></button>
        <button type="button" style={btnStyle()} onClick={() => setDate(todayLocal())}><Calendar {...ICON} /> Today</button>
        <span style={{ flex: 1 }} />
        <button type="button" style={btnStyle(true)} onClick={() => { void getImage(); }} disabled={!board}>
          <Camera {...ICON} /> Get image
        </button>
        <button type="button" style={btnStyle()} onClick={getPng} disabled={!board}>
          <ImageDown {...ICON} /> PNG
        </button>
        <button type="button" style={btnStyle()} onClick={getPdf} disabled={!board}>
          <FileDown {...ICON} /> PDF
        </button>
        {shot === 'copied' && <span style={{ fontSize: 'var(--fs-13)', color: 'var(--c-secondary-a, #2F5D4F)' }}>Copied — paste into WhatsApp</span>}
        {shot === 'downloaded' && <span style={{ fontSize: 'var(--fs-13)' }}>Saved as PNG</span>}
        {shot === 'pdf' && <span style={{ fontSize: 'var(--fs-13)' }}>Saved as PDF</span>}
        {shot === 'failed' && <span style={{ fontSize: 'var(--fs-13)', color: 'var(--c-festive-b, #B8331F)' }}>Could not export</span>}
      </div>

      {view === 'close' && <DailyCloseView date={date} />}

      {view === 'board' && q.isLoading && <div style={{ fontSize: 'var(--fs-13)' }}>Loading the board…</div>}
      {view === 'board' && q.isError && <div role="alert" style={{ fontSize: 'var(--fs-13)', color: 'var(--c-festive-b, #B8331F)' }}>The board could not be loaded — {q.error instanceof Error ? q.error.message : 'something went wrong.'}</div>}

      {view === 'board' && totals && (
        <section style={{
          padding: 'var(--space-4)',
          background: 'rgba(47, 93, 79, 0.10)',
          border: '1px solid var(--c-secondary-a, #2F5D4F)',
          borderRadius: 'var(--radius-md)',
          display: 'flex', gap: 'var(--space-5)', flexWrap: 'wrap',
        }}>
          <div>
            <div className={styles.subtitle}>Can actually move ({totals.date})</div>
            <div style={{ fontSize: 'var(--fs-24, 24px)', fontWeight: 900, color: 'var(--c-secondary-a, #2F5D4F)' }}>{fmt(totals.availableSen)}</div>
          </div>
          <div>
            <div className={styles.subtitle}>In transit (swiped, not yet remitted)</div>
            <div style={{ fontSize: 'var(--fs-24, 24px)', fontWeight: 700 }}>{fmt(totals.totalTransitSen)}</div>
          </div>
          <div>
            {/* Checked vouchers awaiting the second yes — daily bank 的
                pending 就是第一层的checked (owner, 2026-09-02). */}
            <div className={styles.subtitle}>Checked, awaiting approval</div>
            <div style={{ fontSize: 'var(--fs-24, 24px)', fontWeight: 700 }}>{fmt(totals.pendingApprovalSen)}</div>
          </div>
        </section>
      )}

      {view === 'board' && board && <BoardTable board={board} />}

      {view === 'board' && board && (
        <div style={{ fontSize: 'var(--fs-12)', color: 'var(--c-ink-soft, #777)' }}>{board.note}</div>
      )}
    </div>
  );
};

/* ── The daily close (cashup) — count the drawer against the system ────────── */

const DailyCloseView = ({ date }: { date: string }) => {
  const q = useDailyClose(date);
  const saveM = useSaveDailyClose();
  const confirmM = useConfirmDailyClose();
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const [counts, setCounts] = useState<Record<string, string>>({});

  // Re-seed the inputs whenever the day (or its saved counts) change.
  useEffect(() => {
    const seed: Record<string, string> = {};
    for (const r of rows) seed[r.bucket] = r.countedSen == null ? '' : (r.countedSen / 100).toFixed(2);
    setCounts(seed);
  }, [rows]);

  const allConfirmed = rows.length > 0 && rows.every((r) => r.status === 'CONFIRMED');

  const toSen = (v: string): number | null => {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
  };

  const save = () => {
    saveM.mutate({
      date,
      buckets: rows.map((r) => ({ bucket: r.bucket, countedSen: toSen(counts[r.bucket] ?? '') })),
    });
  };

  return (
    <div className="space-y-3">
      <div style={{ fontSize: 'var(--fs-13)', color: 'var(--c-ink-soft, #666)' }}>
        Count what is actually in hand for {date}. Confirming posts the CASH difference into Cash Over/Short the
        same day; card and transfer differences are settlement timing and are settled by the acquirer reconciliation.
      </div>
      <table style={{ width: '100%', fontSize: 'var(--fs-13)', borderCollapse: 'collapse', maxWidth: 720 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--c-line, rgba(34,31,32,0.12))' }}>
            <th style={{ padding: '6px 8px' }}>Bucket</th>
            <th style={{ padding: '6px 8px', textAlign: 'right' }}>System</th>
            <th style={{ padding: '6px 8px', textAlign: 'right' }}>Counted (RM)</th>
            <th style={{ padding: '6px 8px', textAlign: 'right' }}>Difference</th>
            <th style={{ padding: '6px 8px' }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const counted = toSen(counts[r.bucket] ?? '');
            const diff = counted == null ? null : counted - r.systemSen;
            return (
              <tr key={r.bucket} style={{ borderBottom: '1px solid var(--c-line, rgba(34,31,32,0.06))' }}>
                <td style={{ padding: '6px 8px', fontWeight: r.bucket === 'cash' ? 700 : 400 }}>{r.bucket}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmt(r.systemSen)}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                  <input
                    inputMode="decimal"
                    value={counts[r.bucket] ?? ''}
                    disabled={r.status === 'CONFIRMED'}
                    onChange={(e) => setCounts((c0) => ({ ...c0, [r.bucket]: e.target.value }))}
                    style={{ width: 110, textAlign: 'right', padding: '4px 8px', border: '1px solid var(--c-line, rgba(34,31,32,0.2))', borderRadius: 6 }}
                  />
                </td>
                <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 700, color: diff == null || diff === 0 ? 'var(--c-ink)' : diff < 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--c-secondary-a, #2F5D4F)' }}>
                  {diff == null ? '—' : fmt(diff)}
                </td>
                <td style={{ padding: '6px 8px' }}>
                  <span className={`${styles.statusPill} ${r.status === 'CONFIRMED' ? styles.statusActive : styles.statusInactive}`}>{r.status}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <button type="button" style={btnStyle()} disabled={saveM.isPending || allConfirmed} onClick={save}>
          {saveM.isPending ? 'Saving…' : 'Save counts'}
        </button>
        <button type="button" style={btnStyle(true)} disabled={confirmM.isPending || allConfirmed}
          onClick={() => confirmM.mutate({ date })}>
          {confirmM.isPending ? 'Confirming…' : allConfirmed ? 'Day closed' : 'Confirm close'}
        </button>
      </div>
      {confirmM.data?.cashPosting?.jeNo && (
        <div style={{ fontSize: 'var(--fs-13)' }}>
          Cash over/short posted: <span className={styles.codeChip}>{confirmM.data.cashPosting.jeNo}</span>
        </div>
      )}
    </div>
  );
};
