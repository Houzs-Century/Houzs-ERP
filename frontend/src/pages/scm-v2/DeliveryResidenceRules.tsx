// ----------------------------------------------------------------------------
// Delivery Residence Rules — owner-maintained CONFIG for the TMS scheduler's
// per-residence delivery rules (migration 0196 / route
// delivery-residence-rules.ts). Each residence / building type (Condo / Landed /
// Apartment / Office / Shop / Other — the SO's building_type values) with its
// service duration (shown in HOURS, stored as minutes), optional no-delivery
// time windows, and the lift-booking / registration access flags.
//
// The exact numbers are the OWNER's to set; the migration seeds sensible
// defaults (~1.5h / 90 min for most, 1h / 60 min for Landed) and this page is
// how the owner adjusts them later.
//
// Layout (owner 2026-11-07, the Coverage & Fleet design): one card per type with
// its hours, window and access flags, an Active switch and Edit; a drawer reads,
// edits, creates and deletes. The toolbar sits in the body, not the page header,
// so New Type is there when the page is embedded in Coverage & Fleet too.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import {
  useDeliveryResidenceRules,
  useCreateDeliveryResidenceRule,
  useUpdateDeliveryResidenceRule,
  useDeleteDeliveryResidenceRule,
  durationLabel,
  hoursToMinutes,
  minutesToHours,
  type ResidenceRuleRow,
} from '../../vendor/scm/lib/delivery-residence-rules-queries';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { writeFailedAs } from '../../vendor/scm/lib/mutation-error';
import { PageHeader } from '../../components/Layout';
import { ResizableDrawer } from '../../components/ResizableDrawer';
import { cn } from '../../lib/utils';
import { hit, windowLabel } from './fleet/coverageModel';
import {
  Card, Chip, Field, IconBtn, ListToolbar, NoMatch, PencilIcon, ReadRows, Switch,
  dangerBtn, exportCsv, inputCls, primaryBtn, secondaryBtn,
} from './fleet/ui';

type Open = { mode: 'read' | 'edit'; id: string } | { mode: 'new' } | null;

export const DeliveryResidenceRules = ({ embedded = false }: { embedded?: boolean } = {}) => {
  const rules = useDeliveryResidenceRules();
  const update = useUpdateDeliveryResidenceRule();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Open>(null);
  const all = rules.data ?? [];
  const shown = all.filter((r) => hit(q, r.buildingType, r.notes));
  const current = open && open.mode !== 'new' ? all.find((r) => r.id === open.id) ?? null : null;

  const doExport = () => exportCsv('residence-rules.csv', shown, [
    { key: 'type', label: 'Residence type', getValue: (r) => r.buildingType },
    { key: 'hours', label: 'Service (hours)', getValue: (r) => minutesToHours(r.serviceDurationMinutes) },
    { key: 'earliest', label: 'Earliest', getValue: (r) => r.earliestDeliveryTime ?? '' },
    { key: 'latest', label: 'Latest', getValue: (r) => r.latestDeliveryTime ?? '' },
    { key: 'lift', label: 'Lift booking', getValue: (r) => (r.requiresLiftBooking ? 'Required' : 'No') },
    { key: 'reg', label: 'Registration', getValue: (r) => (r.requiresRegistration ? 'Required' : 'No') },
    { key: 'notes', label: 'Notes', getValue: (r) => r.notes ?? '' },
    { key: 'active', label: 'Active', getValue: (r) => (r.isActive ? 'Active' : 'Inactive') },
  ]);

  return (
    <div className="space-y-4">
      {!embedded && (
        <PageHeader
          eyebrow="Delivery"
          title="Residence Rules"
          description="Per residence type, how long a delivery takes (service duration, in hours) and any access rules — no-delivery time windows, service-lift booking, gated-community registration. The scheduler will use these; set the values to match your operation."
        />
      )}
      <ListToolbar search={q} onSearch={setQ} placeholder="Search residence types" shown={shown.length} total={all.length}
        onExport={doExport} newLabel="New Type" onNew={() => setOpen({ mode: 'new' })} />
      {rules.isError && <p className="text-[13px] text-[color:var(--hz-dk-err,#8a2c2c)]">The residence rules could not be loaded.</p>}
      {rules.isLoading && <p className="text-[13px] text-ink-muted">Loading residence rules…</p>}
      {!rules.isLoading && !rules.isError && shown.length === 0 && (
        <NoMatch text={all.length === 0 ? 'No residence rules came back. Add a building type (e.g. Condo, Landed) to set its service duration and access rules.' : 'No residence type matches this search.'}
          onClear={all.length === 0 ? null : () => setQ('')} />
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((r) => (
          <div key={r.id} className={cn('flex flex-col gap-4 rounded-xl border border-border bg-surface p-4', !r.isActive && 'opacity-60')}>
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 flex-none place-items-center rounded-xl bg-primary-soft text-primary" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 21V9l8-5 8 5v12" /><path d="M9 21v-6h6v6" /></svg>
              </span>
              <h2 className="min-w-0 flex-1 truncate text-[16px] font-bold text-ink">{r.buildingType}</h2>
              <Switch on={r.isActive} label={`${r.buildingType} active`} disabled={update.isPending}
                onClick={() => update.mutate({ id: r.id, isActive: !r.isActive }, { onError: writeFailedAs('The rule was not changed') })} />
              <IconBtn label={`Edit ${r.buildingType}`} onClick={() => setOpen({ mode: 'edit', id: r.id })}><PencilIcon /></IconBtn>
            </div>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <span className="flex items-baseline gap-1.5"><span className="text-[32px] font-bold leading-none tracking-tight text-primary">{minutesToHours(r.serviceDurationMinutes)}</span>
                  <span className="text-[13px] text-ink-muted">hours service</span></span>
                <span className="text-[12px] text-ink-muted">{r.serviceDurationMinutes} minutes ({durationLabel(r.serviceDurationMinutes)})</span>
              </div>
              <span className="inline-flex h-[30px] items-center rounded-full bg-surface-2 px-3 text-[12.5px] font-semibold text-ink">{windowLabel(r.earliestDeliveryTime, r.latestDeliveryTime)}</span>
            </div>
            <div className="space-y-2 text-[13px]">
              <div className="flex items-center justify-between gap-3"><span className="text-ink">Lift booking</span><Chip tone={r.requiresLiftBooking ? 'amber' : 'grey'}>{r.requiresLiftBooking ? 'Required' : 'No'}</Chip></div>
              <div className="flex items-center justify-between gap-3"><span className="text-ink">Gate registration</span><Chip tone={r.requiresRegistration ? 'amber' : 'grey'}>{r.requiresRegistration ? 'Required' : 'No'}</Chip></div>
            </div>
            {r.notes && <p className="rounded-lg bg-surface-2 px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-secondary">{r.notes}</p>}
            <button type="button" onClick={() => setOpen({ mode: 'read', id: r.id })} className="mt-auto self-start text-[13px] font-semibold text-primary hover:underline">See details</button>
          </div>
        ))}
      </div>
      {open && (open.mode === 'new' || current) && (
        <RuleDrawer key={open.mode === 'new' ? 'new' : current!.id} rule={current} editing={open.mode !== 'read'}
          onEdit={() => current && setOpen({ mode: 'edit', id: current.id })} onClose={() => setOpen(null)} />
      )}
    </div>
  );
};

function RuleDrawer({ rule, editing, onEdit, onClose }: { rule: ResidenceRuleRow | null; editing: boolean; onEdit: () => void; onClose: () => void }) {
  const del = useDeleteDeliveryResidenceRule();
  const confirm = useConfirm();
  const remove = (r: ResidenceRuleRow) => {
    void confirm({
      title: `Delete residence rule "${r.buildingType}"?`,
      body: 'The scheduler will fall back to its default for this residence type. You can re-add it later.',
      confirmLabel: 'Delete', danger: true,
    }).then((ok) => { if (ok) del.mutate(r.id, { onSuccess: onClose, onError: writeFailedAs('The rule was not deleted') }); });
  };
  return (
    <ResizableDrawer onClose={onClose} storageKey="fleet-rule-drawer" defaultWidth={480} ariaLabel={rule ? `Residence rule ${rule.buildingType}` : 'New residence type'}
      title={rule ? (editing ? `Edit ${rule.buildingType}` : rule.buildingType) : 'New Residence Type'} subtitle="Residence rule"
      headerActions={rule && !editing ? <button type="button" onClick={onEdit} className="rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-semibold text-white">Edit</button> : null}>
      {editing ? <RuleForm rule={rule} onDone={onClose} /> : rule && (
        <div className="space-y-3 p-4">
          <Card>
            <ReadRows rows={[
              ['Service duration', `${minutesToHours(rule.serviceDurationMinutes)} hours (${rule.serviceDurationMinutes} minutes)`],
              ['Delivery window', windowLabel(rule.earliestDeliveryTime, rule.latestDeliveryTime)],
              ['Lift booking', rule.requiresLiftBooking ? 'Required' : 'No'],
              ['Registration', rule.requiresRegistration ? 'Required' : 'No'],
              ['Notes', rule.notes || '—'],
              ['Active', rule.isActive ? 'Yes' : 'No'],
            ]} />
          </Card>
          <button type="button" onClick={() => remove(rule)} disabled={del.isPending} className={dangerBtn}>Delete rule</button>
        </div>
      )}
    </ResizableDrawer>
  );
}

function RuleForm({ rule, onDone }: { rule: ResidenceRuleRow | null; onDone: () => void }) {
  const create = useCreateDeliveryResidenceRule();
  const update = useUpdateDeliveryResidenceRule();
  const [f, setF] = useState({
    buildingType: rule?.buildingType ?? '',
    durationHours: rule ? minutesToHours(rule.serviceDurationMinutes) : '1.5',
    earliest: rule?.earliestDeliveryTime ?? '',
    latest: rule?.latestDeliveryTime ?? '',
    lift: rule?.requiresLiftBooking ?? false,
    reg: rule?.requiresRegistration ?? false,
    notes: rule?.notes ?? '',
  });
  const mins = hoursToMinutes(f.durationHours);
  const problem = !f.buildingType.trim() ? 'Enter the residence type.' : mins === null ? 'Enter the service time in hours (e.g. 1.5).' : null;
  const pending = create.isPending || update.isPending;
  const save = () => {
    if (mins === null) return;
    const body = {
      buildingType: f.buildingType.trim(), serviceDurationMinutes: mins,
      earliestDeliveryTime: f.earliest || null, latestDeliveryTime: f.latest || null,
      requiresLiftBooking: f.lift, requiresRegistration: f.reg, notes: f.notes.trim() || null,
    };
    if (rule) update.mutate({ id: rule.id, ...body }, { onSuccess: onDone, onError: writeFailedAs('The rule was not saved') });
    else create.mutate({ ...body, isActive: true }, { onSuccess: onDone, onError: writeFailedAs('The rule was not added') });
  };
  return (
    <div className="space-y-4 p-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Residence type" wide><input value={f.buildingType} onChange={(e) => setF({ ...f, buildingType: e.target.value })} placeholder="e.g. Serviced Apartment" className={inputCls} /></Field>
        <Field label="Service duration (hours)"><input type="number" step="0.25" min="0" value={f.durationHours} onChange={(e) => setF({ ...f, durationHours: e.target.value })} className={inputCls} /></Field>
        <span />
        <Field label="Earliest delivery"><input type="time" value={f.earliest} onChange={(e) => setF({ ...f, earliest: e.target.value })} className={inputCls} /></Field>
        <Field label="Latest delivery"><input type="time" value={f.latest} onChange={(e) => setF({ ...f, latest: e.target.value })} className={inputCls} /></Field>
      </div>
      <div className="space-y-2 text-[13px] text-ink">
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.lift} onChange={(e) => setF({ ...f, lift: e.target.checked })} />Service-lift booking required</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.reg} onChange={(e) => setF({ ...f, reg: e.target.checked })} />Gate / guardhouse registration required</label>
      </div>
      <Field label="Notes"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="e.g. Condo: no delivery before 10:00, book lift at management office" className={inputCls} /></Field>
      <p className="text-[12px] text-ink-muted">Duration is stored in minutes and shown in hours (1.5h = 90 minutes). Leave the time windows blank for no restriction.</p>
      {problem && f.buildingType !== '' && <p className="text-[12.5px] text-[color:var(--hz-dk-err,#8a2c2c)]">{problem}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={problem !== null || pending} onClick={save} className={primaryBtn}>{pending ? 'Saving…' : rule ? 'Save changes' : 'Create Rule'}</button>
        <button type="button" onClick={onDone} className={secondaryBtn}>Cancel</button>
      </div>
    </div>
  );
}
