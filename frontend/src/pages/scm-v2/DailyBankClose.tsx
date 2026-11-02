// ----------------------------------------------------------------------------
// DailyBankClose — the Daily Bank's Daily close (the owner's Claude Design
// redesign, batch 3): count what is in hand against the system. Only cash
// posts — a difference books to Cash Over/Short (946-0000) dated the day; card
// and transfer differences are timing and settle in Merchant reports and Bank
// statements. Same reads and writes as before (GET/PUT /accounting/daily-close,
// POST /daily-close/confirm); a day still to come is read-only.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react';
import { Lock } from 'lucide-react';
import { fmtDate, fmtDateTime, fmtSenPlain } from '../../vendor/shared/format';
import styles from './DailyBank.module.css';
import { useConfirmDailyClose, useDailyClose, useSaveDailyClose, type DailyCloseRow } from './accounting-phase1-queries';

const bucketLabel = (b: string): string => (b === 'cash' ? 'Cash' : b === 'transfer' ? 'Transfer' : `Card · ${b}`);
const settlesBy = (b: string): string => (b === 'cash'
  ? 'Counted here · a difference books to Cash Over/Short (946-0000)'
  : b === 'transfer' ? 'Bank statements · no posting here' : 'Merchant reports · no posting here');

const toSen = (v: string): number | null => {
  const t = v.replace(/,/g, '').trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};

type CloseState = 'ahead' | 'closed' | 'open';

/** The sentence under the table — what confirming will do, or what was done. */
export function closeNote(o: {
  state: CloseState; day: string; cashCounted: boolean; cashDiff: number | null;
  confirmedBy: string | null; confirmedAt: string | null; cashJeNo: string | null;
}): string {
  const d = fmtDate(o.day);
  if (o.state === 'ahead') return 'This day hasn’t happened yet.';
  if (o.state === 'closed') {
    const who = [o.confirmedBy ? `Closed by ${o.confirmedBy}` : 'Closed', o.confirmedAt ? fmtDateTime(o.confirmedAt).slice(11) : null].filter(Boolean).join(' · ');
    const cash = o.cashDiff == null || o.cashDiff === 0 ? 'cash matched' : `${o.cashDiff < 0 ? 'short' : 'over'} RM ${fmtSenPlain(Math.abs(o.cashDiff))} booked to Cash Over/Short`;
    return [who, cash, o.cashJeNo].filter(Boolean).join(' · ');
  }
  if (!o.cashCounted) return 'Count the cash to close the day. Only cash posts; card and transfer differences are timing and settle in Merchant reports and Bank statements.';
  if (o.cashDiff === 0) return `Cash matches. Confirming locks the counts for ${d}.`;
  return `Cash is ${(o.cashDiff ?? 0) < 0 ? 'short' : 'over'} by RM ${fmtSenPlain(Math.abs(o.cashDiff ?? 0))}. Confirming books it to Cash Over/Short (946-0000) dated ${d}.`;
}

export function DailyBankClose({ date, today }: { date: string; today: string }) {
  const q = useDailyClose(date);
  const saveM = useSaveDailyClose();
  const confirmM = useConfirmDailyClose();
  const rows = useMemo<DailyCloseRow[]>(() => q.data?.rows ?? [], [q.data]);
  const [counts, setCounts] = useState<Partial<Record<string, string>>>({});
  const [said, setSaid] = useState<string | null>(null);

  /* Re-seed the inputs whenever the day (or its saved counts) change. */
  useEffect(() => {
    const seed: Record<string, string> = {};
    for (const r of rows) seed[r.bucket] = r.countedSen == null ? '' : (r.countedSen / 100).toFixed(2);
    setCounts(seed);
    setSaid(null);
  }, [rows]);

  const ahead = date > today;
  const closed = rows.length > 0 && rows.every((r) => r.status === 'CONFIRMED');
  const state: CloseState = ahead ? 'ahead' : closed ? 'closed' : 'open';
  const readOnly = ahead || closed;
  const cashRow = rows.find((r) => r.bucket === 'cash');
  const cashCounted = toSen(counts.cash ?? '') != null;
  const cashDiff = cashRow && cashCounted ? (toSen(counts.cash ?? '') ?? 0) - cashRow.systemSen : cashRow?.diffSen ?? null;
  const anyCounted = rows.some((r) => r.countedSen != null);
  const sub = state === 'ahead' ? '' : state === 'closed' ? 'Counts locked' : anyCounted ? 'Counts not confirmed' : 'Nothing counted yet';

  const save = () => {
    saveM.mutate(
      { date, buckets: rows.map((r) => ({ bucket: r.bucket, countedSen: toSen(counts[r.bucket] ?? '') })) },
      { onSuccess: () => setSaid(`Counts saved for ${fmtDate(date)} · the day is still open`) },
    );
  };
  /* The counts on screen are saved first — the close confirms what is saved. */
  const confirm = () => {
    saveM.mutate({ date, buckets: rows.map((r) => ({ bucket: r.bucket, countedSen: toSen(counts[r.bucket] ?? '') })) }, { onSuccess: () => confirmM.mutate({ date }, {
      onSuccess: (r) => {
        const je = r.cashPosting?.jeNo;
        setSaid(`Closed ${fmtDate(date)}${cashDiff ? ` · ${cashDiff < 0 ? 'short' : 'over'} RM ${fmtSenPlain(Math.abs(cashDiff))} booked to 946-0000` : ' · cash matched'}${je ? ` · ${je}` : ''}`);
      },
    }) });
  };

  return (
    <section className={styles.closeCard} aria-label="Daily close">
      <div className={styles.closeHead}>
        <span className={styles.closeTitle}>Close {fmtDate(date)}</span>
        <span className={`${styles.pill} ${state === 'closed' ? styles.pillClosed : state === 'ahead' ? styles.pillAhead : styles.pillOpen}`}>
          {state === 'closed' ? 'Closed' : state === 'ahead' ? 'Ahead' : 'Open'}
        </span>
        <span className={styles.closeSub}>{sub}</span>
      </div>
      {q.isError && <div className={styles.problem}>The day could not be read — {q.error instanceof Error ? q.error.message : 'try again'}.</div>}
      <div className={styles.tableWrap}>
        <table className={styles.acctTable}>
          <thead>
            <tr><th>Bucket</th><th>Settles by</th><th className={styles.num}>System</th><th className={styles.num}>Counted (RM)</th><th className={styles.num}>Difference</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const counted = toSen(counts[r.bucket] ?? '');
              const diff = counted == null ? null : counted - r.systemSen;
              const tone = diff == null ? styles.muted : diff === 0 ? styles.moneyIn : r.bucket === 'cash' ? styles.negative : styles.diffOther;
              return (
                <tr key={r.bucket}>
                  <td className={r.bucket === 'cash' ? styles.docCell : undefined}>{bucketLabel(r.bucket)}</td>
                  <td className={styles.muted}>{settlesBy(r.bucket)}</td>
                  <td className={styles.num}>{fmtSenPlain(r.systemSen)}</td>
                  <td className={styles.num}>
                    <span className={`${styles.rmInput} ${r.bucket === 'cash' && counted == null && !readOnly ? styles.rmInputDue : ''}`}>
                      <span>RM</span>
                      <input inputMode="decimal" placeholder="0.00" value={counts[r.bucket] ?? ''} disabled={readOnly} aria-label={`${bucketLabel(r.bucket)} counted`}
                        onChange={(e) => setCounts((c0) => ({ ...c0, [r.bucket]: e.target.value }))} />
                    </span>
                  </td>
                  <td className={`${styles.num} ${tone}`}>{diff == null ? '—' : fmtSenPlain(diff)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className={styles.closeNote}>{closeNote({ state, day: date, cashCounted, cashDiff, confirmedBy: q.data?.confirmedBy ?? null, confirmedAt: q.data?.confirmedAt ?? null, cashJeNo: q.data?.cashJeNo ?? null })}</div>
      {!readOnly && (
        <div className={styles.closeButtons}>
          <button type="button" className={styles.navButton} disabled={saveM.isPending} onClick={save}>{saveM.isPending ? 'Saving…' : 'Save counts'}</button>
          <button type="button" className={styles.solidButton} disabled={confirmM.isPending || !cashCounted} title={cashCounted ? undefined : 'Count the cash first'} onClick={confirm}>
            <Lock size={14} />{confirmM.isPending ? 'Confirming…' : 'Confirm close'}
          </button>
        </div>
      )}
      {said && <div className={styles.saidLine} role="status">{said}</div>}
    </section>
  );
}
