// Price check, the card's fifth tab: type what one delivery carried, and the
// card says what it should cost — to hold a 3PL's bill against. It was the Cost
// calculator, a grid of every input greyed out where the card priced nothing,
// and a Compute button (owner 2026-11-11: 「check a drop 是check 价钱？」). Now it
// asks only for what this card prices and answers as you type, the lines
// grouped like the tabs. The answer is the server's (/compute), so it is the
// figure the 3PL invoices tab and Reconciliation work with.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { fmtSen } from '@2990s/shared';
import {
  useComputeCost, type CostBreakdown, type DeliveryFacts, type RateArea, type RateCard, type RateRule,
} from '../../../vendor/scm/lib/delivery-rate-card-queries';
import { cn } from '../../../lib/utils';
import { RULE_LABEL } from '../../../vendor/scm/lib/rate-rule-taxonomy';
import { chargingUnit } from './cardSettings';
import { FLAT_ORDER, type FlatRuleType } from './rateCardLayout';
import { destinationGroups, groupBreakdown, pricedTypes, readFacts, type CheckErrors, type PriceCheckForm } from './priceCheckFacts';
import { Panel } from './ruleEditors';
import { EYEBROW, Field, INPUT, LABEL } from './ui';

const DEBOUNCE_MS = 300;
const ERR = 'text-[12px] font-semibold text-[color:var(--hz-dk-err,#8a2c2c)]';

/** A typed box with its own error under it — outside the label, so the
 *  message never becomes part of the box's name. */
const Box = ({ label, value, placeholder, error, inputMode, onChange }: {
  label: string; value: string; placeholder: string; error: string | undefined; inputMode: 'numeric' | 'text'; onChange: (v: string) => void;
}) => {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className={LABEL}>{label}</label>
      <input id={id} className={cn(INPUT, error && 'border-[color:var(--hz-dk-err,#8a2c2c)]')} inputMode={inputMode} placeholder={placeholder}
        value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-err` : undefined} />
      {error && <span id={`${id}-err`} role="alert" className={ERR}>{error}</span>}
    </div>
  );
};

const UNIT_NOTE: Partial<Record<string, string>> = {
  trip: 'This card charges one price per trip, whatever it carries.',
  drop: 'This card counts drops (DOs), which Price check does not ask for yet, so its per-drop prices are left out.',
  customer: 'This card counts customers, which Price check does not ask for yet, so its per-customer prices are left out.',
};

export const PriceCheck = ({ card, rules, areas, areaRules, form, onForm }: {
  card: RateCard; rules: readonly RateRule[]; areas: readonly RateArea[]; areaRules: readonly RateRule[];
  form: PriceCheckForm; onForm: (f: PriceCheckForm) => void;
}) => {
  const { mutate } = useComputeCost(card.id);
  const [result, setResult] = useState<CostBreakdown | null>(null);
  const seq = useRef(0);
  /* A box shows when the card or one of its areas prices it. */
  const priced = useMemo(() => pricedTypes([...rules, ...areaRules]), [rules, areaRules]);
  const destinations = useMemo(() => destinationGroups(areas, rules), [areas, rules]);
  const counts = FLAT_ORDER.filter((t) => priced.has(t));
  const unit = chargingUnit(card);
  const read = readFacts(form, card, priced, areas);
  const errors: CheckErrors = read.ok ? {} : read.errors;

  /* What the answer depends on: the boxes, and the card's prices and settings
     (a price changed on another tab is in the next answer). */
  const factsKey = read.ok ? JSON.stringify(read.facts) : null;
  const cardKey = JSON.stringify([
    card.basis, card.aggregation, card.minChargeSen, card.capSen, card.rounding,
    rules.map((r) => [r.id, r.amountSen, r.tierPosition, r.bracketMin, r.bracketMax, r.zone]),
    areaRules.map((r) => [r.id, r.amountSen, r.tierPosition, r.bracketMin, r.bracketMax, r.areaId]),
    areas.map((a) => [a.id, a.towns]),
  ]);
  useEffect(() => {
    if (factsKey === null) return undefined;
    const id = ++seq.current;
    const t = setTimeout(() => {
      /* Only the newest answer is shown: an older reply landing late is dropped. */
      mutate(JSON.parse(factsKey) as DeliveryFacts, { onSuccess: (r) => { if (id === seq.current) setResult(r.breakdown); } });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [factsKey, cardKey, mutate]);

  const setCount = (t: FlatRuleType, v: string) => onForm({ ...form, counts: { ...form.counts, [t]: v } });
  const groups = result ? groupBreakdown(result, unit) : [];

  return (
    <Panel section="PRICE_CHECK" title="Price check" note={null}
      hint="Type what one delivery carried. The card says what it should cost — hold a 3PL bill against it." actions={null}>
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(210px,1fr))]">
        {card.aggregation === 'UNIT' && (
          <Box label={unit === 'item' ? 'Items' : 'Sets'} value={form.count} placeholder="0" error={errors.count} inputMode="numeric"
            onChange={(v) => onForm({ ...form, count: v })} />
        )}
        {priced.has('SOFA_BRACKET') && (
          <Box label="Sofas — compartments of each" value={form.sofas} placeholder="3, 6" error={errors.sofas} inputMode="text"
            onChange={(v) => onForm({ ...form, sofas: v })} />
        )}
        {counts.map((t) => (
          <Box key={t} label={RULE_LABEL[t]} value={form.counts[t] ?? ''} placeholder="0" error={errors[t]} inputMode="numeric"
            onChange={(v) => setCount(t, v)} />
        ))}
        {destinations.length > 0 && (
          <Field label="Destination">
            <select className={INPUT} value={form.town} onChange={(e) => onForm({ ...form, town: e.target.value })}>
              <option value="">In town</option>
              {destinations.map((g) => (g.label == null
                ? g.towns.map((z) => <option key={z} value={z}>{z}</option>)
                : (
                  <optgroup key={g.label} label={g.label}>
                    {g.towns.map((z) => <option key={`${g.label}-${z}`} value={z}>{z}</option>)}
                  </optgroup>
                )))}
            </select>
          </Field>
        )}
      </div>
      {UNIT_NOTE[unit] && <p className="text-[12px] text-ink-muted">{UNIT_NOTE[unit]}</p>}

      <div className="flex flex-col gap-3 rounded-xl bg-surface-2 px-4 py-3.5">
        {!read.ok ? (
          <p className="text-[13px] text-ink-muted">Fix the box marked in red to see the price.</p>
        ) : result == null ? (
          <p className="text-[13px] text-ink-muted">Working out the price…</p>
        ) : (
          <>
            {groups.length === 0 && <p className="text-[13px] text-ink-muted">Nothing on this card charges for this delivery.</p>}
            {groups.map((g) => (
              <div key={g.id} className="flex flex-col gap-1">
                <span className={EYEBROW}>{g.title}</span>
                {g.lines.map((l) => (
                  <div key={l.key} className={cn('flex justify-between gap-3 text-[13px]', l.amountSen < 0 ? 'text-ink-muted' : 'text-ink')}>
                    <span className="min-w-0">{l.label}</span>
                    <span className="flex-none tabular-nums">{l.amountSen < 0 ? '−' : ''}{fmtSen(Math.abs(l.amountSen))}</span>
                  </div>
                ))}
              </div>
            ))}
            {result.area && <p className="text-[12px] text-ink-muted">Priced in the area {result.area.name}.</p>}
            <div className="flex justify-between gap-3 border-t border-border pt-2.5 text-[15px] font-semibold text-ink" aria-live="polite">
              <span>This delivery should cost</span>
              <span className="tabular-nums">{fmtSen(result.totalSen)}</span>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
};
