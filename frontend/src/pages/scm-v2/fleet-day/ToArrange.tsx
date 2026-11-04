import { useState } from 'react';
import { cn } from '../../../lib/utils';
import { Button } from '../../../components/Button';
import { fmtSen } from '../../../vendor/shared/format';
import { useNotify } from '../../../vendor/scm/components/NotifyDialog';
import {
  useScheduleDelivery, useUpdateDeliveryFields, type PlanningOrder,
} from '../../../vendor/scm/lib/delivery-planning-queries';
import type { DriverRow } from '../../../vendor/scm/lib/drivers-queries';
import type { HelperRow } from '../../../vendor/scm/lib/helpers-queries';
import { slotLabelOf } from '../../../vendor/scm/lib/fleet-day-cards';
import { latestLiveDoId } from './vm';

type Lorry = { id: string; plate: string };
type Bulk = { lorryId: string; driverId: string; helper1Id: string; helper2Id: string; slotFrom: string; slotTo: string };
const EMPTY_BULK: Bulk = { lorryId: '', driverId: '', helper1Id: '', helper2Id: '', slotFrom: '', slotTo: '' };

/** The To-arrange tab: a selectable table of the day's drops not on a lorry yet,
 *  with a bulk bar that assigns them onto a lorry (minting a run if needed) with
 *  crew and an optional custom slot. */
export function ToArrangeTab({
  orders, date, drivers, helpers, lorries, salespersonOf, onAssigned,
}: {
  orders: PlanningOrder[];
  date: string;
  drivers: DriverRow[];
  helpers: HelperRow[];
  lorries: Lorry[];
  salespersonOf: (o: PlanningOrder) => string;
  onAssigned: () => void;
}) {
  const notify = useNotify();
  const sched = useScheduleDelivery();
  const fields = useUpdateDeliveryFields();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<Bulk>(EMPTY_BULK);
  const [busy, setBusy] = useState(false);

  const allKeys = orders.map((o) => o.so_doc_no);
  const allSel = allKeys.length > 0 && allKeys.every((k) => sel.has(k));
  const toggle = (k: string) => setSel((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const toggleAll = () => setSel(allSel ? new Set() : new Set(allKeys));
  const setB = (patch: Partial<Bulk>) => setBulk((b) => ({ ...b, ...patch }));

  const assign = async () => {
    if (sel.size === 0) return;
    if (!bulk.driverId) { void notify({ title: 'Driver required', body: 'Pick a driver before assigning to a lorry.', tone: 'error' }); return; }
    if ((bulk.slotFrom === '') !== (bulk.slotTo === '')) { void notify({ title: 'Time slot', body: 'Enter both the from and to times, or leave both blank.', tone: 'error' }); return; }
    if (bulk.slotFrom && bulk.slotTo && bulk.slotTo <= bulk.slotFrom) { void notify({ title: 'Time slot', body: 'The end time must be after the start time.', tone: 'error' }); return; }

    setBusy(true);
    const chosen = orders.filter((o) => sel.has(o.so_doc_no));
    const slot = bulk.slotFrom && bulk.slotTo ? `${bulk.slotFrom}–${bulk.slotTo}` : null;
    let ok = 0; let failed = 0; let noDoSlot = 0;
    for (let i = 0; i < chosen.length; i += 1) {
      const o = chosen[i]!;
      try {
        await sched.mutateAsync({
          type: 'so', id: o.so_doc_no, scheduleDate: date, tripDate: date,
          lorryId: bulk.lorryId || null, driverId: bulk.driverId || null,
          helper1Id: bulk.helper1Id || null, helper2Id: bulk.helper2Id || null,
          stopNo: i + 1,
        });
        ok += 1;
        if (slot) {
          const doId = latestLiveDoId(o);
          if (doId) await fields.mutateAsync({ type: 'do', id: doId, timeRange: slot });
          else noDoSlot += 1;
        }
      } catch { failed += 1; }
    }
    setBusy(false);
    setSel(new Set());
    setBulk(EMPTY_BULK);
    void notify({
      title: failed ? 'Assigned with some failures' : 'Assigned to lorry',
      body: [`${ok} order(s) placed on the run${failed ? `, ${failed} failed` : ''}.`, noDoSlot ? `${noDoSlot} had no DO yet, so the slot was skipped.` : ''].filter(Boolean).join(' '),
      tone: failed ? 'error' : 'info',
    });
    onAssigned();
  };

  const th = 'px-2 py-2 text-left font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted';
  const td = 'px-2 py-2 text-[12.5px] text-ink';
  const selectCls = 'h-8 rounded-md border border-border bg-surface px-2 text-[12px] text-ink outline-none focus:border-primary';

  return (
    <div className="space-y-3">
      {/* bulk bar */}
      <div className={cn('flex flex-wrap items-end gap-2 rounded-md border border-border p-3', sel.size > 0 ? 'bg-primary-soft' : 'bg-surface')}>
        <span className="text-[12.5px] font-semibold text-ink">{sel.size} selected</span>
        <select className={selectCls} value={bulk.lorryId} onChange={(e) => setB({ lorryId: e.target.value })} aria-label="Lorry">
          <option value="">Lorry…</option>
          {lorries.map((l) => <option key={l.id} value={l.id}>{l.plate}</option>)}
        </select>
        <select className={selectCls} value={bulk.driverId} onChange={(e) => setB({ driverId: e.target.value })} aria-label="Driver">
          <option value="">Driver…</option>
          {drivers.filter((d) => d.active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select className={selectCls} value={bulk.helper1Id} onChange={(e) => setB({ helper1Id: e.target.value })} aria-label="Helper 1">
          <option value="">Helper 1…</option>
          {helpers.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
        </select>
        <select className={selectCls} value={bulk.helper2Id} onChange={(e) => setB({ helper2Id: e.target.value })} aria-label="Helper 2">
          <option value="">Helper 2…</option>
          {helpers.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
        </select>
        <label className="flex items-center gap-1 text-[11.5px] text-ink-muted">Slot
          <input type="time" className={selectCls} value={bulk.slotFrom} onChange={(e) => setB({ slotFrom: e.target.value })} aria-label="Slot from" />
          <span>–</span>
          <input type="time" className={selectCls} value={bulk.slotTo} onChange={(e) => setB({ slotTo: e.target.value })} aria-label="Slot to" />
        </label>
        <Button variant="primary" onClick={() => void assign()} disabled={busy || sel.size === 0}>{busy ? 'Assigning…' : 'Assign to lorry'}</Button>
        {sel.size > 0 && <Button variant="ghost" onClick={() => setSel(new Set())}>Clear</Button>}
      </div>

      {orders.length === 0 ? (
        <div className="rounded-md border border-border bg-surface p-4 text-center text-[12.5px] text-ink-muted">Every order due this day is on a lorry.</div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-surface">
          <table className="w-full border-collapse">
            <thead className="border-b border-border bg-surface-2">
              <tr>
                <th className={th}><input type="checkbox" checked={allSel} onChange={toggleAll} aria-label="Select all" /></th>
                <th className={th}>SO No.</th><th className={th}>Customer</th><th className={th}>Phone</th>
                <th className={th}>Address</th><th className={th}>Region</th><th className={th}>Slot</th>
                <th className={th}>Salesperson</th><th className={th}>Amount</th><th className={th}>Units</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const checked = sel.has(o.so_doc_no);
                return (
                  <tr key={o.so_doc_no} className={cn('border-b border-border-subtle hover:bg-surface-2', checked && 'bg-primary-soft')}>
                    <td className={td}><input type="checkbox" checked={checked} onChange={() => toggle(o.so_doc_no)} aria-label={`Select ${o.so_doc_no}`} /></td>
                    <td className={cn(td, 'font-mono')}>{o.so_doc_no}</td>
                    <td className={td}>{o.debtor_name || '—'}</td>
                    <td className={td}>{o.phone || '—'}</td>
                    <td className={cn(td, 'max-w-[220px] truncate')}>{o.address || '—'}</td>
                    <td className={td}>{o.region}</td>
                    <td className={td}>{slotLabelOf(o.time_range) || '—'}</td>
                    <td className={td}>{salespersonOf(o)}</td>
                    <td className={cn(td, 'font-mono tabular-nums')}>{fmtSen(o.local_total_sen)}</td>
                    <td className={cn(td, 'tabular-nums')}>{o.delivered_qty + o.remaining_qty}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
