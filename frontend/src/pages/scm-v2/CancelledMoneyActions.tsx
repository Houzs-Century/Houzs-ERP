// The Sales Orders list's bar for ticked CANCELLED orders: what money still
// sits on them, and [Refund] [Convert] over all of them at once — several
// orders, any customers. The forms are the panel's own pickers; the new
// order copies the first ticked order's customer and lines.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ConvertPicker, RefundPicker } from '../../vendor/scm/components/OrderMoneyPanel';
import { newOrderWithMoneyHref, useCancelledWithMoney, type ConvertPick, type ConvertSource } from '../../vendor/scm/lib/so-money-queries';
import { fmtSen } from '../../vendor/shared/format';

export type TickedOrder = { docNo: string; status: string; customer: string | null };

const btn: React.CSSProperties = {
  padding: '4px 12px', borderRadius: 6, border: '1px solid var(--c-line, rgba(34,31,32,0.2))',
  background: 'var(--c-paper, #fff)', cursor: 'pointer', fontSize: 'var(--fs-12)', fontWeight: 600,
};

/** The ticked orders as sources, in the order they were ticked, and the
    ticked orders the money list does not carry (nothing left on them). */
export const sourcesOf = (ticked: TickedOrder[], withMoney: ConvertSource[]): { rows: ConvertSource[]; without: string[] } => {
  const rows: ConvertSource[] = [];
  const without: string[] = [];
  for (const t of ticked) {
    const m = withMoney.find((o) => o.docNo === t.docNo);
    if (m) rows.push(m); else without.push(t.docNo);
  }
  return { rows, without };
};

export const CancelledMoneyActions = ({ ticked, onDone }: { ticked: TickedOrder[]; onDone: () => void }) => {
  const navigate = useNavigate();
  const allCancelled = ticked.length > 0 && ticked.every((t) => t.status === 'CANCELLED');
  const q = useCancelledWithMoney(null, allCancelled);
  const [mode, setMode] = useState<'idle' | 'refund' | 'convert'>('idle');
  const { rows, without } = useMemo(() => sourcesOf(ticked, q.data?.orders ?? []), [ticked, q.data]);
  if (!allCancelled) return null;
  const total = rows.reduce((s, r) => s + r.remainingSen, 0);
  const blocked = !q.data || without.length > 0;
  const why = q.isError ? 'the money on them could not be read' : without.length > 0 ? `${without.join(', ')} ${without.length === 1 ? 'has' : 'have'} no money on it` : q.isLoading ? 'reading the money on them' : null;
  const copyFrom = rows[0]?.docNo ?? '';
  return (
    <div className="mb-3 rounded-lg border border-primary/40 bg-primary-soft px-4 py-2.5" data-testid="cancelled-money-bar" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 'var(--fs-13)' }}>
        <b>Cancelled orders</b>
        {q.data && <span>{fmtSen(total)} still on {rows.length === 1 ? 'this order' : `these ${rows.length} orders`}</span>}
        {why && <span style={{ color: 'var(--c-danger, #a33)' }}>{why}</span>}
        <span style={{ flex: 1 }} />
        {mode === 'idle' && (
          <>
            <button type="button" style={btn} disabled={blocked} onClick={() => setMode('refund')}>Refund</button>
            <button type="button" style={btn} disabled={blocked} onClick={() => setMode('convert')}>Convert</button>
          </>
        )}
      </div>
      {mode === 'refund' && <RefundPicker rows={rows} onDone={() => { setMode('idle'); onDone(); }} />}
      {mode === 'convert' && (
        <ConvertPicker rows={rows} copyFrom={copyFrom} ticked={rows.map((r) => r.docNo)} onDone={() => setMode('idle')}
          onOpen={(from: string, picks: ConvertPick[]) => navigate(newOrderWithMoneyHref(from, picks))} />
      )}
    </div>
  );
};
