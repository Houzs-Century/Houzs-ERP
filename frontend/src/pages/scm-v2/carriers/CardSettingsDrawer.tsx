// A rate card's settings, opened from Edit settings on the card's header. They
// used to fill a card of their own above the prices (owner 2026-11-11: 「看了很
// 乱」); they rarely change, so the header says them in one line and the boxes
// live here. Each change saves as it is made, as it always did.
import { useState } from 'react';
import { useUpdateRateCard, type RateCard } from '../../../vendor/scm/lib/delivery-rate-card-queries';
import { writeFailedAs } from '../../../vendor/scm/lib/mutation-error';
import { ResizableDrawer } from '../../../components/ResizableDrawer';
import { aggHint, centiToRM, rmToSen, type CardKind } from './cardSettings';
import { BTN_PRI, Field, HINT, INPUT, LABEL } from './ui';

const RMField = ({ label, value, placeholder, hint, onCommit }: { label: string; value: string; placeholder: string; hint: string; onCommit: (v: string) => void }) => {
  const [buf, setBuf] = useState<string | null>(null);
  return (
    <Field label={label} hint={hint}>
      <input className={INPUT} inputMode="decimal" placeholder={placeholder} value={buf ?? value}
        onChange={(e) => setBuf(e.target.value)}
        onBlur={() => { if (buf !== null && buf !== value) onCommit(buf); setBuf(null); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    </Field>
  );
};

export const CardSettingsDrawer = ({ card, kind, title, onClose }: { card: RateCard; kind: CardKind; title: string; onClose: () => void }) => {
  const update = useUpdateRateCard();
  const patch = (body: Record<string, unknown>) =>
    update.mutate({ id: card.id, ...body }, { onError: writeFailedAs('The card was not updated') });

  return (
    <ResizableDrawer onClose={onClose} storageKey="carriers-card-settings-drawer" defaultWidth={480} ariaLabel="Card settings"
      title="Card settings" subtitle={title}
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className={HINT}>Each change saves as you make it.</span>
          <button type="button" className={BTN_PRI} onClick={onClose}>Done</button>
        </div>
      }>
      <div className="flex flex-col gap-4 p-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Charging basis">
            <select className={INPUT} value={card.basis} onChange={(e) => patch({ basis: e.target.value })}>
              <option value="SET">By set (frame + mattress)</option>
              <option value="ITEM">By item</option>
            </select>
          </Field>
          {/* WIRED since mig 0244 — this is what the tier ladder counts. */}
          <Field label="Charge per">
            <select className={INPUT} value={card.aggregation} onChange={(e) => patch({ aggregation: e.target.value })}>
              <option value="UNIT">{card.basis === 'ITEM' ? 'Item' : 'Set'}</option>
              <option value="DROP">Drop point (per DO)</option>
              <option value="CUSTOMER">Customer (same address, same day)</option>
              <option value="TRIP">Trip (flat, whatever it carries)</option>
            </select>
          </Field>
        </div>
        <p className={HINT}>{aggHint(card.aggregation)}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <RMField label="Minimum charge (RM)" placeholder="No minimum" hint="The least the card ever charges."
            value={centiToRM(card.minChargeSen)} onCommit={(v) => patch({ minChargeSen: v.trim() === '' ? null : rmToSen(v) })} />
          <RMField label="Cap (RM)" placeholder="No cap" hint="The most the card ever charges."
            value={centiToRM(card.capSen)} onCommit={(v) => patch({ capSen: v.trim() === '' ? null : rmToSen(v) })} />
        </div>
        <Field label="Rounding" hint="Applied to the total, after the minimum and the cap.">
          <select className={INPUT} value={card.rounding} onChange={(e) => patch({ rounding: e.target.value })}>
            <option value="NONE">None</option>
            <option value="NEAREST_10C">Nearest 10 sen</option>
            <option value="NEAREST_RM">Nearest RM</option>
          </select>
        </Field>
        <label className="flex cursor-pointer items-center gap-2.5 text-[13px] font-semibold text-ink">
          <input type="checkbox" className="h-[18px] w-[18px] accent-[#16695f]" checked={card.isActive} disabled={update.isPending}
            onChange={(e) => patch({ isActive: e.target.checked })} />
          Active
        </label>
        {/* WHO the card belongs to is a FACT here, not a control (owner
            2026-08-02): you reached this card by clicking that carrier, so
            re-picking it could only make the editor disagree with its own
            heading. Own fleet IS "no carrier", derived server-side (mig 0246). */}
        <div className="flex flex-col gap-1 border-t border-border pt-4">
          <span className={LABEL}>Carrier</span>
          <span className="text-[13px] font-semibold text-ink">
            {kind === 'own' ? 'Own fleet' : kind === 'removed' ? 'Carrier removed' : title}
          </span>
          <span className={HINT}>
            {kind === 'own'
              ? 'Our own cost structure, so a 3PL drop and an own-fleet drop compare.'
              : kind === 'removed' ? 'Its 3PL company no longer exists.'
              : 'One card per 3PL company. To price a different carrier, open that carrier.'}
          </span>
        </div>
      </div>
    </ResizableDrawer>
  );
};
