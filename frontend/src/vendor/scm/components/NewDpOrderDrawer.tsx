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

import { Fragment, useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@2990s/design-system';
import {
  useCreateDpOrder,
  useScheduleDelivery,
  DP_ENTRY_MENU,
  salesAmountSenOf,
  type DpOrderCreate,
} from '../lib/delivery-planning-queries';
import { useMfgSalesOrdersPaged } from '../lib/sales-order-queries';
import { useSuppliers, useSupplierDetail } from '../lib/suppliers-queries';
import { useLorries } from '../lib/lorries-queries';
import { useStockTransfers } from '../lib/stock-queries';
import { useWarehouses } from '../lib/inventory-queries';
import { useThreePLCompanies } from '../lib/threepl-companies-queries';
import { useSavedLocations } from '../lib/saved-locations-queries';
import { SearchableSelect, type SearchableSelectOption } from './SearchableSelect';
import { useNotify } from './NotifyDialog';
import { writeFailedAs } from '../lib/mutation-error';
import { projectRowParts } from '../lib/project-picker-row';
import { splitHighlight } from '../lib/split-highlight';
import { api } from '../../../api/client';
import styles from '../../../pages/scm-v2/Suppliers.module.css';
import { DateField } from "./DateField";
import { addressLineTwoView, hasLegacyLines } from '../../shared/address-two-lines';
import { PostcodeCascadeField } from './PostcodeCascadeField';
import { useLocalities, resolvePostcode } from '../lib/localities-queries';
import { knownPostcodeInText, DP_POSTCODE_REQUIRED_JOB_TYPES } from '../lib/postcode-in-address';

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const DP_POSTCODE_CLASSES = { field: styles.stackField, label: `${styles.eyebrow} ${styles.stackLabel}`, select: styles.searchInput };


function sourceMeta(jobType: DpOrderCreate['jobType']): { label: string; hint: string; kind: 'so' | 'supplier' | 'project' | 'assr' | 'workshop' | 'transfer' | 'none' } {
  switch (jobType) {
    case 'SUPPLIER_PICKUP': return { label: 'Supplier', hint: 'supplier id — party auto-fills from the supplier master', kind: 'supplier' };
    case 'SETUP':
    case 'DISMANTLE': return { label: 'Project / venue', hint: 'PMS project id — venue + PIC auto-fill', kind: 'project' };
    case 'SERVICE': return { label: 'Service case', hint: 'service case id — customer auto-fills', kind: 'assr' };
    case 'LORRY_SERVICE': return { label: 'Workshop', hint: 'workshop id — name, contact + address auto-fill from the workshop master', kind: 'workshop' };
    case 'TRANSFER': return { label: 'Stock transfer', hint: 'transfer id — the destination warehouse auto-fills from the document', kind: 'transfer' };
    case 'DELIVERY': return { label: 'Customer', hint: '', kind: 'none' };
    default: return { label: 'Sales order', hint: 'SO No. — customer auto-fills (optional)', kind: 'so' };
  }
}

type ProjectPickRow = {
  id: number;
  code: string | null;
  name: string | null;
  venue: string | null;
  organizer: string | null;
  state: string | null;
  brand: string | null;
  start_date: string | null;
  end_date: string | null;
};

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

/* Which master a TRANSFER's From / To is picked from (owner 2026-11-02): our own
   warehouse, an outsourced 3PL carrier, or a saved location (方案2). */
type DestKind = 'warehouse' | 'threepl' | 'saved';

export const NewDpOrderDrawer = ({ onClose }: { onClose: () => void }) => {
  const create = useCreateDpOrder();
  const schedule = useScheduleDelivery();
  const notify = useNotify();

  const [entryKey, setEntryKey] = useState<string>(DP_ENTRY_MENU[0].key);
  const entry = DP_ENTRY_MENU.find((e) => e.key === entryKey) ?? DP_ENTRY_MENU[0];
  const isSchedule = entry.mode === 'schedule';

  const [docId, setDocId] = useState('');
  const [jobDate, setJobDate] = useState('');

  const [form, setForm] = useState({
    jobType: 'SETUP' as DpOrderCreate['jobType'],
    source: '',
    lorryId: '',
    /* TRANSFER only — the DESTINATION. Like the lorry above it is a second
       reference rather than the source: the transfer document (if any) says what
       is being moved, this says where the fleet is driving to, and it is the party
       the address comes from. The destination is one of our own warehouses, an
       outsourced 3PL (owner 2026-11-02), or a saved location (方案2) — destKind
       switches which, and only the matching id is sent. */
    destKind: 'warehouse' as DestKind,
    warehouseId: '',
    threeplCompanyId: '',
    savedLocationId: '',
    partyName: '', contactName: '', contactPhone: '',
    address1: '', address2: '', address3: '', address4: '',
    city: '', postcode: '', state: '',
    /* TRANSFER ORIGIN ("from", owner 2026-11-02 方案1) — the pickup point, picked
       the same way as the destination (our warehouse / 3PL / saved location), its
       address editable. Optional: a plain depot-loaded transfer leaves it blank. */
    fromKind: 'warehouse' as DestKind,
    fromWarehouseId: '',
    fromThreeplCompanyId: '',
    fromSavedLocationId: '',
    fromName: '',
    fromAddress1: '', fromAddress2: '',
    fromCity: '', fromPostcode: '', fromState: '',
    requestedDate: '', remark: '', salesAmount: '',
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((s) => ({ ...s, [k]: v }));
  /* Address line 2 shows what lines 3 / 4 still hold (two lines on every
     address form, owner 2026-11-18); editing it moves all of it to line 2. */
  const setLineTwo = (v: string) =>
    setForm((f) => (hasLegacyLines(f.address3, f.address4) ? { ...f, address2: v, address3: '', address4: '' } : { ...f, address2: v }));

  const src = sourceMeta(form.jobType);

  const locRows = useLocalities().data;
  useEffect(() => {
    if (!locRows?.length) return;
    setForm((s) => {
      let next = s;
      const fill = (keys: { pc: 'postcode' | 'fromPostcode'; st: 'state' | 'fromState'; ci: 'city' | 'fromCity' }, lines: string[]) => {
        if (next[keys.pc].trim()) return;
        const pc = knownPostcodeInText(locRows, [...lines, next[keys.ci]]);
        if (!pc) return;
        const loc = resolvePostcode(locRows, pc);
        next = {
          ...next,
          [keys.pc]: pc,
          [keys.st]: next[keys.st].trim() || loc?.state || '',
          [keys.ci]: next[keys.ci].trim() || loc?.city || '',
        };
      };
      fill({ pc: 'postcode', st: 'state', ci: 'city' }, [s.address1, s.address2, s.address3, s.address4]);
      fill({ pc: 'fromPostcode', st: 'fromState', ci: 'fromCity' }, [s.fromAddress1, s.fromAddress2]);
      return next;
    });
  }, [locRows, form.address1, form.address2, form.address3, form.address4, form.fromAddress1, form.fromAddress2]);

  const postcodeRequired = !isSchedule && DP_POSTCODE_REQUIRED_JOB_TYPES.has(form.jobType);
  const postcodeMissing = postcodeRequired && !form.postcode.trim();

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
  /* Project / venue dropdown rows (owner spec 2026-10-29): the date first, then
     [BRAND], the title, and the state — newest event first. Parts are kept in a
     Map so the custom row renderer looks them up by id without rebuilding, while
     the plain label still fills the closed input and `search` keeps the hidden
     code findable. */
  const projectParts = useMemo(() => {
    const rows = (projectsQ.data?.data ?? []).map((p) => ({ id: String(p.id), parts: projectRowParts(p) }));
    rows.sort((a, b) => b.parts.sortKey.localeCompare(a.parts.sortKey));
    return rows;
  }, [projectsQ.data]);
  const projectPartsById = useMemo(
    () => new Map(projectParts.map((r) => [r.id, r.parts])),
    [projectParts],
  );
  const dateColCh = useMemo(
    () => projectParts.reduce((w, r) => Math.max(w, r.parts.date.length), 10),
    [projectParts],
  );
  const projectOptions = useMemo(
    () => projectParts.map((r) => ({ value: r.id, label: r.parts.plain, search: r.parts.search })),
    [projectParts],
  );
  const renderProjectOption = (opt: SearchableSelectOption, query: string): ReactNode => {
    const parts = projectPartsById.get(opt.value);
    if (!parts) return opt.label;
    const hl = (t: string) =>
      splitHighlight(t, query).map((seg, i) =>
        seg.hit
          ? <mark key={i} style={{ background: 'rgba(242, 201, 76, 0.45)', color: 'inherit', borderRadius: 2, padding: '0 1px' }}>{seg.text}</mark>
          : <Fragment key={i}>{seg.text}</Fragment>,
      );
    return (
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
        <span style={{
          flex: `0 0 ${dateColCh}ch`,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontVariantNumeric: 'tabular-nums',
        }}>{parts.date}</span>
        {parts.brand && <span style={{ flexShrink: 0, fontWeight: 600 }}>[{hl(parts.brand)}]</span>}
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {hl(parts.title)}
          {parts.state && <span style={{ color: 'var(--c-muted, var(--hz-c-ink-muted))' }}> · {hl(parts.state)}</span>}
        </span>
      </span>
    );
  };

  const workshopsQ = useQuery<{ workshops: WorkshopPickRow[] }>({
    queryKey: ['dp-workshop-pick'],
    queryFn: () => api.get<{ workshops: WorkshopPickRow[] }>('/api/fleet-maintenance/workshops'),
    enabled: src.kind === 'workshop',
    staleTime: 60_000,
  });
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

  const transfersQ = useStockTransfers({ status: 'POSTED' });
  const warehousesQ = useWarehouses();
  const threeplQ = useThreePLCompanies();
  /* Saved locations — the kept from/to address book (owner 2026-11-02 方案2). Like
     the warehouse / 3PL lists it is fetched unconditionally (small, cached) and
     only shown when a From / To toggle is on "Saved location". */
  const savedLocationsQ = useSavedLocations();

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
  const threeplOptions = useMemo(
    () => (threeplQ.data ?? [])
      .filter((t) => t.isActive)
      .map((t) => ({ value: t.id, label: `${t.name}${t.code ? ` (${t.code})` : ''}` })),
    [threeplQ.data],
  );
  const savedLocationOptions = useMemo(
    () => (savedLocationsQ.data ?? [])
      .filter((l) => l.isActive)
      .map((l) => ({ value: l.id, label: `${l.name}${l.city ? ` — ${l.city}` : ''}` })),
    [savedLocationsQ.data],
  );

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

  const pickThreepl = (id: string) => {
    const t = (threeplQ.data ?? []).find((r) => r.id === id);
    setForm((s) => ({
      ...s,
      threeplCompanyId: id,
      partyName: (t?.name ?? t?.code ?? '').trim(),
      contactName: (t?.contactName ?? '').trim(),
      contactPhone: (t?.contactPhone ?? t?.officePhone ?? '').trim(),
      address1: (t?.address ?? '').trim(),
      address2: '', address3: '', address4: '',
      city: '', postcode: '', state: '',
    }));
  };

  /* Saved-location destination prefill (方案2) — a kept point with a full
     structured address and contact, filled straight through; stays editable. */
  const pickSavedLocation = (id: string) => {
    const l = (savedLocationsQ.data ?? []).find((r) => r.id === id);
    setForm((s) => ({
      ...s,
      savedLocationId: id,
      partyName: (l?.name ?? '').trim(),
      contactName: (l?.contactName ?? '').trim(),
      contactPhone: (l?.contactPhone ?? '').trim(),
      address1: (l?.address1 ?? '').trim(),
      address2: (l?.address2 ?? '').trim(),
      address3: '', address4: '',
      city: (l?.city ?? '').trim(),
      postcode: (l?.postcode ?? '').trim(),
      state: (l?.state ?? '').trim(),
    }));
  };

  /* ORIGIN ("from") prefills — mirror the destination pickers, writing the from_*
     fields instead. Same masters (our warehouse / 3PL), same field precedence; the
     address stays editable. (owner 2026-11-02 方案1) */
  const pickFromWarehouse = (id: string) => {
    const w = (warehousesQ.data ?? []).find((r) => r.id === id);
    setForm((s) => ({
      ...s,
      fromWarehouseId: id,
      fromName: (w?.name ?? w?.code ?? '').trim(),
      fromAddress1: (w?.location ?? '').trim(),
      fromAddress2: '',
      fromCity: (w?.city ?? '').trim(),
      fromPostcode: (w?.postcode ?? '').trim(),
      fromState: (w?.state ?? '').trim(),
    }));
  };
  const pickFromThreepl = (id: string) => {
    const t = (threeplQ.data ?? []).find((r) => r.id === id);
    setForm((s) => ({
      ...s,
      fromThreeplCompanyId: id,
      fromName: (t?.name ?? t?.code ?? '').trim(),
      fromAddress1: (t?.address ?? '').trim(),
      fromAddress2: '', fromCity: '', fromPostcode: '', fromState: '',
    }));
  };
  const pickFromSavedLocation = (id: string) => {
    const l = (savedLocationsQ.data ?? []).find((r) => r.id === id);
    setForm((s) => ({
      ...s,
      fromSavedLocationId: id,
      fromName: (l?.name ?? '').trim(),
      fromAddress1: (l?.address1 ?? '').trim(),
      fromAddress2: (l?.address2 ?? '').trim(),
      fromCity: (l?.city ?? '').trim(),
      fromPostcode: (l?.postcode ?? '').trim(),
      fromState: (l?.state ?? '').trim(),
    }));
  };

  const pickTransfer = (id: string) => {
    const t = (transfersQ.data ?? []).find((r) => r.id === id);
    const dest = t?.to_warehouse_id ?? '';
    setForm((s) => (dest ? applyWarehouse(dest, { ...s, source: id }) : { ...s, source: id }));
  };

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
    if (form.jobType === 'TRANSFER') {
      if (form.destKind === 'saved') {
        if (form.savedLocationId) body.savedLocationId = form.savedLocationId;
      } else if (form.destKind === 'threepl') {
        if (form.threeplCompanyId) body.threeplCompanyId = form.threeplCompanyId;
      } else if (form.warehouseId) {
        body.warehouseId = form.warehouseId;
      }
      if (form.fromKind === 'saved') {
        if (form.fromSavedLocationId) body.fromSavedLocationId = form.fromSavedLocationId;
      } else if (form.fromKind === 'threepl') {
        if (form.fromThreeplCompanyId) body.fromThreeplCompanyId = form.fromThreeplCompanyId;
      } else if (form.fromWarehouseId) {
        body.fromWarehouseId = form.fromWarehouseId;
      }
      const fromOv: Record<string, string | null> = {};
      const fromMap: Array<[keyof typeof form, string]> = [
        ['fromName', 'party_name'],
        ['fromAddress1', 'address1'], ['fromAddress2', 'address2'],
        ['fromCity', 'city'], ['fromPostcode', 'postcode'], ['fromState', 'state'],
      ];
      for (const [fk, col] of fromMap) {
        const v = String(form[fk]).trim();
        if (v) fromOv[col] = v;
      }
      if (Object.keys(fromOv).length) body.fromOverrides = fromOv;
    }
    if (form.jobType === 'LORRY_SERVICE' && form.lorryId) body.lorryId = form.lorryId;
    if (form.requestedDate) body.requestedDate = form.requestedDate;
    if (form.remark.trim()) body.remark = form.remark.trim();
    if (src.kind === 'none') {
      const sen = salesAmountSenOf(form.salesAmount);
      if (sen === undefined) {
        void notify({ title: 'Sales amount', body: 'Enter the sales amount in RM, e.g. 3500 or 3,500.00.', tone: 'error' });
        return;
      }
      body.salesAmountSen = sen;
    }

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
      onError: writeFailedAs('Create failed'),
    });
  };

  const fieldRow: CSSProperties = { display: 'block', marginBottom: 'var(--space-3)' };
  const inputStyle: CSSProperties = { width: '100%' };
  const row2: CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 'var(--space-3)' };

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
                const key = e.target.value;
                const next = DP_ENTRY_MENU.find((x) => x.key === key) ?? DP_ENTRY_MENU[0];
                setEntryKey(key);
                setDocId('');
                setJobDate('');
                setForm((s) => ({
                  ...s,
                  jobType: next.mode === 'create' ? next.jobType : s.jobType,
                  source: '',
                  lorryId: '',
                  destKind: 'warehouse',
                  warehouseId: '',
                  threeplCompanyId: '',
                  savedLocationId: '',
                  fromKind: 'warehouse',
                  fromWarehouseId: '',
                  fromThreeplCompanyId: '',
                  fromSavedLocationId: '',
                  fromName: '',
                  fromAddress1: '', fromAddress2: '',
                  fromCity: '', fromPostcode: '', fromState: '',
                  partyName: '', contactName: '', contactPhone: '',
                  address1: '', address2: '', address3: '', address4: '',
                  city: '', postcode: '', state: '',
                }));
                setPrefilledFor(null);
              }}>
              {DP_ENTRY_MENU.map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}
            </select>
          </label>

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
                  <div style={{ marginTop: 'var(--space-1)', fontSize: 'var(--fs-11)', color: 'var(--c-muted, var(--hz-c-ink-muted))' }}>
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
                <DateField fullWidth className={styles.searchInput} style={inputStyle} value={jobDate} onChange={(iso) => setJobDate(iso)}/>
              </label>
            </>
          ) : (
          <>

          {src.kind === 'none' ? (
            <div style={{ ...fieldRow, fontSize: 'var(--fs-12)', color: 'var(--c-muted, var(--hz-c-ink-muted))' }}>
              A delivery with no sales order: type the customer, address and postcode below, the sales amount, and what is going in Remark. It goes on the board, Last Mile and Trip Pay (commission on the sales amount); no stock moves and no DO is made.
              <label style={{ display: 'block', marginTop: 'var(--space-2)' }}>
                <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>Sales amount (RM)</div>
                <input className={styles.searchInput} style={inputStyle} inputMode="decimal" placeholder="e.g. 3500.00"
                  aria-label="Sales amount (RM)" value={form.salesAmount} onChange={(e) => set('salesAmount', e.target.value)} />
              </label>
            </div>
          ) : (
          <label style={fieldRow}>
            <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>{src.label} <span style={{ textTransform: 'none', color: 'var(--c-muted, var(--hz-c-ink-muted))' }}>— optional</span></div>
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
                renderOption={renderProjectOption}
                placeholder={projectsQ.isLoading ? 'Loading projects…' : 'Search by date, brand, venue, state or code…'}
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
              <div style={{ marginTop: 'var(--space-1)', fontSize: 'var(--fs-11)', color: 'var(--c-muted, var(--hz-c-ink-muted))' }}>
                Venue address + PIC contact auto-fill from the project on create.
              </div>
            )}
          </label>
          )}

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
              <div style={{ marginTop: 'var(--space-1)', fontSize: 'var(--fs-11)', color: 'var(--c-muted, var(--hz-c-ink-muted))' }}>
                Scheduling this job takes that lorry off the road for the day —
                it stops being offered on the board and counts as a repair day.
              </div>
            </label>
          )}

          {/* ORIGIN ("from") — TRANSFER only, OPTIONAL (owner 2026-11-02 方案1). A
              partner delivery is "from A to B"; this is A, the pickup point, picked
              the same way as the destination (our warehouse / outsourced 3PL). Its
              OWN address fields live in this box — the shared Party fields lower
              down are the DESTINATION. Leave blank for a plain depot-loaded move. */}
          {form.jobType === 'TRANSFER' && (
            <div style={{ ...fieldRow, padding: 'var(--space-3)', border: '1px solid var(--border, rgba(34,31,32,0.12))', borderRadius: '6px' }}>
              <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>
                From (origin) <span style={{ textTransform: 'none', color: 'var(--c-muted, var(--hz-c-ink-muted))' }}>— optional, for a partner / point-to-point move</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', marginBottom: 'var(--space-2)', fontSize: 'var(--fs-12)' }}>
                <label style={{ display: 'inline-flex', gap: 'var(--space-1)', alignItems: 'center' }}>
                  <input type="radio" name="dp-from-kind" checked={form.fromKind === 'warehouse'}
                    onChange={() => setForm((s) => ({ ...s, fromKind: 'warehouse', fromThreeplCompanyId: '', fromSavedLocationId: '' }))} />
                  Our warehouse
                </label>
                <label style={{ display: 'inline-flex', gap: 'var(--space-1)', alignItems: 'center' }}>
                  <input type="radio" name="dp-from-kind" checked={form.fromKind === 'threepl'}
                    onChange={() => setForm((s) => ({ ...s, fromKind: 'threepl', fromWarehouseId: '', fromSavedLocationId: '' }))} />
                  Outsourced (3PL)
                </label>
                <label style={{ display: 'inline-flex', gap: 'var(--space-1)', alignItems: 'center' }}>
                  <input type="radio" name="dp-from-kind" checked={form.fromKind === 'saved'}
                    onChange={() => setForm((s) => ({ ...s, fromKind: 'saved', fromWarehouseId: '', fromThreeplCompanyId: '' }))} />
                  Saved location
                </label>
              </div>
              {form.fromKind === 'warehouse' ? (
                warehousesQ.isError ? (
                  <input className={styles.searchInput} style={inputStyle}
                    placeholder="warehouse id — the warehouse list could not be loaded"
                    value={form.fromWarehouseId} onChange={(e) => set('fromWarehouseId', e.target.value)} />
                ) : (
                  <SearchableSelect
                    value={form.fromWarehouseId}
                    onChange={pickFromWarehouse}
                    options={warehouseOptions}
                    placeholder={warehousesQ.isLoading ? 'Loading warehouses…' : 'Search by code or name…'}
                    className={styles.searchInput}
                    ariaLabel="Origin warehouse"
                  />
                )
              ) : form.fromKind === 'threepl' ? (
                threeplQ.isError ? (
                  <input className={styles.searchInput} style={inputStyle}
                    placeholder="3PL company id — the carrier list could not be loaded"
                    value={form.fromThreeplCompanyId} onChange={(e) => set('fromThreeplCompanyId', e.target.value)} />
                ) : (
                  <SearchableSelect
                    value={form.fromThreeplCompanyId}
                    onChange={pickFromThreepl}
                    options={threeplOptions}
                    placeholder={threeplQ.isLoading ? 'Loading 3PL companies…' : 'Search by name or code…'}
                    className={styles.searchInput}
                    ariaLabel="Origin 3PL"
                  />
                )
              ) : (
                savedLocationsQ.isError ? (
                  <input className={styles.searchInput} style={inputStyle}
                    placeholder="saved location id — the list could not be loaded"
                    value={form.fromSavedLocationId} onChange={(e) => set('fromSavedLocationId', e.target.value)} />
                ) : (
                  <SearchableSelect
                    value={form.fromSavedLocationId}
                    onChange={pickFromSavedLocation}
                    options={savedLocationOptions}
                    placeholder={savedLocationsQ.isLoading ? 'Loading saved locations…' : 'Search saved locations…'}
                    className={styles.searchInput}
                    ariaLabel="Origin saved location"
                  />
                )
              )}
              <label style={{ ...fieldRow, marginTop: 'var(--space-2)' }}>
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
                <div style={fieldRow}>
                  <PostcodeCascadeField
                    value={form.fromPostcode} state={form.fromState} city={form.fromCity}
                    onPick={(t) => setForm((s) => ({ ...s, fromPostcode: t.postcode, fromState: t.state, fromCity: t.city }))}
                    label="From postcode"
                    classes={DP_POSTCODE_CLASSES}
                  />
                </div>
                <label style={fieldRow}>
                  <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>From city</div>
                  <input className={styles.searchInput} style={inputStyle} value={form.fromCity} onChange={(e) => set('fromCity', e.target.value)} />
                </label>
              </div>
              <label style={{ ...fieldRow, marginBottom: 0 }}>
                <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>From state</div>
                <input className={styles.searchInput} style={inputStyle} value={form.fromState} onChange={(e) => set('fromState', e.target.value)} />
              </label>
            </div>
          )}

          {form.jobType === 'TRANSFER' && (
            <label style={fieldRow}>
              <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>
                Destination <span style={{ textTransform: 'none', color: 'var(--c-burnt)' }}>— required</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', marginBottom: 'var(--space-2)', fontSize: 'var(--fs-12)' }}>
                <label style={{ display: 'inline-flex', gap: 'var(--space-1)', alignItems: 'center' }}>
                  <input type="radio" name="dp-dest-kind" checked={form.destKind === 'warehouse'}
                    onChange={() => setForm((s) => ({ ...s, destKind: 'warehouse', threeplCompanyId: '', savedLocationId: '' }))} />
                  Our warehouse
                </label>
                <label style={{ display: 'inline-flex', gap: 'var(--space-1)', alignItems: 'center' }}>
                  <input type="radio" name="dp-dest-kind" checked={form.destKind === 'threepl'}
                    onChange={() => setForm((s) => ({ ...s, destKind: 'threepl', warehouseId: '', savedLocationId: '' }))} />
                  Outsourced (3PL)
                </label>
                <label style={{ display: 'inline-flex', gap: 'var(--space-1)', alignItems: 'center' }}>
                  <input type="radio" name="dp-dest-kind" checked={form.destKind === 'saved'}
                    onChange={() => setForm((s) => ({ ...s, destKind: 'saved', warehouseId: '', threeplCompanyId: '' }))} />
                  Saved location
                </label>
              </div>
              {form.destKind === 'warehouse' ? (
                warehousesQ.isError ? (
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
                )
              ) : form.destKind === 'threepl' ? (
                threeplQ.isError ? (
                  <input className={styles.searchInput} style={inputStyle}
                    placeholder="3PL company id — the carrier list could not be loaded"
                    value={form.threeplCompanyId} onChange={(e) => set('threeplCompanyId', e.target.value)} />
                ) : (
                  <SearchableSelect
                    value={form.threeplCompanyId}
                    onChange={pickThreepl}
                    options={threeplOptions}
                    placeholder={threeplQ.isLoading ? 'Loading 3PL companies…' : 'Search by name or code…'}
                    className={styles.searchInput}
                    ariaLabel="Outsourced 3PL warehouse"
                  />
                )
              ) : (
                savedLocationsQ.isError ? (
                  <input className={styles.searchInput} style={inputStyle}
                    placeholder="saved location id — the list could not be loaded"
                    value={form.savedLocationId} onChange={(e) => set('savedLocationId', e.target.value)} />
                ) : (
                  <SearchableSelect
                    value={form.savedLocationId}
                    onChange={pickSavedLocation}
                    options={savedLocationOptions}
                    placeholder={savedLocationsQ.isLoading ? 'Loading saved locations…' : 'Search saved locations…'}
                    className={styles.searchInput}
                    ariaLabel="Destination saved location"
                  />
                )
              )}
              <div style={{ marginTop: 'var(--space-1)', fontSize: 'var(--fs-11)', color: 'var(--c-muted, var(--hz-c-ink-muted))' }}>
                {form.destKind === 'warehouse'
                  ? 'The warehouse master carries no contact — fill one in below if the driver needs someone to call on arrival.'
                  : form.destKind === 'threepl'
                    ? "The carrier's registered address auto-fills below — edit it if the drop-off differs."
                    : 'The saved location’s address auto-fills below — edit it if this drop-off differs. Maintain the list on Saved Locations.'}
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
            <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>
              Address line 1 <span style={{ textTransform: 'none', color: 'var(--c-burnt)' }}>— required{form.source.trim() ? ', or auto-filled from the source' : ''}</span>
            </div>
            <input className={styles.searchInput} style={inputStyle} value={form.address1} onChange={(e) => set('address1', e.target.value)} />
          </label>
          <label style={fieldRow}>
            <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>Address line 2</div>
            <input className={styles.searchInput} style={inputStyle} value={addressLineTwoView(form.address2, form.address3, form.address4, form)} onChange={(e) => setLineTwo(e.target.value)} />
          </label>
          <div style={row2}>
            <div style={fieldRow}>
              <PostcodeCascadeField
                value={form.postcode} state={form.state} city={form.city}
                onPick={(t) => setForm((s) => ({ ...s, postcode: t.postcode, state: t.state, city: t.city }))}
                label={<>Postcode{postcodeRequired && <span style={{ textTransform: 'none', color: 'var(--c-burnt)' }}> — required</span>}</>}
                classes={DP_POSTCODE_CLASSES}
              />
              {postcodeMissing && (
                <div role="alert" style={{ marginTop: 'var(--space-1)', fontSize: 'var(--fs-12)', color: 'var(--c-burnt)' }}>
                  {form.source.trim()
                    ? 'Pick the postcode, unless the source carries one.'
                    : 'Pick the postcode, or write it in the address.'}
                </div>
              )}
            </div>
            <label style={fieldRow}>
              <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>City</div>
              <input className={styles.searchInput} style={inputStyle} value={form.city} onChange={(e) => set('city', e.target.value)} />
            </label>
          </div>
          <div style={row2}>
            <label style={fieldRow}>
              <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>State</div>
              <input className={styles.searchInput} style={inputStyle} value={form.state} onChange={(e) => set('state', e.target.value)} />
            </label>
            <label style={fieldRow}>
              <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>Requested date</div>
              <DateField
                fullWidth
                className={styles.searchInput}
                style={inputStyle}
                value={form.requestedDate}
                onChange={(iso) => set('requestedDate', iso)}
              />
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
          <Button variant="primary" size="md" onClick={submit}
            disabled={create.isPending || schedule.isPending
              || (isSchedule && (!docId || !jobDate))
              || (!isSchedule && form.jobType === 'LORRY_SERVICE' && !form.lorryId.trim())
              || (!isSchedule && form.jobType === 'TRANSFER'
                && !(form.destKind === 'saved' ? form.savedLocationId.trim()
                  : form.destKind === 'threepl' ? form.threeplCompanyId.trim()
                  : form.warehouseId.trim()))
              || (postcodeMissing && !form.source.trim())
              || (!isSchedule && !form.source.trim()
                && ![form.address1, form.address2, form.address3, form.address4].some((v) => v.trim()))}>
            {isSchedule
              ? (schedule.isPending ? 'Scheduling…' : 'Schedule job')
              : (create.isPending ? 'Creating…' : 'Create DP Order')}
          </Button>
        </div>
      </div>
    </div>
  );
};
