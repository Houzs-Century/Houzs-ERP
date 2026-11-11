// The zone map: outstation zones laid out as the peninsula sits, the Klang
// Valley zones grouped, the East Malaysia zones (3PL only) and the postcodes no
// rule covers, plus a side panel listing the selected zone's postcode ranges and
// its places (the towns 3PL rate cards price there). Finding a postcode selects
// its zone.
import { useState, type CSSProperties } from 'react';
import { Search } from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { ZoneRuleRow } from '../../../vendor/scm/lib/delivery-zones-queries';
import {
  EAST_MALAYSIA_ZONES, KLANG_VALLEY, OUTSTATION_TILES, isKlangValley, isThreePlOnly, postcodePrefix, rangeForPrefix, rangeText, runs,
  zoneColour, zoneName, zoneSummary, type RuleForm, type ZoneRange,
} from './zoneModel';
import { ZonePlaces } from './ZonePlaces';

export const NO_ZONE = 'NONE';

type Props = {
  rows: ZoneRuleRow[];
  map: ZoneRange[];
  usingDefault: boolean;
  byPrefix: (string | null)[];
  selected: string;
  onSelect: (key: string) => void;
  onEdit: (row: ZoneRuleRow) => void;
  onAdd: (initial: RuleForm) => void;
};

const tileCls = (on: boolean) => cn(
  'flex min-w-0 flex-col items-start justify-end gap-0.5 overflow-hidden rounded-xl px-3 py-2 text-left',
  on ? 'shadow-[inset_0_0_0_2px_#16695f,0_6px_16px_rgba(11,71,64,.12)]' : '',
);

export function ZoneMapCard({ rows, map, usingDefault, byPrefix, selected, onSelect, onEdit, onAdd }: Props) {
  const [postcode, setPostcode] = useState('');

  const findPostcode = (raw: string) => {
    const v = raw.replace(/\D/g, '').slice(0, 5);
    setPostcode(v);
    const p = postcodePrefix(v);
    if (p === null) return;
    onSelect(byPrefix[p] ?? NO_ZONE);
  };
  const prefix = postcodePrefix(postcode);
  const hit = prefix === null ? null : rangeForPrefix(prefix, rows.filter((r) => r.isActive));
  const foundZone = prefix === null ? null : byPrefix[prefix];

  const uncovered = runs(byPrefix, (z) => z === null);
  const isNone = selected === NO_ZONE;
  const zone = isNone ? null : selected;

  /* Side panel content for the selection. */
  const mine = (p: number) => (isNone ? byPrefix[p] === null : byPrefix[p] === zone);
  const panelRows = (zone ? rows.filter((r) => r.zone === zone) : []).slice().sort((a, b) => a.prefixStart - b.prefixStart);
  const builtIn = usingDefault && zone ? map.filter((m) => m.zone === zone) : [];
  const group = isNone ? 'Postcodes no rule covers'
    : isKlangValley(zone ?? '') ? 'Klang Valley · shares trips'
      : isThreePlOnly(zone ?? '') ? 'East Malaysia · carried by a 3PL' : 'Outstation · own trip';
  const title = isNone ? 'No zone' : zoneName(zone ?? '');
  const dot = zone ? zoneColour(zone)[1] : '#c2c6bd';

  const tile = (z: string, extra: CSSProperties, compact: boolean, placed = '') => {
    const [bg, fg] = zoneColour(z);
    return (
      <button key={z} type="button" aria-pressed={selected === z} onClick={() => onSelect(z)}
        className={cn(tileCls(selected === z), placed)} style={{ background: bg, color: fg, ...extra }}>
        <span className={cn('font-bold leading-tight', compact ? 'text-[12px]' : 'text-[13px]')}>{zoneName(z)}</span>
        <span className="text-[11px] opacity-80">{zoneSummary(z, byPrefix)}</span>
      </button>
    );
  };

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex flex-wrap">
        <div className="flex min-w-0 flex-[1_1_520px] flex-col gap-4 p-4 md:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-[16px] font-semibold text-ink">Zone map</h2>
            <label className="relative min-w-[200px] flex-[0_1_280px]">
              <Search size={16} strokeWidth={2} className="pointer-events-none absolute left-3 top-3 text-ink-muted" aria-hidden />
              <input aria-label="Find a postcode" inputMode="numeric" value={postcode} onChange={(e) => findPostcode(e.target.value)} placeholder="Find a postcode"
                className="h-10 w-full rounded-full bg-surface-2 pl-9 pr-3 text-[13.5px] text-ink" />
            </label>
          </div>
          {postcode !== '' && (
            prefix === null
              ? <div className="self-start rounded-full bg-[color:var(--hz-dk-warning-bg,#f6ecd4)] px-3.5 py-1.5 text-[13px] font-semibold text-[#80501c]">A postcode has 5 digits</div>
              : foundZone
                ? <div className="self-start rounded-full bg-primary-soft px-3.5 py-1.5 text-[13px] font-semibold text-primary-ink">
                    {postcode} is in {zoneName(foundZone)}{hit?.label && hit.label !== zoneName(foundZone) ? ` · ${hit.label}` : ''}{usingDefault ? ' (built-in map)' : ''}
                  </div>
                : <div className="self-start rounded-full bg-[color:var(--hz-dk-err-bg,#f6dcdc)] px-3.5 py-1.5 text-[13px] font-semibold text-[color:var(--hz-dk-err,#8a2c2c)]">{postcode} is not in any zone</div>
          )}

          <div role="group" aria-label="Zones" className="grid auto-rows-[minmax(58px,auto)] grid-cols-2 gap-2 md:auto-rows-[66px] md:grid-cols-6">
            {OUTSTATION_TILES.map((t) => tile(t.zone, { '--col': t.col, '--row': t.row } as CSSProperties, false, 'md:[grid-column:var(--col)] md:[grid-row:var(--row)]'))}
            <div className="order-first col-span-2 flex flex-col gap-1 rounded-2xl bg-[color:var(--hz-dk-surface-2,#f1f7f5)] p-2 md:order-none md:[grid-column:1/4] md:[grid-row:4/6]">
              <span className="px-0.5 text-[11px] font-bold uppercase tracking-wider text-[#3f6f66]">Klang Valley</span>
              <div className="grid flex-1 grid-cols-3 gap-1.5">
                {KLANG_VALLEY.map((z) => tile(z, {}, true))}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 text-[12px] text-ink-muted">East Malaysia · 3PL only</span>
            <div role="group" aria-label="East Malaysia zones" className="grid min-w-0 flex-[1_1_300px] grid-cols-3 gap-1.5">
              {EAST_MALAYSIA_ZONES.map((z) => tile(z, {}, true))}
            </div>
            <span className="ml-auto" />
            <button type="button" aria-pressed={isNone} onClick={() => onSelect(NO_ZONE)}
              className={cn('h-[34px] rounded-full border-[1.5px] border-dashed border-border-strong px-3.5 text-[12.5px] font-semibold text-ink-muted', isNone && 'ring-2 ring-primary')}>
              No zone · {uncovered.reduce((n, r) => n + r.to - r.from + 1, 0)} of 100 prefixes
            </button>
          </div>
        </div>

        <aside className="flex min-w-0 flex-[1_1_300px] flex-col gap-4 bg-[color:var(--hz-dk-surface-2,#fafaf8)] p-4 md:p-6" aria-label="Selected zone">
          <div className="flex items-center gap-2.5">
            <span className="h-3 w-3 rounded-full" style={{ background: dot }} />
            <span className="text-[12px] font-bold uppercase tracking-wider text-ink-muted">{group}</span>
          </div>
          <div className="text-[24px] font-bold leading-tight text-ink">{title}</div>
          <div>
            <div className="flex h-5 gap-px overflow-hidden rounded-md" aria-hidden>
              {byPrefix.map((z, p) => <span key={p} className="flex-1" style={{ background: mine(p) ? 'var(--hz-c-primary)' : z ? 'var(--hz-c-border)' : 'var(--hz-c-bg)' }} />)}
            </div>
            <div className="mt-1 flex justify-between text-[11px] text-ink-muted"><span>00</span><span>25</span><span>50</span><span>75</span><span>99</span></div>
          </div>

          <div className="flex flex-col">
            {isNone && uncovered.map((r) => (
              <div key={r.from} className="flex items-center gap-3 border-t border-border-subtle py-3">
                <span className="flex-1 text-[16px] font-bold tabular-nums text-ink">{rangeText(r.from, r.to)}</span>
                <button type="button" onClick={() => onAdd({ zone: '', from: String(r.from), to: String(r.to), label: '' })} className="text-[12.5px] font-semibold text-primary hover:underline">Add rule</button>
              </div>
            ))}
            {builtIn.map((m) => (
              <div key={`d${m.prefixStart}`} className="flex items-center gap-3 border-t border-border-subtle py-3">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[16px] font-bold tabular-nums text-ink">{rangeText(m.prefixStart, m.prefixEnd)}</span>
                  <span className="text-[12.5px] text-ink-muted">Built-in map</span>
                </span>
              </div>
            ))}
            {panelRows.map((r) => (
              <div key={r.id} className="flex items-center gap-3 border-t border-border-subtle py-3">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className={cn('text-[16px] font-bold tabular-nums', r.isActive && !usingDefault ? 'text-ink' : 'text-ink-muted')}>{rangeText(r.prefixStart, r.prefixEnd)}</span>
                  <span className="text-[12.5px] text-ink-muted">{[r.label || null, r.isActive ? null : 'turned off'].filter(Boolean).join(' · ') || 'No name'}</span>
                </span>
                <button type="button" onClick={() => onEdit(r)} className="text-[12.5px] font-semibold text-primary hover:underline">Edit</button>
              </div>
            ))}
            {!isNone && panelRows.length === 0 && builtIn.length === 0 && (
              <div className="border-t border-border-subtle py-3.5 text-[13.5px] text-ink-muted">No postcodes in this zone yet.</div>
            )}
            {isNone && uncovered.length === 0 && (
              <div className="border-t border-border-subtle py-3.5 text-[13.5px] text-ink-muted">Every postcode prefix has a zone.</div>
            )}
          </div>
          {!isNone && (
            <button type="button" className="min-h-[40px] self-start rounded-md border border-border bg-surface px-3 text-[12.5px] font-semibold text-ink"
              onClick={() => onAdd({ zone: zone ?? '', from: '', to: '', label: '' })}>
              Add postcodes
            </button>
          )}
          <ZonePlaces zone={zone} />
        </aside>
      </div>
    </section>
  );
}
