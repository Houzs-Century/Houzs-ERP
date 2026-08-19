// ----------------------------------------------------------------------------
// Suppliers — master + supplier_material_bindings management.
//
// Two-code mapping (the HOOKKA pattern):
//   OUR `item_code` (mfg_products.code / fabrics.code)
//     ↔ THEIR `supplier_sku` (whatever the supplier calls it)
//
// UI: design-system reskin (2026-07-16) — full-bleed on the app background,
// shared <PageHeader>, local <Button>, Ink & Petrol Tailwind tokens for the
// chips / search / banner / pagination. The right-side drawer + modal still
// use the shared Suppliers.module.css content primitives (that module is
// imported by ~20 scm-v2 pages, so its classes are deliberately left intact).
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Search, Plus, X } from 'lucide-react';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/Layout';
import { FilterPills } from '../../components/FilterPills';
import { cn } from '../../lib/utils';
import { formatPhone } from '@2990s/shared/phone';
import { PhoneInput } from '../../vendor/scm/components/PhoneInput';
import { StatePicker } from '../../vendor/scm/components/StatePicker';
import {
  useSuppliersPaged,
  useCreateSupplier,
  useUpdateSupplier,
  type SupplierRow,
  type SupplierStatus,
} from '../../vendor/scm/lib/suppliers-queries';
import {
  displaySupplierCategories,
} from '../../vendor/scm/lib/supplier-categories';
import {
  SupplyCategoryPicker,
  useSupplierCategoryPool,
} from '../../vendor/scm/components/SupplyCategoryPicker';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { SearchProgress } from '../../components/SearchProgress';
import { ListPager } from '../../components/ListPager';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { useDebouncedSearchTerm, useSearchResultTransition } from '../../hooks/useServerSearch';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import styles from './Suppliers.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const STATUS_CHIPS: { value: 'all' | SupplierStatus; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
  { value: 'BLOCKED', label: 'Blocked' },
];

// Supply Category filter (owner spec 2026-06-12, replacing PR #208's fixed
// enum). Chips render from the maintained Supply Category pool
// (MaintenanceConfig.supplierCategories, fallback Sofa/Bedframe/Mattress/
// Accessory/Service) + a synthetic "Mixed / Other" chip. 'all' and the
// mixed sentinel can't collide with pool values (pool entries are trimmed
// non-empty user strings; these are namespaced).
const FILTER_ALL = '__all__';
const FILTER_MIXED = '__mixed__';

const STATUS_CLASS: Record<SupplierStatus, string> = {
  ACTIVE: styles.statusActive ?? '',
  INACTIVE: styles.statusInactive ?? '',
  BLOCKED: styles.statusBlocked ?? '',
};

export const Suppliers = () => {
  const navigate = useNavigate();
  const [status, setStatus] = useState<'all' | SupplierStatus>('all');
  // Supply Category filter — now applied SERVER-SIDE (the /suppliers paged
  // endpoint takes ?category=/?pool=) so it stays correct across pages.
  const [category, setCategory] = useState<string>(FILTER_ALL);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);

  const [pageSize, setPageSize] = useLocalStorage<number>('scm:perpage:suppliers', 50);
  // Debounce the search box so each keystroke doesn't fire a server round-trip.
  const { requestTerm: debouncedSearch } = useDebouncedSearchTerm(search);

  // Maintained Supply Category pool (fallback: the default five). Declared up
  // here because it feeds both the filter chips AND the server query (the
  // "Mixed / Other" chip needs the pool to be computed exactly server-side).
  const pool = useSupplierCategoryPool();

  // Reset to the first page whenever a server-query input changes — otherwise a
  // filter change could leave the operator stranded on an out-of-range page.
  useEffect(() => {
    setPage(0);
  }, [status, category, debouncedSearch]);

  /* Batch edit (Commander 2026-06-19 — HOOKKA parity). Selection lives in the
     parent so it survives DataGrid re-renders and drives the batch modal. */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchOpen, setBatchOpen] = useState(false);

  const toggle = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const toggleAll = (keys: string[], allSelected: boolean) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) for (const k of keys) next.delete(k);
      else for (const k of keys) next.add(k);
      return next;
    });

  /* Clear the selection whenever the visible row set shifts (filter change OR
     page change) — a lingering selection would batch-edit rows the operator can
     no longer see. Selection does not survive paging (server-side, per page). */
  useEffect(() => {
    setSelectedIds(new Set());
  }, [status, category, page, debouncedSearch]);

  const { data, isLoading, isFetching, isPlaceholderData, error } = useSuppliersPaged({
    page,
    pageSize: pageSize,
    status: status === 'all' ? undefined : status,
    q: debouncedSearch.trim() || undefined,
    // '__all__' → omit (no filter); '__mixed__' → send + pool so the server
    // reproduces the "Mixed / Other" set exactly.
    category: category === FILTER_ALL ? undefined : category,
    pool: category === FILTER_MIXED ? pool : undefined,
  });
  const searchTransition = useSearchResultTransition({
    inputTerm: search,
    requestTerm: debouncedSearch,
    isFetching,
    isPlaceholderData,
    hasData: data !== undefined,
    hasError: Boolean(error),
  });
  const listLoading = isLoading || searchTransition.isSearching;

  const categoryChips: { value: string; label: string }[] = useMemo(
    () => [
      { value: FILTER_ALL, label: 'All supply categories' },
      ...pool.map((p) => ({ value: p, label: p })),
      { value: FILTER_MIXED, label: 'Mixed / Other' },
    ],
    [pool],
  );

  /* Server page rows + grand total. The Supply-Category chip (incl. the
     owner-spec "Mixed / Other" semantics) is now resolved server-side in the
     /suppliers paged endpoint, so this is just the loaded page. */
  const rows = data?.suppliers ?? [];
  const total = data?.total ?? 0;

  /* Shared DataGrid conversion (2026-06-12). Status + Supply Category chip
     rows above stay as-is (they drive the server query / client pre-filter);
     the grid adds sort, per-column filters, column show-hide / reorder / pin.
     Row click still opens the supplier detail page. Payment Terms ships
     default-hidden (low-value) — re-enable via the Columns popover. */
  const columns = useMemo<DataGridColumn<SupplierRow>[]>(() => [
    {
      key: 'code',
      label: 'Code',
      width: 120,
      accessor: (r) => <span className={styles.codeChip}>{r.code}</span>,
      searchValue: (r) => r.code,
      filterValue: (r) => r.code,
      sortFn: (a, b) => (a.code ?? '').localeCompare(b.code ?? ''),
    },
    {
      key: 'name',
      label: 'Name',
      width: 220,
      accessor: (r) => r.name,
      sortFn: (a, b) => (a.name ?? '').localeCompare(b.name ?? ''),
    },
    {
      key: 'category',
      label: 'Supply Category',
      width: 170,
      accessor: (r) => (
        <span style={{ color: 'var(--fg-muted)' }}>
          {displaySupplierCategories(r.category, pool) || '—'}
        </span>
      ),
      searchValue: (r) => displaySupplierCategories(r.category, pool),
      filterValue: (r) => displaySupplierCategories(r.category, pool) || '—',
    },
    {
      key: 'contact',
      label: 'Contact',
      width: 150,
      accessor: (r) => r.contact_person ?? '—',
    },
    {
      key: 'phone',
      label: 'Phone',
      width: 150,
      accessor: (r) => formatPhone(r.phone ?? r.whatsapp_number) || '—',
      searchValue: (r) => `${r.phone ?? ''} ${r.whatsapp_number ?? ''} ${formatPhone(r.phone ?? r.whatsapp_number)}`,
      filterValue: (r) => formatPhone(r.phone ?? r.whatsapp_number) || '—',
    },
    {
      key: 'state',
      label: 'State',
      width: 110,
      accessor: (r) => r.state ?? '—',
      filterValue: (r) => r.state ?? '—',
    },
    {
      key: 'terms',
      label: 'Payment Terms',
      width: 130,
      accessor: (r) => r.payment_terms ?? '—',
      filterValue: (r) => r.payment_terms ?? '—',
      defaultHidden: true,
    },
    {
      key: 'status',
      label: 'Status',
      width: 110,
      accessor: (r) => (
        <span className={`${styles.statusPill} ${STATUS_CLASS[r.status]}`}>
          {r.status}
        </span>
      ),
      searchValue: (r) => r.status,
      filterValue: (r) => r.status,
    },
  ], [pool]);

  return (
    <div>
      <PageHeader
        eyebrow="Purchasing"
        title="Suppliers"
        description={
          isLoading ? 'Loading suppliers…' : `${total} supplier${total === 1 ? '' : 's'}`
        }
        primaryAction={
          <div className="flex items-stretch gap-2">
            {selectedIds.size > 0 && (
              <Button variant="secondary" onClick={() => setBatchOpen(true)}>
                Batch edit ({selectedIds.size})
              </Button>
            )}
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
              New Supplier
            </Button>
          </div>
        }
      />

      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* The SO strip's own FilterPills slab (owner 2026-07-26). */}
          <FilterPills
            options={STATUS_CHIPS.map((c) => ({ value: c.value as string, label: c.label }))}
            value={status}
            onChange={(v) => setStatus(v as typeof STATUS_CHIPS[number]['value'])}
          />

          <div className="relative min-w-[240px] flex-1">
            <Search
              size={16}
              strokeWidth={1.75}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted"
            />
            <input
              type="search"
              className="h-9 w-full rounded-md border border-border bg-surface pl-9 pr-3 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
              placeholder="Search by code / name / contact…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <SearchProgress
              active={searchTransition.isSearching}
              className="absolute right-3 top-1/2 -translate-y-1/2 bg-surface pl-2"
            />
          </div>
        </div>

        {/* Supply Category filter — same FilterPills slab, rendered from the
            maintained pool + "Mixed / Other". Client-side filter on the
            in-memory list (small dataset). Hides nothing on "All". */}
        <FilterPills
          options={categoryChips.map((c) => ({ value: c.value as string, label: c.label }))}
          value={category}
          onChange={(v) => setCategory(v)}
        />

        {error && !isLoading && (
          <div className="rounded-lg border border-err/40 bg-err/10 px-4 py-2.5 text-[12.5px] text-err">
            <strong className="font-semibold">Failed to load suppliers.</strong>{' '}
            {/* authedFetch already humanised `message`; fallback for a non-Error throw. */}
            {error instanceof Error ? error.message : 'Something went wrong.'}
            <span className="mt-1 block text-[12px] text-ink-secondary">
              If this keeps happening, sign out and back in — your session may have expired — or let IT know.
            </span>
          </div>
        )}

        {/* Search + Supply-Category + status are all driven SERVER-SIDE from the
            page-level controls above, so the grid's own client search box is
            hidden (`hideSearch`) — it would otherwise only filter the loaded page
            and silently hide matches on other pages. Column sort / filters /
            show-hide still operate on the loaded page. */}
        <DataGrid
          rows={searchTransition.resultsAreStale ? [] : rows}
          columns={columns}
          storageKey="dg-suppliers"
          rowKey={(r) => r.id}
          hideSearch
          groupBanner={false}
          isLoading={listLoading}
          emptyMessage="No suppliers yet."
          onRowClick={(r) => navigate(`/scm/suppliers/${r.id}`)}
          selectable={{ selectedKeys: selectedIds, onToggle: toggle, onToggleAll: toggleAll }}
        />

        {!searchTransition.resultsAreStale && <ListPager
          page={page}
          pageSize={pageSize}
          total={total}
          noun="suppliers"
          onPageChange={setPage}
          onPageSizeChange={(n) => { setPageSize(n); setPage(0); }}
        />}
      </div>

      {creating && (
        <SupplierCreateDrawer onClose={() => setCreating(false)} />
      )}

      {batchOpen && (
        <BatchEditModal
          ids={[...selectedIds]}
          onClose={() => setBatchOpen(false)}
          onDone={() => { setSelectedIds(new Set()); setBatchOpen(false); }}
        />
      )}
    </div>
  );
};

const StatusChip = ({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      'h-7 rounded-full border px-3 text-[11px] font-semibold transition-colors',
      active
        ? 'border-primary bg-primary-soft text-primary'
        : 'border-border bg-surface text-ink-secondary hover:border-primary/40 hover:text-primary',
    )}
  >
    {children}
  </button>
);

/* ════════════════════════════════════════════════════════════════════════
   Batch edit modal (Commander 2026-06-19 — HOOKKA parity)

   Sets ONE shared SAFE field across the selected suppliers. Only Payment
   Terms (free-text) and Status (enum) are offered — name / code are unique
   identity and unsafe to bulk-set. Applies one PATCH per supplier (the chosen
   field only), counts ok / fail, then reports + clears the selection.
   ════════════════════════════════════════════════════════════════════════ */

type BatchField = 'payment_terms' | 'status';

const STATUS_OPTIONS: { value: SupplierStatus; label: string }[] = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
  { value: 'BLOCKED', label: 'Blocked' },
];

const BatchEditModal = ({
  ids,
  onClose,
  onDone,
}: {
  ids: string[];
  onClose: () => void;
  onDone: () => void;
}) => {
  const update = useUpdateSupplier();
  const notify = useNotify();
  const [field, setField] = useState<BatchField>('payment_terms');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [statusValue, setStatusValue] = useState<SupplierStatus>('ACTIVE');
  const [applying, setApplying] = useState(false);

  const apply = async () => {
    setApplying(true);
    let ok = 0;
    let fail = 0;
    for (const id of ids) {
      try {
        if (field === 'payment_terms') {
          await update.mutateAsync({ id, payment_terms: paymentTerms.trim() || null });
        } else {
          await update.mutateAsync({ id, status: statusValue });
        }
        ok += 1;
      } catch {
        fail += 1;
      }
    }
    setApplying(false);
    await notify({ title: `Updated ${ok} suppliers (${fail} failed)` });
    onDone();
  };

  return (
    <>
      <div className={styles.backdrop} onClick={applying ? undefined : onClose} />
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label="Batch edit suppliers">
        <header className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>Batch edit ({ids.length})</h2>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onClose}
            disabled={applying}
            aria-label="Close"
          >
            <X {...ICON} />
          </button>
        </header>

        <div className={styles.modalBody}>
          <p className={styles.subtitle} style={{ margin: 0 }}>
            Set one field on the {ids.length} selected supplier{ids.length === 1 ? '' : 's'}.
          </p>

          <div className={styles.section}>
            <p className={styles.eyebrow}>Field</p>
            <label className={styles.fieldRow} style={{ cursor: 'pointer' }}>
              <input
                type="radio"
                name="batch-field"
                checked={field === 'payment_terms'}
                onChange={() => setField('payment_terms')}
              />
              <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-12)' }}>
                Payment Terms
              </span>
            </label>
            <label className={styles.fieldRow} style={{ cursor: 'pointer' }}>
              <input
                type="radio"
                name="batch-field"
                checked={field === 'status'}
                onChange={() => setField('status')}
              />
              <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-12)' }}>
                Status
              </span>
            </label>
          </div>

          <div className={styles.section}>
            {field === 'payment_terms' ? (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>New Payment Terms</span>
                <input
                  className={styles.fieldInput}
                  value={paymentTerms}
                  placeholder="e.g. 30 days"
                  onChange={(e) => setPaymentTerms(e.target.value)}
                />
              </label>
            ) : (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>New Status</span>
                <select
                  className={styles.fieldSelect}
                  value={statusValue}
                  onChange={(e) => setStatusValue(e.target.value as SupplierStatus)}
                >
                  {STATUS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>

        <footer className={styles.drawerFooter}>
          <Button variant="ghost" onClick={onClose} disabled={applying}>Cancel</Button>
          <Button variant="primary" onClick={apply} disabled={applying}>
            {applying ? 'Applying…' : `Apply (${ids.length})`}
          </Button>
        </footer>
      </div>
    </>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Create drawer (edit lives on the full /suppliers/:id page now)
   ════════════════════════════════════════════════════════════════════════ */

const SupplierCreateDrawer = ({ onClose }: { onClose: () => void }) => (
  <>
    <div className={styles.backdrop} onClick={onClose} />
    <aside className={styles.drawer}>
      <header className={styles.drawerHeader}>
        <h2 className={styles.drawerTitle}>New Supplier</h2>
        <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Close">
          <X {...ICON} />
        </button>
      </header>
      <CreateForm onClose={onClose} />
    </aside>
  </>
);

const CreateForm = ({ onClose }: { onClose: () => void }) => {
  const create = useCreateSupplier();
  const notify = useNotify();
  const [form, setForm] = useState<Record<string, string | number>>({
    code: '',
    name: '',
    /* PR #40 — full master record */
    supplierType: '',
    category: '',
    tinNumber: '',
    businessRegNo: '',
    /* Mig 0028 — AutoCount creditor-export parity */
    registrationNo: '',
    exemptionNo: '',
    natureOfBusiness: '',
    contactPerson: '',
    attention: '',
    phone: '',
    phone2: '',
    mobile: '',
    fax: '',
    whatsappNumber: '',
    email: '',
    website: '',
    address: '',
    address1: '',
    address2: '',
    address3: '',
    address4: '',
    city: '',
    postcode: '',
    area: '',
    state: '',
    businessNature: '',
    paymentTerms: '',
    /* Supplier currency — backend supports MYR/RMB/USD/SGD; default MYR.
       Once set, PurchaseOrderNew + PI pages read supplier.currency. */
    currency: 'MYR',
    rating: 0,
    notes: '',
  });
  const onChange = (k: string, v: string | number) => setForm((s) => ({ ...s, [k]: v }));

  const submit = () => {
    const code = String(form.code ?? '').trim();
    const name = String(form.name ?? '').trim();
    if (!code || !name) {
      notify({ title: 'Code and Name are required.', tone: 'error' });
      return;
    }
    create.mutate({
      ...form,
      rating: Number(form.rating) || 0,
    } as unknown as Partial<SupplierRow>, { onSuccess: onClose });
  };

  return (
    <>
      <div className={styles.drawerBody}>
        <SupplierFields form={form} onChange={onChange} />
      </div>
      <footer className={styles.drawerFooter}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit} disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create'}
        </Button>
      </footer>
    </>
  );
};

const SupplierFields = ({
  form,
  onChange,
}: {
  form: Record<string, string | number>;
  onChange: (k: string, v: string | number) => void;
}) => (
  <div className={styles.section}>
    <p className={styles.eyebrow}>Identity</p>
    <div className={styles.formGrid}>
      <Field label="Credit Account *" value={(form.code as string) ?? ''} onChange={(v) => onChange('code', v)} />
      <Field label="Company Name *" value={(form.name as string) ?? ''} onChange={(v) => onChange('name', v)} />
      <Field label="Supplier Type" value={(form.supplierType as string) ?? ''} onChange={(v) => onChange('supplierType', v)} />
      {/* Owner spec 2026-06-12 — Supply Category is a multi-select chip
          toggle fed by the maintained pool; stored comma-joined in the
          existing `category` text column. */}
      <div className={styles.formGridFull}>
        <SupplyCategoryPicker
          value={(form.category as string) ?? ''}
          onChange={(v) => onChange('category', v)}
          fieldClassName={styles.field}
          labelClassName={styles.fieldLabel}
        />
      </div>
      <Field label="TIN Number" value={(form.tinNumber as string) ?? ''} onChange={(v) => onChange('tinNumber', v)} />
      <Field label="Business Reg No" value={(form.businessRegNo as string) ?? ''} onChange={(v) => onChange('businessRegNo', v)} />
      {/* Mig 0028 — AutoCount creditor-export parity. */}
      <Field label="Registration No." value={(form.registrationNo as string) ?? ''} onChange={(v) => onChange('registrationNo', v)} />
      <Field label="Exemption No." value={(form.exemptionNo as string) ?? ''} onChange={(v) => onChange('exemptionNo', v)} />
      <Field label="Nature of Business" value={(form.natureOfBusiness as string) ?? ''} onChange={(v) => onChange('natureOfBusiness', v)} />
    </div>
    <p className={styles.eyebrow} style={{ marginTop: 'var(--space-3)' }}>Contact</p>
    <div className={styles.formGrid}>
      <Field label="Contact Person" value={(form.contactPerson as string) ?? ''} onChange={(v) => onChange('contactPerson', v)} />
      <Field label="Attention" value={(form.attention as string) ?? ''} onChange={(v) => onChange('attention', v)} />
      {/* Task #91 — phone fields normalize to E.164 on blur via PhoneInput. */}
      <PhoneField label="Phone" value={(form.phone as string) ?? ''} onChange={(v) => onChange('phone', v)} />
      {/* Mig 0028 — secondary phone, same E.164 normalization. */}
      <PhoneField label="Phone 2" value={(form.phone2 as string) ?? ''} onChange={(v) => onChange('phone2', v)} />
      <PhoneField label="Mobile" value={(form.mobile as string) ?? ''} onChange={(v) => onChange('mobile', v)} />
      <PhoneField label="WhatsApp" value={(form.whatsappNumber as string) ?? ''} onChange={(v) => onChange('whatsappNumber', v)} />
      <Field label="Fax" value={(form.fax as string) ?? ''} onChange={(v) => onChange('fax', v)} />
      <Field label="Email" value={(form.email as string) ?? ''} onChange={(v) => onChange('email', v)} />
      <Field label="Website" value={(form.website as string) ?? ''} onChange={(v) => onChange('website', v)} />
    </div>
    <p className={styles.eyebrow} style={{ marginTop: 'var(--space-3)' }}>Commercial</p>
    <div className={styles.formGrid}>
      <Field label="Payment Terms" value={(form.paymentTerms as string) ?? ''} onChange={(v) => onChange('paymentTerms', v)} />
      {/* Supplier currency — fixed enum (MYR/RMB/USD/SGD), order is canonical.
          Set RMB here for China suppliers; PO + PI pages pick it up. */}
      <CurrencySelect value={(form.currency as string) ?? 'MYR'} onChange={(v) => onChange('currency', v)} />
      <Field label="Business Nature" value={(form.businessNature as string) ?? ''} onChange={(v) => onChange('businessNature', v)} />
    </div>
    <p className={styles.eyebrow} style={{ marginTop: 'var(--space-3)' }}>Address</p>
    <div className={styles.formGrid}>
      {/* Task #102 — State is the shared my_localities-backed StatePicker
          (grouped by country, type-to-search), never free text. Matches the
          full Supplier edit form so both supplier surfaces behave identically. */}
      <label className={styles.field}>
        <span className={styles.fieldLabel}>State</span>
        <StatePicker
          value={(form.state as string) ?? ''}
          onChange={(v) => onChange('state', v)}
          selectClassName={styles.fieldSelect}
        />
      </label>
      <Field label="Area" value={(form.area as string) ?? ''} onChange={(v) => onChange('area', v)} />
      <Field label="Postcode" value={(form.postcode as string) ?? ''} onChange={(v) => onChange('postcode', v)} />
      <Field label="City" value={(form.city as string) ?? ''} onChange={(v) => onChange('city', v)} />
      {/* Structured pickup address (mig 0131) — the SAME shape as the SO header,
          so a Supplier-Pickup DP order auto-fills it in the SO-Maintenance format.
          The legacy single-line Billing Address below is kept for billing. */}
      <Field label="Address 1" value={(form.address1 as string) ?? ''} onChange={(v) => onChange('address1', v)} gridFull />
      <Field label="Address 2" value={(form.address2 as string) ?? ''} onChange={(v) => onChange('address2', v)} gridFull />
      <Field label="Address 3" value={(form.address3 as string) ?? ''} onChange={(v) => onChange('address3', v)} gridFull />
      <Field label="Address 4" value={(form.address4 as string) ?? ''} onChange={(v) => onChange('address4', v)} gridFull />
      <Field
        label="Billing Address"
        value={(form.address as string) ?? ''}
        onChange={(v) => onChange('address', v)}
        multiline
        gridFull
      />
      <Field
        label="Notes"
        value={(form.notes as string) ?? ''}
        onChange={(v) => onChange('notes', v)}
        multiline
        gridFull
      />
    </div>
  </div>
);

const Field = ({
  label,
  value,
  onChange,
  multiline,
  gridFull,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  gridFull?: boolean;
}) => (
  <label className={`${styles.field} ${gridFull ? styles.formGridFull : ''}`}>
    <span className={styles.fieldLabel}>{label}</span>
    {multiline ? (
      <textarea
        className={styles.fieldTextarea}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    ) : (
      <input
        className={styles.fieldInput}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    )}
  </label>
);

/* Supplier currency picker. Fixed MYR/RMB/USD/SGD enum (NOT sorted — the
   order is canonical). The backend defaults to MYR if unset, but we send an
   explicit default so the create payload always carries a currency. */
const CURRENCY_OPTIONS = ['MYR', 'RMB', 'USD', 'SGD'] as const;

const CurrencySelect = ({
  value, onChange,
}: {
  value: string; onChange: (v: string) => void;
}) => (
  <label className={styles.field}>
    <span className={styles.fieldLabel}>Currency</span>
    <select
      className={styles.fieldSelect}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {CURRENCY_OPTIONS.map((c) => (
        <option key={c} value={c}>{c}</option>
      ))}
    </select>
  </label>
);

/* Task #91 — Phone variant of Field. Same label/layout, but the input runs
   through PhoneInput so its value is normalized to E.164 on blur. */
const PhoneField = ({
  label, value, onChange,
}: {
  label: string; value: string; onChange: (v: string) => void;
}) => (
  <label className={styles.field}>
    <span className={styles.fieldLabel}>{label}</span>
    <PhoneInput className={styles.fieldInput} value={value} onChange={onChange} />
  </label>
);

