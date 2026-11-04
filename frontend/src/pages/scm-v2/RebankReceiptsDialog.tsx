// RebankReceiptsDialog — move earlier transfer receipts onto the company's
// Receive into bank (owner 2026-11-04: 之前的收款我做maybank recon 时会有出现了
// 吗？ → 做改记工具). Settlement Setup opens it from the Receive into row.
//
// Find lists the transfer receipts in the dates booked on another bank, each
// with why it cannot move when it cannot (matched on that bank's statement, or
// a closed bank month). Move reverses each on its own date and books it again
// on Receive into, REBANK_PER_CALL at a time; what happened to every receipt is
// shown, the failures by name. Rules: backend/src/acc/receipt-rebank.ts.

import { useState } from 'react';
import { fmtDate, fmtSen } from '../../vendor/shared/format';
import {
  REBANK_PER_CALL, useRebankCandidates, useRebankMove, type RebankOutcome, type RebankRow,
} from '../../vendor/scm/lib/accounting-queries';
import { SetupModal } from './finance/SetupParts';
import sp from './finance/SetupParts.module.css';

const keyOf = (r: { source: string; paymentId: string }) => `${r.source}:${r.paymentId}`;

export function RebankReceiptsDialog({ targetName, defaultFrom, today, onClose }: {
  targetName: string;
  defaultFrom: string;
  today: string;
  onClose: () => void;
}) {
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(today);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [results, setResults] = useState<RebankOutcome[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = useRebankCandidates(range);
  const move = useRebankMove();
  const [busy, setBusy] = useState(false);
  /* The list as it stood when Move was pressed: the re-read after it comes back
     without the moved ones, and each one's outcome must stay on screen. */
  const [moving, setMoving] = useState<RebankRow[] | null>(null);

  const rows: RebankRow[] = moving ?? q.data?.rows ?? [];
  const movable = rows.filter((r) => r.blocked == null);
  const movableSen = movable.reduce((s, r) => s + r.amountSen, 0);
  const byKey = new Map((results ?? []).map((r) => [keyOf(r), r]));

  const find = () => {
    setResults(null); setError(null); setMoving(null);
    if (!from || !to || from > to) { setError('Pick a from date on or before the to date.'); return; }
    setRange({ from, to });
  };

  const run = async () => {
    if (movable.length === 0 || busy) return;
    setBusy(true); setError(null); setMoving(rows);
    const done: RebankOutcome[] = [];
    try {
      for (let i = 0; i < movable.length; i += REBANK_PER_CALL) {
        const batch = movable.slice(i, i + REBANK_PER_CALL).map((r) => ({ source: r.source, paymentId: r.paymentId }));
        const r = await move.mutateAsync(batch);
        done.push(...r.results);
        setResults([...done]);
      }
    } catch (e) {
      setError(`Stopped after ${done.length} of ${movable.length}: ${e instanceof Error ? e.message : 'the move failed'}`);
    } finally {
      setBusy(false);
    }
  };

  const moved = (results ?? []).filter((r) => r.status === 'moved').length;
  const failed = (results ?? []).filter((r) => r.status === 'failed').length;

  return (
    <SetupModal
      wide
      title={`Move earlier transfers to ${targetName}`}
      sub="Transfer receipts booked on another bank, reversed on their own date and booked again here. Nothing else about the payment changes."
      okLabel={results ? 'Close' : movable.length > 0 ? `Move ${movable.length} (${fmtSen(movableSen)})` : 'Close'}
      busyLabel="Moving…"
      busy={busy}
      error={error}
      onOk={() => { if (results || movable.length === 0) onClose(); else void run(); }}
      onCancel={onClose}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', gridColumn: '1 / -1' }}>
        <label className={sp.hint}>From <input className={sp.input} type="date" aria-label="Move from date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className={sp.hint}>To <input className={sp.input} type="date" aria-label="Move to date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button type="button" className={sp.btn} onClick={find} disabled={busy || q.isFetching}>{q.isFetching ? 'Finding…' : 'Find'}</button>
      </div>
      {q.isError && <div className={sp.hint} style={{ gridColumn: '1 / -1', color: '#a3352a' }}>{q.error instanceof Error ? q.error.message : 'Could not list the receipts.'}</div>}
      {range && q.data && (
        <div style={{ gridColumn: '1 / -1' }}>
          <div className={sp.hint} style={{ marginBottom: 6 }}>
            {rows.length === 0
              ? `No transfer receipts in these dates sit on another bank — nothing to move.`
              : `${rows.length} receipt(s) on another bank · ${movable.length} can move (${fmtSen(movableSen)})${rows.length > movable.length ? ` · ${rows.length - movable.length} cannot, see why` : ''}`}
            {results && ` · moved ${moved}${failed ? ` · ${failed} failed` : ''}`}
          </div>
          {rows.length > 0 && (
            <div style={{ maxHeight: 360, overflow: 'auto' }}>
              <table className={sp.table}>
                <thead><tr><th>Date</th><th>Document</th><th>Now on</th><th style={{ textAlign: 'right' }}>Amount</th><th>Status</th></tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const out = byKey.get(keyOf(r));
                    return (
                      <tr key={keyOf(r)}>
                        <td>{fmtDate(r.paidOn)}</td>
                        <td>{r.docNo}</td>
                        <td>{r.fromAccount}</td>
                        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtSen(r.amountSen)}</td>
                        <td className={sp.hint}>
                          {out ? (out.status === 'moved' ? `Moved · ${out.jeNo ?? ''}` : `${out.status === 'failed' ? 'Failed' : 'Skipped'}: ${out.reason ?? ''}`)
                            : r.blocked ?? 'Will move'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </SetupModal>
  );
}
