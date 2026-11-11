// ----------------------------------------------------------------------------
// EditDpOrderDrawer — edit an unscheduled DP Order's party / address / date /
// remark (PATCH /dp-orders/:id).
//
// Owner 2026-11-02 ("DP order maintenance"): the registry had no "edit" — a
// mistyped address meant cancelling the job and raising a new one. The PATCH
// endpoint has always existed and refuses anything past PENDING_SCHEDULE; this is
// its first UI. A scheduled job's details are on a manifest a driver may already
// hold, so the page offers Edit on PENDING_SCHEDULE rows only.
//
// Deliberately a SMALLER body than NewDpOrderDrawer: no job type, no source
// picker, no auto-fill — the party is already resolved, this just corrects the
// stored fields. Mirrors NewDpOrderDrawer's chrome + the Suppliers CSS module.
// In-app NotifyDialog only.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import type { CSSProperties } from 'react';
import { X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useUpdateDpOrder,
  dpJobTypeLabel,
  type DpOrderRow,
} from '../lib/delivery-planning-queries';
import { useNotify } from './NotifyDialog';
import { writeFailedAs } from '../lib/mutation-error';
import { DateField } from './DateField';
import styles from '../../../pages/scm-v2/Suppliers.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

export const EditDpOrderDrawer = ({ row, onClose }: { row: DpOrderRow; onClose: () => void }) => {
  const update = useUpdateDpOrder();
  const notify = useNotify();

  const [form, setForm] = useState({
    partyName: row.party_name ?? '',
    contactName: row.contact_name ?? '',
    contactPhone: row.contact_phone ?? '',
    address1: row.address1 ?? '',
    address2: row.address2 ?? '',
    // Kept (not shown) so an existing line 3/4 passes through unchanged, exactly
    // as NewDpOrderDrawer only exposes line 1 and line 2.
    address3: row.address3 ?? '',
    address4: row.address4 ?? '',
    city: row.city ?? '',
    postcode: row.postcode ?? '',
    state: row.state ?? '',
    // Origin ("from") — TRANSFER only (owner 2026-11-02 方案1); the section renders
    // only for a transfer, but the fields are always in state so the diff is simple.
    fromName: row.from_name ?? '',
    fromAddress1: row.from_address1 ?? '',
    fromAddress2: row.from_address2 ?? '',
    fromCity: row.from_city ?? '',
    fromPostcode: row.from_postcode ?? '',
    fromState: row.from_state ?? '',
    requestedDate: row.requested_date ?? '',
    remark: row.remark ?? '',
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  const isTransfer = row.job_type === 'TRANSFER';

  const fieldRow: CSSProperties = { display: 'block', marginBottom: 'var(--space-3)' };
  const inputStyle: CSSProperties = { width: '100%' };
  const row2: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' };

  const hasAddress = [form.address1, form.address2, form.address3, form.address4].some((v) => v.trim() !== '');

  const submit = () => {
    /* Every field goes up as its own value — unlike create's "non-empty only"
       overrides — because editing must be able to CLEAR a field (a line typed in
       error), and a cleared field reaches the server as null, not as "unchanged".
       The backend refuses a change that leaves the job with no address. */
    const toNull = (v: string): string | null => (v.trim() === '' ? null : v.trim());
    update.mutate(
      {
        id: row.id,
        partyName: toNull(form.partyName),
        contactName: toNull(form.contactName),
        contactPhone: toNull(form.contactPhone),
        address1: toNull(form.address1),
        address2: toNull(form.address2),
        address3: toNull(form.address3),
        address4: toNull(form.address4),
        city: toNull(form.city),
        postcode: toNull(form.postcode),
        state: toNull(form.state),
        // Origin fields only for a transfer, so a non-transfer edit never writes them.
        ...(isTransfer ? {
          fromName: toNull(form.fromName),
          fromAddress1: toNull(form.fromAddress1),
          fromAddress2: toNull(form.fromAddress2),
          fromCity: toNull(form.fromCity),
          fromPostcode: toNull(form.fromPostcode),
          fromState: toNull(form.fromState),
        } : {}),
        requestedDate: form.requestedDate ? form.requestedDate : null,
        remark: toNull(form.remark),
      },
      {
        onSuccess: () => { void notify({ title: 'DP Order updated' }); onClose(); },
        onError: writeFailedAs('Update failed'),
      },
    );
  };

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.drawer} onClick={(e) => e.stopPropagation()}>
        <div className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>Edit DP Order{row.dp_no ? ` — ${row.dp_no}` : ''}</h2>
          <button type="button" onClick={onClose} className={styles.codeChip}><X {...ICON} /></button>
        </div>

        <div className={styles.drawerBody}>
          <div style={{ margin: '0 0 var(--space-3)', fontSize: 'var(--fs-12)', color: 'var(--c-muted, var(--hz-c-ink-muted))' }}>
            {dpJobTypeLabel(row.job_type)} · Pending Schedule. A job can be edited until it is scheduled.
          </div>

          {/* Origin ("from") — TRANSFER only (owner 2026-11-02 方案1). Shown above the
              destination so the job reads from -> to. Free text, optional. */}
          {isTransfer && (
            <div style={{ ...fieldRow, padding: 'var(--space-3)', border: '1px solid var(--border, rgba(34,31,32,0.12))', borderRadius: '6px' }}>
              <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>
                From (origin) <span style={{ textTransform: 'none', color: 'var(--c-muted, var(--hz-c-ink-muted))' }}>— optional</span>
              </div>
              <label style={fieldRow}>
                <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>From name</div>
                <input className={styles.searchInput} style={inputStyle} value={form.fromName} onChange={(e) => set('fromName', e.target.value)} />
              </label>
              <label style={fieldRow}>
                <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>From address line 1</div>
                <input className={styles.searchInput} style={inputStyle} value={form.fromAddress1} onChange={(e) => set('fromAddress1', e.target.value)} />
              </label>
              <label style={fieldRow}>
                <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>From address line 2</div>
                <input className={styles.searchInput} style={inputStyle} value={form.fromAddress2} onChange={(e) => set('fromAddress2', e.target.value)} />
              </label>
              <div style={row2}>
                <label style={fieldRow}>
                  <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>From city</div>
                  <input className={styles.searchInput} style={inputStyle} value={form.fromCity} onChange={(e) => set('fromCity', e.target.value)} />
                </label>
                <label style={fieldRow}>
                  <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>From postcode</div>
                  <input className={styles.searchInput} style={inputStyle} value={form.fromPostcode} onChange={(e) => set('fromPostcode', e.target.value)} />
                </label>
              </div>
              <label style={{ ...fieldRow, marginBottom: 0 }}>
                <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>From state</div>
                <input className={styles.searchInput} style={inputStyle} value={form.fromState} onChange={(e) => set('fromState', e.target.value)} />
              </label>
            </div>
          )}

          {isTransfer && (
            <div className={styles.eyebrow} style={{ margin: 'var(--space-1) 0 var(--space-2)', color: 'var(--c-burnt)' }}>To (destination)</div>
          )}
          <label style={fieldRow}>
            <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>Party name</div>
            <input className={styles.searchInput} style={inputStyle} value={form.partyName} onChange={(e) => set('partyName', e.target.value)} />
          </label>
          <div style={row2}>
            <label style={fieldRow}>
              <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>Contact</div>
              <input className={styles.searchInput} style={inputStyle} value={form.contactName} onChange={(e) => set('contactName', e.target.value)} />
            </label>
            <label style={fieldRow}>
              <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>Phone</div>
              <input className={styles.searchInput} style={inputStyle} value={form.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} />
            </label>
          </div>

          <label style={fieldRow}>
            <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>
              Address line 1 <span style={{ textTransform: 'none', color: 'var(--c-burnt)' }}>— required</span>
            </div>
            <input className={styles.searchInput} style={inputStyle} value={form.address1} onChange={(e) => set('address1', e.target.value)} />
          </label>
          <label style={fieldRow}>
            <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>Address line 2</div>
            <input className={styles.searchInput} style={inputStyle} value={form.address2} onChange={(e) => set('address2', e.target.value)} />
          </label>
          <div style={row2}>
            <label style={fieldRow}>
              <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>City</div>
              <input className={styles.searchInput} style={inputStyle} value={form.city} onChange={(e) => set('city', e.target.value)} />
            </label>
            <label style={fieldRow}>
              <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>Postcode</div>
              <input className={styles.searchInput} style={inputStyle} value={form.postcode} onChange={(e) => set('postcode', e.target.value)} />
            </label>
          </div>
          <div style={row2}>
            <label style={fieldRow}>
              <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>State</div>
              <input className={styles.searchInput} style={inputStyle} value={form.state} onChange={(e) => set('state', e.target.value)} />
            </label>
            <label style={fieldRow}>
              <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>Requested date</div>
              <DateField fullWidth className={styles.searchInput} style={inputStyle} value={form.requestedDate} onChange={(iso) => set('requestedDate', iso)} />
            </label>
          </div>
          <label style={fieldRow}>
            <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>Remark</div>
            <input className={styles.searchInput} style={inputStyle} value={form.remark} onChange={(e) => set('remark', e.target.value)} />
          </label>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)', padding: 'var(--space-4)' }}>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" onClick={submit} disabled={update.isPending || !hasAddress}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default EditDpOrderDrawer;
