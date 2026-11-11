// ----------------------------------------------------------------------------
// Delivery Planning Regions — the owner-maintained MASTER for the Delivery
// Planning board's region tabs (migration 0053 / route
// delivery-planning-regions.ts): the region buckets (Code · Name · Sort · Active)
// with create / edit / delete.
//
// The live buckets are the owner-maintained geographic regions (KL/SEL /
// Northern / Southern / East Coast / East Malaysia); the owner adds more here and
// they show up automatically as tabs on Delivery Planning (the board reads this
// master). Per-state → region(s) assignment lives in SO Maintenance (the
// multi-select), not here; the Areas line is read LIVE from that mapping so it
// can never drift from the actual routing.
//
// Layout (owner 2026-11-07, the Coverage & Fleet design): one card per region
// in sort order, with its areas, an Active switch and Edit; a drawer reads,
// edits, creates and deletes. Delete surfaces the route's 409 region_in_use
// (a state still maps to it). The toolbar sits in the body so New Region is
// there when the page is embedded in Coverage & Fleet too.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import {
  useDeliveryPlanningRegions,
  useCreateDeliveryPlanningRegion,
  useUpdateDeliveryPlanningRegion,
  useDeleteDeliveryPlanningRegion,
  useStateDeliveryRegions,
  sortOrderOf,
  type RegionMasterRow,
} from '../../vendor/scm/lib/delivery-planning-regions-queries';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { writeFailedAs } from '../../vendor/scm/lib/mutation-error';
import { PageHeader } from '../../components/Layout';
import { ResizableDrawer } from '../../components/ResizableDrawer';
import { cn } from '../../lib/utils';
import { areasByRegionCode, hit } from './fleet/coverageModel';
import {
  Card, Field, IconBtn, ListToolbar, NoMatch, PencilIcon, ReadRows, Switch,
  dangerBtn, exportCsv, inputCls, primaryBtn, secondaryBtn,
} from './fleet/ui';

type Open = { mode: 'read' | 'edit'; id: string } | { mode: 'new' } | null;

export const DeliveryPlanningRegions = ({ embedded = false }: { embedded?: boolean } = {}) => {
  const regions = useDeliveryPlanningRegions();
  const update = useUpdateDeliveryPlanningRegion();
  const stateRegions = useStateDeliveryRegions();
  const areas = useMemo(() => areasByRegionCode(stateRegions.data ?? []), [stateRegions.data]);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Open>(null);
  const all = useMemo(() => [...(regions.data ?? [])].sort((a, b) => sortOrderOf(a) - sortOrderOf(b)), [regions.data]);
  const shown = all.filter((r) => hit(q, r.code, r.name, ...(areas[r.code] ?? [])));
  const current = open && open.mode !== 'new' ? all.find((r) => r.id === open.id) ?? null : null;
  const nextSort = all.reduce((m, r) => Math.max(m, sortOrderOf(r)), 0) + 1;

  const doExport = () => exportCsv('regions.csv', shown, [
    { key: 'code', label: 'Code', getValue: (r) => r.code },
    { key: 'name', label: 'Name', getValue: (r) => r.name },
    { key: 'areas', label: 'Areas', getValue: (r) => (areas[r.code] ?? []).join(', ') },
    { key: 'sort', label: 'Sort', getValue: (r) => sortOrderOf(r) },
    { key: 'active', label: 'Active', getValue: (r) => (r.active ? 'Active' : 'Inactive') },
  ]);

  return (
    <div className="space-y-4">
      {!embedded && (
        <PageHeader
          eyebrow="Delivery"
          title="Delivery Regions"
          description="The region buckets (tabs) on Delivery Planning, with the areas each one covers. Assign which states fall under each region in SO Maintenance."
        />
      )}
      <ListToolbar search={q} onSearch={setQ} placeholder="Search regions or areas" shown={shown.length} total={all.length}
        onExport={doExport} newLabel="New Region" onNew={() => setOpen({ mode: 'new' })} />
      {regions.isError && <p className="text-[13px] text-[color:var(--hz-dk-err,#8a2c2c)]">The regions could not be loaded.</p>}
      {regions.isLoading && <p className="text-[13px] text-ink-muted">Loading regions…</p>}
      {!regions.isLoading && !regions.isError && shown.length === 0 && (
        <NoMatch text={all.length === 0 ? 'No regions came back. Add your delivery buckets (e.g. KL/SEL, Northern, Southern) to get started.' : 'No region matches this search.'}
          onClear={all.length === 0 ? null : () => setQ('')} />
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((r) => (
          <div key={r.id} className={cn('flex flex-col gap-3 rounded-xl border border-border bg-surface p-4', !r.active && 'opacity-60')}>
            <div className="flex items-center gap-2.5">
              <span className={cn('rounded-md px-2 py-1 font-mono text-[12.5px] font-bold tracking-wide',
                r.code === 'SG' ? 'border border-dashed border-primary text-primary' : 'bg-primary text-white')}>{r.code}</span>
              <h2 className="min-w-0 flex-1 truncate text-[16px] font-bold text-ink">{r.name}</h2>
              <Switch on={r.active} label={`${r.name} active`} disabled={update.isPending}
                onClick={() => update.mutate({ id: r.id, active: !r.active }, { onError: writeFailedAs('The region was not changed') })} />
              <IconBtn label={`Edit ${r.name}`} onClick={() => setOpen({ mode: 'edit', id: r.id })}><PencilIcon /></IconBtn>
            </div>
            <div><span className="block text-[12px] text-ink-muted">Areas</span>
              <span className="text-[13.5px] text-ink">{(areas[r.code] ?? []).join(', ') || 'No state is mapped to it yet'}</span></div>
            <div className="mt-auto flex items-center justify-between text-[12.5px] text-ink-muted">
              <span>Sort {sortOrderOf(r)}</span>
              <button type="button" onClick={() => setOpen({ mode: 'read', id: r.id })} className="text-[13px] font-semibold text-primary hover:underline">See details</button>
            </div>
          </div>
        ))}
      </div>
      {open && (open.mode === 'new' || current) && (
        <RegionDrawer key={open.mode === 'new' ? 'new' : current!.id} region={current} areas={current ? areas[current.code] ?? [] : []}
          editing={open.mode !== 'read'} nextSort={nextSort}
          onEdit={() => current && setOpen({ mode: 'edit', id: current.id })} onClose={() => setOpen(null)} />
      )}
    </div>
  );
};

function RegionDrawer({ region, areas, editing, nextSort, onEdit, onClose }: {
  region: RegionMasterRow | null; areas: string[]; editing: boolean; nextSort: number; onEdit: () => void; onClose: () => void;
}) {
  const del = useDeleteDeliveryPlanningRegion();
  const confirm = useConfirm();
  const remove = (r: RegionMasterRow) => {
    void confirm({
      title: `Delete region "${r.name}" (${r.code})?`,
      body: 'The region disappears from the Delivery Planning tabs. Blocked if any state still maps to it.',
      confirmLabel: 'Delete', danger: true,
    }).then((ok) => { if (ok) del.mutate(r.id, { onSuccess: onClose, onError: writeFailedAs('The region was not deleted') }); });
  };
  return (
    <ResizableDrawer onClose={onClose} storageKey="fleet-region-drawer" defaultWidth={460} ariaLabel={region ? `Region ${region.name}` : 'New region'}
      title={region ? `${editing ? 'Edit ' : ''}${region.name} (${region.code})` : 'New Region'} subtitle="Region"
      headerActions={region && !editing ? <button type="button" onClick={onEdit} className="rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-semibold text-white">Edit</button> : null}>
      {editing ? <RegionForm region={region} nextSort={nextSort} onDone={onClose} /> : region && (
        <div className="space-y-3 p-4">
          <Card>
            <ReadRows rows={[
              ['Code', region.code], ['Name', region.name], ['Areas', areas.join(', ') || '—'],
              ['Sort', String(sortOrderOf(region))], ['Active', region.active ? 'Yes' : 'No'],
            ]} />
          </Card>
          <p className="text-[12px] text-ink-muted">Which states fall under a region is set in SO Maintenance.</p>
          <button type="button" onClick={() => remove(region)} disabled={del.isPending} className={dangerBtn}>Delete region</button>
        </div>
      )}
    </ResizableDrawer>
  );
}

function RegionForm({ region, nextSort, onDone }: { region: RegionMasterRow | null; nextSort: number; onDone: () => void }) {
  const create = useCreateDeliveryPlanningRegion();
  const update = useUpdateDeliveryPlanningRegion();
  const [f, setF] = useState({ code: region?.code ?? '', name: region?.name ?? '', sort: String(region ? sortOrderOf(region) : nextSort) });
  const sort = Number(f.sort);
  const problem = !f.code.trim() ? 'Enter the code.' : !f.name.trim() ? 'Enter the name.' : !(Number.isInteger(sort) && sort >= 0) ? 'Sort must be a whole number of 0 or more.' : null;
  const pending = create.isPending || update.isPending;
  const save = () => {
    const body = { code: f.code.trim(), name: f.name.trim(), sortOrder: sort };
    if (region) update.mutate({ id: region.id, ...body }, { onSuccess: onDone, onError: writeFailedAs('The region was not saved') });
    else create.mutate({ ...body, active: true }, { onSuccess: onDone, onError: writeFailedAs('The region was not added') });
  };
  return (
    <div className="space-y-4 p-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Code"><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="e.g. JB" className={inputCls} /></Field>
        <Field label="Sort order"><input inputMode="numeric" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} className={inputCls} /></Field>
        <Field label="Name" wide><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Johor Bahru" className={inputCls} /></Field>
      </div>
      <p className="text-[12px] text-ink-muted">Code is changed to upper case and must be unique. A region with code SG gets the dashed style on the board.</p>
      {problem && (f.code !== '' || f.name !== '') && <p className="text-[12.5px] text-[color:var(--hz-dk-err,#8a2c2c)]">{problem}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={problem !== null || pending} onClick={save} className={primaryBtn}>{pending ? 'Saving…' : region ? 'Save changes' : 'Create Region'}</button>
        <button type="button" onClick={onDone} className={secondaryBtn}>Cancel</button>
      </div>
    </div>
  );
}
