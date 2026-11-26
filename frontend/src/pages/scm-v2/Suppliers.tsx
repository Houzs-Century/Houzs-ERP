
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useSearchParams } from 'react-router-dom';
import { rememberScmListFocus, takeScmListFocus } from '../../lib/scmListReturn';
import { Search, Plus, X } from 'lucide-react';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/Layout';
import { humaniseStatusKey } from '../../vendor/scm/lib/status-pill';
import { FilterPills } from '../../components/FilterPills';
import { cn } from '../../lib/utils';
import { formatPhone } from '@2990s/shared/phone';
import { PhoneInput } from '../../vendor/scm/components/PhoneInput';
import { AddressTripleFields } from '../../vendor/scm/components/AddressTripleFields';
import { addressLineTwoView, hasLegacyLines } from '../../vendor/shared/address-two-lines';
import {
  useSuppliersPaged,
  useCreateSupplier,
  useNextSupplierCode,
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
import { DataGridCompat, type GridColumn } from '../../components/DataGridCompat';
import { SearchProgress } from '../../components/SearchProgress';
import { ListPager } from '../../components/ListPager';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { useDebouncedSearchTerm, useSearchResultTransition } from '../../hooks/useServerSearch';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useCapability } from '../../auth/capabilities';
import { withoutSupplierFinanceKeys } from '../../vendor/shared/supplier-finance-fields';
import styles from './Suppliers.module.css';
import { masterNeedsPostcode, masterPostcodeError } from '../../vendor/shared/master-postcode-rule';

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
  const [params, setParams] = useSearchParams();
  const setParam = (changes: Record<string, string | null>) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(changes)) {
        if (v === null || v === '') next.delete(k); else next.set(k, v);
      }
      return next;
    }, { replace: true });
  const statusParam = params.get('status');
  const status: 'all' | SupplierStatus = STATUS_CHIPS.some((c) => c.value !== 'all' && c.value === statusParam)
    ? (statusParam as SupplierStatus)
    : 'all';
  const setStatus = (v: 'all' | SupplierStatus) => setParam({ status: v === 'all' ? null : v, page: null });
  const category = params.get('category') ?? FILTER_ALL;
  const setCategory = (v: string) => setParam({ category: v === FILTER_ALL ? null : v, page: null });
  const [search, setSearch] = useState(() => params.get('q') ?? '');
  const page = Math.max(0, Math.floor(Number(params.get('page')) || 0));
  const setPage = (n: number) => setParam({ page: n > 0 ? String(n) : null });
  const [returnFocus] = useState(() => takeScmListFocus('/scm/suppliers'));
  const [scrollTo, setScrollTo] = useState<{ key: string; nonce: number } | null>(null);
  const [creating, setCreating] = useState(false);

  const [pageSize, setPageSize] = useLocalStorage<number>('scm:perpage:suppliers', 50);
  const { requestTerm: debouncedSearch } = useDebouncedSearchTerm(search);

  const pool = useSupplierCategoryPool();

  useEffect(() => {
    const term = debouncedSearch.trim();
    if (term !== (params.get('q') ?? '')) setParam({ q: term || null, page: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a settled new search term moves the address
  }, [debouncedSearch]);

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

  useEffect(() => {
    setSelectedIds(new Set());
  }, [status, category, page, debouncedSearch]);

  const { data, isLoading, isFetching, isPlaceholderData, error } = useSuppliersPaged({
    page,
    pageSize: pageSize,
    status: status === 'all' ? undefined : status,
    q: debouncedSearch.trim() || undefined,
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

  const rows = data?.suppliers ?? [];
  const total = data?.total ?? 0;

  useEffect(() => {
    if (!returnFocus || scrollTo || isPlaceholderData) return;
    if (rows.some((r) => r.id === returnFocus)) setScrollTo({ key: returnFocus, nonce: Date.now() });
  }, [returnFocus, scrollTo, isPlaceholderData, rows]);

  const columns = useMemo<GridColumn<SupplierRow>[]>(() => [
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
          {humaniseStatusKey(r.status)}
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

        <FilterPills
          options={categoryChips.map((c) => ({ value: c.value as string, label: c.label }))}
          value={category}
          onChange={(v) => setCategory(v)}
        />

        {error && !isLoading && (
          <div className="rounded-lg border border-err/40 bg-err/10 px-4 py-2.5 text-[12.5px] text-err">
            <strong className="font-semibold">Failed to load suppliers.</strong>{' '}
            {error instanceof Error ? error.message : 'Something went wrong.'}
            <span className="mt-1 block text-[12px] text-ink-secondary">
              If this keeps happening, sign out and back in — your session may have expired — or let IT know.
            </span>
          </div>
        )}

        <DataGridCompat
          rows={searchTransition.resultsAreStale ? [] : rows}
          columns={columns}
          storageKey="dg-suppliers"
          rowKey={(r) => r.id}
          hideSearch
          groupBanner={false}
          isLoading={listLoading}
          emptyMessage="No suppliers yet."
          onRowClick={(r) => {
            rememberScmListFocus('/scm/suppliers', r.id);
            navigate(`/scm/suppliers/${r.id}`);
          }}
          scrollToRow={scrollTo}
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
          await update.mutateAsync({ id, paymentTerms: paymentTerms.trim() || null } as unknown as Partial<SupplierRow> & { id: string });
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
  /* Owner 2026-09-30: a purchaser opens a supplier with its code and the
     purchasing part; the Finance part is Finance's to fill. */
  const isFinance = useCapability('scm.money.move');
  const [form, setForm] = useState<Record<string, string | number>>({
    code: '',
    name: '',
    supplierType: '',
    category: '',
    tinNumber: '',
    businessRegNo: '',
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
    email2: '',
    email3: '',
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
    currency: 'MYR',
    rating: 0,
    notes: '',
  });
  const onChange = (k: string, v: string | number) => setForm((s) => ({ ...s, [k]: v }));

  /* Purchasing opens suppliers of goods: the code is numbered 400- plus the
     name's first letter until someone types one (owner 2026-11-20). */
  const [codeTyped, setCodeTyped] = useState(false);
  const typedName = String(form.name ?? '');
  const nextCode = useNextSupplierCode('400', typedName, !codeTyped);
  const suggested = typedName.trim() ? (nextCode.data?.code ?? '') : '';
  useEffect(() => {
    if (codeTyped) return;
    setForm((s) => (s.code === suggested ? s : { ...s, code: suggested }));
  }, [codeTyped, suggested]);
  const onFieldChange = (k: string, v: string | number) => {
    if (k === 'code') setCodeTyped(true);
    onChange(k, v);
  };

  const submit = () => {
    const name = String(form.name ?? '').trim();
    if (!name) {
      notify({ title: 'Name is required.', tone: 'error' });
      return;
    }
    const pcErr = masterPostcodeError(String(form.country || ''), String(form.postcode || ''));
    if (pcErr) { void notify({ title: pcErr, tone: 'error' }); return; }
    create.mutate({
      ...(isFinance ? form : withoutSupplierFinanceKeys(form)),
      rating: Number(form.rating) || 0,
    } as unknown as Partial<SupplierRow>, { onSuccess: onClose });
  };

  return (
    <>
      <div className={styles.drawerBody}>
        <SupplierFields form={form} onChange={onFieldChange} finance={isFinance} />
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
  finance,
}: {
  form: Record<string, string | number>;
  onChange: (k: string, v: string | number) => void;
  finance: boolean;
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
      {finance && (
        <>
          <Field label="TIN Number" value={(form.tinNumber as string) ?? ''} onChange={(v) => onChange('tinNumber', v)} />
          <Field label="Business Reg No" value={(form.businessRegNo as string) ?? ''} onChange={(v) => onChange('businessRegNo', v)} />
          <Field label="Registration No." value={(form.registrationNo as string) ?? ''} onChange={(v) => onChange('registrationNo', v)} />
          <Field label="Exemption No." value={(form.exemptionNo as string) ?? ''} onChange={(v) => onChange('exemptionNo', v)} />
        </>
      )}
      <Field label="Nature of Business" value={(form.natureOfBusiness as string) ?? ''} onChange={(v) => onChange('natureOfBusiness', v)} />
    </div>
    <p className={styles.eyebrow} style={{ marginTop: 'var(--space-3)' }}>Contact</p>
    <div className={styles.formGrid}>
      <Field label="Contact Person" value={(form.contactPerson as string) ?? ''} onChange={(v) => onChange('contactPerson', v)} />
      <Field label="Attention" value={(form.attention as string) ?? ''} onChange={(v) => onChange('attention', v)} />
      <PhoneField label="Phone" value={(form.phone as string) ?? ''} onChange={(v) => onChange('phone', v)} />
      <PhoneField label="Phone 2" value={(form.phone2 as string) ?? ''} onChange={(v) => onChange('phone2', v)} />
      <PhoneField label="Mobile" value={(form.mobile as string) ?? ''} onChange={(v) => onChange('mobile', v)} />
      <PhoneField label="WhatsApp" value={(form.whatsappNumber as string) ?? ''} onChange={(v) => onChange('whatsappNumber', v)} />
      <Field label="Fax" value={(form.fax as string) ?? ''} onChange={(v) => onChange('fax', v)} />
      <Field label="Email" value={(form.email as string) ?? ''} onChange={(v) => onChange('email', v)} />
      <Field label="Email 2" value={(form.email2 as string | undefined) ?? ''} onChange={(v) => onChange('email2', v)} />
      <Field label="Email 3" value={(form.email3 as string | undefined) ?? ''} onChange={(v) => onChange('email3', v)} />
      <Field label="Website" value={(form.website as string) ?? ''} onChange={(v) => onChange('website', v)} />
    </div>
    <p className={styles.eyebrow} style={{ marginTop: 'var(--space-3)' }}>Commercial</p>
    <div className={styles.formGrid}>
      <Field label="Payment Terms" value={(form.paymentTerms as string) ?? ''} onChange={(v) => onChange('paymentTerms', v)} />
      <CurrencySelect value={(form.currency as string) ?? 'MYR'} onChange={(v) => onChange('currency', v)} />
      <Field label="Business Nature" value={(form.businessNature as string) ?? ''} onChange={(v) => onChange('businessNature', v)} />
    </div>
    <p className={styles.eyebrow} style={{ marginTop: 'var(--space-3)' }}>Address</p>
    <div className={styles.formGrid}>
      {/* The Sales Order's address block (owner 2026-11-18: two lines, then
          State / City / Postcode, the same controls everywhere). The structured
          lines (mig 0131) are what a Supplier-Pickup DP order copies. Line 2 shows
          what an older supplier still holds in lines 3 / 4; editing it moves all
          of it to line 2 (shared/address-two-lines). */}
      <Field label="Address line 1" value={(form.address1 as string) ?? ''} onChange={(v) => onChange('address1', v)} gridFull />
      <Field
        label="Address line 2"
        value={addressLineTwoView(form.address2 as string, form.address3 as string, form.address4 as string,
          { postcode: form.postcode as string, city: form.city as string, state: form.state as string })}
        onChange={(v) => {
          onChange('address2', v);
          if (hasLegacyLines(form.address3 as string, form.address4 as string)) { onChange('address3', ''); onChange('address4', ''); }
        }}
        gridFull
      />
      <AddressTripleFields
        postcodeRequired={masterNeedsPostcode(String(form.country || ''))}
        country=""
        value={{ state: String(form.state || ''), city: String(form.city || ''), postcode: String(form.postcode || '') }}
        onChange={(t) => { onChange('state', t.state); onChange('city', t.city); onChange('postcode', t.postcode); }}
        classes={{ field: styles.field, label: styles.fieldLabel, select: styles.fieldSelect, selectWrap: styles.selectWrap, chevron: styles.selectChevron, input: styles.fieldInput }}
      />
      <Field label="Area" value={(form.area as string) ?? ''} onChange={(v) => onChange('area', v)} />
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

const CURRENCY_OPTIONS = ['MYR', 'RMB', 'CNY', 'USD', 'SGD'] as const;

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

