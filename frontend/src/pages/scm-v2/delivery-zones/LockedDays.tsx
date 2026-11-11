// Locked delivery days (scm.delivery_day_locks via /delivery-zones/locks). A lock
// marks a day as settled on Delivery Date Arrangement; it is a marker, nothing
// on the server refuses a change to a locked day. Locks made here and there are
// company-wide (no warehouse), the same as the ones that page creates.
import { useState } from 'react';
import { Lock } from 'lucide-react';
import { fmtDate, todayMY } from '../../../vendor/shared/format';
import { DateField } from '../../../vendor/scm/components/DateField';
import { useConfirm } from '../../../vendor/scm/components/ConfirmDialog';
import { writeFailedAs } from '../../../vendor/scm/lib/mutation-error';
import { useDayLocks, useLockDay, useUnlockDay } from '../../../vendor/scm/lib/delivery-zones-queries';

const inputCls = 'min-h-[40px] w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink';

export function LockedDays() {
  const today = todayMY();
  const locks = useDayLocks({ from: today });
  const lockDay = useLockDay();
  const unlockDay = useUnlockDay();
  const askConfirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [date, setDate] = useState('');
  const [notes, setNotes] = useState('');
  const list = locks.data ?? [];
  // The lock table's unique key includes a nullable warehouse, so the server does
  // not stop a second company-wide lock on the same day; refuse it here.
  const already = date !== '' && list.some((l) => l.deliveryDate === date && l.warehouseId == null);

  const save = () => {
    if (!date || already) return;
    lockDay.mutate({ deliveryDate: date, warehouseId: null, notes: notes.trim() || null }, {
      onSuccess: () => { setAdding(false); setDate(''); setNotes(''); },
      onError: writeFailedAs('Day not locked'),
    });
  };

  const unlock = async (id: string, day: string) => {
    if (!(await askConfirm({ title: `Unlock ${fmtDate(day)}?`, body: 'Its delivery dates can be proposed and changed again.', confirmLabel: 'Unlock' }))) return;
    unlockDay.mutate(id, { onError: writeFailedAs('Day not unlocked') });
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[16px] font-semibold text-ink">Locked days</h2>
          <p className="text-[12.5px] text-ink-muted">Shown as locked on Delivery Date Arrangement. Today and later.</p>
        </div>
        {!adding && <button type="button" onClick={() => setAdding(true)} className="min-h-[40px] rounded-md border border-border bg-surface px-3 text-[12.5px] font-semibold text-ink">Lock a day</button>}
      </div>

      {adding && (
        <div className="grid gap-3 rounded-xl border border-border bg-surface p-4 sm:grid-cols-[200px_1fr_auto]">
          <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-ink-muted">Day
            <DateField value={date} onChange={setDate} min={today} fullWidth aria-label="Day to lock" invalid={already} />
            {already && <span className="font-normal text-[color:var(--hz-dk-err,#8a2c2c)]">This day is already locked.</span>}
          </label>
          <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-ink-muted">Note
            <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} placeholder="Optional" className={inputCls} />
          </label>
          <div className="flex items-end gap-2">
            <button type="button" onClick={save} disabled={!date || already || lockDay.isPending} className="min-h-[40px] rounded-md bg-primary px-3 text-[12.5px] font-semibold text-white disabled:opacity-50">
              {lockDay.isPending ? 'Locking…' : 'Lock day'}
            </button>
            <button type="button" onClick={() => { setAdding(false); setDate(''); setNotes(''); }} className="min-h-[40px] px-2 text-[12.5px] text-ink">Cancel</button>
          </div>
        </div>
      )}

      {locks.isError && <p className="text-[12.5px] text-[color:var(--hz-dk-err,#8a2c2c)]">Locked days could not be loaded.</p>}
      {!locks.isLoading && !locks.isError && list.length === 0 && (
        <div className="flex items-center gap-3 rounded-xl border border-border bg-surface p-5 text-[13.5px] text-ink-muted">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-surface-2"><Lock size={18} aria-hidden /></span>
          No days locked from today on.
        </div>
      )}
      {list.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
          {list.map((l) => (
            <div key={l.id} className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4">
              <div className="flex items-center gap-2.5">
                <span className="grid h-9 w-9 flex-none place-items-center rounded-lg bg-primary-soft text-primary"><Lock size={16} aria-hidden /></span>
                <span className="flex flex-col">
                  <span className="text-[15px] font-semibold text-ink">{fmtDate(l.deliveryDate)}</span>
                  <span className="text-[12px] text-ink-muted">{l.warehouseId ? 'One warehouse' : 'All warehouses'}</span>
                </span>
              </div>
              <span className="text-[13px] text-ink-secondary">{l.notes || 'No note'}</span>
              <button type="button" onClick={() => void unlock(l.id, l.deliveryDate)} disabled={unlockDay.isPending} className="self-start text-[12.5px] font-semibold text-primary hover:underline disabled:opacity-50">Unlock</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
