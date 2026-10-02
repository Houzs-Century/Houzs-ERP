// Desktop presentation of a DRAFT GRN line split over several racks (owner
// 2026-10-02). The logic is the shared useGrnLineRackSplit — the phone's
// MobileGrnLineRack renders the same hook — so only the look is desktop's.
// Saves on Add / remove, like the one-rack picker's own endpoint, independent of
// the line form's Save.
import { useState } from 'react';
import { X } from 'lucide-react';
import { SearchableSelect } from '../../vendor/scm/components/SearchableSelect';
import { NumberInput } from '../../vendor/scm/components/NumberInput';
import { Button } from '../../components/Button';
import { useGrnLineRackSplit } from '../../vendor/scm/lib/grn-line-rack';

export function GrnRackSplitField({ grnId, itemId, lineRackId, qtyAccepted, rackOptions, rackLabelById, inputClassName }: {
  grnId: string;
  itemId: string;
  lineRackId: string | null;
  qtyAccepted: number;
  rackOptions: { value: string; label: string }[];
  rackLabelById: ReadonlyMap<string, string>;
  inputClassName?: string;
}) {
  const split = useGrnLineRackSplit({ grnId, itemId, lineRackId, qtyAccepted });
  const [rackId, setRackId] = useState('');
  const [qty, setQty] = useState<number | null>(null);
  const busy = split.saving || split.loading;

  const pick = (v: string) => {
    setRackId(v);
    setQty(split.remaining > 0 ? split.remaining : 1);
  };
  const add = () => {
    if (!rackId || !qty) return;
    split.add(rackId, qty, () => { setRackId(''); setQty(null); });
  };

  return (
    <div className="flex flex-col gap-1.5">
      {split.splits.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {split.splits.map((s) => (
            <span key={s.rackId} className="inline-flex items-center gap-1 rounded-full bg-primary-soft py-0.5 pl-2.5 pr-1 text-[12px] text-ink">
              {rackLabelById.get(s.rackId) ?? '?'} &times; {s.qty}
              <button type="button" aria-label={`Remove ${rackLabelById.get(s.rackId) ?? 'rack'}`} disabled={busy}
                onClick={() => split.remove(s.rackId)} className="rounded p-0.5 text-ink-muted hover:text-ink">
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className={`text-[11.5px] ${split.remaining > 0 ? 'text-amber-700' : 'text-primary'}`}>
        {split.remaining > 0 ? `${split.remaining} of ${qtyAccepted} not on a rack yet` : `All ${qtyAccepted} on racks`}
      </div>
      <div className="flex items-center gap-1.5">
        <SearchableSelect
          className={inputClassName}
          value={rackId}
          onChange={pick}
          disabled={busy || rackOptions.length === 0}
          ariaLabel="Add a rack"
          placeholder={rackOptions.length === 0 ? 'No racks in this warehouse' : 'Add a rack (type to search)'}
          options={rackOptions}
        />
        {rackId && (
          <>
            <NumberInput className={inputClassName} sign="unsigned" decimal={false} value={qty}
              onValueChange={(n) => setQty(n)} aria-label="Quantity on this rack" style={{ width: 72 }} />
            <Button variant="secondary" onClick={add} disabled={busy || !qty}>Add</Button>
          </>
        )}
      </div>
      {split.error && <div role="alert" className="text-[11.5px] text-red-700">{split.error}</div>}
    </div>
  );
}
