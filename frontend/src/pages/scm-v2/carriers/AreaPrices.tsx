// Areas, at the top of the Outstation tab (owner 2026-11-11 on the 3PL
// quotations: 加「地区价」). An area is a name and its towns, with prices of its
// own. They read as ONE ruled table (owner, the same day: 「做成一个table」,
// 「别"，"」, 「放线条」, prices 「放在上面别centre」): the card's own prices first,
// then a row per town A to Z, each area's name, prices and pencil merged down
// across its towns. A click on a price changes or removes it; a dash, where the
// card's own price applies, adds one. A delivery to one of the area's towns is
// priced with these in place of the card's own; a town price on the same town
// still adds on top.
import { useMemo, useState } from 'react';
import { Check, Pencil, Plus, X } from 'lucide-react';
import { fmtSen } from '@2990s/shared';
import {
  useAddAreaWithPrices, useCreateRateRule, useDeleteRateArea, useUpdateRateArea,
  type NewRateRule, type RateArea, type RateRule,
} from '../../../vendor/scm/lib/delivery-rate-card-queries';
import { useConfirm } from '../../../vendor/scm/components/ConfirmDialog';
import { writeFailedAs } from '../../../vendor/scm/lib/mutation-error';
import { cn } from '../../../lib/utils';
import { centiToRM, rmToSen } from './cardSettings';
import { areaColumns, columnHead, parseTowns, ruleAt, sortTowns, townLabel, type PriceBox } from './rateCardAreas';
import { AMOUNT_ERROR, PriceEditor } from './ruleEditors';
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

/* The ruled table's cells: lines on every side, as in a spreadsheet. */
const CELL = 'border border-border-strong px-2.5 py-1.5 align-top';
const HEAD = 'border border-border-strong bg-surface-2 px-2.5 py-2 align-bottom text-[12px] font-semibold text-ink-secondary';
const PRICE_BTN = 'min-h-[28px] w-full rounded-md px-1 text-right tabular-nums text-ink hover:bg-surface-2 hover:text-primary';
const SMALL_BTN = 'grid h-8 w-8 flex-none place-items-center rounded-lg text-ink-muted hover:bg-surface-2 disabled:opacity-50';

/** A price this area has no box for yet, added from its own cell. */
const AddCellPrice = ({ cardId, template, label, scope }: {
  cardId: string; template: Omit<NewRateRule, 'amountSen'>; label: string; scope: string;
}) => {
  const create = useCreateRateRule(cardId);
  const [draft, setDraft] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const what = `${label} price for ${scope}`;
  if (draft === null) {
    return (
      <button type="button" onClick={() => setDraft('')} aria-label={`Add ${what}`} title="The card’s own price applies. Click to give this area its own."
        className="min-h-[28px] w-full rounded-md px-1 text-right text-ink-muted hover:bg-surface-2 hover:text-primary">—</button>
    );
  }
  const save = () => {
    const amountSen = rmToSen(draft);
    if (draft.trim() === '' || amountSen == null) { setErr(AMOUNT_ERROR); return; }
    create.mutate({ ...template, amountSen }, { onSuccess: () => setDraft(null), onError: writeFailedAs('The price was not added') });
  };
  return (
    <span className="flex flex-col items-end gap-1">
      <input autoFocus className="min-h-[34px] w-[110px] rounded-lg border border-border bg-surface px-2 text-right text-[14px] tabular-nums text-ink"
        inputMode="decimal" placeholder="0.00" aria-label={`Amount for ${label} for ${scope}`}
        value={draft} onChange={(e) => { setErr(null); setDraft(e.target.value); }}
        onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setDraft(null); }} />
      <span className="flex items-center gap-1">
        <button type="button" className={cn(SMALL_BTN, 'text-primary')} onClick={save} disabled={create.isPending} aria-label={`Save ${what}`}>
          <Check size={15} strokeWidth={2} />
        </button>
        <button type="button" className={SMALL_BTN} onClick={() => setDraft(null)} aria-label={`Cancel ${what}`}><X size={15} strokeWidth={2} /></button>
      </span>
      {err && <span role="alert" className={ERR}>{err}</span>}
    </span>
  );
};

/** One area's price for one column: the amount (a click changes or removes
 *  it), or a dash where the card's own price applies (a click adds one). */
const AreaPriceCell = ({ cardId, area, col, rule, rowSpan }: {
  cardId: string; area: RateArea; col: PriceBox; rule: RateRule | null; rowSpan: number;
}) => {
  const [editing, setEditing] = useState(false);
  const name = `${col.label} for ${area.name}`;
  return (
    <td rowSpan={rowSpan} className={cn(CELL, 'text-right')}>
      {rule == null
        ? <AddCellPrice cardId={cardId} template={{ ...col.rule, areaId: area.id }} label={col.label} scope={area.name} />
        : editing
          ? <PriceEditor cardId={cardId} rule={rule} name={name} onDone={() => setEditing(false)} />
          : (
            <button type="button" onClick={() => setEditing(true)} aria-label={`Edit ${name}, ${fmtSen(rule.amountSen)}`} className={PRICE_BTN}>
              {centiToRM(rule.amountSen)}
            </button>
          )}
    </td>
  );
};

/** One area: a row per town, its name, prices and pencil merged down across them. */
const AreaRows = ({ cardId, area, rules, columns, editing, onEditing }: {
  cardId: string; area: RateArea; rules: readonly RateRule[]; columns: readonly PriceBox[]; editing: boolean; onEditing: (on: boolean) => void;
}) => {
  const towns = sortTowns(area.towns);
  const rows = towns.length > 0 ? towns : [''];
  const span = rows.length;
  return (
    <tbody aria-label={area.name}>
      {rows.map((town, i) => (
        <tr key={town || '-'}>
          {i === 0 && (
            <th scope="rowgroup" rowSpan={span} className={cn(CELL, 'text-left font-normal')}>
              <span className="block text-[13px] font-bold text-ink">{area.name}</span>
              <span className={HINT}>{townsWord(towns.length)}</span>
            </th>
          )}
          <td className={cn(CELL, 'text-ink-secondary')}>{townLabel(town)}</td>
          {i === 0 && columns.map((c) => (
            <AreaPriceCell key={c.key} cardId={cardId} area={area} col={c} rule={ruleAt(rules, area.id, c.key)} rowSpan={span} />
          ))}
          {i === 0 && (
            <td rowSpan={span} className={cn(CELL, 'w-[44px] text-center')}>
              {!editing && (
                <button type="button" className="grid h-7 w-7 place-items-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-primary"
                  onClick={() => onEditing(true)} aria-label={`Change ${area.name}`}>
                  <Pencil size={14} strokeWidth={1.75} />
                </button>
              )}
            </td>
          )}
        </tr>
      ))}
      {editing && (
        <tr>
          <td colSpan={columns.length + 3} className={cn(CELL, 'bg-surface-2/50 py-3')}>
            <AreaEditor cardId={cardId} area={area} onDone={() => onEditing(false)} />
          </td>
        </tr>
      )}
    </tbody>
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

/** The card's areas as one ruled table — the card's own prices first, then a
 *  row per town, each area's name and prices merged down across its towns —
 *  and the form for a new area when it is open. */
export const AreaPrices = ({ cardId, areas, rules, ownRules, template, unit, adding, onAdding }: {
  cardId: string; areas: readonly RateArea[]; rules: readonly RateRule[]; ownRules: readonly RateRule[];
  template: readonly PriceBox[]; unit: string; adding: boolean; onAdding: (open: boolean) => void;
}) => {
  const [editing, setEditing] = useState<string | null>(null);
  const columns = useMemo(() => areaColumns(template, rules, unit), [template, rules, unit]);
  return (
    <div className="flex flex-col gap-2.5">
      {areas.length > 0 && (
        <>
          <span className="text-[12.5px] font-semibold text-ink-secondary">Areas, each with its own prices (RM)</span>
          {/* On a phone the table keeps its columns and scrolls sideways inside this box. */}
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-[13px] tabular-nums">
              <thead>
                <tr>
                  <th scope="col" className={cn(HEAD, 'text-left')}>Area</th>
                  <th scope="col" className={cn(HEAD, 'text-left')}>Town</th>
                  {columns.map((c) => <th key={c.key} scope="col" className={cn(HEAD, 'text-right')}>{columnHead(c)}</th>)}
                  <th scope="col" className={HEAD}><span className="sr-only">Change the area</span></th>
                </tr>
              </thead>
              <tbody aria-label="Everywhere else">
                <tr className="bg-surface-2/60">
                  <th scope="row" className={cn(CELL, 'text-left font-normal')}>
                    <span className="block text-[13px] font-semibold text-ink-secondary">Everywhere else</span>
                    <span className={HINT}>the card’s own prices</span>
                  </th>
                  <td className={cn(CELL, 'text-ink-muted')}>Towns not in an area below</td>
                  {columns.map((c) => {
                    const own = ruleAt(ownRules, null, c.key);
                    return <td key={c.key} className={cn(CELL, 'text-right text-ink-secondary')}>{own ? centiToRM(own.amountSen) : '—'}</td>;
                  })}
                  <td className={CELL} />
                </tr>
              </tbody>
              {areas.map((a) => (
                <AreaRows key={a.id} cardId={cardId} area={a} rules={rules} columns={columns}
                  editing={editing === a.id} onEditing={(on) => setEditing(on ? a.id : null)} />
              ))}
            </table>
          </div>
        </>
      )}
      {adding && <AddArea cardId={cardId} template={template} onDone={() => onAdding(false)} />}
    </div>
  );
};
