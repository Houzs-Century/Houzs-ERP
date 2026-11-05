// ----------------------------------------------------------------------------
// Saved Locations — the "common locations" address book (owner 2026-11-02 方案2).
// Owner-maintained points a transfer is driven between: customers, suppliers,
// outsourced warehouses, frequent drops. A TRANSFER DP order's From and To
// pickers read this list, so a fixed point is picked once instead of re-typed.
//
// Route /scm/saved-locations, nav "Saved Locations" under Transportation.
// Backed by scm.saved_locations (mig 20261102T1700). Per-company scoped.
// Modelled on ThreePLCompanies.tsx (register card + list rows), minus the fleet.
// ----------------------------------------------------------------------------

import { useState, type CSSProperties } from 'react';
import { Button } from '@2990s/design-system';
import { MapPin, Plus, Trash2, Pencil, Check, X } from 'lucide-react';
import { PageHeader } from '../../components/Layout';
import { FormCard, FormGrid, FormField, FormInput } from '../../vendor/scm/components/FormCard';
import { PhoneInput } from '../../vendor/scm/components/PhoneInput';
import { formatPhone } from '@2990s/shared/phone';
import styles from './Suppliers.module.css';
import {
  useSavedLocations,
  useCreateSavedLocation,
  useUpdateSavedLocation,
  useDeleteSavedLocation,
  type SavedLocationRow,
} from '../../vendor/scm/lib/saved-locations-queries';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const BLANK = {
  name: '', contactName: '', contactPhone: '',
  address1: '', address2: '', city: '', postcode: '', state: '',
};
type Fields = typeof BLANK;

const joinedAddress = (r: SavedLocationRow): string =>
  [r.address1, r.address2, r.city, r.postcode, r.state].filter(Boolean).join(', ');

export const SavedLocations = ({ embedded = false }: { embedded?: boolean } = {}) => {
  const list = useSavedLocations();
  const createLoc = useCreateSavedLocation();
  const notify = useNotify();

  const [form, setForm] = useState<Fields>(BLANK);
  const set = (k: keyof Fields) => (v: string) => setForm((p) => ({ ...p, [k]: v }));

  const submit = () => {
    if (!form.name.trim()) { void notify({ title: 'Name required', body: 'Give the location a name.', tone: 'error' }); return; }
    if (!form.address1.trim() && !form.address2.trim()) {
      void notify({ title: 'Address required', body: 'Fill in address line 1 or 2 — the point of a saved location is its address.', tone: 'error' }); return;
    }
    const trimmed = (v: string) => v.trim() || null;
    createLoc.mutate(
      {
        name: form.name.trim(),
        contactName: trimmed(form.contactName), contactPhone: trimmed(form.contactPhone),
        address1: trimmed(form.address1), address2: trimmed(form.address2),
        city: trimmed(form.city), postcode: trimmed(form.postcode), state: trimmed(form.state),
      },
      {
        onSuccess: () => { setForm(BLANK); void notify({ title: 'Location saved', body: 'It can now be picked as a From or To on a transfer.', tone: 'info' }); },
        onError: (err) => notify({ title: 'Could not save', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
      },
    );
  };

  const rows = list.data ?? [];

  return (
    <div className="space-y-4">
      {!embedded && (
        <PageHeader
          eyebrow="Delivery"
          title="Saved Locations"
          description="Keep the points you deliver between — customers, suppliers, outsourced warehouses, frequent drops — so a transfer's From and To can be picked here instead of re-typed each time."
        />
      )}

      <FormCard
        title="Add a saved location"
        actions={
          <Button variant="primary" size="sm" onClick={submit} disabled={createLoc.isPending}>
            <Plus {...ICON} /><span>{createLoc.isPending ? 'Saving…' : 'Add location'}</span>
          </Button>
        }
      >
        <FormGrid>
          <FormField label="Location name" required span={2}>
            <FormInput value={form.name} onChange={(e) => set('name')(e.target.value)} placeholder="e.g. Sunway Pyramid loading bay" />
          </FormField>
          <FormField label="Contact person">
            <FormInput value={form.contactName} onChange={(e) => set('contactName')(e.target.value)} placeholder="Name" />
          </FormField>
          <FormField label="Contact phone" hint="Stored as +60…">
            <PhoneInput className={styles.fieldInput} value={form.contactPhone} onChange={set('contactPhone')} />
          </FormField>
          <FormField label="Address line 1" span={2}>
            <FormInput value={form.address1} onChange={(e) => set('address1')(e.target.value)} placeholder="Street / unit" />
          </FormField>
          <FormField label="Address line 2" span={2}>
            <FormInput value={form.address2} onChange={(e) => set('address2')(e.target.value)} placeholder="Area" />
          </FormField>
          <FormField label="City">
            <FormInput value={form.city} onChange={(e) => set('city')(e.target.value)} />
          </FormField>
          <FormField label="Postcode">
            <FormInput value={form.postcode} onChange={(e) => set('postcode')(e.target.value)} />
          </FormField>
          <FormField label="State">
            <FormInput value={form.state} onChange={(e) => set('state')(e.target.value)} />
          </FormField>
        </FormGrid>
      </FormCard>

      <div style={{ borderRadius: 10, border: '1px solid var(--border, rgba(0,0,0,0.12))', overflow: 'hidden' }}>
        {list.isLoading ? (
          <p style={{ padding: '12px 16px', fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>Loading…</p>
        ) : rows.length === 0 ? (
          <p style={{ padding: '12px 16px', fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>
            No saved locations yet. Add one above, then pick it as a From or To when you raise a transfer.
          </p>
        ) : (
          rows.map((r) => <LocationRow key={r.id} row={r} />)
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
        <MapPin {...ICON} />
        <span>
          A saved location is this company&rsquo;s own list. Deleting one does not change any transfer already raised — those keep the address that was copied onto them.
        </span>
      </div>
    </div>
  );
};

const ROW_SHELL: CSSProperties = { borderTop: '1px solid var(--border, rgba(0,0,0,0.06))' };

const LocationRow = ({ row }: { row: SavedLocationRow }) => {
  const update = useUpdateSavedLocation();
  const del = useDeleteSavedLocation();
  const notify = useNotify();
  const askConfirm = useConfirm();

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Fields>({
    name: row.name,
    contactName: row.contactName ?? '', contactPhone: row.contactPhone ?? '',
    address1: row.address1 ?? '', address2: row.address2 ?? '',
    city: row.city ?? '', postcode: row.postcode ?? '', state: row.state ?? '',
  });
  const set = (k: keyof Fields) => (v: string) => setForm((p) => ({ ...p, [k]: v }));

  const save = () => {
    if (!form.name.trim()) { void notify({ title: 'Name required', tone: 'error' }); return; }
    if (!form.address1.trim() && !form.address2.trim()) { void notify({ title: 'Address required', tone: 'error' }); return; }
    const trimmed = (v: string) => v.trim() || null;
    update.mutate(
      {
        id: row.id, name: form.name.trim(),
        contactName: trimmed(form.contactName), contactPhone: trimmed(form.contactPhone),
        address1: trimmed(form.address1), address2: trimmed(form.address2),
        city: trimmed(form.city), postcode: trimmed(form.postcode), state: trimmed(form.state),
      },
      { onSuccess: () => setEditing(false), onError: (err) => notify({ title: 'Could not save', body: err instanceof Error ? err.message : '', tone: 'error' }) },
    );
  };

  const remove = async () => {
    if (!(await askConfirm({ title: 'Delete this saved location?', body: `${row.name} — transfers already raised keep their copied address.`, confirmLabel: 'Delete' }))) return;
    del.mutate(row.id, { onError: (err) => notify({ title: 'Could not delete', body: err instanceof Error ? err.message : '', tone: 'error' }) });
  };

  if (editing) {
    return (
      <div style={ROW_SHELL}>
        <div style={{ padding: '12px' }}>
          <FormGrid>
            <FormField label="Location name" required span={2}>
              <FormInput value={form.name} onChange={(e) => set('name')(e.target.value)} />
            </FormField>
            <FormField label="Contact person">
              <FormInput value={form.contactName} onChange={(e) => set('contactName')(e.target.value)} />
            </FormField>
            <FormField label="Contact phone">
              <PhoneInput className={styles.fieldInput} value={form.contactPhone} onChange={set('contactPhone')} />
            </FormField>
            <FormField label="Address line 1" span={2}>
              <FormInput value={form.address1} onChange={(e) => set('address1')(e.target.value)} />
            </FormField>
            <FormField label="Address line 2" span={2}>
              <FormInput value={form.address2} onChange={(e) => set('address2')(e.target.value)} />
            </FormField>
            <FormField label="City">
              <FormInput value={form.city} onChange={(e) => set('city')(e.target.value)} />
            </FormField>
            <FormField label="Postcode">
              <FormInput value={form.postcode} onChange={(e) => set('postcode')(e.target.value)} />
            </FormField>
            <FormField label="State">
              <FormInput value={form.state} onChange={(e) => set('state')(e.target.value)} />
            </FormField>
          </FormGrid>
          <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
            <Button variant="primary" size="sm" onClick={save} disabled={update.isPending}><Check {...ICON} /><span>Save</span></Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}><X {...ICON} /><span>Cancel</span></Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={ROW_SHELL}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, padding: '10px 12px' }}>
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <strong style={{ fontSize: 'var(--fs-13)' }}>{row.name}</strong>
          <div style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {joinedAddress(row) || 'No address'}
          </div>
        </div>

        <div style={{ flex: '1 1 160px', minWidth: 0 }}>
          <div style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>Contact</div>
          <div style={{ fontSize: 'var(--fs-12)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.contactName || '—'}</div>
          {row.contactPhone && <div style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>{formatPhone(row.contactPhone)}</div>}
        </div>

        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', flex: '0 0 auto' }}>
          <input type="checkbox" checked={row.isActive} disabled={update.isPending}
            onChange={() => update.mutate({ id: row.id, isActive: !row.isActive }, {
              onError: (err) => notify({ title: 'Could not update', body: err instanceof Error ? err.message : '', tone: 'error' }),
            })} />
          <span style={{ fontSize: 'var(--fs-12)', color: row.isActive ? 'var(--c-secondary-a, inherit)' : 'var(--fg-muted)' }}>{row.isActive ? 'Active' : 'Inactive'}</span>
        </label>

        <div style={{ display: 'inline-flex', gap: 4, flex: '0 0 auto' }}>
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}><Pencil {...ICON} /><span>Edit</span></Button>
          <Button variant="ghost" size="sm" onClick={remove} disabled={del.isPending}><Trash2 {...ICON} /></Button>
        </div>
      </div>
    </div>
  );
};

export default SavedLocations;
