// Areas, at the top of the Outstation tab (owner 2026-11-11 on the 3PL
// quotations: 加「地区价」). An area is a name and its towns, with prices of its
// own shown as tiles, the way the Delivery tab shows the card's: a click changes
// or removes a price, a dashed tile adds one the card's own ladder has and the
// area does not. A delivery to one of the area's towns is priced with these in
// place of the card's own; a town price on the same town still adds on top.
import { useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
import {
  useAddAreaWithPrices, useDeleteRateArea, useUpdateRateArea,
  type NewRateRule, type RateArea, type RateRule,
} from '../../../vendor/scm/lib/delivery-rate-card-queries';
import { useConfirm } from '../../../vendor/scm/components/ConfirmDialog';
import { writeFailedAs } from '../../../vendor/scm/lib/mutation-error';
import { cn } from '../../../lib/utils';
import { rmToSen } from './cardSettings';
import { areaGrids, parseTowns, type PriceBox } from './rateCardAreas';
import { AMOUNT_ERROR, AddPriceTile, PriceTile, TileGrid } from './ruleEditors';
import { BTN_PRI, BTN_QUIET, HINT, INPUT, LABEL } from './ui';

const ERR = 'text-[12.5px] font-semibold text-[color:var(--hz-dk-err,#8a2c2c)]';
const townsWord = (n: number) => `${n} ${n === 1 ? 'town' : 'towns'}`;

/** Name and towns, typed: used to add an area and to change one. */
const AreaFields = ({ idPrefix, name, towns, onName, onTowns }: {
  idPrefix: string; name: string; towns: string; onName: (v: string) => void; onTowns: (v: string) => void;
}) => (
  <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
    <label className="flex min-w-0 flex-col gap-1.5" htmlFor={`${idPrefix}-name`}>
      <span className={LABEL}>Area name</span>
      <input id={`${idPrefix}-name`} className={INPUT} value={name} placeholder="Kuching zone 3" onChange={(e) => onName(e.target.value)} />
    </label>
    <label className="flex min-w-0 flex-col gap-1.5" htmlFor={`${idPrefix}-towns`}>
      <span className={LABEL}>Towns, separated by commas</span>
      <textarea id={`${idPrefix}-towns`} rows={2} className={cn(INPUT, 'py-2 leading-snug')} value={towns} placeholder="PADAWAN, BATU KAWAH, KOTA SAMARAHAN"
        onChange={(e) => onTowns(e.target.value)} />
      <span className={HINT}>A delivery whose address names one of these towns is priced with this area’s prices.</span>
    </label>
  </div>
);

/** The area's name and towns being changed, and its removal. */
const AreaEditor = ({ cardId, area, onDone }: { cardId: string; area: RateArea; onDone: () => void }) => {
  const update = useUpdateRateArea(cardId);
  const del = useDeleteRateArea(cardId);
  const askConfirm = useConfirm();
  const [name, setName] = useState(area.name);
  const [towns, setTowns] = useState(area.towns.join(', '));
  const [err, setErr] = useState<string | null>(null);
  const save = () => {
    const list = parseTowns(towns);
    if (name.trim() === '') { setErr('Give the area a name.'); return; }
    if (list.length === 0) { setErr('List at least one town.'); return; }
    update.mutate({ id: area.id, name: name.trim(), towns: list }, { onSuccess: onDone, onError: writeFailedAs('The area was not saved') });
  };
  const remove = async () => {
    if (!(await askConfirm({ title: `Remove the area "${area.name}"?`, body: 'Its prices are removed with it, and its towns are priced at the card’s own prices again.', confirmLabel: 'Remove', danger: true }))) return;
    del.mutate(area.id, { onSuccess: onDone, onError: writeFailedAs('The area was not removed') });
  };
  return (
    <div className="flex flex-col gap-3">
      <AreaFields idPrefix={`area-${area.id}`} name={name} towns={towns} onName={(v) => { setErr(null); setName(v); }} onTowns={(v) => { setErr(null); setTowns(v); }} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={BTN_PRI} onClick={save} disabled={update.isPending}>{update.isPending ? 'Saving…' : 'Save area'}</button>
        <button type="button" className={BTN_QUIET} onClick={onDone}>Cancel</button>
        <button type="button" className={cn(BTN_QUIET, 'ml-auto text-[color:var(--hz-dk-err,#8a2c2c)]')} onClick={() => void remove()} disabled={del.isPending}>Remove area</button>
      </div>
      {err && <p role="alert" className={ERR}>{err}</p>}
    </div>
  );
};

/** One area: its towns, then its prices as tiles. */
const AreaCard = ({ cardId, area, rules, template, unit }: {
  cardId: string; area: RateArea; rules: readonly RateRule[]; template: readonly PriceBox[]; unit: string;
}) => {
  const [editing, setEditing] = useState(false);
  const grids = areaGrids(rules, area.id, unit, template);
  return (
    <section aria-label={area.name} className="flex flex-col gap-3 rounded-xl border border-border px-4 py-3.5">
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <h4 className="min-w-0 text-[14.5px] font-bold text-ink">{area.name}<span className="ml-1.5 font-medium text-ink-muted">{townsWord(area.towns.length)}</span></h4>
          {!editing && (
            <button type="button" className={cn(BTN_QUIET, 'min-h-[32px] flex-none px-2.5 text-[12.5px]')} onClick={() => setEditing(true)} aria-label={`Change ${area.name}`}>
              <Pencil size={13} strokeWidth={1.75} />Change
            </button>
          )}
        </div>
        {/* The towns get the card's full width: a long list wraps under the name, not beside a button. */}
        {!editing && <p className="text-[12.5px] leading-snug text-ink-secondary">{area.towns.join(' · ')}</p>}
      </div>
      {editing && <AreaEditor cardId={cardId} area={area} onDone={() => setEditing(false)} />}
      {grids.length === 0 && (
        <p className="text-[13px] text-ink-muted">No prices yet: its towns are priced at the card’s own prices.</p>
      )}
      {grids.map((g) => (
        <TileGrid key={g.id} title={g.title}>
          {g.cells.map((c) => <PriceTile key={c.rule.id} cardId={cardId} cell={c} scope={area.name} />)}
          {g.missing.map((b) => (
            <AddPriceTile key={b.key} cardId={cardId} ruleType={null} template={{ ...b.rule, areaId: area.id }} label={b.tile} scope={area.name} />
          ))}
        </TileGrid>
      ))}
    </section>
  );
};

/** A new area: name, towns, and a box for each price of the card's own ladder. */
const AddArea = ({ cardId, template, onDone }: { cardId: string; template: readonly PriceBox[]; onDone: () => void }) => {
  const add = useAddAreaWithPrices(cardId);
  const [name, setName] = useState('');
  const [towns, setTowns] = useState('');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const save = () => {
    const list = parseTowns(towns);
    if (name.trim() === '') { setErr('Give the area a name.'); return; }
    if (list.length === 0) { setErr('List at least one town.'); return; }
    const prices: Array<Omit<NewRateRule, 'areaId'>> = [];
    for (const b of template) {
      const raw = (amounts[b.key] ?? '').trim();
      if (raw === '') continue;
      const amountSen = rmToSen(raw);
      if (amountSen == null) { setErr(`${b.label}: ${AMOUNT_ERROR}`); return; }
      prices.push({ ...b.rule, amountSen });
    }
    if (prices.length === 0) { setErr('Enter at least one price for the area.'); return; }
    add.mutate({ area: { name: name.trim(), towns: list }, prices }, { onSuccess: onDone, onError: writeFailedAs('The area was not added') });
  };
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-dashed border-border bg-surface-2/50 px-4 py-3.5">
      <AreaFields idPrefix="new-area" name={name} towns={towns} onName={(v) => { setErr(null); setName(v); }} onTowns={(v) => { setErr(null); setTowns(v); }} />
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]">
        {template.map((b) => (
          <label key={b.key} className="flex min-w-0 flex-col justify-end gap-1.5">
            <span className={LABEL}>{b.label} (RM)</span>
            <input className={cn(INPUT, 'text-right tabular-nums')} inputMode="decimal" placeholder="0.00" value={amounts[b.key] ?? ''}
              onChange={(e) => { setErr(null); setAmounts((s) => ({ ...s, [b.key]: e.target.value })); }} />
          </label>
        ))}
      </div>
      <p className={HINT}>A price left blank is the card’s own price in this area.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BTN_PRI} onClick={save} disabled={add.isPending}><Plus size={16} strokeWidth={1.75} />{add.isPending ? 'Adding…' : 'Add area'}</button>
        <button type="button" className={BTN_QUIET} onClick={onDone}>Cancel</button>
      </div>
      {err && <p role="alert" className={ERR}>{err}</p>}
    </div>
  );
};

/** The card's areas, then the form for a new one when it is open. */
export const AreaPrices = ({ cardId, areas, rules, template, unit, adding, onAdding }: {
  cardId: string; areas: readonly RateArea[]; rules: readonly RateRule[]; template: readonly PriceBox[]; unit: string;
  adding: boolean; onAdding: (open: boolean) => void;
}) => (
  <div className="flex flex-col gap-2.5">
    {(areas.length > 0 || adding) && <span className="text-[12.5px] font-semibold text-ink-secondary">Areas, each with its own prices</span>}
    {areas.map((a) => <AreaCard key={a.id} cardId={cardId} area={a} rules={rules} template={template} unit={unit} />)}
    {adding && <AddArea cardId={cardId} template={template} onDone={() => onAdding(false)} />}
  </div>
);
