// Areas, at the top of the Outstation tab (owner 2026-11-11 on the 3PL
// quotations: 加「地区价」). An area is a name and its towns, with prices of its
// own. They read as ONE finance table (owner, the same day: 「做成一个table」,
// 「别"，"」, prices 「放在上面别centre」; then 「table 可以用 finance table」): the
// card's own prices first, then a shaded band per area over a row per town A to
// Z, the area's prices and pencil on its first town. A click on a price changes
// or removes it; a dash, where the card's own price applies, adds one. A delivery
// to one of the area's towns is priced with these in place of the card's own; a
// town price on the same town still adds on top.
import { useMemo, useState } from 'react';
import { DataTable, type Column } from '../../../components/DataTable';
import { useSmallViewport } from '../../../hooks/useSmallViewport';
import { Pencil, Plus } from 'lucide-react';
import {
  useAddAreaWithPrices, useDeleteRateArea, useUpdateRateArea,
  type NewRateRule, type RateArea, type RateRule,
} from '../../../vendor/scm/lib/delivery-rate-card-queries';
import { useConfirm } from '../../../vendor/scm/components/ConfirmDialog';
import { writeFailedAs } from '../../../vendor/scm/lib/mutation-error';
import { cn } from '../../../lib/utils';
import { centiToRM, rmToSen } from './cardSettings';
import { areaColumns, columnHead, parseTowns, ruleAt, sortTowns, townLabel, type PriceBox } from './rateCardAreas';
import { AMOUNT_ERROR, AddPriceCell, PriceButton } from './ruleEditors';
import { BTN_PRI, BTN_QUIET, HINT, INPUT, LABEL } from './ui';

const ERR = 'text-[12px] font-semibold text-[color:var(--hz-dk-err,#8a2c2c)]';

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

/** One line of the Areas table: the card's own prices ("Everywhere else"), or
 *  one town of an area. An area's prices and pencil sit on its first town. */
interface AreaLine { key: string; group: string; area: RateArea | null; town: string; first: boolean }

/** The group of the card's own prices; an area's group is its id. */
const OWN = 'own';

/* A cell left empty on purpose: an area's prices are not repeated under its
   first town, and DataTable draws a dash ("no price") in a null cell. */
const BLANK = <span aria-hidden="true" />;

const areaLines = (areas: readonly RateArea[]): AreaLine[] => [
  { key: OWN, group: OWN, area: null, town: '', first: true },
  ...areas.flatMap((a) => {
    const towns = sortTowns(a.towns);
    return (towns.length > 0 ? towns : ['']).map((t, i) => ({ key: `${a.id}:${t || '-'}`, group: a.id, area: a, town: t, first: i === 0 }));
  }),
];

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

/** The card's areas as one finance table — the card's own prices first, then a
 *  band per area over a row per town, the area's prices on its first town — with
 *  the form for an area being changed or added under it. The towns stay in
 *  their order (a sort or funnel would pull an area's prices off its top); the
 *  sheet export repeats an area's prices on each of its towns. */
export const AreaPrices = ({ cardId, areas, rules, ownRules, template, unit, adding, onAdding }: {
  cardId: string; areas: readonly RateArea[]; rules: readonly RateRule[]; ownRules: readonly RateRule[];
  template: readonly PriceBox[]; unit: string; adding: boolean; onAdding: (open: boolean) => void;
}) => {
  const [editing, setEditing] = useState<string | null>(null);
  /* A phone keeps the grid (scrolling sideways), not cards: a card per town
     would lose the area band its prices hang from. */
  const small = useSmallViewport();
  const boxes = useMemo(() => areaColumns(template, rules, unit), [template, rules, unit]);
  const lines = useMemo(() => areaLines(areas), [areas]);
  const names = useMemo(() => new Map(areas.map((a) => [a.id, a.name])), [areas]);
  const columns = useMemo<Column<AreaLine>[]>(() => {
    const priceOf = (r: AreaLine, key: string) => (r.area ? ruleAt(rules, r.area.id, key) : ruleAt(ownRules, null, key));
    return [
      {
        key: 'area', label: 'Area', defaultHidden: true, disableSort: true, disableFilter: true,
        getValue: (r) => r.group, exportValue: (r) => r.area?.name ?? 'Everywhere else',
        render: (r) => r.area?.name ?? 'Everywhere else',
      },
      {
        key: 'town', label: 'Town', width: '220px', disableSort: true, disableFilter: true, getValue: (r) => r.town,
        exportValue: (r) => (r.area ? townLabel(r.town) : 'Towns not in an area'),
        render: (r) => (r.area ? townLabel(r.town) : <span className="text-ink-muted">Towns not in an area below</span>),
      },
      ...boxes.map((c): Column<AreaLine> => ({
        key: `price:${c.key}`, label: columnHead(c), align: 'right', width: '116px',
        exportValue: (r) => { const p = priceOf(r, c.key); return p ? p.amountSen / 100 : ''; },
        render: (r) => {
          if (!r.area) {
            const own = priceOf(r, c.key);
            return <span className="tabular-nums text-ink-secondary">{own ? centiToRM(own.amountSen) : '—'}</span>;
          }
          if (!r.first) return BLANK;
          const rule = priceOf(r, c.key);
          return rule == null
            ? <AddPriceCell cardId={cardId} rule={{ ...c.rule, areaId: r.area.id }} label={c.label} scope={r.area.name} />
            : <PriceButton cardId={cardId} rule={rule} name={`${c.label} for ${r.area.name}`} />;
        },
      })),
      {
        key: 'change', label: 'Change', width: '64px', align: 'center',
        renderHeader: () => <span className="sr-only">Change the area</span>,
        render: (r) => {
          const area = r.area;
          if (!area || !r.first) return BLANK;
          return (
            <button type="button" className="-my-1 inline-grid h-7 w-7 place-items-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-primary"
              onClick={() => setEditing(area.id)} aria-label={`Change ${area.name}`} aria-pressed={editing === area.id}>
              <Pencil size={14} strokeWidth={1.75} />
            </button>
          );
        },
      },
    ];
  }, [boxes, rules, ownRules, cardId, editing]);
  const open = areas.find((a) => a.id === editing) ?? null;
  return (
    <div className="flex flex-col gap-2.5">
      {areas.length > 0 && (
        <DataTable<AreaLine>
          tableId="rate-card-areas" exportName="rate-card-areas" exportXlsx embedded={small}
          columns={columns} rows={lines} getRowKey={(r) => r.key}
          groupBy={{ key: 'area', label: (id) => (id === OWN ? 'Everywhere else · the card’s own prices' : names.get(id) ?? id) }}
          getRowClassName={() => 'bg-surface'}
          freezeHeight="off"
        />
      )}
      {open && (
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface-dim/40 px-4 py-3.5">
          <span className="text-[13px] font-semibold text-ink">Change {open.name}</span>
          <AreaEditor key={open.id} cardId={cardId} area={open} onDone={() => setEditing(null)} />
        </div>
      )}
      {adding && <AddArea cardId={cardId} template={template} onDone={() => onAdding(false)} />}
    </div>
  );
};
