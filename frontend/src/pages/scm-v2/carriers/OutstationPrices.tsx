// Outstation, laid out by price: one band per amount ("RM 40.00 — 2 towns"),
// its towns as chips. A 53-row town table read as a wall (owner 2026-11-11,
// 「看了很乱」); most towns share a handful of prices, so the bands are short.
// A chip opens to change or remove that town's price. Per-trip prices get bands
// of their own only when the card has any.
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { fmtSen } from '@2990s/shared';
import type { RateRule } from '../../../vendor/scm/lib/delivery-rate-card-queries';
import { cn } from '../../../lib/utils';
import { CATEGORY_HINT } from '../../../vendor/scm/lib/rate-rule-taxonomy';
import { hiddenZoneRules, priceBands, type PriceBand, type RuleBlock, type RuleSection, type TownPrice } from './rateCardLayout';
import { AddRule, Panel, PriceEditor } from './ruleEditors';
import { BTN_QUIET, HINT, Pill } from './ui';

type Kind = 'per order' | 'per trip';
const SEARCH_FROM = 8;
const townsWord = (n: number) => `${n} ${n === 1 ? 'town' : 'towns'}`;

const TownChip = ({ cardId, town, kind }: { cardId: string; town: TownPrice; kind: Kind }) => {
  const [editing, setEditing] = useState(false);
  const name = `${town.zone} ${kind}`;
  if (editing) {
    return (
      <span className="flex flex-col gap-1 rounded-xl px-2.5 py-1.5 ring-1 ring-primary">
        <span className="text-[12px] font-semibold text-ink-muted">{town.zone}</span>
        <PriceEditor cardId={cardId} rule={town.rule} name={name} onDone={() => setEditing(false)} />
      </span>
    );
  }
  return (
    <button type="button" onClick={() => setEditing(true)} aria-label={`Edit ${name}, ${fmtSen(town.rule.amountSen)}`}
      className="inline-flex min-h-[32px] items-center gap-1.5 rounded-full border border-border px-3 text-[12.5px] font-semibold text-ink hover:border-primary hover:text-primary">
      {town.zone}{town.twice && <Pill tone="amber">Twice</Pill>}
    </button>
  );
};

const Bands = ({ cardId, title, bands, kind }: { cardId: string; title: string; bands: PriceBand[]; kind: Kind }) => (
  <div className="flex flex-col">
    <span className="pb-1.5 text-[12.5px] font-semibold text-ink-secondary">{title}</span>
    {bands.map((b) => (
      <div key={b.amountSen} className="grid gap-3 border-t border-border py-2.5 [grid-template-columns:104px_minmax(0,1fr)]">
        <div className="flex flex-col">
          <span className="text-[14px] font-bold tabular-nums text-ink">{fmtSen(b.amountSen)}</span>
          <span className={HINT}>{townsWord(b.towns.length)}</span>
        </div>
        <div className="flex flex-wrap items-start gap-1.5">
          {b.towns.map((t) => <TownChip key={t.rule.id} cardId={cardId} town={t} kind={kind} />)}
        </div>
      </div>
    ))}
  </div>
);

/** A second price for a town the bands already show: listed so none hides. */
const SecondPrice = ({ cardId, rule }: { cardId: string; rule: RateRule }) => {
  const [editing, setEditing] = useState(false);
  const name = `${rule.zone ?? ''} ${rule.ruleType === 'OUTSTATION' ? 'per order' : 'per trip'} (second)`;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-0.5">
      <span>{rule.zone} · {rule.ruleType === 'OUTSTATION' ? 'per order' : 'per trip'}</span>
      {editing
        ? <PriceEditor cardId={cardId} rule={rule} name={name} onDone={() => setEditing(false)} />
        : (
          <button type="button" onClick={() => setEditing(true)} aria-label={`Edit ${name}`}
            className="min-h-[32px] rounded-md px-1.5 font-bold tabular-nums hover:bg-surface-2">{fmtSen(rule.amountSen)}</button>
        )}
    </div>
  );
};

type Zones = Extract<RuleBlock, { kind: 'zones' }>;

export const OutstationPrices = ({ cardId, rules, section, zones }: { cardId: string; rules: readonly RateRule[]; section: RuleSection; zones: string[] }) => {
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState<'OUTSTATION' | 'OUTSTATION_TRIP' | null>(null);
  const rows = section.blocks.find((b): b is Zones => b.kind === 'zones')?.rows ?? [];
  const perOrder = priceBands(rows, 'perOrder');
  const perTrip = priceBands(rows, 'perTrip');
  const hidden = hiddenZoneRules(rules, rows);
  const needle = q.trim().toLowerCase();
  const narrow = (bands: PriceBand[]) => (needle
    ? bands.map((b) => ({ ...b, towns: b.towns.filter((t) => t.zone.toLowerCase().includes(needle)) })).filter((b) => b.towns.length > 0)
    : bands);
  const shownOrder = narrow(perOrder);
  const shownTrip = narrow(perTrip);

  return (
    <Panel section="OUTSTATION" title="Outstation" note={rows.length ? townsWord(rows.length) : null} hint={CATEGORY_HINT.OUTSTATION}
      actions={
        <>
          {rows.length >= SEARCH_FROM && (
            <input className="min-h-[36px] min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 text-[13px] text-ink sm:w-[200px] sm:flex-none" placeholder="Find a town" aria-label="Find a town"
              value={q} onChange={(e) => setQ(e.target.value)} />
          )}
          {adding === null && (
            <button type="button" className={cn(BTN_QUIET, 'min-h-[36px] px-3 text-[13px]')} onClick={() => setAdding('OUTSTATION')}>
              <Plus size={15} strokeWidth={1.75} />Add town
            </button>
          )}
        </>
      }>
      {rows.length === 0 && <p className="text-[13px] text-ink-muted">This card has no outstation towns yet, so a delivery costs the same wherever it goes.</p>}
      {perOrder.length > 0 && <Bands cardId={cardId} title="Per order" bands={shownOrder} kind="per order" />}
      {perTrip.length > 0
        ? <Bands cardId={cardId} title="Per trip" bands={shownTrip} kind="per trip" />
        : rows.length > 0 && (
          <p className="flex flex-wrap items-center gap-x-1.5 border-t border-border pt-2.5 text-[13px] text-ink-muted">
            Per trip: none ·
            <button type="button" className="inline-flex items-center gap-1 font-semibold text-ink hover:text-primary" onClick={() => setAdding('OUTSTATION_TRIP')}>
              <Plus size={14} strokeWidth={2} />Add a per-trip price
            </button>
          </p>
        )}
      {needle !== '' && shownOrder.length === 0 && shownTrip.length === 0 && (
        <p className="text-[13px] text-ink-muted">No town matches “{q.trim()}”.</p>
      )}
      {hidden.length > 0 && (
        <div className="rounded-xl bg-[color:var(--hz-dk-warning-bg,#f6ecd4)] px-3 py-2.5 text-[12.5px] text-accent-ink">
          <p className="mb-1.5 font-semibold">A town priced twice: the card uses one of these, so remove the one that is wrong.</p>
          {hidden.map((r) => <SecondPrice key={r.id} cardId={cardId} rule={r} />)}
        </div>
      )}
      {adding !== null && (
        <AddRule key={adding} cardId={cardId} category="OUTSTATION" zones={zones} initialType={adding} onDone={() => setAdding(null)} />
      )}
    </Panel>
  );
};
