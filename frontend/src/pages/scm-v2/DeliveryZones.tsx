// ----------------------------------------------------------------------------
// Delivery Zones — the owner-maintained postcode -> area-zone map (mig 0205,
// route delivery-zones.ts). Each rule maps a first-two-digit postcode prefix
// RANGE to one of the area zones; the date proposer derives every order's zone
// from its postcode through this map.
//
// Until a rule is in use the classifier falls back to the built-in Malaysian
// map, so the page shows that map and offers to load it as editable rules.
// The page logic that mirrors the classifier lives in delivery-zones/zoneModel.ts.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Pencil } from 'lucide-react';
import { PageHeader } from '../../components/Layout';
import { cn } from '../../lib/utils';
import { writeLineExportFile, type ExportFormat, type LineExportMatrix } from '../../components/dataTableLineExport';
import { todayMY } from '../../vendor/shared/format';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { writeFailedAs } from '../../vendor/scm/lib/mutation-error';
import {
  useCreateZoneRule, useUpdateZoneRule, useZoneMap, type ZoneRuleRow,
} from '../../vendor/scm/lib/delivery-zones-queries';
import {
  effectiveMap, pad2, prefixText, rangeText, zoneByPrefix, zoneColour, zoneName, type RuleForm,
} from './delivery-zones/zoneModel';
import { ZoneMapCard } from './delivery-zones/ZoneMapCard';
import { ZoneRuleDrawer, type DrawerTarget } from './delivery-zones/ZoneRuleDrawer';
import { LockedDays } from './delivery-zones/LockedDays';

type Show = 'all' | 'on' | 'off';
const SHOW_LABEL: Record<Show, string> = { all: 'All', on: 'In use', off: 'Turned off' };

export const DeliveryZones = () => {
  const [params, setParams] = useSearchParams();
  const selected = params.get('zone') || 'KL';
  const q = params.get('q') ?? '';
  const show = (['all', 'on', 'off'].includes(params.get('show') ?? '') ? params.get('show') : 'all') as Show;
  const setParam = (key: string, value: string, fallback: string) => setParams((p) => {
    const next = new URLSearchParams(p);
    if (value === fallback) next.delete(key); else next.set(key, value);
    return next;
  }, { replace: true });

  const zoneMap = useZoneMap();
  const create = useCreateZoneRule();
  const update = useUpdateZoneRule();
  const askConfirm = useConfirm();
  const [drawer, setDrawer] = useState<DrawerTarget | null>(null);
  const [loading, setLoading] = useState(false);

  const rows = zoneMap.data?.zones ?? [];
  const defaultMap = zoneMap.data?.defaultMap ?? [];
  const knownZones = zoneMap.data?.knownZones ?? [];
  const eff = effectiveMap(rows, defaultMap);
  const byPrefix = zoneByPrefix(eff.map);

  const needle = q.trim().toLowerCase();
  const shown = rows.filter((r) => (show === 'all' || (show === 'on' ? r.isActive : !r.isActive))
    && (!needle || [r.zone, zoneName(r.zone), r.label ?? '', pad2(r.prefixStart), pad2(r.prefixEnd), prefixText(r.prefixStart, r.prefixEnd)]
      .join(' ').toLowerCase().includes(needle)));

  const missingDefaults = defaultMap.filter((d) => !rows.some((r) => r.zone === d.zone && r.prefixStart === d.prefixStart && r.prefixEnd === d.prefixEnd));

  const loadDefaults = async () => {
    if (missingDefaults.length === 0) return;
    if (!(await askConfirm({
      title: `Load the default Malaysian map (${missingDefaults.length} rules)?`,
      body: 'Adds the built-in postcode ranges as editable rules. Rules you already have are left as they are.',
      confirmLabel: 'Load defaults',
    }))) return;
    setLoading(true);
    const failed: string[] = [];
    for (const d of missingDefaults) {
      // Sequential so one failure does not hide the others; the set is small (18).
      try {
        // eslint-disable-next-line no-await-in-loop -- sequential on purpose, see above
        await create.mutateAsync({ zone: d.zone, prefixStart: d.prefixStart, prefixEnd: d.prefixEnd });
      } catch (err) {
        failed.push(`${d.zone} ${prefixText(d.prefixStart, d.prefixEnd)}: ${err instanceof Error ? err.message : 'failed'}`);
      }
    }
    setLoading(false);
    if (failed.length > 0) {
      writeFailedAs(`${failed.length} of ${missingDefaults.length} default rules were not added`)(new Error(failed.join('\n')));
    }
  };

  const toggle = async (r: ZoneRuleRow) => {
    if (r.isActive) {
      const last = rows.filter((x) => x.isActive).length === 1;
      if (!(await askConfirm({
        title: `Turn off ${zoneName(r.zone)} ${rangeText(r.prefixStart, r.prefixEnd)}?`,
        body: last
          ? 'This is the last rule in use, so postcodes go back to the built-in Malaysian map.'
          : 'Postcodes in this range go to whichever other rule covers them, or have no zone.',
        confirmLabel: 'Turn off', danger: true,
      }))) return;
    }
    update.mutate({ id: r.id, isActive: !r.isActive }, { onError: writeFailedAs(r.isActive ? 'Rule not turned off' : 'Rule not turned on') });
  };

  const exportRules = () => {
    const header = ['Zone', 'Zone name', 'Prefix from', 'Prefix to', 'Covers', 'Name', 'In use'];
    const matrix: LineExportMatrix = {
      header,
      formats: header.map((): ExportFormat => 'text'),
      body: shown.map((r) => [r.zone, zoneName(r.zone), pad2(r.prefixStart), pad2(r.prefixEnd), rangeText(r.prefixStart, r.prefixEnd), r.label ?? '', r.isActive ? 'Yes' : 'No']),
    };
    writeLineExportFile(matrix, 'Delivery zones', `DeliveryZones-${todayMY()}.xlsx`)
      .catch(writeFailedAs('Export failed'));
  };

  const openNew = (initial: RuleForm) => setDrawer({ kind: 'new', initial });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Delivery setup"
        title="Delivery Zones"
        description="Which zone each postcode belongs to. A rule covers the first two digits of a postcode (43 = Kajang, 10–14 = Penang). When rules overlap, the narrower range wins, so you can carve Puchong out of the 46–47 Petaling Jaya block without deleting it."
        actions={
          <span className="flex flex-wrap gap-2">
            <button type="button" onClick={() => openNew({ zone: knownZones.includes(selected) ? selected : '', from: '', to: '', label: '' })}
              className="min-h-[40px] rounded-md border border-border bg-surface px-3 text-[13px] font-semibold text-ink">Add rule</button>
            <Link to="/scm/auto-schedule" className="inline-flex min-h-[40px] items-center rounded-md bg-primary px-3 text-[13px] font-semibold text-white">Propose delivery dates</Link>
          </span>
        }
      />

      {zoneMap.isError && <p className="rounded-xl bg-[#f6dcdc] px-4 py-3 text-[13px] text-[color:var(--hz-dk-err,#8a2c2c)]">The zone map could not be loaded. {zoneMap.error instanceof Error ? zoneMap.error.message : ''}</p>}

      {!zoneMap.isError && <ZoneMapCard rows={rows} map={eff.map} usingDefault={eff.usingDefault} byPrefix={byPrefix}
        selected={selected} onSelect={(k) => setParam('zone', k, 'KL')}
        onEdit={(rule) => setDrawer({ kind: 'edit', rule })} onAdd={openNew} />}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[16px] font-semibold text-ink">Rules <span className="font-medium text-ink-muted">{rows.length} zone {rows.length === 1 ? 'rule' : 'rules'}</span></h2>
          <div className="flex flex-wrap items-center gap-2">
            <input aria-label="Search zones" value={q} onChange={(e) => setParam('q', e.target.value, '')} placeholder="Search zones…"
              className="h-9 w-[200px] rounded-full bg-surface-2 px-3.5 text-[13px] text-ink" />
            <button type="button" onClick={exportRules} disabled={shown.length === 0} className="h-9 rounded-md border border-border bg-surface px-3 text-[12.5px] font-semibold text-ink disabled:opacity-50">Export</button>
            <div role="group" aria-label="Show" className="flex rounded-lg bg-surface-2 p-0.5">
              {(Object.keys(SHOW_LABEL) as Show[]).map((s) => (
                <button key={s} type="button" aria-pressed={show === s} onClick={() => setParam('show', s, 'all')}
                  className={cn('min-h-[32px] rounded-md px-3 text-[12.5px] font-semibold', show === s ? 'bg-surface text-ink shadow-sm' : 'text-ink-muted')}>{SHOW_LABEL[s]}</button>
              ))}
            </div>
          </div>
        </div>

        {eff.usingDefault && !zoneMap.isLoading && !zoneMap.isError && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-primary-soft px-5 py-4">
            <span className="text-[13.5px] font-semibold text-primary-ink">
              {rows.length === 0
                ? 'No custom zone rules yet. Postcodes use the built-in Malaysian map.'
                : 'Every rule is turned off, so postcodes use the built-in Malaysian map.'}
            </span>
            {missingDefaults.length > 0 && (
              <button type="button" onClick={() => void loadDefaults()} disabled={loading} className="min-h-[40px] rounded-md bg-primary px-3 text-[12.5px] font-semibold text-white disabled:opacity-50">
                {loading ? 'Loading…' : 'Load the default map as editable rules'}
              </button>
            )}
          </div>
        )}

        <div className="rounded-xl border border-border bg-surface py-1.5">
          {zoneMap.isError && <div className="px-6 py-8 text-center text-[13px] text-[color:var(--hz-dk-err,#8a2c2c)]">Zone rules could not be loaded, so none are shown.</div>}
          {zoneMap.isLoading && <div className="px-6 py-8 text-center text-[13px] text-ink-muted">Loading zone rules…</div>}
          {shown.map((r, i) => {
            const [, fg] = zoneColour(r.zone);
            return (
              <div key={r.id} className={cn('flex items-center gap-x-4 gap-y-2 px-4 py-3 md:px-6', i > 0 && 'border-t border-border-subtle', !r.isActive && 'opacity-60')}>
                <span className="h-3 w-3 flex-none rounded" style={{ background: fg, opacity: 0.65 }} />
                <span className="flex min-w-0 flex-1 flex-col md:flex-row md:items-center md:gap-4">
                  <span className="min-w-0 text-[14px] font-semibold text-ink md:flex-[0_0_170px]">{zoneName(r.zone)}</span>
                  <span className="min-w-0 text-[13px] text-ink-secondary md:flex-[1_1_140px]">{r.label && r.label !== zoneName(r.zone) ? r.label : ''}</span>
                  <span className="text-[14px] font-semibold tabular-nums text-ink md:flex-[0_0_140px]">{rangeText(r.prefixStart, r.prefixEnd)}</span>
                </span>
                <button type="button" role="switch" aria-checked={r.isActive} aria-label={`In use: ${zoneName(r.zone)} ${prefixText(r.prefixStart, r.prefixEnd)}`}
                  onClick={() => void toggle(r)} disabled={update.isPending}
                  className={cn('flex h-[26px] w-11 flex-none rounded-full p-[3px] transition-colors', r.isActive ? 'justify-end bg-primary' : 'justify-start bg-border-strong')}>
                  <span className="h-5 w-5 rounded-full bg-surface shadow" />
                </button>
                <button type="button" aria-label={`Edit rule ${zoneName(r.zone)} ${prefixText(r.prefixStart, r.prefixEnd)}`} onClick={() => setDrawer({ kind: 'edit', rule: r })}
                  className="grid h-9 w-9 place-items-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink">
                  <Pencil size={16} strokeWidth={2} />
                </button>
              </div>
            );
          })}
          {!zoneMap.isLoading && !zoneMap.isError && shown.length === 0 && (
            <div className="flex flex-col items-center gap-1.5 px-6 py-9 text-center">
              <span className="text-[14px] font-semibold text-ink">
                {needle ? 'No rule matches' : rows.length === 0 ? 'No zone rules yet. Add one, or load the default Malaysian map above.' : show === 'off' ? 'No rules turned off' : 'No rules in use'}
              </span>
              {(needle || show !== 'all') && rows.length > 0 && (
                <button type="button" onClick={() => setParams((p) => { const n = new URLSearchParams(p); n.delete('q'); n.delete('show'); return n; }, { replace: true })}
                  className="text-[12.5px] font-semibold text-primary hover:underline">Show all rules</button>
              )}
            </div>
          )}
        </div>
      </section>

      <LockedDays />

      {drawer && (
        <ZoneRuleDrawer target={drawer} rules={rows} defaultMap={defaultMap} knownZones={knownZones} onClose={() => setDrawer(null)} />
      )}
    </div>
  );
};
