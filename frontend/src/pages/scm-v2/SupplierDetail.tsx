
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  TrendingUp, Package, Plus, Pencil, Trash2, Star, X, Save, Search,
  Tag, ChevronDown, ChevronRight, Download, Upload, Anchor,
} from 'lucide-react';
import { MaintenanceTab, type MaintenanceSection } from './Products';
import { SofaComboTab } from '../../vendor/scm/components/SofaComboTab';
import { SupplierLeadTimes } from './SupplierLeadTimes';
import { FabricTracking } from './FabricTracking';
import { setActiveCompanyId } from '../../lib/activeCompany';
import { scmListReturnTo } from '../../lib/scmListReturn';
import { Button } from '../../components/Button';
import { DetailLoadFailure } from './DetailLoadFailure';
import { PageHeader } from '../../components/Layout';
import { StatCard } from '../../components/StatCard';
import {
  useSupplierDetail,
  useSupplierScorecard,
  useUpdateSupplier,
  useCreateBinding,
  useCreateBindingsBatch,
  useUpdateBinding,
  useDeleteBinding,
  useSetCostAnchor,
  useBindingPriceHistory,
  useScheduleBindingPrice,
  type BindingPriceChange,
  type BindingRow,
  type MaterialKind,
  type Currency,
  type SupplierRow,
  type SupplierStatus,
  type NewBinding,
  type PriceMatrix,
  type SofaPriceMatrix,
  type BedframePriceMatrix,
} from '../../vendor/scm/lib/suppliers-queries';
import { useMfgProducts, useMaintenanceConfig, mfgCategoryLabel, type MfgCategory, type MfgProductRow } from '../../vendor/scm/lib/mfg-products-queries';
import { useDebouncedValue } from '../../vendor/scm/lib/hooks';
/* A refused write must SAY so. The five grid cells below fire-and-forget, and
   useUpdateBinding carries no onError (unlike useDeleteBinding and
   useSetCostAnchor beside it), so a 503 from the go-live write freeze - or a
   403, or a 504 - changed nothing and reported nothing. That is the owner's
   exact report on 2026-09-07: "我点了main 为什么没反应". */
import { writeFailed } from '../../vendor/scm/lib/mutation-error';
import { useCapability } from '../../auth/capabilities';
import { supplierSaveBody } from '../../vendor/scm/lib/supplier-save-body';
import { useProductModels, type ProductModelRow } from '../../vendor/scm/lib/product-models-queries';
import {
  useLocalities,
  distinctCountries,
  citiesInState,
} from '../../vendor/scm/lib/localities-queries';
import { PAYMENT_TERMS, PAYMENT_TERMS_CUSTOM } from '../../vendor/shared/pick-lists';
import { PickListField } from '../../vendor/scm/components/PickListField';
import { SgPostcodeField } from '../../vendor/scm/components/SgPostcodeField';
import { StatePicker } from '../../vendor/scm/components/StatePicker';
import { PostcodeCascadeField } from '../../vendor/scm/components/PostcodeCascadeField';
import { addressLineTwoView, hasLegacyLines } from '../../vendor/shared/address-two-lines';
import { composeSupplierSku, looksAmbiguous } from '../../vendor/scm/lib/supplier-sku-helpers';
import { countModelessMatches, modelMatchesSearch } from '../../vendor/scm/lib/model-picker-search';
import { parseSupplierCategories, displaySupplierCategories } from '../../vendor/scm/lib/supplier-categories';
import { SupplyCategoryPicker, useSupplierCategoryPool } from '../../vendor/scm/components/SupplyCategoryPicker';
import { DataGridCompat, type GridColumn } from '../../components/DataGridCompat';
import { DataTable, type Column } from '../../components/DataTable';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import { formatPhone } from '@2990s/shared/phone';
import { maintValues, fmtSen, fmtDateOrDash, fmtQty } from '@2990s/shared';
import { PhoneInput } from '../../vendor/scm/components/PhoneInput';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { NumberInput } from '../../vendor/scm/components/NumberInput';
import styles from './SupplierDetail.module.css';
import { exportBindingsCsv, ImportBindingsDialog } from './SupplierBindingsCsv';
import { UnmappedModelSkus } from './UnmappedModelSkus';
import { EffectiveDatedHistory } from '../../vendor/scm/components/EffectiveDatedHistory';
import { todayMyt } from '../../vendor/scm/lib/dates';
import { statusLabel } from '../../vendor/scm/lib/status-pill';
import { DateField } from '../../vendor/scm/components/DateField';
import { masterNeedsPostcode, masterPostcodeError } from '../../vendor/shared/master-postcode-rule';

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

type OtherCompanyMiss = { companyId: number; companyCode: string | null; message: string };
function readOtherCompanyMiss(err: unknown): OtherCompanyMiss | null {
  const body = (err as { body?: unknown } | null)?.body;
  if (typeof body !== 'string') return null;
  try {
    const j = JSON.parse(body) as { error?: unknown; companyId?: unknown; companyCode?: unknown; message?: unknown };
    if (j.error !== 'in_other_company') return null;
    const companyId = Number(j.companyId);
    if (!Number.isInteger(companyId) || companyId <= 0) return null;
    return {
      companyId,
      companyCode: typeof j.companyCode === 'string' ? j.companyCode : null,
      message: typeof j.message === 'string' ? j.message : 'This supplier belongs to another company.',
    };
  } catch {
    return null;
  }
}

type KpiTone = 'default' | 'success' | 'warning' | 'error';

const BACK_LINK_CLASS =
  'inline-flex h-9 w-fit items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors hover:border-primary/40 hover:bg-primary-soft hover:text-primary';

const TAB_COUNT_CLASS =
  'ml-1.5 inline-flex items-center rounded-full bg-surface-2 px-1.5 text-[10px] font-semibold text-ink-secondary';

const STATUS_PILL_BASE =
  'inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider';

const STATUS_CLASS: Record<SupplierStatus, string> = {
  ACTIVE: 'bg-synced-bg text-synced',
  INACTIVE: 'bg-surface-dim text-ink-muted',
  BLOCKED: 'bg-err/10 text-err',
};

const fmtCurrency = (centi: number, currency: Currency): string => {
  const v = (centi / 100).toLocaleString('en-MY', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency === 'MYR' ? `RM ${v}` : `${v} ${currency}`;
};


function usePersistedOpen(storageKey: string, defaultOpen = true): [boolean, () => void] {
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return defaultOpen;
    try {
      const raw = window.localStorage.getItem(storageKey);
      return raw == null ? defaultOpen : raw === '1';
    } catch { return defaultOpen; }
  });
  const toggle = useCallback(() => {
    setOpen((v) => {
      try { window.localStorage.setItem(storageKey, v ? '0' : '1'); } catch { }
      return !v;
    });
  }, [storageKey]);
  return [open, toggle];
}

type DeliveryDelta = { label: string; tone: 'ok' | 'late' | 'neutral' };

function deliveryDelta(expected: string | null, received: string | null): DeliveryDelta {
  if (!expected || !received) return { label: '—', tone: 'neutral' };
  const exp = new Date(expected).getTime();
  const rec = new Date(received).getTime();
  if (!Number.isFinite(exp) || !Number.isFinite(rec)) return { label: '—', tone: 'neutral' };
  const diffDays = Math.round((rec - exp) / 86400000);
  if (diffDays <= 0) {
    return { label: diffDays === 0 ? 'on time' : `${-diffDays}d early`, tone: 'ok' };
  }
  return { label: `${diffDays}d late`, tone: 'late' };
}


const SUPPLIER_CATEGORIES = ['SOFA', 'BEDFRAME', 'MATTRESS', 'ACCESSORY', 'SERVICE', 'MIXED'] as const;
type SupplierCategory = typeof SUPPLIER_CATEGORIES[number];

const SUPPLIER_CATEGORY_LABEL: Record<SupplierCategory, string> = {
  SOFA:      'Sofa',
  BEDFRAME:  'Bedframe',
  MATTRESS:  'Mattress',
  ACCESSORY: 'Accessory',
  SERVICE:   'Service',
  MIXED:     'Mixed / Other',
};

const isSupplierCategory = (v: string | null | undefined): v is SupplierCategory =>
  typeof v === 'string' && (SUPPLIER_CATEGORIES as readonly string[]).includes(v);

/** Owner spec 2026-06-12 — suppliers.category is now a comma-joined Supply
 *  Category list ("Sofa, Bedframe"). Derive the single canonical gating
 *  category for the Pricing/Combo/Fabric tab filters:
 *    • exactly ONE value that matches a canonical category (any casing,
 *      legacy uppercase 'SOFA' included) → that category;
 *    • two or more values → 'MIXED' (every section surfaces);
 *    • one unknown value → 'MIXED';
 *    • empty/null → null (default behaviour, everything shows). */
function deriveGatingCategory(text: string | null | undefined): SupplierCategory | null {
  const list = parseSupplierCategories(text);
  if (list.length === 0) return null;
  if (list.length >= 2) return 'MIXED';
  const up = list[0]!.toUpperCase();
  return isSupplierCategory(up) ? up : 'MIXED';
}

function maintenanceSectionsForCategory(
  cat: SupplierCategory | null,
): MaintenanceSection[] | undefined {
  if (!cat || cat === 'MIXED') return undefined;
  switch (cat) {
    case 'BEDFRAME':  return ['Bedframe', 'Common', 'Products Maintenance'];
    case 'SOFA':      return ['Sofa', 'Common', 'Products Maintenance'];
    case 'MATTRESS':  return ['Common', 'Products Maintenance'];
    case 'ACCESSORY': return ['Products Maintenance'];
    case 'SERVICE':   return ['Common'];
    default:          return undefined;
  }
}

function mfgCategoryFromSupplierCategory(
  cat: SupplierCategory | null,
): MfgCategory | null {
  if (!cat || cat === 'MIXED') return null;
  switch (cat) {
    case 'BEDFRAME':  return 'BEDFRAME';
    case 'SOFA':      return 'SOFA';
    case 'MATTRESS':  return 'MATTRESS';
    case 'ACCESSORY': return 'ACCESSORY';
    case 'SERVICE':   return 'SERVICE';
    default:          return null;
  }
}

type SupplierDetailTab = 'overview' | 'sku-pricing' | 'maintenance' | 'combos' | 'fabric' | 'lead-times';

export const SupplierDetail = () => {
  const { id } = useParams<{ id: string }>();
  const detail = useSupplierDetail(id ?? null);
  const scorecard = useSupplierScorecard(id ?? null);

  const supplier = detail.data?.supplier;
  const bindings = detail.data?.bindings ?? [];
  const score = scorecard.data;

  const [activeTab, setActiveTab] = useState<SupplierDetailTab>('overview');
  const supplierCategory: SupplierCategory | null = deriveGatingCategory(supplier?.category);
  const showCombo  = supplierCategory == null || supplierCategory === 'SOFA' || supplierCategory === 'MIXED';
  const showFabric = supplierCategory == null || supplierCategory === 'SOFA' || supplierCategory === 'BEDFRAME' || supplierCategory === 'MIXED';

  const otrTone = useMemo<KpiTone>(() => {
    const v = score?.onTimeRate ?? 0;
    if (v >= 90) return 'success';
    if (v >= 75) return 'warning';
    return 'error';
  }, [score]);

  const defectTone = useMemo<KpiTone>(() => {
    const v = score?.defectRate ?? 0;
    if (v <= 1) return 'success';
    if (v <= 3) return 'warning';
    return 'error';
  }, [score]);

  const [skuDialog, setSkuDialog] = useState<
    { mode: 'closed' } | { mode: 'multi' } | { mode: 'edit'; binding: BindingRow }
  >({ mode: 'closed' });

  const [editingInfo, setEditingInfo] = useState(false);

  /* isPending, NOT isLoading (BUG-HISTORY 2026-07-16, "打開會 error 先然後再
     loading 出來"). isLoading is (isPending && isFetching) → false while the query
     is pending but not actively fetching (disabled, or paused offline). The
     `!supplier` half of the error branch below then fires on a merely-PENDING
     query and paints "Supplier not found or failed to load" before anything has
     been asked. isPending holds this branch until the query settles. */
  if (detail.isPending) {
    return (
      <div className="space-y-4">
        <p className={styles.infoLabel}>Loading supplier…</p>
      </div>
    );
  }

  if (detail.isError || !supplier) {
    const otherCo = detail.isError ? readOtherCompanyMiss(detail.error) : null;
    return (
      <div className="space-y-4">
        <Link to={scmListReturnTo("/scm/suppliers")} className={BACK_LINK_CLASS}>
          <ArrowLeft {...ICON} />
          <span>Back to Suppliers</span>
        </Link>
        {otherCo ? (
          /* Not gone — just in another company. Offer the switch instead of the
             red "not found" wall (owner ask 2026-07-24). Switching writes this
             tab's company then reloads, the pattern the top-bar switcher uses. */
          <div className="flex flex-col items-start gap-2 rounded-md border border-border bg-surface px-4 py-3 text-[13px] text-ink-secondary">
            <span>{otherCo.message}</span>
            <Button
              variant="primary"
              onClick={() => { setActiveCompanyId(otherCo.companyId); window.location.reload(); }}
            >
              Switch to {otherCo.companyCode ?? 'that company'}
            </Button>
          </div>
        ) : (
          <DetailLoadFailure noun="Supplier" error={detail.isError ? detail.error : null} onRetry={() => void detail.refetch()} retrying={detail.isFetching} />
        )}
      </div>
    );
  }

  return (
    <div>
      <PageHeader back
        eyebrow="Supplier"
        title={`${supplier.code} — ${supplier.name}`}
        description="Supplier scorecard, SKU mappings and recent purchase order history."
        primaryAction={
          <Link to={scmListReturnTo("/scm/suppliers")} className={BACK_LINK_CLASS}>
            <ArrowLeft size={14} />
            <span>Back</span>
          </Link>
        }
        actions={
          <span className={`${STATUS_PILL_BASE} ${STATUS_CLASS[supplier.status]}`}>
            {supplier.status}
          </span>
        }
      />

      <div className="space-y-4">
      <SupplierInfoCard
        supplier={supplier}
        editing={editingInfo}
        onEdit={() => setEditingInfo(true)}
        onClose={() => setEditingInfo(false)}
      />

      <div
        role="tablist"
        className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md border border-border bg-surface p-1 shadow-stone"
      >
        <SupplierTabButton
          active={activeTab === 'overview'}
          onClick={() => setActiveTab('overview')}
        >
          Overview
        </SupplierTabButton>
        <SupplierTabButton
          active={activeTab === 'sku-pricing'}
          onClick={() => setActiveTab('sku-pricing')}
        >
          SKU Pricing
          <span className={TAB_COUNT_CLASS}>
            {bindings.length}
          </span>
        </SupplierTabButton>
        <SupplierTabButton
          active={activeTab === 'maintenance'}
          onClick={() => setActiveTab('maintenance')}
        >
          Maintenance
          {supplierCategory && (
            <span className={TAB_COUNT_CLASS}>
              {SUPPLIER_CATEGORY_LABEL[supplierCategory]}
            </span>
          )}
        </SupplierTabButton>
        {showCombo && (
          <SupplierTabButton
            active={activeTab === 'combos'}
            onClick={() => setActiveTab('combos')}
          >
            Combo Pricing
          </SupplierTabButton>
        )}
        {showFabric && (
          <SupplierTabButton
            active={activeTab === 'fabric'}
            onClick={() => setActiveTab('fabric')}
          >
            Fabric Converter
          </SupplierTabButton>
        )}
        <SupplierTabButton
          active={activeTab === 'lead-times'}
          onClick={() => setActiveTab('lead-times')}
        >
          Lead Times
        </SupplierTabButton>
      </div>

      {activeTab === 'overview' && (
        <SupplierOverviewPanel
          score={score}
          otrTone={otrTone}
          defectTone={defectTone}
        />
      )}
      {activeTab === 'sku-pricing' && (
        <SupplierSkuPricingPanel
          id={id!}
          supplierCode={supplier.code}
          bindings={bindings}
          setSkuDialog={setSkuDialog}
        />
      )}
      {activeTab === 'maintenance' && (
        <SupplierPricingPanel
          supplierId={id!}
          supplierName={supplier.name}
          supplierCategory={supplierCategory}
        />
      )}
      {activeTab === 'lead-times' && <SupplierLeadTimes supplierId={id!} />}
      {activeTab === 'combos' && showCombo && (
        <section className={styles.card}>
          <header className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>
              <Tag {...ICON} style={{ color: 'var(--hz-c-primary-ink)' }} />
              Combo Pricing · {supplier.name}
            </h2>
          </header>
          <div className={styles.cardBody}>
            <SofaComboTab supplierId={id!} />
          </div>
        </section>
      )}
      {activeTab === 'fabric' && showFabric && <FabricTracking />}
      </div>

      {skuDialog.mode === 'multi' && (
        <ModelSkuPickerDialog
          supplierId={id!}
          existingBindings={bindings}
          supplierCategory={supplierCategory}
          onClose={() => setSkuDialog({ mode: 'closed' })}
        />
      )}
      {skuDialog.mode === 'edit' && (
        <SkuFormDialog
          supplierId={id!}
          editing={skuDialog.binding}
          onClose={() => setSkuDialog({ mode: 'closed' })}
        />
      )}
    </div>
  );
};


const SupplierTabButton = ({
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
    role="tab"
    aria-selected={active}
    data-active={active}
    onClick={onClick}
    className={
      active
        ? 'inline-flex items-center whitespace-nowrap rounded bg-primary px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-white transition-all duration-150'
        : 'inline-flex items-center whitespace-nowrap rounded px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-all duration-150 hover:bg-primary-soft hover:text-primary'
    }
  >
    {children}
  </button>
);

const SupplierOverviewPanel = ({
  score,
  otrTone,
  defectTone,
}: {
  score: ReturnType<typeof useSupplierScorecard>['data'];
  otrTone: KpiTone;
  defectTone: KpiTone;
}) => {
  return (
  <>
    <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <StatCard
          label="On-Time Rate"
          tone={(score?.receivedPOs ?? 0) > 0 ? otrTone : 'default'}
          value={(score?.receivedPOs ?? 0) > 0 ? `${(score?.onTimeRate ?? 0).toFixed(1)}%` : '—'}
          subtitle={
            (score?.receivedPOs ?? 0) > 0
              ? `${score?.onTimeCount ?? 0} of ${score?.receivedPOs ?? 0} received POs on time`
              : 'No received POs yet'
          }
        />

        <StatCard
          label="Defect Rate"
          tone={(score?.receivedPOs ?? 0) > 0 ? defectTone : 'default'}
          value={(score?.receivedPOs ?? 0) > 0 ? `${(score?.defectRate ?? 0).toFixed(2)}%` : '—'}
        />

        <StatCard
          label="Avg Lead Days"
          value={(score?.receivedPOs ?? 0) > 0 ? (score?.averageLeadDays ?? 0).toFixed(1) : '—'}
        />
      </section>

    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>
          <TrendingUp {...ICON} style={{ color: 'var(--hz-c-primary-ink)' }} />
          Last 10 Purchase Orders
          <span className={styles.cardTitleCount}>({score?.totalPOs ?? 0} total)</span>
        </h2>
      </header>
      <LastTenPOsTable rows={score?.last10POs ?? []} />
    </section>
  </>
  );
};


const SupplierSkuPricingPanel = ({
  id,
  supplierCode,
  bindings,
  setSkuDialog,
}: {
  id: string;
  supplierCode: string;
  bindings: BindingRow[];
  setSkuDialog: (s: { mode: 'closed' } | { mode: 'multi' } | { mode: 'edit'; binding: BindingRow }) => void;
}) => {
  /* PR — Commander 2026-05-28 ("我需要一个 import 跟 export 的功能"):
     supplier-scoped CSV round-trip for the SKU MAPPINGS card. Mirrors the
     Products page Export/Import toolbar but per-supplier (different shape:
     one row per binding, per-category price-matrix columns). */
  const [importing, setImporting] = useState(false);
  const sofaConfig = useMaintenanceConfig('master');
  const sofaHeights = sofaConfig.data?.data?.sofaSizes
    ? maintValues(sofaConfig.data.data.sofaSizes)
    : SOFA_HEIGHT_FALLBACK.map(String);
  /* PR — Commander 2026-05-27 ("为什么 SKU Mapping 那边没有根据我的
     Product Maintenance 做出相对的排版呢"):
     Group bindings using the SAME sub-section labels the Product Maintenance
     sidebar uses, so Supplier Detail and Products feel like the same shape:
       Bedframe Sizes  ← mfg_products where category = BEDFRAME
       Mattress Sizes  ← mfg_products where category = MATTRESS
       Sofa Compartments ← SOFA SKUs that belong to a Model (model_id != null)
       Sofa (other)    ← legacy / non-Model sofa SKUs
       Accessories     ← ACCESSORY
       Services        ← SERVICE
       Others          ← orphan codes (fabric / raw / unknown)

     We look up the product client-side via the same mfg-products cache the
     picker uses (no new endpoint). Order is fixed so the UI doesn't
     reshuffle as bindings are added.

     TODO (commander follow-up): per-tier supplier pricing per category. E.g.
     Sofa: one row per Model with columns for compartment widths 24/26/28/30.
     Bedframe: one row per Model with columns for size variants 3FT/5FT/6FT.
     Needs a new supplier_material_binding_prices child table (or JSONB
     price_tiers column on supplier_material_bindings) — out of scope for
     this PR per task brief. */
  const products = useMfgProducts({ fresh: true });

  const CATEGORY_ORDER: readonly string[] = [
    'BEDFRAME_SIZES',
    'MATTRESS_SIZES',
    'SOFA_COMPARTMENTS',
    'SOFA_OTHER',
    'ACCESSORIES',
    'SERVICES',
    'OTHERS',
  ];
  const CATEGORY_LABEL: Record<string, string> = {
    BEDFRAME_SIZES:    'Bedframe Sizes',
    MATTRESS_SIZES:    'Mattress Sizes',
    SOFA_COMPARTMENTS: 'Sofa Compartments',
    SOFA_OTHER:        'Sofa (other)',
    ACCESSORIES:       'Accessories',
    SERVICES:          'Services',
    OTHERS:            'Others',
  };

  const byCategory = useMemo(() => {
    const productByCode = new Map<string, MfgProductRow>(
      (products.data ?? []).map((p) => [p.code, p]),
    );
    const classify = (p: MfgProductRow | undefined): string => {
      if (!p) return 'OTHERS';
      switch (p.category) {
        case 'BEDFRAME':  return 'BEDFRAME_SIZES';
        case 'MATTRESS':  return 'MATTRESS_SIZES';
        case 'SOFA':      return p.model_id ? 'SOFA_COMPARTMENTS' : 'SOFA_OTHER';
        case 'ACCESSORY': return 'ACCESSORIES';
        case 'SERVICE':   return 'SERVICES';
        default:          return 'OTHERS';
      }
    };
    const buckets = new Map<string, BindingRow[]>();
    for (const b of bindings) {
      const key = classify(productByCode.get(b.item_code));
      const arr = buckets.get(key) ?? [];
      arr.push(b);
      buckets.set(key, arr);
    }
    return CATEGORY_ORDER
      .filter((c) => buckets.has(c))
      .map((c) => [c, buckets.get(c)!] as const);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- CATEGORY_ORDER is a fixed display order, not a reactive value
  }, [bindings, products.data]);

  const [open, toggleOpen] = usePersistedOpen('panel-supplier-sku-mappings');

  return (
    <section className={styles.card}>
      <header
        className={styles.cardHeader}
        onClick={toggleOpen}
        aria-expanded={open}
        title={open ? 'Click to collapse' : 'Click to expand'}
        style={{ cursor: 'pointer', userSelect: 'none' }}
      >
        <h2 className={styles.cardTitle}>
          {open
            ? <ChevronDown {...SM_ICON} style={{ color: 'var(--hz-c-ink-muted)' }} />
            : <ChevronRight {...SM_ICON} style={{ color: 'var(--hz-c-ink-muted)' }} />}
          <Package {...ICON} style={{ color: 'var(--hz-c-primary-ink)' }} />
          SKU Mappings
          <span className={styles.cardTitleCount}>
            {bindings.length === 0
              ? '(no codes yet)'
              : byCategory.length === 1
                ? `(${bindings.length} ${bindings.length === 1 ? 'code' : 'codes'})`
                : `(${byCategory.length} categories · ${bindings.length} codes)`}
          </span>
        </h2>
        <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
          <AutoSuffixButton supplierId={id} bindings={bindings} />
          <Button
            variant="secondary"
            onClick={() => exportBindingsCsv(bindings, supplierCode, sofaHeights, products.data ?? [])}
            disabled={bindings.length === 0}
            title="Download CSV of every SKU mapping for this supplier"
          >
            <Download {...ICON} />
            <span>Export Bindings</span>
          </Button>
          <Button
            variant="secondary"
            onClick={() => setImporting(true)}
            title="Update existing bindings from a CSV (rows matched by internal_code)"
          >
            <Upload {...ICON} />
            <span>Import Bindings</span>
          </Button>
          <Button variant="primary" onClick={() => setSkuDialog({ mode: 'multi' })}>
            <Plus {...ICON} />
            <span>Add SKU Mappings</span>
          </Button>
        </span>
      </header>
      {importing && (
        <ImportBindingsDialog
          supplierId={id}
          bindings={bindings}
          products={products.data ?? []}
          sofaHeights={sofaHeights}
          onClose={() => setImporting(false)}
        />
      )}
      {open && (
        <UnmappedModelSkus supplierId={id} bindings={bindings} products={products.data ?? []} />
      )}
      {open && (bindings.length === 0 ? (
        <div className={styles.cardBody}>
          <p className={styles.emptyRow}>No SKU mappings yet for this supplier.</p>
        </div>
      ) : (
        byCategory.map(([category, rows]) => (
          <CategorySection
            key={category}
            label={CATEGORY_LABEL[category] ?? category}
            count={rows.length}
          >
            <SkuMappingsTable
              supplierId={id}
              bindings={rows}
              groupKind={groupKindFromCategory(category)}
              storageKey={`dg-supplier-bindings-${category.toLowerCase()}`}
              onEdit={(b) => setSkuDialog({ mode: 'edit', binding: b })}
            />
          </CategorySection>
        ))
      ))}
    </section>
  );
};

const SupplierPricingPanel = ({
  supplierId,
  supplierName,
  supplierCategory,
}: {
  supplierId: string;
  supplierName: string;
  supplierCategory: SupplierCategory | null;
}) => {
  const sectionFilter: MaintenanceSection[] =
    maintenanceSectionsForCategory(supplierCategory) ?? ['Bedframe', 'Sofa', 'Common'];
  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>
          <Tag {...ICON} style={{ color: 'var(--hz-c-primary-ink)' }} />
          Maintenance · {supplierName}
          {supplierCategory && (
            <span className={styles.cardTitleCount}>
              ({SUPPLIER_CATEGORY_LABEL[supplierCategory]} surcharges)
            </span>
          )}
        </h2>
      </header>
      <div className={styles.cardBody}>
        <MaintenanceTab
          scope={`supplier:${supplierId}`}
          sectionFilter={sectionFilter}
          singleCostColumn
          emptyHint={
            <>
              No supplier-specific surcharges yet. The master / selling-price
              config will be used by default; commander can override below
              by editing + saving a row scoped to this supplier.
            </>
          }
        />
      </div>
    </section>
  );
};

const InfoCell = ({ label, value }: { label: string; value: string }) => (
  <div className={styles.infoCell}>
    <span className={styles.infoLabel}>{label}</span>
    <span className={styles.infoValue}>{value}</span>
  </div>
);


const CategorySection = ({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
}) => {
  const [open, toggleOpen] = usePersistedOpen(`panel-skumap-${label}`);
  return (
    <div style={{ borderTop: '1px solid #d6d9d2' }}>
      <button
        type="button"
        onClick={toggleOpen}
        aria-expanded={open}
        className={styles.subGroupHead}
        style={{ borderBottom: open ? '1px solid #d6d9d2' : 'none' }}
      >
        {open
          ? <ChevronDown size={10} strokeWidth={1.75} style={{ color: 'var(--hz-c-ink-muted)' }} />
          : <ChevronRight size={10} strokeWidth={1.75} style={{ color: 'var(--hz-c-ink-muted)' }} />}
        <span>{label}</span>
        <span className={styles.subGroupHeadCount}>
          {count} {count === 1 ? 'code' : 'codes'}
        </span>
      </button>
      {open && children}
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   SKU Mappings table — inline edit (main toggle, delete) + open dialog.

   PR — Commander 2026-05-27 ("跟着 Product Maintenance 的排版"): the column
   layout now depends on which Products Maintenance sub-section the group
   belongs to. Sofa Compartments → seat-height matrix × P1/P2/P3 tier toggle.
   Bedframe Sizes → Price 1 + Price 2. Mattress / Accessory / Service / Other
   → unchanged single Unit Price column.
   ════════════════════════════════════════════════════════════════════════ */

export type SkuGroupKind = 'sofa' | 'bedframe' | 'mattress' | 'other';

function groupKindFromCategory(category: string): SkuGroupKind {
  switch (category) {
    case 'SOFA_COMPARTMENTS':
    case 'SOFA_OTHER':
      return 'sofa';
    case 'BEDFRAME_SIZES':
      return 'bedframe';
    case 'MATTRESS_SIZES':
      return 'mattress';
    default:
      return 'other';
  }
}

const SkuMappingsTable = ({
  supplierId,
  bindings,
  groupKind,
  storageKey,
  onEdit,
}: {
  supplierId: string;
  bindings: BindingRow[];
  groupKind: SkuGroupKind;
  storageKey: string;
  onEdit: (b: BindingRow) => void;
}) => {
  if (bindings.length === 0) {
    return (
      <div className={styles.cardBody}>
        <p className={styles.emptyRow}>No SKU mappings yet for this supplier.</p>
      </div>
    );
  }

  if (groupKind === 'sofa') {
    return (
      <SofaSkuMappingsTable
        supplierId={supplierId}
        bindings={bindings}
        storageKey={storageKey}
        onEdit={onEdit}
      />
    );
  }
  if (groupKind === 'bedframe') {
    return (
      <BedframeSkuMappingsTable
        supplierId={supplierId}
        bindings={bindings}
        storageKey={storageKey}
        onEdit={onEdit}
      />
    );
  }
  return (
    <DefaultSkuMappingsTable
      supplierId={supplierId}
      bindings={bindings}
      storageKey={storageKey}
      onEdit={onEdit}
    />
  );
};

/* ────────────────────────────────────────────────────────────────────────
   DataGrid conversion (owner request 2026-06-12) — the three SKU mapping
   table variants now render through the shared DataGrid, gaining sorting,
   per-column filters, column show/hide, reorder/pin and layout persistence.
   Inline cell editors (supplier SKU, prices), the Main star and the row
   Edit/Delete actions are preserved inside cell accessors; CellStop keeps
   clicks in those editors from bubbling into the grid's row handlers
   (mirrors the old td-level stopPropagation).
   ──────────────────────────────────────────────────────────────────────── */

const CellStop = ({ children }: { children: React.ReactNode }) => (
  <span
    onClick={(e) => e.stopPropagation()}
    onDoubleClick={(e) => e.stopPropagation()}
    style={{ display: 'inline-flex', alignItems: 'center' }}
  >
    {children}
  </span>
);

const bindingRowKey = (b: BindingRow) => b.id;

function bindingHeadColumns(
  supplierId: string,
  update: ReturnType<typeof useUpdateBinding>,
): GridColumn<BindingRow>[] {
  return [
    {
      key: 'code',
      label: 'Internal Code',
      width: 150,
      accessor: (b) => <span className={styles.codeCell}>{b.item_code}</span>,
      searchValue: (b) => b.item_code,
      filterValue: (b) => b.item_code,
      sortFn: (a, b) => (a.item_code ?? '').localeCompare(b.item_code ?? ''),
    },
    {
      key: 'name',
      label: 'Internal Description',
      width: 220,
      accessor: (b) => b.material_name,
    },
    {
      key: 'sku',
      label: 'Supplier SKU',
      width: 150,
      accessor: (b) => (
        <CellStop>
          <InlineSupplierSku binding={b} supplierId={supplierId} update={update} />
        </CellStop>
      ),
      searchValue: (b) => b.supplier_sku,
      filterValue: (b) => b.supplier_sku,
      sortFn: (a, b) => (a.supplier_sku ?? '').localeCompare(b.supplier_sku ?? ''),
    },
  ];
}

function bindingTailColumns(
  supplierId: string,
  update: ReturnType<typeof useUpdateBinding>,
  remove: ReturnType<typeof useDeleteBinding>,
  onEdit: (b: BindingRow) => void,
  setAnchor: ReturnType<typeof useSetCostAnchor>,
): GridColumn<BindingRow>[] {
  return [
    {
      key: 'lead',
      label: 'Lead',
      width: 70,
      align: 'right',
      accessor: (b) => `${b.lead_time_days}d`,
      filterValue: (b) => `${b.lead_time_days}d`,
      sortFn: (a, b) => a.lead_time_days - b.lead_time_days,
    },
    {
      key: 'moq',
      label: 'MOQ',
      width: 70,
      align: 'right',
      accessor: (b) => String(b.moq),
      sortFn: (a, b) => a.moq - b.moq,
    },
    {
      key: 'matrix',
      label: 'Matrix',
      width: 70,
      accessor: (b) => (b.price_matrix ? 'Yes' : '—'),
      filterValue: (b) => (b.price_matrix ? 'Yes' : '—'),
      sortFn: (a, b) => Number(Boolean(a.price_matrix)) - Number(Boolean(b.price_matrix)),
    },
    {
      key: 'anchor',
      label: 'Cost anchor',
      width: 100,
      accessor: (b) => (
        <CellStop>
          <AnchorCell binding={b} supplierId={supplierId} setAnchor={setAnchor} />
        </CellStop>
      ),
      searchValue: (b) => (b.is_cost_anchor ? 'anchor' : ''),
      filterValue: (b) => (b.is_cost_anchor ? 'Anchored' : '—'),
      sortFn: (a, b) => Number(a.is_cost_anchor) - Number(b.is_cost_anchor),
    },
    {
      key: 'main',
      label: 'Main',
      width: 90,
      accessor: (b) => (
        <CellStop>
          <MainStarCell binding={b} supplierId={supplierId} update={update} />
        </CellStop>
      ),
      searchValue: (b) => (b.is_main_supplier ? 'main' : ''),
      filterValue: (b) => (b.is_main_supplier ? 'Main' : '—'),
      sortFn: (a, b) => Number(a.is_main_supplier) - Number(b.is_main_supplier),
    },
    {
      key: 'actions',
      label: 'Actions',
      width: 90,
      align: 'right',
      sortable: false,
      groupable: false,
      accessor: (b) => (
        <CellStop>
          <RowActionsCell binding={b} supplierId={supplierId} remove={remove} onEdit={onEdit} />
        </CellStop>
      ),
      searchValue: () => '',
    },
  ];
}


const DefaultSkuMappingsTable = ({
  supplierId,
  bindings,
  storageKey,
  onEdit,
}: {
  supplierId: string;
  bindings: BindingRow[];
  storageKey: string;
  onEdit: (b: BindingRow) => void;
}) => {
  const update = useUpdateBinding();
  const remove = useDeleteBinding();
  const setAnchor = useSetCostAnchor();

  const columns = useMemo<GridColumn<BindingRow>[]>(() => [
    ...bindingHeadColumns(supplierId, update),
    {
      key: 'price',
      label: 'Unit Price',
      width: 130,
      align: 'right',
      accessor: (b) => (
        <CellStop>
          <InlineUnitPrice binding={b} supplierId={supplierId} update={update} />
        </CellStop>
      ),
      searchValue: (b) => fmtCurrency(b.unit_price_sen, b.currency),
      filterValue: (b) => fmtCurrency(b.unit_price_sen, b.currency),
      sortFn: (a, b) => a.unit_price_sen - b.unit_price_sen,
    },
    ...bindingTailColumns(supplierId, update, remove, onEdit, setAnchor),
  ], [supplierId, update, remove, onEdit, setAnchor]);

  return (
    <DataGridCompat
      rows={bindings}
      columns={columns}
      storageKey={storageKey}
      exportName="Supplier Materials"
      rowKey={bindingRowKey}
      searchPlaceholder="Search mappings…"
      onRowDoubleClick={onEdit}
      groupBanner={false}
      emptyMessage="No SKU mappings yet for this supplier."
    />
  );
};


const SOFA_TIER_CHIPS: { value: 'P1' | 'P2' | 'P3' | 'P4'; label: string }[] = [
  { value: 'P1', label: 'P1' },
  { value: 'P2', label: 'P2' },
  { value: 'P3', label: 'P3 (HL)' },
  { value: 'P4', label: 'P4 (FL)' },
];

const SOFA_HEIGHT_FALLBACK = ['24', '26', '28', '30', '32', '35'];

/** Column header for a seat-height. Pool values are free text: a bare number
 *  gains its inch mark, anything typed with one (`25"`) or a word (`DEFAULT`)
 *  shows as typed, so the header never reads `25""`. */
export const seatHeightLabel = (h: string): string => (/^\d+(\.\d+)?$/.test(h.trim()) ? `${h.trim()}"` : h);

const SofaSkuMappingsTable = ({
  supplierId,
  bindings,
  storageKey,
  onEdit,
}: {
  supplierId: string;
  bindings: BindingRow[];
  storageKey: string;
  onEdit: (b: BindingRow) => void;
}) => {
  const update = useUpdateBinding();
  const remove = useDeleteBinding();
  const setAnchor = useSetCostAnchor();
  const [selectedTier, setSelectedTier] = useState<'P1' | 'P2' | 'P3' | 'P4'>('P2');

  const config = useMaintenanceConfig('master');
  const heights = useMemo(
    () => (config.data?.data?.sofaSizes
      ? maintValues(config.data.data.sofaSizes)
      : SOFA_HEIGHT_FALLBACK.map(String)),
    [config.data],
  );

  const columns = useMemo<GridColumn<BindingRow>[]>(() => [
    ...bindingHeadColumns(supplierId, update),
    ...heights.map<GridColumn<BindingRow>>((h) => ({
      key: `h-${h}`,
      label: seatHeightLabel(h),
      width: 130,
      align: 'right',
      accessor: (b) => (
        <CellStop>
          <InlineSofaMatrixCell
            binding={b}
            supplierId={supplierId}
            update={update}
            height={h}
            tier={selectedTier}
          />
        </CellStop>
      ),
      searchValue: () => '',
      filterValue: (b) => {
        const sen = readSofaCell(b.price_matrix, h, selectedTier);
        return sen == null ? '—' : fmtCurrency(sen, b.currency);
      },
      sortFn: (a, b) =>
        (readSofaCell(a.price_matrix, h, selectedTier) ?? -1)
        - (readSofaCell(b.price_matrix, h, selectedTier) ?? -1),
    })),
    ...bindingTailColumns(supplierId, update, remove, onEdit, setAnchor),
  ], [supplierId, update, remove, onEdit, setAnchor, heights, selectedTier]);

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          padding: '4px var(--space-3)',
          borderBottom: '1px solid #d6d9d2',
          background: 'var(--hz-c-surface)',
        }}
      >
        <span style={{ fontSize: 'var(--fs-9)', fontWeight: 700, color: 'var(--hz-c-ink-muted)', textTransform: 'uppercase', letterSpacing: '0.12em' }}>
          Fabric tier
        </span>
        {SOFA_TIER_CHIPS.map((c) => (
          <button
            key={c.value}
            type="button"
            aria-pressed={selectedTier === c.value}
            onClick={() => setSelectedTier(c.value)}
            style={{
              fontFamily: 'var(--font-button)',
              fontSize: 'var(--fs-11)',
              fontWeight: 600,
              padding: '1px 10px',
              borderRadius: 'var(--radius-pill)',
              border: selectedTier === c.value ? '1px solid #11140f' : '1px solid var(--hz-c-border)',
              background: selectedTier === c.value ? '#11140f' : 'var(--hz-c-surface)',
              color: selectedTier === c.value ? '#f4f6f3' : 'var(--hz-c-ink)',
              cursor: 'pointer',
            }}
          >
            {c.label}
          </button>
        ))}
        <span style={{ marginInlineStart: 'var(--space-2)', fontSize: 'var(--fs-10)', color: 'var(--fg-soft)' }}>
          Cost per (seat-height × tier). Empty cell = "no price set".
        </span>
      </div>

      <DataGridCompat
        rows={bindings}
        columns={columns}
        storageKey={storageKey}
        exportName="Supplier Materials"
        rowKey={bindingRowKey}
        searchPlaceholder="Search mappings…"
        onRowDoubleClick={onEdit}
        groupBanner={false}
        emptyMessage="No SKU mappings yet for this supplier."
      />
    </div>
  );
};


const BedframeSkuMappingsTable = ({
  supplierId,
  bindings,
  storageKey,
  onEdit,
}: {
  supplierId: string;
  bindings: BindingRow[];
  storageKey: string;
  onEdit: (b: BindingRow) => void;
}) => {
  const update = useUpdateBinding();
  const remove = useDeleteBinding();
  const setAnchor = useSetCostAnchor();

  const columns = useMemo<GridColumn<BindingRow>[]>(() => [
    ...bindingHeadColumns(supplierId, update),
    ...(['P1', 'P2'] as const).map<GridColumn<BindingRow>>((tier) => ({
      key: `price-${tier}`,
      label: tier === 'P1' ? 'Price 1' : 'Price 2',
      width: 130,
      align: 'right',
      accessor: (b) => (
        <CellStop>
          <InlineBedframeMatrixCell
            binding={b}
            supplierId={supplierId}
            update={update}
            tier={tier}
          />
        </CellStop>
      ),
      searchValue: () => '',
      filterValue: (b) => {
        const sen = readBedframeCell(b.price_matrix, tier);
        return sen == null ? '—' : fmtCurrency(sen, b.currency);
      },
      sortFn: (a, b) =>
        (readBedframeCell(a.price_matrix, tier) ?? -1)
        - (readBedframeCell(b.price_matrix, tier) ?? -1),
    })),
    ...bindingTailColumns(supplierId, update, remove, onEdit, setAnchor),
  ], [supplierId, update, remove, onEdit, setAnchor]);

  return (
    <DataGridCompat
      rows={bindings}
      columns={columns}
      storageKey={storageKey}
      exportName="Supplier Materials"
      rowKey={bindingRowKey}
      searchPlaceholder="Search mappings…"
      onRowDoubleClick={onEdit}
      groupBanner={false}
      emptyMessage="No SKU mappings yet for this supplier."
    />
  );
};


const MainStarCell = ({
  binding,
  supplierId,
  update,
}: {
  binding: BindingRow;
  supplierId: string;
  update: ReturnType<typeof useUpdateBinding>;
}) => (
  <>
    <button
      type="button"
      className={styles.iconBtn}
      title={binding.is_main_supplier ? 'Main supplier' : 'Set as main'}
      onClick={(e) => {
        e.stopPropagation();
        update.mutate(
          { supplierId, bindingId: binding.id, isMainSupplier: !binding.is_main_supplier },
          { onError: writeFailed },
        );
      }}
    >
      <Star
        size={16}
        strokeWidth={1.75}
        fill={binding.is_main_supplier ? 'currentColor' : 'none'}
        style={{ color: binding.is_main_supplier ? 'var(--hz-c-primary-ink)' : 'var(--hz-c-ink-muted)' }}
      />
    </button>
    {binding.is_main_supplier && <span className={styles.mainPill}>Main</span>}
  </>
);

const looksLikeSofaMatrix = (m: PriceMatrix | null): boolean => {
  if (!m || typeof m !== 'object') return false;
  return Object.values(m as Record<string, unknown>).some(
    (v) => v !== null && typeof v === 'object',
  );
};

const AnchorCell = ({
  binding,
  supplierId,
  setAnchor,
}: {
  binding: BindingRow;
  supplierId: string;
  setAnchor: ReturnType<typeof useSetCostAnchor>;
}) => {
  const askConfirm = useConfirm();
  const anchored = binding.is_cost_anchor;
  if (binding.material_kind !== 'mfg_product') {
    return <span className={styles.muted}>—</span>;
  }
  const sofaSkipped = looksLikeSofaMatrix(binding.price_matrix);
  const title = anchored
    ? 'Cost anchor ON — this supplier’s cost ⇄ product cost stay in sync. Click to unlink.'
    : sofaSkipped
      ? 'Set as cost anchor. Note: sofa per-height cost is NOT auto-synced (phase-2).'
      : 'Set as cost anchor — links this supplier’s cost to the product’s cost (both update together).';
  return (
    <>
      <button
        type="button"
        className={styles.iconBtn}
        title={title}
        disabled={setAnchor.isPending}
        onClick={async (e) => {
          e.stopPropagation();
          if (!anchored) {
            const ok = await askConfirm({
              title: `Anchor ${binding.item_code} to this supplier’s cost?`,
              body:
                `Product-Maintenance cost will be kept equal to this supplier’s cost ` +
                `(editing either side updates the other).` +
                (sofaSkipped ? `\n\nNote: sofa per-height cost is not auto-synced.` : ''),
              confirmLabel: 'Anchor',
            });
            if (!ok) return;
          }
          setAnchor.mutate({ supplierId, bindingId: binding.id, anchor: !anchored });
        }}
      >
        <Anchor
          size={16}
          strokeWidth={1.75}
          fill={anchored ? 'currentColor' : 'none'}
          style={{ color: anchored ? 'var(--hz-c-primary-ink)' : 'var(--hz-c-ink-muted)' }}
        />
      </button>
      {anchored && <span className={styles.mainPill}>Anchor</span>}
    </>
  );
};

const RowActionsCell = ({
  binding,
  supplierId,
  remove,
  onEdit,
}: {
  binding: BindingRow;
  supplierId: string;
  remove: ReturnType<typeof useDeleteBinding>;
  onEdit: (b: BindingRow) => void;
}) => {
  const askConfirm = useConfirm();
  return (
  <span className={styles.actionsCell}>
    <button
      type="button"
      className={styles.iconBtn}
      title="Edit"
      onClick={(e) => {
        e.stopPropagation();
        onEdit(binding);
      }}
    >
      <Pencil {...SM_ICON} />
    </button>
    <button
      type="button"
      className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
      title="Delete"
      onClick={async (e) => {
        e.stopPropagation();
        if (await askConfirm({
          title: `Remove mapping ${binding.item_code} → ${binding.supplier_sku}?`,
          confirmLabel: 'Remove',
          danger: true,
        })) {
          remove.mutate({ supplierId, bindingId: binding.id });
        }
      }}
    >
      <Trash2 {...SM_ICON} />
    </button>
  </span>
  );
};


const InlineSupplierSku = ({
  binding, supplierId, update,
}: {
  binding: BindingRow;
  supplierId: string;
  update: ReturnType<typeof useUpdateBinding>;
}) => {
  const [draft, setDraft] = useState(binding.supplier_sku);
  const [committed, setCommitted] = useState(binding.supplier_sku);
  if (committed !== binding.supplier_sku) {
    setCommitted(binding.supplier_sku);
    setDraft(binding.supplier_sku);
  }
  const commit = () => {
    const next = draft.trim();
    if (next === binding.supplier_sku) return;
    if (!next) { setDraft(binding.supplier_sku); return; }
    update.mutate({ supplierId, bindingId: binding.id, supplierSku: next }, { onError: writeFailed });
  };
  return (
    <input
      className={styles.inlineSku}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
        if (e.key === 'Escape') { setDraft(binding.supplier_sku); (e.target as HTMLInputElement).blur(); }
      }}
      title="Click to edit · Enter to save · Esc to cancel"
    />
  );
};

const InlineUnitPrice = ({
  binding, supplierId, update,
}: {
  binding: BindingRow;
  supplierId: string;
  update: ReturnType<typeof useUpdateBinding>;
}) => {
  return (
    <MoneyInput
      valueSen={binding.unit_price_sen}
      currency={binding.currency === 'MYR' ? 'RM' : binding.currency}
      onCommit={(sen) => {
        const next = sen ?? 0;
        if (next === binding.unit_price_sen) return;
        update.mutate({ supplierId, bindingId: binding.id, unitPriceSen: next }, { onError: writeFailed });
      }}
    />
  );
};


function readSofaCell(
  matrix: PriceMatrix | null,
  height: string,
  tier: 'P1' | 'P2' | 'P3' | 'P4',
): number | null {
  if (!matrix || typeof matrix !== 'object') return null;
  const m = matrix as SofaPriceMatrix;
  const row = m[height];
  if (!row || typeof row !== 'object') return null;
  const v = row[tier];
  return typeof v === 'number' ? v : null;
}

function readBedframeCell(
  matrix: PriceMatrix | null,
  tier: 'P1' | 'P2',
): number | null {
  if (!matrix || typeof matrix !== 'object') return null;
  const m = matrix as BedframePriceMatrix;
  const v = m[tier];
  return typeof v === 'number' ? v : null;
}

function setSofaCell(
  matrix: PriceMatrix | null,
  height: string,
  tier: 'P1' | 'P2' | 'P3' | 'P4',
  valueSen: number | null,
): SofaPriceMatrix | null {
  const next: SofaPriceMatrix = { ...(matrix as SofaPriceMatrix | null ?? {}) };
  const innerSrc = (next[height] ?? {}) as { P1?: number; P2?: number; P3?: number; P4?: number };
  const inner: { P1?: number; P2?: number; P3?: number; P4?: number } = { ...innerSrc };
  if (valueSen == null || valueSen === 0) {
    delete inner[tier];
  } else {
    inner[tier] = valueSen;
  }
  if (Object.keys(inner).length === 0) delete next[height];
  else next[height] = inner;
  return Object.keys(next).length === 0 ? null : next;
}

function setBedframeCell(
  matrix: PriceMatrix | null,
  tier: 'P1' | 'P2',
  valueSen: number | null,
): BedframePriceMatrix | null {
  const next: BedframePriceMatrix = { ...(matrix as BedframePriceMatrix | null ?? {}) };
  if (valueSen == null || valueSen === 0) {
    delete next[tier];
  } else {
    next[tier] = valueSen;
  }
  return Object.keys(next).length === 0 ? null : next;
}

const MatrixPriceInput = ({
  valueSen,
  currency,
  onCommit,
  placeholder,
}: {
  valueSen: number | null;
  currency: Currency;
  onCommit: (v: number | null) => void;
  placeholder?: string;
}) => {
  return (
    <MoneyInput
      valueSen={valueSen}
      currency={currency === 'MYR' ? 'RM' : currency}
      allowBlank
      placeholder={placeholder ?? '—'}
      onCommit={onCommit}
      title="Click to edit · Enter to save · Esc to cancel · blank to clear"
    />
  );
};

const InlineSofaMatrixCell = ({
  binding,
  supplierId,
  update,
  height,
  tier,
}: {
  binding: BindingRow;
  supplierId: string;
  update: ReturnType<typeof useUpdateBinding>;
  height: string;
  tier: 'P1' | 'P2' | 'P3' | 'P4';
}) => {
  const valueSen = readSofaCell(binding.price_matrix, height, tier);
  return (
    <MatrixPriceInput
      valueSen={valueSen}
      currency={binding.currency}
      onCommit={(v) => {
        const next = setSofaCell(binding.price_matrix, height, tier, v);
        update.mutate({ supplierId, bindingId: binding.id, priceMatrix: next }, { onError: writeFailed });
      }}
    />
  );
};

const InlineBedframeMatrixCell = ({
  binding,
  supplierId,
  update,
  tier,
}: {
  binding: BindingRow;
  supplierId: string;
  update: ReturnType<typeof useUpdateBinding>;
  tier: 'P1' | 'P2';
}) => {
  const valueSen = readBedframeCell(binding.price_matrix, tier);
  return (
    <MatrixPriceInput
      valueSen={valueSen}
      currency={binding.currency}
      onCommit={(v) => {
        const next = setBedframeCell(binding.price_matrix, tier, v);
        update.mutate({ supplierId, bindingId: binding.id, priceMatrix: next }, { onError: writeFailed });
      }}
    />
  );
};


const AutoSuffixButton = ({
  supplierId, bindings,
}: { supplierId: string; bindings: BindingRow[] }) => {
  const products = useMfgProducts();
  const update = useUpdateBinding();
  const [running, setRunning] = useState(false);
  const askConfirm = useConfirm();

  const candidates = useMemo(() => {
    const byKey = new Map<string, BindingRow[]>();
    for (const b of bindings) {
      if (!looksAmbiguous(b.supplier_sku)) continue;
      const arr = byKey.get(b.supplier_sku) ?? [];
      arr.push(b);
      byKey.set(b.supplier_sku, arr);
    }
    const list: BindingRow[] = [];
    for (const arr of byKey.values()) if (arr.length >= 2) list.push(...arr);
    return list;
  }, [bindings]);

  if (candidates.length === 0) return null;

  const onClick = async () => {
    if (running) return;
    const productsByCode = new Map((products.data ?? []).map((p) => [p.code, p]));
    const ok = await askConfirm({
      title: `Auto-suffix ${candidates.length} binding${candidates.length === 1 ? '' : 's'}?`,
      body: 'Each row will get its per-SKU suffix appended to its current supplier_sku (e.g. "5539" → "5539-1A(LHF)").',
      confirmLabel: 'Auto-suffix',
    });
    if (!ok) return;
    setRunning(true);
    try {
      for (const b of candidates) {
        const p = productsByCode.get(b.item_code);
        if (!p) continue;
        const next = composeSupplierSku(b.supplier_sku, p);
        if (next === b.supplier_sku) continue;
        await update.mutateAsync({ supplierId, bindingId: b.id, supplierSku: next });
      }
    } finally {
      setRunning(false);
    }
  };

  return (
    <Button variant="secondary" onClick={onClick} disabled={running}>
      <span>
        {running
          ? 'Auto-suffixing…'
          : `Auto-suffix supplier_sku · ${candidates.length}`}
      </span>
    </Button>
  );
};


type LastPo = {
  id: string;
  poNo: string;
  status: string;
  poDate: string;
  expectedDate: string | null;
  receivedDate: string | null;
  totalSen: number;
  orderedQty: number;
  receivedQty: number;
};

const deltaClass = (tone: string) => (tone === 'ok' ? styles.deltaOk : tone === 'late' ? styles.deltaLate : styles.deltaNeutral);
const LAST_PO_COLUMNS: Column<LastPo>[] = [
  { key: 'po', label: 'PO No.', render: (po) => <Link to={`/scm/purchase-orders?focus=${po.id}`} style={{ color: 'inherit' }}>{po.poNo}</Link>, getValue: (po) => po.poNo },
  { key: 'status', label: 'Status', render: (po) => statusLabel('po', po.status), getValue: (po) => po.status },
  { key: 'ordered', label: 'Ordered', align: 'right', render: (po) => fmtQty(po.orderedQty), getValue: (po) => po.orderedQty, exportFormat: 'number' },
  { key: 'received', label: 'Received', align: 'right', render: (po) => fmtQty(po.receivedQty), getValue: (po) => po.receivedQty, exportFormat: 'number' },
  { key: 'total', label: 'Total', align: 'right', render: (po) => fmtSen(po.totalSen), getValue: (po) => po.totalSen, exportValue: (po) => po.totalSen / 100, exportFormat: 'money' },
  { key: 'expected', label: 'Expected', render: (po) => fmtDateOrDash(po.expectedDate), getValue: (po) => po.expectedDate, exportFormat: 'date' },
  { key: 'actual', label: 'Actual', render: (po) => fmtDateOrDash(po.receivedDate), getValue: (po) => po.receivedDate, exportFormat: 'date' },
  {
    key: 'delta', label: 'Delta',
    render: (po) => { const d = deliveryDelta(po.expectedDate, po.receivedDate); return <span className={deltaClass(d.tone)}>{d.label}</span>; },
    getValue: (po) => deliveryDelta(po.expectedDate, po.receivedDate).label,
  },
];

const LastTenPOsTable = ({ rows }: { rows: LastPo[] }) => (
  <DataTable<LastPo>
    tableId="supplier-last-pos"
    exportName="supplier-last-pos"
    exportXlsx
    columns={LAST_PO_COLUMNS}
    rows={rows}
    emptyLabel="No purchase orders found for this supplier."
    getRowKey={(po) => po.id}
  />
);


type SkuDraft = {
  materialKind: MaterialKind;
  itemCode: string;
  acItemCode: string;
  materialName: string;
  supplierSku: string;
  unitPriceSen: number;
  currency: Currency;
  leadTimeDays: number;
  moq: number;
  isMainSupplier: boolean;
  paymentTermsOverride: string;
  notes: string;
};

const SkuFormDialog = ({
  supplierId,
  editing,
  onClose,
}: {
  supplierId: string;
  editing: BindingRow | null;
  onClose: () => void;
}) => {
  const create = useCreateBinding();
  const update = useUpdateBinding();
  const notify = useNotify();
  const products = useMfgProducts();

  const [draft, setDraft] = useState<SkuDraft>(() =>
    editing
      ? {
          materialKind: editing.material_kind,
          itemCode: editing.item_code,
          acItemCode: editing.ac_item_code ?? '',
          materialName: editing.material_name,
          supplierSku: editing.supplier_sku,
          unitPriceSen: editing.unit_price_sen,
          currency: editing.currency,
          leadTimeDays: editing.lead_time_days,
          moq: editing.moq,
          isMainSupplier: editing.is_main_supplier,
          paymentTermsOverride: editing.payment_terms_override ?? '',
          notes: editing.notes ?? '',
        }
      : {
          materialKind: 'mfg_product',
          itemCode: '',
          acItemCode: '',
          materialName: '',
          supplierSku: '',
          unitPriceSen: 0,
          currency: 'MYR',
          leadTimeDays: 0,
          moq: 0,
          isMainSupplier: false,
          paymentTermsOverride: '',
          notes: '',
        },
  );

  const findProductByCode = (code: string): MfgProductRow | null => {
    if (!code.trim()) return null;
    const wanted = code.trim().toUpperCase();
    return (products.data ?? []).find((p) => (p.code ?? '').toUpperCase() === wanted) ?? null;
  };

  const supplierSkuRef = useRef(draft.supplierSku);
  supplierSkuRef.current = draft.supplierSku;
  useEffect(() => {
    if (editing) return;
    if (draft.materialKind !== 'mfg_product') return;
    if (supplierSkuRef.current.trim()) return;
    const p = findProductByCode(draft.itemCode);
    if (!p) return;
    const next = composeSupplierSku(draft.itemCode, p);
    if (!next || next === supplierSkuRef.current) return;
    setDraft((s) => ({
      ...s,
      materialName: s.materialName.trim() || (p.name ?? s.materialName),
      supplierSku: next,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.itemCode, draft.materialKind, products.data, editing]);

  const skuPreview = useMemo(() => {
    if (draft.materialKind !== 'mfg_product') return null;
    const code = draft.itemCode.trim();
    if (!code) return null;
    const p = findProductByCode(code);
    if (!p) return null;
    const composed = composeSupplierSku(code, p);
    if (!composed) return null;
    const current = draft.supplierSku.trim();
    const overridden = current.length > 0 && current !== composed;
    return { composed, overridden, current };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- findProductByCode reads products.data
  }, [draft.materialKind, draft.itemCode, draft.supplierSku, products.data]);

  const submit = () => {
    if (!draft.itemCode.trim() || !draft.materialName.trim() || !draft.supplierSku.trim()) {
      notify({ title: 'Internal code, description and supplier SKU are required.', tone: 'error' });
      return;
    }
    const onError = (err: unknown) => notify({
      title: 'Save failed',
      body: err instanceof Error ? err.message : 'Something went wrong.',
      tone: 'error',
    });
    if (editing) {
      update.mutate(
        { supplierId, bindingId: editing.id, ...draft },
        { onSuccess: onClose, onError },
      );
    } else {
      create.mutate({ supplierId, ...draft }, { onSuccess: onClose, onError });
    }
  };

  const set = <K extends keyof SkuDraft>(k: K, v: SkuDraft[K]) =>
    setDraft((s) => ({ ...s, [k]: v }));

  const pending = create.isPending || update.isPending;

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <header className={styles.modalHeader}>
          <h3 className={styles.modalTitle}>
            {editing ? 'Edit SKU Mapping' : 'Add SKU Mapping'}
          </h3>
          <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Close">
            <X {...ICON} />
          </button>
        </header>

        <div className={styles.modalBody}>
          <div className={styles.formGrid}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Material Kind</span>
              <span className={styles.selectWrap}>
                <select
                  className={styles.fieldSelect}
                  value={draft.materialKind}
                  onChange={(e) => set('materialKind', e.target.value as MaterialKind)}
                >
                  <option value="mfg_product">Manufacturing SKU</option>
                  <option value="fabric">Fabric</option>
                  <option value="raw">Raw material</option>
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Currency</span>
              <span className={styles.selectWrap}>
                <select
                  className={styles.fieldSelect}
                  value={draft.currency}
                  onChange={(e) => set('currency', e.target.value as Currency)}
                >
                  <option>MYR</option>
                  <option>RMB</option>
                  <option>USD</option>
                  <option>SGD</option>
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Our Internal Code *</span>
              <input
                className={styles.fieldInput}
                placeholder="e.g. 1003-(K), AVANI 01"
                value={draft.itemCode}
                onChange={(e) => set('itemCode', e.target.value)}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Supplier SKU *</span>
              <input
                className={styles.fieldInput}
                placeholder="Their code"
                value={draft.supplierSku}
                onChange={(e) => set('supplierSku', e.target.value)}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>AutoCount Item Code</span>
              <input className={styles.fieldInput} placeholder="Its code in AutoCount (optional)"
                value={draft.acItemCode} onChange={(e) => set('acItemCode', e.target.value)} />
            </label>

            {skuPreview && (
              <div
                className={styles.formGridFull}
                style={{
                  fontSize: 'var(--fs-11)', color: 'var(--hz-c-ink-muted)',
                  padding: '6px 2px', lineHeight: 1.5,
                }}
              >
                <span style={{
                  fontFamily: 'var(--font-button)', fontSize: 'var(--fs-10)',
                  letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--hz-c-primary-ink)',
                }}>Supplier SKU → </span>
                <code style={{ fontWeight: 700, color: 'var(--hz-c-ink)' }}>{skuPreview.composed}</code>
                {skuPreview.overridden && (
                  <span> · overridden (using <code style={{ fontWeight: 700, color: 'var(--hz-c-ink)' }}>{skuPreview.current}</code>)</span>
                )}
              </div>
            )}

            <label className={`${styles.field} ${styles.formGridFull}`}>
              <span className={styles.fieldLabel}>Internal Description *</span>
              <input
                className={styles.fieldInput}
                placeholder="e.g. HILTON BEDFRAME (6FT)"
                value={draft.materialName}
                onChange={(e) => set('materialName', e.target.value)}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Unit Price</span>
              <MoneyInput
                bare
                valueSen={draft.unitPriceSen}
                inputClassName={styles.fieldInput}
                align="left"
                onCommit={(sen) => set('unitPriceSen', sen ?? 0)}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Lead Time (days)</span>
              <NumberInput sign="unsigned" decimal={false} className={styles.fieldInput} value={draft.leadTimeDays}
                onValueChange={(n) => set('leadTimeDays', n ?? 0)} />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>MOQ</span>
              <NumberInput sign="unsigned" decimal={false} className={styles.fieldInput} value={draft.moq}
                onValueChange={(n) => set('moq', n ?? 0)} />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Payment Terms Override</span>
              <input className={styles.fieldInput} placeholder="e.g. 30% deposit, balance on delivery"
                value={draft.paymentTermsOverride} onChange={(e) => set('paymentTermsOverride', e.target.value)} />
            </label>

            <div className={`${styles.field} ${styles.formGridFull}`}>
              <label className={styles.checkRow}>
                <input
                  type="checkbox"
                  checked={draft.isMainSupplier}
                  onChange={(e) => set('isMainSupplier', e.target.checked)}
                />
                <span className={styles.fieldLabel} style={{ margin: 0 }}>
                  Set as MAIN supplier for this material
                </span>
              </label>
            </div>

            <label className={`${styles.field} ${styles.formGridFull}`}>
              <span className={styles.fieldLabel}>Notes</span>
              <textarea
                className={styles.fieldInput}
                placeholder="Free-text note for this supplier mapping"
                value={draft.notes}
                onChange={(e) => set('notes', e.target.value)}
                style={{ minHeight: 60, resize: 'vertical' }}
              />
            </label>
          </div>

          {editing && <BindingPriceTimeline supplierId={supplierId} binding={editing} />}
        </div>

        <footer className={styles.modalFooter}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={pending}>
            {pending ? 'Saving…' : editing ? 'Save Changes' : 'Add Mapping'}
          </Button>
        </footer>
      </div>
    </div>
  );
};

const BindingPriceTimeline = ({ supplierId, binding }: { supplierId: string; binding: BindingRow }) => {
  const history = useBindingPriceHistory(supplierId, binding.id);
  const schedule = useScheduleBindingPrice();
  const notify = useNotify();
  const [effectiveFrom, setEffectiveFrom] = useState(() => todayMyt());
  const [priceSen, setPriceSen] = useState<number>(binding.unit_price_sen);

  const rows: BindingPriceChange[] = history.data?.history ?? [];

  const submit = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      void notify({ title: 'Pick a valid date.', tone: 'error' });
      return;
    }
    schedule.mutate(
      { supplierId, bindingId: binding.id, effectiveFrom, unitPriceSen: priceSen },
      {
        onSuccess: (r) => notify({
          title: r.applied
            ? 'Price applied — it is the current cost from today.'
            : r.baselined
              ? `Price scheduled for ${effectiveFrom} (current cost baselined at today).`
              : `Price scheduled for ${effectiveFrom}.`,
        }),
        onError: (e) => notify({ title: 'Schedule failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' }),
      },
    );
  };

  return (
    <div className={styles.formGridFull} style={{ marginTop: 'var(--space-4)', borderTop: '1px solid var(--line)', paddingTop: 'var(--space-3)' }}>
      <span className={styles.fieldLabel}>Supplier price timeline</span>
      <p style={{ fontSize: 'var(--fs-11)', color: 'var(--hz-c-ink-muted)', margin: '2px 0 10px' }}>
        The unit cost this supplier charges, by date. A scheduled price becomes the current cost on its date (POs and the Product Maintenance cost follow). Past orders are never touched.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
        <label className={styles.field} style={{ margin: 0 }}>
          <span className={styles.fieldLabel}>Effective from</span>
          <DateField className={styles.fieldInput} value={effectiveFrom} onChange={(iso) => setEffectiveFrom(iso)} />
        </label>
        <label className={styles.field} style={{ margin: 0 }}>
          <span className={styles.fieldLabel}>Unit price</span>
          <MoneyInput bare valueSen={priceSen} inputClassName={styles.fieldInput} align="left" onCommit={(sen) => setPriceSen(sen ?? 0)} />
        </label>
        <Button variant="secondary" onClick={submit} disabled={schedule.isPending}>
          {schedule.isPending ? 'Scheduling…' : 'Schedule price'}
        </Button>
      </div>
      <EffectiveDatedHistory
        rows={rows}
        rowKey={(r) => r.id}
        effectiveFrom={(r) => r.effective_from}
        loading={history.isLoading}
        emptyLabel="No scheduled or past supplier prices yet."
        renderRow={(r) => (
          <div style={{ fontSize: 'var(--fs-13)', marginTop: 2 }}>
            <strong style={{ fontFamily: 'var(--font-mono, monospace)' }}>{fmtSen(r.unit_price_sen ?? 0)}</strong>
            {r.notes ? <span style={{ color: 'var(--fg-soft)', marginLeft: 8 }}>{r.notes}</span> : null}
          </div>
        )}
      />
    </div>
  );
};


const SupplierInfoCard = ({
  supplier,
  editing,
  onEdit,
  onClose,
}: {
  supplier: SupplierRow;
  editing: boolean;
  onEdit: () => void;
  onClose: () => void;
}) => {
  const update = useUpdateSupplier();
  const notify = useNotify();
  /* Owner 2026-09-30 (采购只看采购的部分; 代码只有 finance 能改): the Finance part —
     TIN, business reg, registration, exemption — shows to Finance only (the
     server does not send it to anyone else), and only Finance edits the code. */
  const isFinance = useCapability('scm.money.move');
  // Owner spec 2026-06-12 — maintained Supply Category pool, for rendering
  // the stored comma-joined list with canonical casing.
  const categoryPool = useSupplierCategoryPool();
  const [form, setForm] = useState({
    code: supplier.code,
    name: supplier.name,
    supplierType: supplier.supplier_type ?? '',
    category: supplier.category ?? '',
    tinNumber: supplier.tin_number ?? '',
    businessRegNo: supplier.business_reg_no ?? '',
    registrationNo: supplier.registration_no ?? '',
    exemptionNo: supplier.exemption_no ?? '',
    natureOfBusiness: supplier.nature_of_business ?? '',
    contactPerson: supplier.contact_person ?? '',
    attention: supplier.attention ?? '',
    email: supplier.email ?? '',
    email2: supplier.email2 ?? '',
    email3: supplier.email3 ?? '',
    phone: supplier.phone ?? '',
    phone2: supplier.phone2 ?? '',
    mobile: supplier.mobile ?? '',
    fax: supplier.fax ?? '',
    website: supplier.website ?? '',
    whatsappNumber: supplier.whatsapp_number ?? '',
    paymentTerms: supplier.payment_terms ?? '',
    currency: supplier.currency,
    address: supplier.address ?? '',
    address1: supplier.address1 ?? '',
    address2: supplier.address2 ?? '',
    address3: supplier.address3 ?? '',
    address4: supplier.address4 ?? '',
    postcode: supplier.postcode ?? '',
    area: supplier.area ?? '',
    city: supplier.city ?? '',
    state: supplier.state ?? '',
    country: supplier.country ?? 'Malaysia',
    businessNature: supplier.business_nature ?? '',
    notes: supplier.notes ?? '',
  });

  const setF = (k: keyof typeof form, v: string) => setForm((s) => ({ ...s, [k]: v }));

  const save = () => {
    const pcErr = masterPostcodeError(form.country, form.postcode);
    if (pcErr) { void notify({ title: pcErr, tone: 'error' }); return; }
    update.mutate({ id: supplier.id, ...supplierSaveBody(form, supplier.code, isFinance) } as Partial<SupplierRow> & { id: string }, {
      onSuccess: onClose,
      // Never fail silently (Commander 2026-06-16 — "Save 没有反应"): surface the
      // real error so a server reject (e.g. a stale DB constraint) is visible.
      onError: (err) => notify({ title: 'Save failed', body: `${err instanceof Error ? err.message : 'Something went wrong.'}`, tone: 'error' }),
    });
  };

  const [open, toggleOpen] = usePersistedOpen('panel-supplier-info');
  const bodyVisible = open || editing;

  return (
    <section className={styles.card}>
      <header
        className={styles.cardHeader}
        onClick={toggleOpen}
        aria-expanded={bodyVisible}
        title={bodyVisible ? 'Click to collapse' : 'Click to expand'}
        style={{ cursor: 'pointer', userSelect: 'none' }}
      >
        <h2 className={styles.cardTitle}>
          {bodyVisible
            ? <ChevronDown {...SM_ICON} style={{ color: 'var(--hz-c-ink-muted)' }} />
            : <ChevronRight {...SM_ICON} style={{ color: 'var(--hz-c-ink-muted)' }} />}
          Supplier Info
        </h2>
        <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
          {!editing ? (
            <Button variant="secondary" onClick={onEdit}>
              <Pencil {...ICON} />
              <span>Edit</span>
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={onClose}>Cancel</Button>
              <Button variant="primary" onClick={save} disabled={update.isPending}>
                <Save {...ICON} />
                <span>{update.isPending ? 'Saving…' : 'Save'}</span>
              </Button>
            </>
          )}
        </span>
      </header>
      {bodyVisible && (
      <div className={styles.cardBody}>
        {!editing ? (
          <div className={styles.infoGrid}>
            <InfoCell label="Credit Account" value={supplier.code} />
            <InfoCell label="Company Name" value={supplier.name} />
            <InfoCell label="Supplier Type" value={supplier.supplier_type ?? '—'} />
            <InfoCell
              label="Supply Category"
              value={displaySupplierCategories(supplier.category, categoryPool) || '—'}
            />
            {isFinance && (
              <>
                <InfoCell label="TIN Number" value={supplier.tin_number ?? '—'} />
                <InfoCell label="Business Reg No" value={supplier.business_reg_no ?? '—'} />
                <InfoCell label="Registration No." value={supplier.registration_no ?? '—'} />
                <InfoCell label="Exemption No." value={supplier.exemption_no ?? '—'} />
              </>
            )}
            <InfoCell label="Nature of Business" value={supplier.nature_of_business ?? '—'} />
            <InfoCell label="Contact Person" value={supplier.contact_person ?? '—'} />
            <InfoCell label="Attention" value={supplier.attention ?? '—'} />
            <InfoCell label="Email" value={supplier.email ?? '—'} />
            {/* Owner 2026-11-09 — the PO email copies Email 2 / Email 3 (Cc). */}
            <InfoCell label="Email 2" value={supplier.email2 ?? '—'} />
            <InfoCell label="Email 3" value={supplier.email3 ?? '—'} />
            <InfoCell label="Phone" value={supplier.phone ? formatPhone(supplier.phone) : '—'} />
            <InfoCell label="Phone 2" value={supplier.phone2 ? formatPhone(supplier.phone2) : '—'} />
            <InfoCell label="Mobile" value={supplier.mobile ? formatPhone(supplier.mobile) : '—'} />
            <InfoCell label="Fax" value={supplier.fax ?? '—'} />
            <InfoCell label="WhatsApp" value={supplier.whatsapp_number ? formatPhone(supplier.whatsapp_number) : '—'} />
            <InfoCell label="Website" value={supplier.website ?? '—'} />
            <InfoCell label="Payment Terms" value={supplier.payment_terms ?? '—'} />
            <InfoCell label="Currency" value={supplier.currency} />
            <InfoCell label="Country" value={supplier.country ?? 'Malaysia'} />
            <InfoCell label="State" value={supplier.state ?? '—'} />
            <InfoCell label="Postcode" value={supplier.postcode ?? '—'} />
            <InfoCell label="Area" value={supplier.area ?? '—'} />
            <InfoCell label="Business Nature" value={supplier.business_nature ?? '—'} />
            {supplier.address && (
              <div className={`${styles.infoCell} ${styles.infoCellFull}`}>
                <span className={styles.infoLabel}>Billing Address</span>
                <span className={styles.infoValue}>{supplier.address}</span>
              </div>
            )}
            {supplier.notes && (
              <div className={`${styles.infoCell} ${styles.infoCellFull}`}>
                <span className={styles.infoLabel}>Notes</span>
                <span className={styles.infoValue}>{supplier.notes}</span>
              </div>
            )}
          </div>
        ) : (
          <div className={styles.formGrid}>
            <EditField label={isFinance ? 'Credit Account *' : 'Credit Account (Finance changes it)'} value={form.code} onChange={(v) => setF('code', v)} disabled={!isFinance} />
            <EditField label="Company Name *" value={form.name} onChange={(v) => setF('name', v)} />
            <EditField label="Supplier Type" value={form.supplierType} onChange={(v) => setF('supplierType', v)} placeholder="Matrix / Distributor / Maker" />
            {/* Owner spec 2026-06-12 — Supply Category is a multi-select chip
                toggle fed by the maintained pool (a supplier can supply
                multiple categories; stored comma-joined). The Pricing tab
                still gates its maintenance sub-tabs off the derived single
                category (multi → every section shows). */}
            <SupplyCategoryPicker
              value={form.category}
              onChange={(v) => setF('category', v)}
              fieldClassName={styles.field}
              labelClassName={styles.fieldLabel}
            />
            {isFinance && (
              <>
                <EditField label="TIN Number" value={form.tinNumber} onChange={(v) => setF('tinNumber', v)} />
                <EditField label="Business Reg No" value={form.businessRegNo} onChange={(v) => setF('businessRegNo', v)} />
                <EditField label="Registration No." value={form.registrationNo} onChange={(v) => setF('registrationNo', v)} />
                <EditField label="Exemption No." value={form.exemptionNo} onChange={(v) => setF('exemptionNo', v)} />
              </>
            )}
            <EditField label="Nature of Business" value={form.natureOfBusiness} onChange={(v) => setF('natureOfBusiness', v)} />
            <EditField label="Contact Person" value={form.contactPerson} onChange={(v) => setF('contactPerson', v)} />
            <EditField label="Attention" value={form.attention} onChange={(v) => setF('attention', v)} />
            <EditField label="Email" value={form.email} onChange={(v) => setF('email', v)} />
            <EditField label="Email 2" value={form.email2} onChange={(v) => setF('email2', v)} />
            <EditField label="Email 3" value={form.email3} onChange={(v) => setF('email3', v)} />
            <PhoneEditField label="Phone" value={form.phone} onChange={(v) => setF('phone', v)} />
            <PhoneEditField label="Phone 2" value={form.phone2} onChange={(v) => setF('phone2', v)} />
            <PhoneEditField label="Mobile" value={form.mobile} onChange={(v) => setF('mobile', v)} />
            <EditField label="Fax" value={form.fax} onChange={(v) => setF('fax', v)} />
            <PhoneEditField label="WhatsApp" value={form.whatsappNumber} onChange={(v) => setF('whatsappNumber', v)} />
            <EditField label="Website" value={form.website} onChange={(v) => setF('website', v)} />
            <PickListField label="Payment Terms" options={PAYMENT_TERMS} other={PAYMENT_TERMS_CUSTOM} value={form.paymentTerms}
              onChange={(v) => setF('paymentTerms', v)} pickLabel="— Pick term —" typePlaceholder="Type custom term" upper={false}
              classes={{ field: styles.field, label: styles.fieldLabel, select: styles.fieldSelect, selectWrap: styles.selectWrap, chevron: styles.selectChevron, input: styles.fieldInput }} />
            <CurrencyEditSelect value={form.currency} onChange={(v) => setF('currency', v)} />
            <EditField label="Business Nature" value={form.businessNature} onChange={(v) => setF('businessNature', v)} />
            {/* Address — Country + State cascade (PR #47), plus Postcode
                dropdown from scm.my_localities (2026-07-23). Picking State
                back-derives Country the way the owner asked: pick State,
                Country auto-fills. Picking a Postcode first fills State and
                City back (the Sales Order picker, owner 2026-11-17), so a DP
                supplier pickup can copy it; Area
                (industrial estate name etc.) stays free-text — it's a
                supplier-specific concept, not the my_localities city. */}
            {/* Two address lines, as on the Sales Order (owner 2026-11-18). Line 2
                shows what an older supplier still holds in lines 3 / 4; editing it
                moves all of it to line 2 (shared/address-two-lines). */}
            <EditField label="Address line 1" value={form.address1} onChange={(v) => setF('address1', v)} />
            <EditField
              label="Address line 2"
              value={addressLineTwoView(form.address2, form.address3, form.address4, { postcode: form.postcode, city: form.city, state: form.state })}
              onChange={(v) => setForm((s) => (hasLegacyLines(s.address3, s.address4) ? { ...s, address2: v, address3: '', address4: '' } : { ...s, address2: v }))}
            />
            <CountrySelect value={form.country} onChange={(v) => {
              setF('country', v);
              if (v !== form.country) { setF('state', ''); setF('city', ''); setF('postcode', ''); }
            }} />
            <label className={styles.field}>
              <span className={styles.fieldLabel}>State</span>
              <StatePicker
                country={form.country}
                value={form.state}
                selectClassName={styles.fieldSelect}
                onChange={(v, derivedCountry) => {
                  setF('state', v);
                  if (derivedCountry && derivedCountry !== form.country) setF('country', derivedCountry);
                  setF('city', '');
                  setF('postcode', '');
                }}
              />
            </label>
            <EditField label="Area" value={form.area} onChange={(v) => setF('area', v)} />
            <CitySelect state={form.state} value={form.city} onChange={(v) => setF('city', v)} />
            {form.country === 'Singapore' ? <SgPostcodeField value={form.postcode} onChange={(v) => setF('postcode', v)} onResolve={(r) => { setF('address', r.address); if (r.state && r.city) { setF('state', r.state); setF('city', r.city); } }} fieldClassName={styles.field} labelClassName={styles.fieldLabel} inputClassName={styles.fieldInput} /> : <PostcodeCascadeField value={form.postcode} state={form.state} city={form.city} label={masterNeedsPostcode(form.country) ? 'Postcode *' : 'Postcode'} onPick={(t) => { setF('postcode', t.postcode); setF('state', t.state); setF('city', t.city); }} classes={{ field: styles.field, label: styles.fieldLabel, select: styles.fieldSelect, selectWrap: styles.selectWrap, chevron: styles.selectChevron, input: styles.fieldInput }} />}
            <EditField label="Billing Address" value={form.address} onChange={(v) => setF('address', v)} multiline />
            <EditField label="Notes" value={form.notes} onChange={(v) => setF('notes', v)} multiline />
          </div>
        )}
      </div>
      )}
    </section>
  );
};

const EditField = ({
  label, value, onChange, multiline, placeholder, disabled,
}: {
  label: string; value: string; onChange: (v: string) => void;
  multiline?: boolean; placeholder?: string; disabled?: boolean;
}) => (
  <label className={`${styles.field} ${multiline ? styles.formGridFull : ''}`}>
    <span className={styles.fieldLabel}>{label}</span>
    {multiline ? (
      <textarea
        className={styles.fieldInput}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ minHeight: 60, resize: 'vertical' }}
      />
    ) : (
      <input
        className={styles.fieldInput}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
      />
    )}
  </label>
);

const PhoneEditField = ({
  label, value, onChange,
}: {
  label: string; value: string; onChange: (v: string) => void;
}) => (
  <label className={styles.field}>
    <span className={styles.fieldLabel}>{label}</span>
    <PhoneInput className={styles.fieldInput} value={value} onChange={onChange} />
  </label>
);


const MODEL_CATEGORY_CHIPS: { value: 'all' | MfgCategory; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'BEDFRAME', label: 'Bedframe' },
  { value: 'SOFA', label: 'Sofa' },
  { value: 'MATTRESS', label: 'Mattress' },
  { value: 'ACCESSORY', label: 'Accessory' },
  { value: 'SERVICE', label: 'Service' },
];

type ModelDraft = {
  modelId: string;
  modelCode: string;
  modelName: string;
  category: MfgCategory;
  skus: MfgProductRow[];
  alreadyBoundCodes: string[];
  supplierCode: string;
  description: string;
  unitPriceSen: number;
  leadTimeDays: number;
  moq: number;
  isMainSupplier: boolean;
};

function bindingStatus(skuCount: number, boundCount: number): {
  tone: 'none' | 'mixed' | 'all';
  label: string;
} {
  if (boundCount === 0) return { tone: 'none', label: 'not mapped' };
  if (boundCount >= skuCount) return { tone: 'all', label: `all ${skuCount} mapped · edit price in the table below` };
  return { tone: 'mixed', label: `mixed ${boundCount}/${skuCount}` };
}

const ModelSkuPickerDialog = ({
  supplierId,
  existingBindings,
  supplierCategory,
  onClose,
}: {
  supplierId: string;
  existingBindings: BindingRow[];
  supplierCategory: SupplierCategory | null;
  onClose: () => void;
}) => {
  const batch = useCreateBindingsBatch();
  const notify = useNotify();
  const [step, setStep] = useState<1 | 2>(1);
  const initialCategory: 'all' | MfgCategory =
    mfgCategoryFromSupplierCategory(supplierCategory) ?? 'all';
  const [category, setCategory] = useState<'all' | MfgCategory>(initialCategory);
  const [search, setSearch] = useState('');
  const [advanced, setAdvanced] = useState(false);

  const modelsQ = useProductModels(
    category === 'all' ? undefined : { category },
  );
  const productsQ = useMfgProducts(
    category === 'all' ? undefined : { category },
  );

  const skusByModel = useMemo(() => {
    const map = new Map<string, MfgProductRow[]>();
    for (const p of productsQ.data ?? []) {
      if (!p.model_id) continue;
      const arr = map.get(p.model_id) ?? [];
      arr.push(p);
      map.set(p.model_id, arr);
    }
    return map;
  }, [productsQ.data]);

  const boundCodes = useMemo(
    () => new Set(existingBindings.map((b) => `${b.material_kind}|${b.item_code}`)),
    [existingBindings],
  );

  const modelRows = useMemo(() => {
    const out: { model: ProductModelRow; skus: MfgProductRow[]; boundCount: number }[] = [];
    for (const m of modelsQ.data ?? []) {
      const skus = skusByModel.get(m.id) ?? [];
      if (!modelMatchesSearch(m, skus, search)) continue;
      const bound = skus.filter((s) => boundCodes.has(`mfg_product|${s.code}`));
      out.push({ model: m, skus, boundCount: bound.length });
    }
    return out;
  }, [modelsQ.data, skusByModel, search, boundCodes]);

  const modelessMatches = useMemo(
    () => countModelessMatches(productsQ.data ?? [], search),
    [productsQ.data, search],
  );

  const [pickedIds, setPickedIds] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, ModelDraft>>({});
  const [expandedSkuPreview, setExpandedSkuPreview] = useState<Set<string>>(new Set());
  const toggleSkuPreview = (modelId: string) => {
    setExpandedSkuPreview((s) => {
      const next = new Set(s);
      if (next.has(modelId)) next.delete(modelId); else next.add(modelId);
      return next;
    });
  };

  const togglePick = (m: ProductModelRow, skus: MfgProductRow[]) => {
    setPickedIds((s) => {
      const next = new Set(s);
      if (next.has(m.id)) next.delete(m.id);
      else if (skus.length > 0) next.add(m.id);
      return next;
    });
  };

  const pickedCount = pickedIds.size;

  const goNext = () => {
    const seeded: Record<string, ModelDraft> = {};
    for (const id of pickedIds) {
      const row = modelRows.find((r) => r.model.id === id);
      if (!row) continue;
      const existing = drafts[id];
      const prices = row.skus
        .map((s) => s.base_price_sen ?? 0)
        .filter((v) => v > 0);
      const avgPrice = prices.length
        ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length)
        : 0;
      seeded[id] = existing ?? {
        modelId: row.model.id,
        modelCode: row.model.model_code,
        modelName: row.model.name,
        category: row.model.category,
        skus: row.skus,
        alreadyBoundCodes: row.skus
          .filter((s) => boundCodes.has(`mfg_product|${s.code}`))
          .map((s) => s.code),
        supplierCode: '',
        description: '',
        unitPriceSen: avgPrice,
        leadTimeDays: 7,
        moq: 1,
        isMainSupplier: false,
      };
    }
    setDrafts(seeded);
    setStep(2);
  };

  const setDraft = (id: string, patch: Partial<ModelDraft>) => {
    setDrafts((s) => ({ ...s, [id]: { ...s[id]!, ...patch } }));
  };

  const submit = () => {
    const list: NewBinding[] = [];
    for (const d of Object.values(drafts)) {
      const code = d.supplierCode.trim();
      if (!code) continue;
      for (const sku of d.skus) {
        if (d.alreadyBoundCodes.includes(sku.code)) continue;
        const supplierSku = composeSupplierSku(code, sku);
        list.push({
          materialKind: 'mfg_product' as MaterialKind,
          itemCode: sku.code,
          materialName: sku.name ?? sku.code,
          supplierSku,
          unitPriceSen: d.unitPriceSen,
          currency: 'MYR' as Currency,
          leadTimeDays: d.leadTimeDays,
          moq: d.moq,
          isMainSupplier: d.isMainSupplier,
          notes: d.description.trim() || undefined,
        });
      }
    }
    if (list.length === 0) { onClose(); return; }
    batch.mutate({ supplierId, bindings: list }, {
      onSuccess: async (res) => {
        if (res.skipped > 0) {
          await notify({
            title:
              `Inserted ${res.inserted} SKU mapping${res.inserted === 1 ? '' : 's'}; ` +
              `skipped ${res.skipped} already bound.`,
          });
        }
        onClose();
      },
      onError: (err: unknown) => notify({
        title: 'Binding failed',
        body: err instanceof Error ? err.message : 'Something went wrong.',
        tone: 'error',
      }),
    });
  };

  if (advanced) {
    return (
      <MultiSkuPickerDialog
        supplierId={supplierId}
        existingBindings={existingBindings}
        initialSearch={search}
        onClose={onClose}
      />
    );
  }

  const loading = modelsQ.isLoading || productsQ.isLoading;

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div
        className={styles.modal}
        style={{ width: 'min(900px, 95vw)', maxHeight: '90vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.modalHeader}>
          <h3 className={styles.modalTitle}>
            {step === 1
              ? `Pick Model(s) to map · ${pickedCount} selected`
              : `Supplier codes by Model · ${pickedCount} Model${pickedCount === 1 ? '' : 's'}`}
          </h3>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <label
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                fontSize: 'var(--fs-12)', color: 'var(--hz-c-ink-muted)', cursor: 'pointer',
              }}
              title="Switch to per-SKU picker (for Models needing different codes per size)"
            >
              <input
                type="checkbox"
                checked={false}
                onChange={() => setAdvanced(true)}
              />
              Advanced (per-SKU)
            </label>
            <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Close">
              <X {...ICON} />
            </button>
          </span>
        </header>

        {step === 1 ? (
          <>
            <div className={styles.modalBody} style={{ paddingBottom: 'var(--space-3)' }}>
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center', marginBottom: 'var(--space-3)' }}>
                {MODEL_CATEGORY_CHIPS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => setCategory(c.value)}
                    style={{
                      fontFamily: 'var(--font-button)', fontSize: 'var(--fs-13)', fontWeight: 600,
                      padding: 'var(--space-2) var(--space-3)',
                      borderRadius: 'var(--radius-pill)',
                      border: category === c.value ? '1px solid #11140f' : '1px solid var(--hz-c-border)',
                      background: category === c.value ? '#11140f' : 'var(--hz-c-surface)',
                      color: category === c.value ? '#f4f6f3' : 'var(--hz-c-ink)',
                      cursor: 'pointer',
                    }}
                  >
                    {c.label}
                  </button>
                ))}
                <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
                  <Search {...ICON} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--hz-c-ink-muted)', pointerEvents: 'none' }} />
                  <input
                    type="search"
                    placeholder="Search Model or SKU code / name…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    style={{
                      width: '100%', fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-14)',
                      background: 'var(--hz-c-surface)', border: '1px solid var(--hz-c-border)',
                      borderRadius: 'var(--radius-md)',
                      padding: 'var(--space-2) var(--space-3) var(--space-2) var(--space-7)',
                      outline: 'none',
                    }}
                  />
                </div>
              </div>
              <div style={{ maxHeight: '50vh', overflowY: 'auto', border: '1px solid var(--hz-c-border)', borderRadius: 'var(--radius-md)' }}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}></th>
                      <th>Model Code</th>
                      <th>Name</th>
                      <th>Category</th>
                      <th className={styles.tableRight}>SKUs</th>
                      <th>Mapping status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading && (
                      <tr><td colSpan={6} className={styles.emptyRow}>Loading…</td></tr>
                    )}
                    {!loading && modelRows.length === 0 && (
                      <tr><td colSpan={6} className={styles.emptyRow}>No Models match.</td></tr>
                    )}
                    {!loading && modelRows.map(({ model, skus, boundCount }) => {
                      const isPicked = pickedIds.has(model.id);
                      const inactive = !model.active;
                      const noSkus = skus.length === 0;
                      const fullyBound = boundCount >= skus.length && skus.length > 0;
                      const disabled = inactive || noSkus || fullyBound;
                      const status = bindingStatus(skus.length, boundCount);
                      return (
                        <tr
                          key={model.id}
                          onClick={() => !disabled && togglePick(model, skus)}
                          style={{
                            cursor: disabled ? 'not-allowed' : 'pointer',
                            opacity: disabled ? 0.4 : 1,
                            background: isPicked ? 'rgba(232, 107, 58, 0.06)' : undefined,
                          }}
                          title={
                            inactive
                              ? 'Model is inactive — activate it in SKU Master before mapping prices'
                              : noSkus
                                ? 'No active SKUs under this Model'
                                : fullyBound
                                  ? 'Already mapped to this supplier. Close this and edit its price in the SKU Mappings table.'
                                  : ''
                          }
                        >
                          <td>
                            <input
                              type="checkbox"
                              checked={isPicked}
                              disabled={disabled}
                              onChange={() => togglePick(model, skus)}
                              onClick={(e) => e.stopPropagation()}
                            />
                          </td>
                          <td className={styles.codeCell}>{model.model_code}</td>
                          <td>
                            {model.name}
                            {inactive && (
                              <span style={{ marginLeft: 6, fontSize: 'var(--fs-11)', fontWeight: 700, color: 'var(--hz-c-primary-ink)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                                · Inactive
                              </span>
                            )}
                          </td>
                          <td className={styles.muted}>{mfgCategoryLabel(model.category)}</td>
                          <td className={`${styles.tableRight} ${styles.muted}`}>{skus.length}</td>
                          <td>
                            <span
                              style={{
                                fontSize: 'var(--fs-12)',
                                fontWeight: 600,
                                color:
                                  status.tone === 'all'
                                    ? 'var(--c-secondary-a, var(--hz-dk-secondary-a, #2F5D4F))'
                                    : status.tone === 'mixed'
                                      ? '#0c3f39'
                                      : '#767b6e',
                              }}
                            >
                              {status.label}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {!loading && modelessMatches > 0 && (
                <p className={styles.infoLabel} style={{ marginTop: 'var(--space-2)' }}>
                  {modelessMatches} matching SKU{modelessMatches === 1 ? ' has' : 's have'} no Model.{' '}
                  <button
                    type="button"
                    onClick={() => setAdvanced(true)}
                    style={{ background: 'none', border: 'none', padding: 0, color: 'inherit', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}
                  >
                    Map with Advanced (per-SKU)
                  </button>
                </p>
              )}
            </div>
            <footer className={styles.modalFooter}>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button variant="primary" onClick={goNext} disabled={pickedCount === 0}>
                <span>Next · Fill supplier codes ({pickedCount})</span>
              </Button>
            </footer>
          </>
        ) : (
          <>
            <div className={styles.modalBody} style={{ paddingBottom: 'var(--space-3)' }}>
              {/* Commander 2026-06-16 — trimmed the intro + 6-bullet explainer
                  ("提示词太多了"): the column headers + placeholders already say
                  what to type. Keep ONE short line for context. */}
              <p className={styles.infoLabel} style={{ marginBottom: 'var(--space-2)' }}>
                Fill each Model's supplier code + note. Save binds every active SKU under it (same code + price). Prices here are COST, not selling.
              </p>
              <div style={{ maxHeight: '50vh', overflowY: 'auto', border: '1px solid var(--hz-c-border)', borderRadius: 'var(--radius-md)' }}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Model · #SKUs</th>
                      <th>Supplier Code</th>
                      <th>Description</th>
                      <th className={styles.tableRight}>Unit Price (RM)</th>
                      <th className={styles.tableRight}>Lead (d)</th>
                      <th className={styles.tableRight}>MOQ</th>
                      <th>Main</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.values(drafts).map((d) => {
                      const remaining = d.skus.length - d.alreadyBoundCodes.length;
                      const expanded = expandedSkuPreview.has(d.modelId);
                      const skusToMap = d.skus.filter((s) => !d.alreadyBoundCodes.includes(s.code));
                      const toMap = skusToMap.map((s) => s.code);
                      const previewMap = d.supplierCode.trim()
                        ? Object.fromEntries(
                            skusToMap.map((s) => [s.code, composeSupplierSku(d.supplierCode, s)]),
                          )
                        : undefined;
                      return (
                        <Fragment key={d.modelId}>
                          <tr>
                            <td>
                              <div className={styles.codeCell}>{d.modelCode}</div>
                              <div className={styles.muted}>{d.modelName}</div>
                              <button
                                type="button"
                                onClick={() => toggleSkuPreview(d.modelId)}
                                className={styles.muted}
                                style={{
                                  background: 'transparent',
                                  border: 'none',
                                  padding: 0,
                                  marginTop: 2,
                                  fontSize: 'var(--fs-12)',
                                  cursor: d.skus.length === 0 ? 'default' : 'pointer',
                                  color: expanded ? 'var(--hz-c-primary-ink)' : 'var(--hz-c-ink-muted)',
                                  textDecoration: 'underline',
                                  textUnderlineOffset: 2,
                                }}
                                title={expanded ? 'Hide SKU list' : 'Show SKU list'}
                              >
                                {expanded ? '▾' : '▸'} {remaining} of {d.skus.length} SKUs to map
                                {d.alreadyBoundCodes.length > 0 ? ` (${d.alreadyBoundCodes.length} already)` : ''}
                              </button>
                            </td>
                            <td>
                              <input
                                value={d.supplierCode}
                                onChange={(e) => setDraft(d.modelId, { supplierCode: e.target.value })}
                                placeholder="Their code for the whole Model"
                                style={smallInputStyle}
                              />
                              {previewMap && toMap.length > 0 && (
                                <div style={{
                                  marginTop: 4, fontSize: 'var(--fs-11)', color: 'var(--hz-c-ink-muted)',
                                  lineHeight: 1.4,
                                }}>
                                  <span style={{
                                    fontFamily: 'var(--font-button)', fontSize: 'var(--fs-10)',
                                    letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--hz-c-primary-ink)',
                                  }}>becomes → </span>
                                  {toMap.slice(0, 2).map((c, i) => (
                                    <span key={c}>
                                      <code style={{ fontWeight: 700, color: 'var(--hz-c-ink)' }}>{previewMap[c]}</code>
                                      {i < Math.min(2, toMap.length) - 1 ? ', ' : ''}
                                    </span>
                                  ))}
                                  {toMap.length > 2 && <span> … +{toMap.length - 2} more</span>}
                                </div>
                              )}
                            </td>
                            <td>
                              <input
                                value={d.description}
                                onChange={(e) => setDraft(d.modelId, { description: e.target.value })}
                                placeholder='e.g. "Foam B grade, 6-week lead"'
                                style={{ ...smallInputStyle, width: '100%', minWidth: 180 }}
                              />
                            </td>
                            <td className={styles.tableRight}>
                              <MoneyInput
                                bare
                                valueSen={d.unitPriceSen}
                                onCommit={(sen) => setDraft(d.modelId, { unitPriceSen: sen ?? 0 })}
                                style={{ ...smallInputStyle, width: 100, textAlign: 'right' }}
                              />
                            </td>
                            <td className={styles.tableRight}>
                              <NumberInput
                                sign="unsigned"
                                decimal={false}
                                value={d.leadTimeDays}
                                onValueChange={(n) => setDraft(d.modelId, { leadTimeDays: n ?? 0 })}
                                style={{ ...smallInputStyle, width: 60, textAlign: 'right' }}
                              />
                            </td>
                            <td className={styles.tableRight}>
                              <NumberInput
                                sign="unsigned"
                                decimal={false}
                                value={d.moq}
                                onValueChange={(n) => setDraft(d.modelId, { moq: n ?? 0 })}
                                style={{ ...smallInputStyle, width: 60, textAlign: 'right' }}
                              />
                            </td>
                            <td>
                              <input
                                type="checkbox"
                                checked={d.isMainSupplier}
                                onChange={(e) => setDraft(d.modelId, { isMainSupplier: e.target.checked })}
                              />
                            </td>
                          </tr>
                          {expanded && d.skus.length > 0 && (
                            <tr>
                              <td colSpan={7} style={{
                                background: 'var(--hz-c-surface-2)',
                                padding: 'var(--space-2) var(--space-3)',
                                borderTop: '1px dashed #d6d9d2',
                              }}>
                                <SkuPreviewStrip
                                  toMap={toMap}
                                  alreadyBound={d.alreadyBoundCodes}
                                  previewMap={previewMap}
                                />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <footer className={styles.modalFooter}>
              <Button variant="ghost" onClick={() => setStep(1)}>← Back</Button>
              <Button variant="primary" onClick={submit} disabled={batch.isPending}>
                {batch.isPending
                  ? 'Saving…'
                  : `Save ${pickedCount} Model${pickedCount === 1 ? '' : 's'}`}
              </Button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
};


type MultiDraft = {
  itemCode: string;
  materialName: string;
  supplierSku: string;
  unitPriceSen: number;
  leadTimeDays: number;
  moq: number;
  isMainSupplier: boolean;
};

const CATEGORY_CHIPS: { value: 'all' | MfgCategory; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'BEDFRAME', label: 'Bedframe' },
  { value: 'SOFA', label: 'Sofa' },
  { value: 'MATTRESS', label: 'Mattress' },
  { value: 'ACCESSORY', label: 'Accessory' },
  { value: 'SERVICE', label: 'Service' },
];

const MULTI_PICKER_RENDER_CAP = 60;

const MultiSkuPickerDialog = ({
  supplierId,
  existingBindings,
  initialSearch,
  onClose,
}: {
  supplierId: string;
  existingBindings: BindingRow[];
  initialSearch: string;
  onClose: () => void;
}) => {
  const batch = useCreateBindingsBatch();
  const notify = useNotify();
  const [step, setStep] = useState<1 | 2>(1);
  const [category, setCategory] = useState<'all' | MfgCategory>('all');
  const [search, setSearch] = useState(initialSearch);
  const debouncedSearch = useDebouncedValue(search, 250);
  /* Server-typeahead gate (owner #1 scaling pain, 2026-07-14) — the "All / no
     search" read used to pull the WHOLE ~1141-SKU catalog. It is now bounded:
     the query only fires once >= 2 search chars are typed OR a category chip is
     picked (a category-scoped read is bounded). Picks live in `picked`
     (independent of this query), so gating never drops a selected product. */
  const trimmedSearch = debouncedSearch.trim();
  const gateOpen = trimmedSearch.length >= 2 || category !== 'all';
  const products = useMfgProducts({
    category: category === 'all' ? undefined : category,
    search: trimmedSearch || undefined,
    enabled: gateOpen,
  });

  const alreadyBound = useMemo(
    () => new Set(existingBindings.map((b) => `${b.material_kind}|${b.item_code}`)),
    [existingBindings],
  );

  const [picked, setPicked] = useState<Record<string, MfgProductRow>>({});
  const pickedCount = Object.keys(picked).length;
  const [drafts, setDrafts] = useState<Record<string, MultiDraft>>({});

  const toggleProduct = (p: MfgProductRow) => {
    if (alreadyBound.has(`mfg_product|${p.code}`)) return;
    setPicked((s) => {
      const next = { ...s };
      if (next[p.id]) delete next[p.id];
      else next[p.id] = p;
      return next;
    });
  };

  const goNext = () => {
    const seeded: Record<string, MultiDraft> = {};
    for (const p of Object.values(picked)) {
      seeded[p.code] = drafts[p.code] ?? {
        itemCode: p.code,
        materialName: p.name,
        supplierSku: '',
        unitPriceSen: p.base_price_sen ?? 0,
        leadTimeDays: 7,
        moq: 1,
        isMainSupplier: false,
      };
    }
    setDrafts(seeded);
    setStep(2);
  };

  const setDraft = (code: string, patch: Partial<MultiDraft>) => {
    setDrafts((s) => ({ ...s, [code]: { ...s[code]!, ...patch } }));
  };

  const submit = () => {
    const list: NewBinding[] = Object.values(drafts).map((d) => ({
      materialKind: 'mfg_product' as MaterialKind,
      itemCode: d.itemCode,
      materialName: d.materialName,
      supplierSku: d.supplierSku.trim() || d.itemCode,
      unitPriceSen: d.unitPriceSen,
      currency: 'MYR' as Currency,
      leadTimeDays: d.leadTimeDays,
      moq: d.moq,
      isMainSupplier: d.isMainSupplier,
    }));
    if (list.length === 0) { onClose(); return; }
    batch.mutate({ supplierId, bindings: list }, {
      onSuccess: async (res) => {
        if (res.skipped > 0) {
          await notify({ title: `Inserted ${res.inserted} mapping${res.inserted === 1 ? '' : 's'}; skipped ${res.skipped} already bound.` });
        }
        onClose();
      },
    });
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div
        className={styles.modal}
        style={{ width: 'min(900px, 95vw)', maxHeight: '90vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.modalHeader}>
          <h3 className={styles.modalTitle}>
            {step === 1 ? `Pick products to map · ${pickedCount} selected` : `Fill in supplier codes · ${pickedCount} products`}
          </h3>
          <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Close">
            <X {...ICON} />
          </button>
        </header>

        {step === 1 ? (
          <>
            <div className={styles.modalBody} style={{ paddingBottom: 'var(--space-3)' }}>
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center', marginBottom: 'var(--space-3)' }}>
                {CATEGORY_CHIPS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => setCategory(c.value)}
                    style={{
                      fontFamily: 'var(--font-button)', fontSize: 'var(--fs-13)', fontWeight: 600,
                      padding: 'var(--space-2) var(--space-3)',
                      borderRadius: 'var(--radius-pill)',
                      border: category === c.value ? '1px solid #11140f' : '1px solid var(--hz-c-border)',
                      background: category === c.value ? '#11140f' : 'var(--hz-c-surface)',
                      color: category === c.value ? '#f4f6f3' : 'var(--hz-c-ink)',
                      cursor: 'pointer',
                    }}
                  >
                    {c.label}
                  </button>
                ))}
                <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
                  <Search {...ICON} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--hz-c-ink-muted)', pointerEvents: 'none' }} />
                  <input
                    type="search"
                    placeholder="Search code / name / description…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    style={{
                      width: '100%', fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-14)',
                      background: 'var(--hz-c-surface)', border: '1px solid var(--hz-c-border)',
                      borderRadius: 'var(--radius-md)',
                      padding: 'var(--space-2) var(--space-3) var(--space-2) var(--space-7)',
                      outline: 'none',
                    }}
                  />
                </div>
              </div>
              <div style={{ maxHeight: '50vh', overflowY: 'auto', border: '1px solid var(--hz-c-border)', borderRadius: 'var(--radius-md)' }}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}></th>
                      <th>Code</th>
                      <th>Description</th>
                      <th>Category</th>
                      <th>Size</th>
                      <th className={styles.tableRight}>Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!gateOpen && (
                      <tr><td colSpan={6} className={styles.emptyRow}>Type at least 2 characters, or pick a category, to search the catalog.</td></tr>
                    )}
                    {gateOpen && products.isLoading && (
                      <tr><td colSpan={6} className={styles.emptyRow}>Loading…</td></tr>
                    )}
                    {gateOpen && !products.isLoading && (products.data ?? []).length === 0 && (
                      <tr><td colSpan={6} className={styles.emptyRow}>No products match.</td></tr>
                    )}
                    {!products.isLoading && (products.data ?? []).slice(0, MULTI_PICKER_RENDER_CAP).map((p) => {
                      const bound = alreadyBound.has(`mfg_product|${p.code}`);
                      const isPicked = Boolean(picked[p.id]);
                      return (
                        <tr
                          key={p.id}
                          onClick={() => toggleProduct(p)}
                          style={{
                            cursor: bound ? 'not-allowed' : 'pointer',
                            opacity: bound ? 0.4 : 1,
                            background: isPicked ? 'rgba(232, 107, 58, 0.06)' : undefined,
                          }}
                          title={bound ? 'Already bound to this supplier' : ''}
                        >
                          <td>
                            <input
                              type="checkbox"
                              checked={isPicked}
                              disabled={bound}
                              onChange={() => toggleProduct(p)}
                              onClick={(e) => e.stopPropagation()}
                            />
                          </td>
                          <td className={styles.codeCell}>{p.code}</td>
                          <td>{p.name}</td>
                          <td className={styles.muted}>{mfgCategoryLabel(p.category)}</td>
                          <td className={styles.muted}>{p.size_label ?? '—'}</td>
                          <td className={styles.priceCell}>{p.base_price_sen ? fmtSen(p.base_price_sen) : '—'}</td>
                        </tr>
                      );
                    })}
                    {!products.isLoading && (products.data ?? []).length > MULTI_PICKER_RENDER_CAP && (
                      <tr>
                        <td colSpan={6} className={styles.emptyRow}>
                          Showing the first {MULTI_PICKER_RENDER_CAP} of {(products.data ?? []).length} — narrow by search or category.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            <footer className={styles.modalFooter}>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button variant="primary" onClick={goNext} disabled={pickedCount === 0}>
                <span>Next · Fill supplier codes ({pickedCount})</span>
              </Button>
            </footer>
          </>
        ) : (
          <>
            <div className={styles.modalBody} style={{ paddingBottom: 'var(--space-3)' }}>
              <p className={styles.infoLabel} style={{ marginBottom: 'var(--space-3)' }}>
                Fill in each product's supplier-side code + price + lead time. Leave Supplier SKU blank to use our internal code.
              </p>
              <div style={{ maxHeight: '50vh', overflowY: 'auto', border: '1px solid var(--hz-c-border)', borderRadius: 'var(--radius-md)' }}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Our Code · Name</th>
                      <th>Supplier SKU</th>
                      <th className={styles.tableRight}>Unit Price (RM)</th>
                      <th className={styles.tableRight}>Lead (d)</th>
                      <th className={styles.tableRight}>MOQ</th>
                      <th>Main</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.values(drafts).map((d) => (
                      <tr key={d.itemCode}>
                        <td>
                          <div className={styles.codeCell}>{d.itemCode}</div>
                          <div className={styles.muted}>{d.materialName}</div>
                        </td>
                        <td>
                          <input
                            value={d.supplierSku}
                            onChange={(e) => setDraft(d.itemCode, { supplierSku: e.target.value })}
                            placeholder="(blank = same as our code)"
                            style={smallInputStyle}
                          />
                        </td>
                        <td className={styles.tableRight}>
                          <MoneyInput
                            bare
                            valueSen={d.unitPriceSen}
                            onCommit={(sen) => setDraft(d.itemCode, { unitPriceSen: sen ?? 0 })}
                            style={{ ...smallInputStyle, width: 100, textAlign: 'right' }}
                          />
                        </td>
                        <td className={styles.tableRight}>
                          <NumberInput
                            sign="unsigned"
                            decimal={false}
                            value={d.leadTimeDays}
                            onValueChange={(n) => setDraft(d.itemCode, { leadTimeDays: n ?? 0 })}
                            style={{ ...smallInputStyle, width: 60, textAlign: 'right' }}
                          />
                        </td>
                        <td className={styles.tableRight}>
                          <NumberInput
                            sign="unsigned"
                            decimal={false}
                            value={d.moq}
                            onValueChange={(n) => setDraft(d.itemCode, { moq: n ?? 0 })}
                            style={{ ...smallInputStyle, width: 60, textAlign: 'right' }}
                          />
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            checked={d.isMainSupplier}
                            onChange={(e) => setDraft(d.itemCode, { isMainSupplier: e.target.checked })}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <footer className={styles.modalFooter}>
              <Button variant="ghost" onClick={() => setStep(1)}>← Back</Button>
              <Button variant="primary" onClick={submit} disabled={batch.isPending}>
                {batch.isPending ? 'Saving…' : `Save ${pickedCount} mapping${pickedCount === 1 ? '' : 's'}`}
              </Button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
};

export function SkuPreviewStrip({
  toMap, alreadyBound, previewMap,
}: {
  toMap:         string[];
  alreadyBound:  string[];
  previewMap?:   Record<string, string>;
}) {
  return (
    <div style={{
      display: 'flex',
      flexWrap: 'wrap',
      gap: 6,
      alignItems: 'center',
    }}>
      <span style={{
        fontSize: 'var(--fs-11)',
        color: 'var(--hz-c-ink-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        marginRight: 8,
      }}>
        Will bulk-map →
      </span>
      {toMap.length === 0 ? (
        <span style={{ color: 'var(--hz-c-ink-muted)', fontSize: 'var(--fs-12)' }}>
          All SKUs already mapped.
        </span>
      ) : toMap.map((c) => {
        const resolved = previewMap?.[c];
        return (
          <code
            key={c}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-12)',
              background: 'var(--hz-c-surface)',
              border: '1px solid var(--hz-c-border)',
              borderRadius: 'var(--radius-sm)',
              padding: '2px 8px',
            }}
          >
            {c}
            {resolved && (
              <span style={{ color: 'var(--hz-c-ink-muted)' }}>
                {' → '}
                <span style={{ color: 'var(--hz-c-primary-ink)', fontWeight: 600 }}>{resolved}</span>
              </span>
            )}
          </code>
        );
      })}
      {alreadyBound.length > 0 && (
        <>
          <span style={{
            fontSize: 'var(--fs-11)',
            color: 'var(--hz-c-ink-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            margin: '0 8px',
          }}>
            · skip (already bound):
          </span>
          {alreadyBound.map((c) => (
            <code
              key={c}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-12)',
                background: 'var(--hz-c-surface-2)',
                border: '1px dashed var(--hz-c-border)',
                borderRadius: 'var(--radius-sm)',
                padding: '2px 8px',
                color: 'var(--hz-c-ink-muted)',
                textDecoration: 'line-through',
              }}
            >
              {c}
            </code>
          ))}
        </>
      )}
    </div>
  );
}

const smallInputStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-13)',
  background: 'var(--hz-c-surface-2)',
  border: '1px solid var(--hz-c-border)',
  borderRadius: 'var(--radius-sm)',
  padding: '4px 8px',
  outline: 'none',
};


const CountrySelect = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => {
  const localities = useLocalities();
  const list = useMemo(
    () => (localities.data ? distinctCountries(localities.data) : []),
    [localities.data],
  );
  const isEmpty = !localities.isLoading && list.length === 0;
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>Country</span>
      <span className={styles.selectWrap}>
        <select className={styles.fieldSelect} value={value ?? ''}
          disabled={localities.isLoading || isEmpty}
          onChange={(e) => onChange(e.target.value)}>
          <option value="">
            {localities.isLoading ? 'Loading…' : isEmpty ? 'No countries seeded' : '— Pick country —'}
          </option>
          {sortByText(list).map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
      </span>
    </label>
  );
};

const CitySelect = ({
  state, value, onChange,
}: { state: string; value: string; onChange: (v: string) => void }) => {
  const localities = useLocalities();
  const rows = localities.data ?? [];
  const list = useMemo(() => (state ? citiesInState(rows, state) : []), [rows, state]);
  const isEmpty = !localities.isLoading && list.length === 0;
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>City</span>
      <span className={styles.selectWrap}>
        <select className={styles.fieldSelect} value={value ?? ''}
          disabled={localities.isLoading || !state || isEmpty}
          onChange={(e) => onChange(e.target.value)}>
          <option value="">
            {localities.isLoading ? 'Loading…' :
             !state ? 'Pick a state first' :
             isEmpty ? 'No cities seeded for this state' :
             '— Pick city —'}
          </option>
          {sortByText(list).map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
      </span>
    </label>
  );
};

const CURRENCY_OPTIONS: readonly Currency[] = ['MYR', 'RMB', 'CNY', 'USD', 'SGD'];

const CurrencyEditSelect = ({ value, onChange }: { value: Currency; onChange: (v: Currency) => void }) => (
  <label className={styles.field}>
    <span className={styles.fieldLabel}>Currency</span>
    <span className={styles.selectWrap}>
      <select
        className={styles.fieldSelect}
        value={value}
        onChange={(e) => onChange(e.target.value as Currency)}
      >
        {CURRENCY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
    </span>
  </label>
);
