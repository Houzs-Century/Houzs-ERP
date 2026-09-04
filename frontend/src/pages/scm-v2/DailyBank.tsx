// ----------------------------------------------------------------------------
// Daily Bank — "today, where is the money, and how much can actually move"
// (accounting module phase 2B; brief §3.6, owner decision 2b).
//
// Reads one live endpoint (/accounting/daily-bank) computed from the ledger —
// no cache, so this board, the Trial Balance and the GL can never disagree.
// Get Image draws the board onto a canvas (no DOM capture dependency) and
// copies a PNG to the clipboard for WhatsApp, with a download fallback.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react';
import { Calendar, Camera, ChevronLeft, ChevronRight } from 'lucide-react';
import { useDailyBank, useDailyClose, useSaveDailyClose, useConfirmDailyClose, type DailyBankBoard } from './accounting-phase1-queries';
import { fmtSen } from '../../vendor/shared/format';
import styles from './Suppliers.module.css';
import { PageHeader } from '../../components/Layout';
import { DateField } from "../../vendor/scm/components/DateField";

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

export const DailyBank = () => {
  const [date, setDate] = useState(todayLocal());
  const q = useDailyBank(date);
  const board = q.data ?? null;
  const [shot, setShot] = useState<'idle' | 'copied' | 'downloaded' | 'failed'>('idle');
  const [view, setView] = useState<'board' | 'close'>('board');

  const getImage = async () => {
    if (!board) return;
    const canvas = drawBoard(board);
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
        const a = document.createElement('a');
        a.href = canvas.toDataURL('image/png');
        a.download = `daily-bank-${board.date}.png`;
        a.click();
        setShot('downloaded');
      } catch {
        setShot('failed');
      }
    }
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
        <button type="button" style={btnStyle()} onClick={() => setDate((d) => shiftDate(d, -1))}><ChevronLeft {...ICON} /></button>
        <DateField
          value={date}
          onChange={(iso) => iso && setDate(iso)}
          style={{ padding: '6px 10px', border: '1px solid var(--c-line, rgba(34,31,32,0.2))', borderRadius: 6, fontSize: 'var(--fs-13)' }}
        />
        <button type="button" style={btnStyle()} onClick={() => setDate((d) => shiftDate(d, 1))}><ChevronRight {...ICON} /></button>
        <button type="button" style={btnStyle()} onClick={() => setDate(todayLocal())}><Calendar {...ICON} /> Today</button>
        <span style={{ flex: 1 }} />
        <button type="button" style={btnStyle(true)} onClick={() => { void getImage(); }} disabled={!board}>
          <Camera {...ICON} /> Get image
        </button>
        {shot === 'copied' && <span style={{ fontSize: 'var(--fs-13)', color: 'var(--c-secondary-a, #2F5D4F)' }}>Copied — paste into WhatsApp</span>}
        {shot === 'downloaded' && <span style={{ fontSize: 'var(--fs-13)' }}>Saved as PNG</span>}
        {shot === 'failed' && <span style={{ fontSize: 'var(--fs-13)', color: 'var(--c-festive-b, #B8331F)' }}>Could not export</span>}
      </div>

      {view === 'close' && <DailyCloseView date={date} />}

      {view === 'board' && q.isLoading && <div style={{ fontSize: 'var(--fs-13)' }}>Loading the board…</div>}

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

      {view === 'board' && board?.blocks.map((b) => (
        <section key={b.accountCode} style={{
          padding: 'var(--space-4)',
          background: 'var(--c-cream)',
          border: '1px solid var(--c-line, rgba(34,31,32,0.12))',
          borderRadius: 'var(--radius-md)',
        }} className="space-y-2">
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'baseline', flexWrap: 'wrap' }}>
            <b>{b.accountName}</b>
            <span className={styles.codeChip}>{b.accountCode}</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 'var(--fs-13)' }}>Opening {fmt(b.openingSen)}</span>
            <span style={{ fontSize: 'var(--fs-13)', color: 'var(--c-secondary-a, #2F5D4F)' }}>+ {fmt(b.inSen)}</span>
            <span style={{ fontSize: 'var(--fs-13)', color: 'var(--c-orange)' }}>− {fmt(b.outSen)}</span>
            <span style={{ fontWeight: 900 }}>= {fmt(b.closingSen)}</span>
          </div>
          {b.receipts.map((m) => (
            <div key={`${m.jeNo}-r`} style={{ fontSize: 'var(--fs-13)', color: 'var(--c-secondary-a, #2F5D4F)' }}>
              + {fmt(m.amountSen)} · {m.sourceType}{m.sourceDocNo ? ` ${m.sourceDocNo}` : ''} <span className={styles.codeChip}>{m.jeNo}</span> {m.note}
            </div>
          ))}
          {b.payouts.map((m) => (
            <div key={`${m.jeNo}-p`} style={{ fontSize: 'var(--fs-13)', color: 'var(--c-orange)' }}>
              − {fmt(m.amountSen)} · {m.sourceType}{m.sourceDocNo ? ` ${m.sourceDocNo}` : ''} <span className={styles.codeChip}>{m.jeNo}</span> {m.note}
            </div>
          ))}
          {b.receipts.length === 0 && b.payouts.length === 0 && (
            <div style={{ fontSize: 'var(--fs-13)', color: 'var(--c-ink-soft, #777)' }}>No movement this day.</div>
          )}
        </section>
      ))}

      {view === 'board' && board && board.transit.length > 0 && (
        <section style={{
          padding: 'var(--space-4)',
          background: 'var(--c-cream)',
          border: '1px dashed var(--c-line, rgba(34,31,32,0.3))',
          borderRadius: 'var(--radius-md)',
        }} className="space-y-1">
          <b>Settlement in transit (by acquirer)</b>
          {board.transit.map((t) => (
            <div key={t.accountCode} style={{ fontSize: 'var(--fs-13)', display: 'flex', gap: 'var(--space-3)' }}>
              <span className={styles.codeChip}>{t.acquirerCode}</span>
              <span>{t.accountName}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontWeight: 700 }}>{fmt(t.balanceSen)}</span>
            </div>
          ))}
        </section>
      )}

      {view === 'board' && board && (
        <div style={{ fontSize: 'var(--fs-12)', color: 'var(--c-ink-soft, #777)' }}>{board.note}</div>
      )}
    </div>
  );
};

/* ── The PNG the owner sends to WhatsApp — drawn, not captured ─────────────── */

const drawBoard = (b: DailyBankBoard): HTMLCanvasElement => {
  const W = 720;
  const P = 28;
  const lineH = 26;
  const rows =
    6 + b.blocks.reduce((s, bl) => s + 2 + bl.receipts.length + bl.payouts.length, 0) + b.transit.length + 3;
  const H = P * 2 + rows * lineH;
  const canvas = document.createElement('canvas');
  const scale = 2; // crisp on phone screens
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);

  ctx.fillStyle = '#FFFDF7';
  ctx.fillRect(0, 0, W, H);
  let y = P + 6;
  const text = (t: string, x: number, opts: { bold?: boolean; size?: number; color?: string; right?: boolean } = {}) => {
    ctx.font = `${opts.bold ? '700' : '400'} ${opts.size ?? 14}px system-ui, sans-serif`;
    ctx.fillStyle = opts.color ?? '#221F20';
    ctx.textAlign = opts.right ? 'right' : 'left';
    ctx.fillText(t, x, y);
  };
  const nl = (n = 1) => { y += lineH * n; };

  text(`DAILY BANK — ${b.date}`, P, { bold: true, size: 20 });
  nl(1.5);
  text(`Can actually move: ${fmtSen(b.availableSen)}`, P, { bold: true, size: 17, color: '#2F5D4F' });
  nl();
  text(`In transit (not yet remitted): ${fmtSen(b.totalTransitSen)}   ·   Checked, awaiting approval: ${fmtSen(b.pendingApprovalSen)}`, P, { size: 13, color: '#555' });
  nl(1.5);

  for (const bl of b.blocks) {
    text(`${bl.accountName}  (${bl.accountCode})`, P, { bold: true, size: 15 });
    text(`${fmtSen(bl.openingSen)}  +${fmtSen(bl.inSen)}  −${fmtSen(bl.outSen)}  =  ${fmtSen(bl.closingSen)}`, W - P, { bold: true, size: 14, right: true });
    nl();
    for (const m of bl.receipts) {
      text(`+ ${fmtSen(m.amountSen)}   ${m.sourceType}${m.sourceDocNo ? ` ${m.sourceDocNo}` : ''}   ${m.note}`.slice(0, 88), P + 14, { size: 12.5, color: '#2F5D4F' });
      nl();
    }
    for (const m of bl.payouts) {
      text(`− ${fmtSen(m.amountSen)}   ${m.sourceType}${m.sourceDocNo ? ` ${m.sourceDocNo}` : ''}   ${m.note}`.slice(0, 88), P + 14, { size: 12.5, color: '#B8331F' });
      nl();
    }
    nl(0.5);
  }

  if (b.transit.length > 0) {
    text('Settlement in transit (by acquirer):', P, { bold: true, size: 14 });
    nl();
    for (const t of b.transit) {
      text(`${t.acquirerCode}  ${t.accountName}`, P + 14, { size: 13 });
      text(fmtSen(t.balanceSen), W - P, { size: 13, right: true, bold: true });
      nl();
    }
  }
  nl(0.5);
  text('Live from the ledger - posted entries only. Transit money is visible, not spendable.', P, { size: 11, color: '#888' });

  return canvas;
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
