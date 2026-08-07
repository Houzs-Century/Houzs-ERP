// ----------------------------------------------------------------------------
// NewDpOrderDrawer — create a DP Order (delivery-planning job) from the board.
//
// Owner mockup 2026-07-18. Six job types via a dropdown (owner: "做成 dropdown
// 比较省空间"). Each type's party comes from a different master; the operator may
// give a SOURCE reference and the SERVER auto-fills the party from it, or fill
// the fields by hand for a manual job (setup / dismantle). Manual fields sent
// here WIN over the server auto-fill.
//
// P3 follow-up (2026-07-28): the source is a type-to-search PICKER, not a raw
// id input — SUPPLIER_PICKUP picks from the supplier master, SETUP/DISMANTLE
// from the PMS project list — and picking LIVE-PREFILLS the party fields so
// the operator sees (and may edit) what will be stored before creating. The
// prefill mirrors backend dp-party.ts field-for-field; because prefilled
// fields go up as overrides, preview and outcome cannot drift. If the list
// fetch fails (a position without that master's page access), the picker
// degrades to the original free-text id input — the server-side fill on
// create never needed the caller to read the master.
//
// Mirrors DeliveryFieldsDrawer's chrome + the Suppliers CSS module. In-app
// NotifyDialog only.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@2990s/design-system';
import {
  useCreateDpOrder,
  useScheduleDelivery,
  DP_ENTRY_MENU,
  type DpOrderCreate,
} from '../lib/delivery-planning-queries';
import { useMfgSalesOrdersPaged } from '../lib/sales-order-queries';
import { useSuppliers, useSupplierDetail } from '../lib/suppliers-queries';
import { useLorries } from '../lib/lorries-queries';
import { useStockTransfers } from '../lib/stock-queries';
import { useWarehouses } from '../lib/inventory-queries';
import { SearchableSelect } from './SearchableSelect';
import { useNotify } from './NotifyDialog';
// App-level client for the PMS project list (/api/projects lives outside the
// /api/scm mount that the vendored authed-fetch targets). Same app-import
// precedent as DataGrid's activeCompany subscription.
import { api } from '../../../api/client';
import styles from '../../../pages/scm-v2/Suppliers.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/* Job types + labels come from the SHARED canonical list (DP_JOB_TYPES /
   DP_JOB_TYPE_LABEL in delivery-planning-queries) — the same set the board renders
   in its Type chip — so this dropdown can never drift from what's shown elsewhere. */

/* What the SOURCE reference means for each type, and the field it maps to. */
function sourceMeta(jobType: DpOrderCreate['jobType']): { label: string; hint: string; kind: 'so' | 'supplier' | 'project' | 'assr' | 'workshop' | 'transfer' | 'none' } {
  switch (jobType) {
    case 'SUPPLIER_PICKUP': return { label: 'Supplier', hint: 'supplier id — party auto-fills from the supplier master', kind: 'supplier' };
    case 'SETUP':
    case 'DISMANTLE': return { label: 'Project / venue', hint: 'PMS project id — venue + PIC auto-fill', kind: 'project' };
    case 'SERVICE': return { label: 'Service case', hint: 'service case id — customer auto-fills', kind: 'assr' };
    case 'LORRY_SERVICE': return { label: 'Workshop', hint: 'workshop id — name, contact + address auto-fill from the workshop master', kind: 'workshop' };
    case 'TRANSFER': return { label: 'Stock transfer', hint: 'transfer id — the destination warehouse auto-fills from the document', kind: 'transfer' };
    default: return { label: 'Sales order', hint: 'SO No. — customer auto-fills (optional)', kind: 'so' };
  }
}

/* The slice of a PMS project row this picker needs (GET /api/projects → { data }). */
type ProjectPickRow = {
  id: number;
  code: string | null;
  name: string | null;
  venue: string | null;
  organizer: string | null;
  state: string | null;
};

/* The slice of the workshop master this picker needs — mig 0241, served by
   GET /api/fleet-maintenance/workshops as { workshops } in camelCase. That
   master is deliberately NOT scm.suppliers ("a workshop you send a lorry to is
   none of those"), so it needs its own picker rather than reusing the supplier
   one. */
/* The slice of a service case the ASSR legs need (GET /api/assr → { data }).
   Only enough to recognise the case in a dropdown — the party comes from the
   case itself when the board renders the leg. */
type AssrPickRow = {
  id: number;
  assr_no: string;
  doc_no: string | null;
  customer_name: string | null;
  inspection_by?: string | null;
};

type WorkshopPickRow = {
  id: string;
  code: string | null;
  name: string | null;
  contactName: string | null;
  contactPhone: string | null;
  officePhone: string | null;
  address: string | null;
  isActive: boolean;
};

export const NewDpOrderDrawer = ({ onClose }: { onClose: () => void }) => {
  const create = useCreateDpOrder();
  const schedule = useScheduleDelivery();
  const notify = useNotify();

  /* Which of the nine menu entries is selected. The entry — not a job type —
     is the drawer's mode switch: five of them CREATE a dp_order, four SCHEDULE
     a document that is already on the board (see DP_ENTRY_MENU for why). */
  const [entryKey, setEntryKey] = useState<string>(DP_ENTRY_MENU[0].key);
  const entry = DP_ENTRY_MENU.find((e) => e.key === entryKey) ?? DP_ENTRY_MENU[0];
  const isSchedule = entry.mode === 'schedule';

  /* Schedule-mode state: which existing document, and the date to write on it.
     Kept apart from `form` because none of the party fields apply — the
     document already owns its customer and address. */
  const [docId, setDocId] = useState('');
  const [jobDate, setJobDate] = useState('');

  const [form, setForm] = useState({
    jobType: 'SETUP' as DpOrderCreate['jobType'],
    source: '',
    /* LORRY_SERVICE only — the lorry being serviced. It is a SECOND reference,
       not the source: the source (workshop) supplies the party, this supplies
       the job's subject and is the lorry taken off the road when the job is
       scheduled. Every other job type leaves it empty. */
    lorryId: '',
    /* TRANSFER only — the DESTINATION warehouse. Like the lorry above it is a
       second reference rather than the source: the transfer document (if any)
       says what is being moved, this says where the fleet is driving to, and it
       is the party the address comes from. */
    warehouseId: '',
    partyName: '', contactName: '', contactPhone: '',
    address1: '', address2: '', address3: '', address4: '',
    city: '', postcode: '', state: '',
    requestedDate: '', remark: '',
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  const src = sourceMeta(form.jobType);

  /* ── Schedule-mode pickers ───────────────────────────────────────────────
     Only fetched for the entry that needs them. SOs come from the paged list
     (newest first, one page is plenty for "which order am I planning today");
     service cases come from the ASSR list, which lives outside the /api/scm
     mount like the project list above. */
  const soQ = useMfgSalesOrdersPaged({ page: 1, pageSize: 200, sort: '-so_date' });
  const assrQ = useQuery<{ data: AssrPickRow[] }>({
    queryKey: ['dp-assr-pick'],
    queryFn: () => api.get<{ data: AssrPickRow[] }>('/api/assr?page=1&per_page=200&exclude_stage=completed'),
    enabled: isSchedule && entry.scheduleType === 'assr',
    staleTime: 60_000,
  });

  const soOptions = useMemo(
    () => ((soQ.data?.salesOrders ?? []) as Array<Record<string, unknown>>).map((s) => ({
      value: String(s.doc_no ?? ''),
      label: `${String(s.doc_no ?? '')}${s.debtor_name ? ` — ${String(s.debtor_name)}` : ''}`,
    })).filter((o) => o.value !== ''),
    [soQ.data],
  );
  const assrOptions = useMemo(
    () => (assrQ.data?.data ?? []).map((a) => ({
      value: String(a.id),
      label: `${a.assr_no}${a.customer_name ? ` — ${a.customer_name}` : ''}${a.doc_no ? ` · ${a.doc_no}` : ''}`,
    })),
    [assrQ.data],
  );

  /* ── Source pickers ──────────────────────────────────────────────────────
     Fetch lazily per kind (enabled-gated) so a drawer opened for a manual
     SETUP never touches the supplier master and vice versa. isError → the
     free-text fallback below. */
  const suppliersQ = useSuppliers(undefined);
  const suppliersEnabled = src.kind === 'supplier';
  const projectsQ = useQuery<{ data: ProjectPickRow[] }>({
    queryKey: ['dp-project-pick'],
    queryFn: () => api.get<{ data: ProjectPickRow[] }>('/api/projects?per_page=200'),
    enabled: src.kind === 'project',
    staleTime: 60_000,
  });

  const supplierOptions = useMemo(
    () => (suppliersQ.data ?? []).map((s) => ({ value: s.id, label: `${s.name} (${s.code})` })),
    [suppliersQ.data],
  );
  const projectOptions = useMemo(
    () => (projectsQ.data?.data ?? []).map((p) => ({
      value: String(p.id),
      label: `${p.code ?? p.id} — ${p.name ?? ''}${p.venue ? ` · ${p.venue}` : ''}`,
    })),
    [projectsQ.data],
  );

  /* Workshops + lorries — LORRY_SERVICE only. The workshop master lives outside
     the /api/scm mount (same app-import precedent as the project list above) and
     is gated on fleet.read, so a position without the fleet pages gets isError
     and the free-text fallback rather than a dead picker. */
  const workshopsQ = useQuery<{ workshops: WorkshopPickRow[] }>({
    queryKey: ['dp-workshop-pick'],
    queryFn: () => api.get<{ workshops: WorkshopPickRow[] }>('/api/fleet-maintenance/workshops'),
    enabled: src.kind === 'workshop',
    staleTime: 60_000,
  });
  /* Only lorries that can still be sent anywhere. An inactive one is off the
     fleet entirely — raising a service job for it would block nothing. */
  const lorriesQ = useLorries({ fleet: 'internal' });

  const workshopOptions = useMemo(
    () => (workshopsQ.data?.workshops ?? [])
      .filter((w) => w.isActive)
      .map((w) => ({ value: w.id, label: `${w.name ?? w.code ?? w.id}${w.code ? ` (${w.code})` : ''}` })),
    [workshopsQ.data],
  );
  const lorryOptions = useMemo(
    () => (lorriesQ.data ?? [])
      .filter((l) => l.active !== false)
      .map((l) => ({ value: l.id, label: l.plate })),
    [lorriesQ.data],
  );

  /* Transfers + warehouses — TRANSFER only. POSTED transfers only: a cancelled
     document describes a move that is not happening, and sending a lorry for it
     is the mistake this filter exists to prevent. */
  const transfersQ = useStockTransfers({ status: 'POSTED' });
  const warehousesQ = useWarehouses();

  const transferOptions = useMemo(
    () => (transfersQ.data ?? []).map((t) => ({
      value: t.id,
      label: `${t.transfer_no} — ${t.from_warehouse?.code ?? '?'} → ${t.to_warehouse?.code ?? '?'}${t.transfer_date ? ` · ${t.transfer_date}` : ''}`,
    })),
    [transfersQ.data],
  );
  const warehouseOptions = useMemo(
    () => (warehousesQ.data ?? []).map((w) => ({
      value: w.id,
      label: `${w.code}${w.name && w.name !== w.code ? ` — ${w.name}` : ''}`,
    })),
    [warehousesQ.data],
  );

  /* Supplier prefill — the DETAIL row (the list view predates the structured
     address columns), applied once per pick so later hand-edits are never
     clobbered by a background refetch. Field precedence mirrors backend
     dp-party.ts snapshotFromSupplier exactly. */
  const pickedSupplierId = src.kind === 'supplier' && form.source ? form.source : null;
  const supplierDetailQ = useSupplierDetail(pickedSupplierId);
  const [prefilledFor, setPrefilledFor] = useState<string | null>(null);
  useEffect(() => {
    const row = supplierDetailQ.data?.supplier as (Record<string, unknown> & { id?: string }) | undefined;
    if (!row || !pickedSupplierId || row.id !== pickedSupplierId || prefilledFor === pickedSupplierId) return;
    const t = (v: unknown): string => (v == null ? '' : String(v).trim());
    const structured = [row.address1, row.address2, row.address3, row.address4].some((v) => t(v) !== '');
    setForm((s) => ({
      ...s,
      partyName: t(row.name),
      contactName: t(row.contact_person) || t(row.attention),
      contactPhone: t(row.phone) || t(row.mobile),
      address1: structured ? t(row.address1) : t(row.address),
      address2: structured ? t(row.address2) : '',
      address3: structured ? t(row.address3) : '',
      address4: structured ? t(row.address4) : '',
      city: t(row.city),
      postcode: t(row.postcode),
      state: t(row.state),
    }));
    setPrefilledFor(pickedSupplierId);
  }, [supplierDetailQ.data, pickedSupplierId, prefilledFor]);

  /* Project prefill — from the picked LIST row (venue + state; the PIC's
     name/phone need a users lookup the server does on create, and the venue
     address only lives on the full project row — the hint says so). */
  const pickProject = (id: string) => {
    set('source', id);
    const p = (projectsQ.data?.data ?? []).find((r) => String(r.id) === id);
    if (!p) return;
    setForm((s) => ({
      ...s,
      source: id,
      partyName: (p.venue ?? p.organizer ?? '').trim(),
      state: (p.state ?? '').trim(),
    }));
  };

  /* Workshop prefill — straight off the picked LIST row; unlike the supplier
     master there is no richer detail view to wait for. Field precedence mirrors
     backend dp-party.ts snapshotFromWorkshop exactly (named contact first, the
     office line second), so what the operator previews is what gets stored. */
  const pickWorkshop = (id: string) => {
    const w = (workshopsQ.data?.workshops ?? []).find((r) => r.id === id);
    setForm((s) => ({
      ...s,
      source: id,
      partyName: (w?.name ?? '').trim(),
      contactName: (w?.contactName ?? '').trim(),
      contactPhone: (w?.contactPhone ?? w?.officePhone ?? '').trim(),
      address1: (w?.address ?? '').trim(),
      address2: '', address3: '', address4: '',
      city: '', postcode: '', state: '',
    }));
  };

  /* Warehouse prefill — mirrors backend dp-party.ts snapshotFromWarehouse field
     for field: the master's free-text `location` is the only street line there
     is, the name falls back to the code, and there is no contact to invent. */
  const applyWarehouse = (id: string, prev: typeof form): typeof form => {
    const w = (warehousesQ.data ?? []).find((r) => r.id === id);
    return {
      ...prev,
      warehouseId: id,
      partyName: (w?.name ?? w?.code ?? '').trim(),
      contactName: '', contactPhone: '',
      address1: (w?.location ?? '').trim(),
      address2: '', address3: '', address4: '',
      city: (w?.city ?? '').trim(),
      postcode: (w?.postcode ?? '').trim(),
      state: (w?.state ?? '').trim(),
    };
  };
  const pickWarehouse = (id: string) => setForm((s) => applyWarehouse(id, s));

  /* Picking a transfer document fills the destination FROM the document, then
     the party from that destination — the same two steps the server takes when
     only stockTransferId is sent. The operator can still change the warehouse
     afterwards; whatever is on screen is what gets stored. */
  const pickTransfer = (id: string) => {
    const t = (transfersQ.data ?? []).find((r) => r.id === id);
    const dest = t?.to_warehouse_id ?? '';
    setForm((s) => (dest ? applyWarehouse(dest, { ...s, source: id }) : { ...s, source: id }));
  };

  /* Schedule-mode submit — put a DATE on a document that is already a board row.
     No dp_order is inserted: the SO/DO and the three ASSR legs are synthesised
     from their own source, so creating one would double the line or be eaten by
     the anti-double-count guard. This is the same PATCH the board's own inline
     date cell fires, which is why the row appears with no further wiring. */
  const submitSchedule = () => {
    if (!isSchedule || !docId || !jobDate) return;
    schedule.mutate(
      entry.scheduleType === 'assr'
        ? { type: 'assr', id: docId, scheduleDate: jobDate, jobKind: entry.jobKind }
        : { type: 'so', id: docId, scheduleDate: jobDate },
      {
        onSuccess: () => {
          notify({
            title: 'Job scheduled',
            body: `${entry.label} on ${jobDate}. It is on the board — assign a lorry and crew there.`,
          });
          onClose();
        },
        onError: (err) => notify({
          title: 'Could not schedule',
          body: err instanceof Error ? err.message : 'Something went wrong.',
          tone: 'error',
        }),
      },
    );
  };

  const submit = () => {
    if (isSchedule) { submitSchedule(); return; }
    const body: DpOrderCreate = { jobType: form.jobType };
    const ref = form.source.trim();
    if (ref) {
      if (src.kind === 'supplier') body.supplierId = ref;
      else if (src.kind === 'project') body.projectId = Number(ref) || undefined;
      else if (src.kind === 'assr') body.assrCaseId = Number(ref) || undefined;
      else if (src.kind === 'workshop') body.workshopId = ref;
      else if (src.kind === 'transfer') body.stockTransferId = ref;
      else if (src.kind === 'so') body.soDocNo = ref;
    }
    /* The destination rides alongside the transfer document, not instead of it:
       an ad-hoc move has a warehouse and no document, and a document-backed one
       records where the fleet was actually sent even if the document's
       destination is edited later. */
    if (form.jobType === 'TRANSFER' && form.warehouseId) body.warehouseId = form.warehouseId;
    /* The serviced lorry rides alongside the source, not instead of it: the
       workshop is the party, this is the job's subject. Sent for LORRY_SERVICE
       only, so switching type can never smuggle a stale lorry onto a setup job. */
    if (form.jobType === 'LORRY_SERVICE' && form.lorryId) body.lorryId = form.lorryId;
    if (form.requestedDate) body.requestedDate = form.requestedDate;
    if (form.remark.trim()) body.remark = form.remark.trim();

    // Manual fields → overrides (win over the server's auto-fill). Only non-empty
    // keys, so a blank field never clobbers an auto-filled value.
    const ov: Record<string, string | null> = {};
    const map: Array<[keyof typeof form, string]> = [
      ['partyName', 'party_name'], ['contactName', 'contact_name'], ['contactPhone', 'contact_phone'],
      ['address1', 'address1'], ['address2', 'address2'], ['address3', 'address3'], ['address4', 'address4'],
      ['city', 'city'], ['postcode', 'postcode'], ['state', 'state'],
    ];
    for (const [fk, col] of map) {
      const v = String(form[fk] ?? '').trim();
      if (v) ov[col] = v;
    }
    if (Object.keys(ov).length) body.overrides = ov;

    create.mutate(body, {
      onSuccess: () => { notify({ title: 'DP Order created', body: 'It is now on the board as Pending Schedule.' }); onClose(); },
      onError: (err) => notify({ title: 'Create failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
    });
  };

  const fieldRow: CSSProperties = { display: 'block', marginBottom: 'var(--space-3)' };
  const inputStyle: CSSProperties = { width: '100%' };
  const row2: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' };

  /* Which control the source field renders as. A failed list fetch (403 for a
     position without that master's page, or a network hiccup) falls back to
     the original free-text id input rather than a dead picker. */
  const sourceControl =
    src.kind === 'supplier' && !suppliersQ.isError ? 'supplier-picker'
    : src.kind === 'project' && !projectsQ.isError ? 'project-picker'
    : src.kind === 'workshop' && !workshopsQ.isError ? 'workshop-picker'
    : src.kind === 'transfer' && !transfersQ.isError ? 'transfer-picker'
    : 'text';

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.drawer} onClick={(e) => e.stopPropagation()}>
        <div className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>New DP Order</h2>
          <button type="button" onClick={onClose} className={styles.codeChip}><X {...ICON} /></button>
        </div>

        <div className={styles.drawerBody}>
          <label style={fieldRow}>
            <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>Job type</div>
            <select className={styles.searchInput} style={inputStyle}
              value={entryKey}
              onChange={(e) => {
                // A supplier id is meaningless on a SETUP and vice versa — and
                // so is the party the old source prefilled (a venue name must
                // not survive into "Supplier name" as a would-be override).
                // Switching entry clears the pick AND the party fields;
                // date/remark stay, they are type-agnostic. The schedule-mode
                // document + date clear too — an SO number is not a service case.
                const key = e.target.value;
                const next = DP_ENTRY_MENU.find((x) => x.key === key) ?? DP_ENTRY_MENU[0];
                setEntryKey(key);
                setDocId('');
                setJobDate('');
                setForm((s) => ({
                  ...s,
                  jobType: next.mode === 'create' ? next.jobType : s.jobType,
                  source: '',
                  // Same reasoning for the serviced lorry: it only means
                  // anything on a LORRY_SERVICE, so it clears with the rest.
                  lorryId: '',
                  warehouseId: '',
                  partyName: '', contactName: '', contactPhone: '',
                  address1: '', address2: '', address3: '', address4: '',
                  city: '', postcode: '', state: '',
                }));
                setPrefilledFor(null);
              }}>
              {DP_ENTRY_MENU.map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}
            </select>
          </label>

          {/* ── Schedule mode — put a date on a document that already exists ──
              Deliberately a MUCH shorter body: there is no party to fill in,
              because the sales order or the service case already owns its
              customer and address. The panel says so, so the next reader does
              not go looking for the address fields. */}
          {isSchedule ? (
            <>
              <div style={{
                margin: 'var(--space-2) 0 var(--space-3)', padding: 'var(--space-2)',
                background: 'rgba(31, 94, 115, 0.08)', borderRadius: '6px',
                fontSize: 'var(--fs-12)', lineHeight: 1.5,
              }}>
                This job already exists — {entry.scheduleType === 'assr' ? 'the service case' : 'the sales order'} is its
                document. Picking a date puts it on the board; the customer and address
                come from the document, and nothing new is created.
              </div>

              <label style={fieldRow}>
                <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>
                  {entry.scheduleType === 'assr' ? 'Service case' : 'Sales order'}{' '}
                  <span style={{ textTransform: 'none', color: 'var(--c-burnt)' }}>— required</span>
                </div>
                {entry.scheduleType === 'assr' ? (
                  assrQ.isError ? (
                    <input className={styles.searchInput} style={inputStyle}
                      placeholder="service case id — the case list could not be loaded"
                      value={docId} onChange={(e) => setDocId(e.target.value)} />
                  ) : (
                    <SearchableSelect
                      value={docId}
                      onChange={setDocId}
                      options={assrOptions}
                      placeholder={assrQ.isLoading ? 'Loading service cases…' : 'Search by ASSR no, customer or SO…'}
                      className={styles.searchInput}
                      ariaLabel="Service case"
                    />
                  )
                ) : soQ.isError ? (
                  <input className={styles.searchInput} style={inputStyle}
                    placeholder="SO No. — the order list could not be loaded"
                    value={docId} onChange={(e) => setDocId(e.target.value)} />
                ) : (
                  <SearchableSelect
                    value={docId}
                    onChange={setDocId}
                    options={soOptions}
                    placeholder={soQ.isLoading ? 'Loading sales orders…' : 'Search by SO no or customer…'}
                    className={styles.searchInput}
                    ariaLabel="Sales order"
                  />
                )}
                {entry.key === 'ASSR_INSPECTION' && (
                  <div style={{ marginTop: 'var(--space-1)', fontSize: 'var(--fs-11)', color: 'var(--c-muted, #767b6e)' }}>
                    An inspection reaches the board only when the case is inspected by our
                    own team — on a supplier-inspected case the date is kept but no fleet
                    job appears, because we do not dispatch for someone else's inspection.
                  </div>
                )}
              </label>

              <label style={fieldRow}>
                <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>
                  Job date <span style={{ textTransform: 'none', color: 'var(--c-burnt)' }}>— required</span>
                </div>
                <input type="date" className={styles.searchInput} style={inputStyle}
                  value={jobDate} onChange={(e) => setJobDate(e.target.value)} />
              </label>
            </>
          ) : (
          <>

          <label style={fieldRow}>
            <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>{src.label} <span style={{ textTransform: 'none', color: 'var(--c-muted, #767b6e)' }}>— optional</span></div>
            {sourceControl === 'supplier-picker' ? (
              <SearchableSelect
                value={form.source}
                onChange={(id) => { set('source', id); setPrefilledFor(null); }}
                options={supplierOptions}
                placeholder={suppliersQ.isLoading ? 'Loading suppliers…' : 'Search supplier by name or code…'}
                className={styles.searchInput}
                ariaLabel="Supplier"
              />
            ) : sourceControl === 'project-picker' ? (
              <SearchableSelect
                value={form.source}
                onChange={pickProject}
                options={projectOptions}
                placeholder={projectsQ.isLoading ? 'Loading projects…' : 'Search project by code, name or venue…'}
                className={styles.searchInput}
                ariaLabel="Project / venue"
              />
            ) : sourceControl === 'workshop-picker' ? (
              <SearchableSelect
                value={form.source}
                onChange={pickWorkshop}
                options={workshopOptions}
                placeholder={workshopsQ.isLoading ? 'Loading workshops…' : 'Search workshop by name or code…'}
                className={styles.searchInput}
                ariaLabel="Workshop"
              />
            ) : sourceControl === 'transfer-picker' ? (
              <SearchableSelect
                value={form.source}
                onChange={pickTransfer}
                options={transferOptions}
                placeholder={transfersQ.isLoading ? 'Loading transfers…' : 'Search by transfer no or warehouse…'}
                className={styles.searchInput}
                ariaLabel="Stock transfer"
              />
            ) : (
              <input className={styles.searchInput} style={inputStyle} placeholder={src.hint}
                value={form.source} onChange={(e) => set('source', e.target.value)} />
            )}
            {sourceControl === 'project-picker' && form.source !== '' && (
              <div style={{ marginTop: 'var(--space-1)', fontSize: 'var(--fs-11)', color: 'var(--c-muted, #767b6e)' }}>
                Venue address + PIC contact auto-fill from the project on create.
              </div>
            )}
          </label>

          {/* The lorry being serviced. LORRY_SERVICE only, and the one field on
              this drawer that is genuinely REQUIRED: without it the job knows
              which workshop it is going to but not which vehicle, and nothing
              comes off the road when it is scheduled. */}
          {form.jobType === 'LORRY_SERVICE' && (
            <label style={fieldRow}>
              <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>
                Lorry going in <span style={{ textTransform: 'none', color: 'var(--c-burnt)' }}>— required</span>
              </div>
              {lorriesQ.isError ? (
                <input className={styles.searchInput} style={inputStyle}
                  placeholder="lorry id — the fleet list could not be loaded"
                  value={form.lorryId} onChange={(e) => set('lorryId', e.target.value)} />
              ) : (
                <SearchableSelect
                  value={form.lorryId}
                  onChange={(id) => set('lorryId', id)}
                  options={lorryOptions}
                  placeholder={lorriesQ.isLoading ? 'Loading lorries…' : 'Search by plate…'}
                  className={styles.searchInput}
                  ariaLabel="Lorry going in"
                />
              )}
              <div style={{ marginTop: 'var(--space-1)', fontSize: 'var(--fs-11)', color: 'var(--c-muted, #767b6e)' }}>
                Scheduling this job takes that lorry off the road for the day —
                it stops being offered on the board and counts as a repair day.
              </div>
            </label>
          )}

          {/* Where the goods are going. TRANSFER only, and required for the same
              reason the lorry is on a service job: a move with no destination
              has no address, so the driver has nowhere to be sent. Picking a
              transfer document fills this in; an ad-hoc move sets it directly. */}
          {form.jobType === 'TRANSFER' && (
            <label style={fieldRow}>
              <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>
                Destination warehouse <span style={{ textTransform: 'none', color: 'var(--c-burnt)' }}>— required</span>
              </div>
              {warehousesQ.isError ? (
                <input className={styles.searchInput} style={inputStyle}
                  placeholder="warehouse id — the warehouse list could not be loaded"
                  value={form.warehouseId} onChange={(e) => set('warehouseId', e.target.value)} />
              ) : (
                <SearchableSelect
                  value={form.warehouseId}
                  onChange={pickWarehouse}
                  options={warehouseOptions}
                  placeholder={warehousesQ.isLoading ? 'Loading warehouses…' : 'Search by code or name…'}
                  className={styles.searchInput}
                  ariaLabel="Destination warehouse"
                />
              )}
              <div style={{ marginTop: 'var(--space-1)', fontSize: 'var(--fs-11)', color: 'var(--c-muted, #767b6e)' }}>
                The warehouse master carries no contact — fill one in below if the
                driver needs someone to call on arrival.
              </div>
            </label>
          )}

          <div className={styles.eyebrow} style={{ margin: 'var(--space-2) 0', color: 'var(--c-burnt)' }}>
            Party — auto-fills from the {src.label.toLowerCase()}; edit any field to override
          </div>
          <label style={fieldRow}>
            <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>{src.kind === 'supplier' ? 'Supplier' : src.kind === 'project' ? 'Venue' : src.kind === 'workshop' ? 'Workshop' : src.kind === 'transfer' ? 'Warehouse' : 'Customer'} name</div>
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
            <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>Address line 1</div>
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
              <input type="date" className={styles.searchInput} style={inputStyle} value={form.requestedDate} onChange={(e) => set('requestedDate', e.target.value)} />
            </label>
          </div>
          <label style={fieldRow}>
            <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>Remark</div>
            <input className={styles.searchInput} style={inputStyle} value={form.remark} onChange={(e) => set('remark', e.target.value)} />
          </label>
          </>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)', padding: 'var(--space-4)' }}>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          {/* Every entry has one thing it cannot do without — a lorry for a
              service, a destination for a transfer, a document and a date for
              anything being scheduled. The button says no rather than letting
              the server reject it, or worse, accept a job nobody can act on.
              The LABEL changes too: "Create" would be a lie in schedule mode,
              where nothing is created. */}
          <Button variant="primary" size="md" onClick={submit}
            disabled={create.isPending || schedule.isPending
              || (isSchedule && (!docId || !jobDate))
              || (!isSchedule && form.jobType === 'LORRY_SERVICE' && !form.lorryId.trim())
              || (!isSchedule && form.jobType === 'TRANSFER' && !form.warehouseId.trim())}>
            {isSchedule
              ? (schedule.isPending ? 'Scheduling…' : 'Schedule job')
              : (create.isPending ? 'Creating…' : 'Create DP Order')}
          </Button>
        </div>
      </div>
    </div>
  );
};
