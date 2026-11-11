// ----------------------------------------------------------------------------
// Saved Locations — the "common locations" address book (owner 2026-11-02 方案2).
// Owner-maintained points a transfer is driven between: customers, suppliers,
// outsourced warehouses, frequent drops. A TRANSFER DP order's From and To
// pickers read this list, so a fixed point is picked once instead of re-typed.
//
// Route /scm/saved-locations, nav "Saved Locations" under Transportation, and the
// Places tab of Coverage & Fleet. Backed by scm.saved_locations (mig
// 20261102T1700). Per-company scoped.
//
// Layout (owner 2026-11-07, the Coverage & Fleet design): one row per place with
// its address and contact, an Active switch and Edit; a drawer reads, edits,
// adds and deletes.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { formatPhone } from '@2990s/shared/phone';
import { PageHeader } from '../../components/Layout';
import { ResizableDrawer } from '../../components/ResizableDrawer';
import { cn } from '../../lib/utils';
import { PhoneInput } from '../../vendor/scm/components/PhoneInput';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { writeFailedAs } from '../../vendor/scm/lib/mutation-error';
import {
  useSavedLocations,
  useCreateSavedLocation,
  useUpdateSavedLocation,
  useDeleteSavedLocation,
  type SavedLocationRow,
} from '../../vendor/scm/lib/saved-locations-queries';
import { hit, placeAddress } from './fleet/coverageModel';
import {
  Card, Field, IconBtn, ListToolbar, NoMatch, PencilIcon, ReadRows, Switch,
  dangerBtn, exportCsv, inputCls, primaryBtn, secondaryBtn,
} from './fleet/ui';

type Open = { mode: 'read' | 'edit'; id: string } | { mode: 'new' } | null;

const contactLine = (r: SavedLocationRow): string =>
  [r.contactName, r.contactPhone ? formatPhone(r.contactPhone) : null].filter(Boolean).join(' · ');

export const SavedLocations = ({ embedded = false }: { embedded?: boolean } = {}) => {
  const list = useSavedLocations();
  const update = useUpdateSavedLocation();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Open>(null);
  const all = list.data ?? [];
  const shown = all.filter((r) => hit(q, r.name, placeAddress(r), r.contactName, r.contactPhone, r.notes));
  const current = open && open.mode !== 'new' ? all.find((r) => r.id === open.id) ?? null : null;

  const doExport = () => exportCsv('saved-locations.csv', shown, [
    { key: 'name', label: 'Name', getValue: (r) => r.name },
    { key: 'contact', label: 'Contact person', getValue: (r) => r.contactName ?? '' },
    { key: 'phone', label: 'Contact phone', getValue: (r) => r.contactPhone ?? '' },
    { key: 'a1', label: 'Address line 1', getValue: (r) => r.address1 ?? '' },
    { key: 'a2', label: 'Address line 2', getValue: (r) => r.address2 ?? '' },
    { key: 'city', label: 'City', getValue: (r) => r.city ?? '' },
    { key: 'postcode', label: 'Postcode', getValue: (r) => r.postcode ?? '' },
    { key: 'state', label: 'State', getValue: (r) => r.state ?? '' },
    { key: 'notes', label: 'Notes', getValue: (r) => r.notes ?? '' },
    { key: 'active', label: 'Active', getValue: (r) => (r.isActive ? 'Active' : 'Inactive') },
  ]);

  return (
    <div className="space-y-4">
      {!embedded && (
        <PageHeader
          eyebrow="Delivery"
          title="Saved Locations"
          description="Keep the points you deliver between — customers, suppliers, outsourced warehouses, frequent drops — so a transfer's From and To can be picked here instead of re-typed each time."
        />
      )}
      <ListToolbar search={q} onSearch={setQ} placeholder="Search name, area or address" shown={shown.length} total={all.length}
        onExport={doExport} newLabel="New location" onNew={() => setOpen({ mode: 'new' })} />
      {list.isError && <p className="text-[13px] text-[color:var(--hz-dk-err,#8a2c2c)]">The saved locations could not be loaded.</p>}
      {list.isLoading && <p className="text-[13px] text-ink-muted">Loading saved locations…</p>}
      {!list.isLoading && !list.isError && shown.length === 0 && (
        <NoMatch text={all.length === 0 ? 'No saved locations came back. Add one, then pick it as a From or To when you raise a transfer.' : 'No saved location matches this search.'}
          onClear={all.length === 0 ? null : () => setQ('')} />
      )}
      <div className="flex flex-col gap-2.5">
        {shown.map((r) => (
          <div key={r.id} className={cn('flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface p-3.5', !r.isActive && 'opacity-60')}>
            <span className="grid h-10 w-10 flex-none place-items-center rounded-xl bg-primary-soft text-primary" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" /></svg>
            </span>
            <button type="button" onClick={() => setOpen({ mode: 'read', id: r.id })} className="flex min-w-0 flex-[1_1_260px] flex-col gap-0.5 text-left">
              <span className="text-[15px] font-bold text-ink">{r.name}</span>
              <span className="truncate text-[12.5px] text-ink-muted">{placeAddress(r) || 'No address'}</span>
            </button>
            <span className="flex min-w-0 flex-[0_1_200px] flex-col text-[12.5px]"><span className="text-ink-muted">Contact</span><span className="truncate text-ink">{contactLine(r) || '—'}</span></span>
            <Switch on={r.isActive} label={`${r.name} active`} disabled={update.isPending}
              onClick={() => update.mutate({ id: r.id, isActive: !r.isActive }, { onError: writeFailedAs('The location was not changed') })} />
            <IconBtn label={`Edit ${r.name}`} onClick={() => setOpen({ mode: 'edit', id: r.id })}><PencilIcon /></IconBtn>
          </div>
        ))}
      </div>
      <p className="text-[12px] text-ink-muted">
        A saved location is this company&rsquo;s own list. Deleting one does not change any transfer already raised — those keep the address that was copied onto them.
      </p>
      {open && (open.mode === 'new' || current) && (
        <PlaceDrawer key={open.mode === 'new' ? 'new' : current!.id} place={current} editing={open.mode !== 'read'}
          onEdit={() => current && setOpen({ mode: 'edit', id: current.id })} onClose={() => setOpen(null)} />
      )}
    </div>
  );
};

function PlaceDrawer({ place, editing, onEdit, onClose }: { place: SavedLocationRow | null; editing: boolean; onEdit: () => void; onClose: () => void }) {
  const del = useDeleteSavedLocation();
  const confirm = useConfirm();
  const remove = (r: SavedLocationRow) => {
    void confirm({ title: 'Delete this saved location?', body: `${r.name} — transfers already raised keep their copied address.`, confirmLabel: 'Delete', danger: true })
      .then((ok) => { if (ok) del.mutate(r.id, { onSuccess: onClose, onError: writeFailedAs('The location was not deleted') }); });
  };
  const address = place ? [place.address1, place.address2, [place.postcode, place.city].filter(Boolean).join(' '), place.state].filter(Boolean).join('\n') : '';
  return (
    <ResizableDrawer onClose={onClose} storageKey="fleet-place-drawer" defaultWidth={480} ariaLabel={place ? `Saved location ${place.name}` : 'New saved location'}
      title={place ? `${editing ? 'Edit ' : ''}${place.name}` : 'New saved location'} subtitle="Saved location"
      headerActions={place && !editing ? <button type="button" onClick={onEdit} className="rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-semibold text-white">Edit</button> : null}>
      {editing ? <PlaceForm place={place} onDone={onClose} /> : place && (
        <div className="space-y-3 p-4">
          <Card>
            <ReadRows rows={[['Contact', contactLine(place) || '—'], ['Address', address || 'No address'], ['Notes', place.notes || '—'], ['Active', place.isActive ? 'Yes' : 'No']]} />
          </Card>
          <button type="button" onClick={() => remove(place)} disabled={del.isPending} className={dangerBtn}>Delete location</button>
        </div>
      )}
    </ResizableDrawer>
  );
}

const BLANK = { name: '', contactName: '', contactPhone: '', address1: '', address2: '', city: '', postcode: '', state: '', notes: '' };

function PlaceForm({ place, onDone }: { place: SavedLocationRow | null; onDone: () => void }) {
  const create = useCreateSavedLocation();
  const update = useUpdateSavedLocation();
  const [f, setF] = useState(place ? {
    name: place.name, contactName: place.contactName ?? '', contactPhone: place.contactPhone ?? '',
    address1: place.address1 ?? '', address2: place.address2 ?? '', city: place.city ?? '', postcode: place.postcode ?? '', state: place.state ?? '', notes: place.notes ?? '',
  } : BLANK);
  const set = (k: keyof typeof BLANK) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const problem = !f.name.trim() ? 'Enter the location name.'
    : !f.address1.trim() && !f.address2.trim() ? 'Fill in address line 1 or 2. The point of a saved location is its address.' : null;
  const pending = create.isPending || update.isPending;
  const save = () => {
    const t = (v: string) => v.trim() || null;
    const body = {
      name: f.name.trim(), contactName: t(f.contactName), contactPhone: t(f.contactPhone),
      address1: t(f.address1), address2: t(f.address2), city: t(f.city), postcode: t(f.postcode), state: t(f.state), notes: t(f.notes),
    };
    if (place) update.mutate({ id: place.id, ...body }, { onSuccess: onDone, onError: writeFailedAs('The location was not saved') });
    else create.mutate(body, { onSuccess: onDone, onError: writeFailedAs('The location was not added') });
  };
  const text = (k: keyof typeof BLANK, label: string, ph: string, wide: boolean) => (
    <Field label={label} wide={wide}><input value={f[k]} onChange={(e) => set(k)(e.target.value)} placeholder={ph} className={inputCls} /></Field>
  );
  return (
    <div className="space-y-4 p-4">
      <div className="grid grid-cols-2 gap-3">
        {text('name', 'Location name', 'e.g. Sunway Pyramid loading bay', true)}
        {text('contactName', 'Contact person', 'Name', false)}
        <Field label="Contact phone"><PhoneInput className={inputCls} value={f.contactPhone} onChange={set('contactPhone')} /></Field>
        {text('address1', 'Address line 1', 'Street / unit', true)}
        {text('address2', 'Address line 2', 'Area', true)}
        {text('city', 'City', '', false)}
        {text('postcode', 'Postcode', '', false)}
        {text('state', 'State', '', true)}
        {text('notes', 'Notes', 'e.g. Loading bay closes at 5pm, call the guard first', true)}
      </div>
      {problem && f.name !== '' && <p className="text-[12.5px] text-[color:var(--hz-dk-err,#8a2c2c)]">{problem}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={problem !== null || pending} onClick={save} className={primaryBtn}>{pending ? 'Saving…' : place ? 'Save changes' : 'Add location'}</button>
        <button type="button" onClick={onDone} className={secondaryBtn}>Cancel</button>
      </div>
    </div>
  );
}

export default SavedLocations;
