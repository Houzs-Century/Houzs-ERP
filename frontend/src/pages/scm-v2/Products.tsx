
import { useCallback, useEffect, useMemo, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  Download,
  Upload,
  Edit3,
  Save,
  Search,
  History,
  Package,
  Trash2,
  EyeOff,
  Plus,
  X,
  Truck,
  Star,
  ChevronDown,
  Info,
} from 'lucide-react';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/Layout';
import { humaniseStatusKey } from '../../vendor/scm/lib/status-pill';
import { useDebouncedValue } from '../../vendor/scm/lib/hooks';
import { SearchableSelect } from '../../vendor/scm/components/SearchableSelect';
import { fmtSen, fmtDate, fmtDateTime, maintActiveValues, maintEntryActive, maintEntryValue, maintEntryWithActive, maintEntryWithValue, maintValues, resolveSofaQuickPresets, SOFA_MODULES, type MaintPoolEntry, type SofaQuickPreset } from '@2990s/shared';
import {
  useMfgProducts,
  useMfgProductBoundCodes,
  useUpdateMfgProductPrices,
  useCreateMfgProduct,
  useBatchImportMfgProducts,
  useDeleteMfgProduct,
  useUpdateMfgProductStatus,
  useMaintenanceConfig,
  useMaintenanceConfigHistory,
  useSaveMaintenanceConfig,
  useSpecialAddons,
  useSpecialAddonsHistory,
  useSaveSpecialAddons,
  useRenameSofaCompartment,
  useMfgProductSuppliers,
  useMfgProductPriceChanges,
  useCreateMfgProductPriceChange,
  useUploadSofaCompartmentPhoto,
  useDeleteSofaCompartmentPhoto,
  type MfgCategory,
  type SofaCompartmentRenameResult,
  type MfgProductRow,
  type BatchImportRow,
  type BatchImportResult,
  type MaintenanceConfig,
  type PricedOption,
  type SofaPriceTier,
  type ProductSupplierRow,
  type ProductCostAnchor,
  type MfgProductPriceChangeRow,
  type SpecialAddonRow,
  type SpecialAddonInput,
  type SpecialAddonGroup,
  type SpecialAddonsHistoryRow, mfgCategoryLabel,
} from '../../vendor/scm/lib/mfg-products-queries';
import { CategorySwapSelect } from '../../vendor/scm/components/CategorySwapSelect';
import { costMarker } from './costMarker';
import { CostAnchorCard } from './CostAnchorCard';
import { ProductPriceTimeline } from './ProductPriceTimeline';
import { SkuHistoryTabs } from './SkuHistoryTabs';
import { AddSupplierBinding } from './AddSupplierBinding';
import { DeleteBindingButton } from './DeleteBindingButton';
import { ImportModelsMoved } from '../../vendor/scm/components/ImportModelsMoved';
import { MFG_CATEGORY_LABELS, MFG_PRODUCT_CATEGORIES } from '../../vendor/shared/product-categories';
import { useStaffLookup } from '../../hooks/useStaffLookup';
import { useFabricTrackings } from '../../vendor/scm/lib/fabric-queries';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import { DataTable, type Column } from '../../components/DataTable';
import { SkeletonRows } from '../../vendor/scm/components/Skeleton';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { usePrompt } from '../../vendor/scm/components/PromptDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { todayMyt } from '../../vendor/scm/lib/dates';
import { FabricsTable } from '../../vendor/scm/components/FabricsTable';
import { SofaComboTab } from '../../vendor/scm/components/SofaComboTab';
import { FabricTracking } from './FabricTracking';
import { formatSizeRich, formatSizeRichWithCfg, resolveSizeInfo } from '../../vendor/scm/lib/size-info';
import { formatPhone } from '../../vendor/shared/phone';
import { ProductModels, NewModelDialog } from './ProductModels';
import { VariantsTab } from './products/VariantsTab';
import { MergeCodesDialog } from './products/MergeCodesDialog';
import { modelFilterLabel, modelLabelOf } from './products/modelLabel';
import { describeRenameCounts } from './products/compartmentRename';
import { Categories } from './Categories';
import { useBrandingPool, useProductModel } from '../../vendor/scm/lib/product-models-queries';
import { useQueryClient } from '@tanstack/react-query';
import { parseMoneyToSen } from '../../lib/money';
import styles from './Products.module.css';
import { buildSkuImportRows, gridToSkuRecords, importFailureMessage, priceSheetRinggit, withSkuImportHeaders } from './products-import-headers';
import { readImportGrid } from '../../lib/import-sheet';
import { ProductRow, fmtRm, fmtUnit, priceForHeightTier, useSkuGridOrder, saveStagedEdits, stageRowEdit, type ProductEditPatch } from './products/SkuEditRow';
import { renameCompartmentMeta } from './compartmentRename';
import { guardFormula } from '../../lib/csv';
import { downloadSkuImportTemplate, savedSummary } from './products/skuImportTemplate';

const ICON_PROPS = { size: 16, strokeWidth: 1.75 } as const;

type TopTab = 'sku' | 'modular' | 'maintenance' | 'combos' | 'variants' | 'fabric' | 'categories';


export const Products = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = (searchParams.get('tab') ?? 'sku') as TopTab;
  const topTab: TopTab = ['sku', 'modular', 'maintenance', 'combos', 'variants', 'fabric', 'categories'].includes(
    tabFromUrl,
  )
    ? tabFromUrl
    : 'sku';
  const setTopTab = (next: TopTab) => {
    const sp = new URLSearchParams(searchParams);
    if (next === 'sku') sp.delete('tab');
    else sp.set('tab', next);
    setSearchParams(sp, { replace: true });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Master data"
        title="Products"
        actions={
          <div
            role="tablist"
            className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md border border-border bg-surface p-1 shadow-stone [&>*]:shrink-0"
          >
            {([
              { value: 'sku' as const, label: 'SKU Master' },
              { value: 'modular' as const, label: 'Modular' },
              { value: 'maintenance' as const, label: 'Maintenance' },
              /* PR #237 — Sofa Combo Pricing (Commander 2026-05-28
                 "去查看 hookka 的 combo module 把整个 copy 过来"). Module-set
                 combo deals that OVERRIDE per-Model compartment pricing. */
              { value: 'combos' as const, label: 'Combo Pricing' },
              { value: 'variants' as const, label: 'Variants' },
              { value: 'fabric' as const, label: 'Fabric Converter' },
              { value: 'categories' as const, label: 'Categories' },
            ]).map((t) => (
              <button
                key={t.value}
                type="button"
                role="tab"
                data-active={topTab === t.value}
                onClick={() => setTopTab(t.value)}
                className={
                  topTab === t.value
                    ? 'whitespace-nowrap rounded bg-primary px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-white shadow-sm transition-all duration-150'
                    : 'whitespace-nowrap rounded px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-all duration-150 hover:bg-primary-soft hover:text-primary'
                }
              >
                {t.label}
              </button>
            ))}
          </div>
        }
      />

      {topTab === 'sku' && <SkuMasterTab />}
      {topTab === 'modular' && <ProductModels />}
      {topTab === 'maintenance' && <MaintenanceTab />}
      {topTab === 'combos' && <SofaComboTab />}
      {topTab === 'variants' && <VariantsTab />}
      {topTab === 'fabric' && <FabricTracking />}
      {topTab === 'categories' && <Categories />}
    </div>
  );
};


const CATEGORIES: { value: MfgCategory | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  ...MFG_PRODUCT_CATEGORIES.map((c) => ({ value: c, label: MFG_CATEGORY_LABELS[c] })),
];


type Tier = SofaPriceTier;

const TIER_CHIPS: { value: Tier; label: string }[] = [
  { value: 'PRICE_1', label: 'P1' },
  { value: 'PRICE_2', label: 'P2' },
  { value: 'PRICE_3', label: 'P3 (HL)' },
  { value: 'PRICE_4', label: 'P4 (FL)' },
];



const VIRTUAL_ROW_THRESHOLD = 40;
const VIRTUAL_OVERSCAN = 12;
const SKU_ROW_HEIGHT_ESTIMATE = 34;

const SkuMasterTab = () => {
  const [category, setCategory] = useState<MfgCategory | 'all'>('all');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [editMode, setEditMode] = useState(false);
  /* Edit→Save (Commander 2026-06-15 — no 裸奔): in Edit Prices mode every cell
     edit stages into pendingEdits keyed by row id; NOTHING hits the server until
     Save. Cancel discards the staged edits. Replaces the old blur-auto-save. */
  const [pendingEdits, setPendingEdits] = useState<Record<string, ProductEditPatch>>({});
  const [savingEdits, setSavingEdits] = useState(false);
  const updatePrices = useUpdateMfgProductPrices();
  const notify = useNotify();
  const askConfirm = useConfirm();
  const rowsByIdRef = useRef(new Map<string, MfgProductRow>());
  const stageEdit = useCallback((id: string, patch: ProductEditPatch) => {
    setPendingEdits((prev) => stageRowEdit(prev, rowsByIdRef.current.get(id) ?? null, id, patch));
  }, []);
  const dirtyCount = Object.keys(pendingEdits).length;
  const saveEdits = async () => {
    const snapshot = pendingEdits;
    const total = Object.keys(snapshot).length;
    if (total === 0) { setEditMode(false); return; }
    setSavingEdits(true);
    const { savedIds, failures } = await saveStagedEdits(snapshot, (id, patch) => updatePrices.mutateAsync({ id, ...patch }));
    setPendingEdits((prev) => {
      const out = { ...prev };
      for (const id of savedIds) if (out[id] === snapshot[id]) delete out[id];
      return out;
    });
    if (savedIds.length > 0) await qc.refetchQueries({ queryKey: ['mfg-products'], type: 'active' });
    setSavingEdits(false);
    const plural = (n: number) => `${n} SKU${n === 1 ? '' : 's'}`;
    if (failures.length === 0) {
      setEditMode(false); if (savedIds.length > 0) bumpGridEpoch();
      void notify({ title: `Saved ${plural(savedIds.length)}.` });
      return;
    }
    void notify({
      title: `Saved ${savedIds.length} of ${plural(total)}. ${failures.length} not saved.`,
      body: failures.slice(0, 5).map((f) => `· ${rowsByIdRef.current.get(f.id)?.code ?? f.id}: ${f.message.slice(0, 160)}`).join('\n')
        + '\n\nThe changes that did not save are still on screen. Fix them and press Save again, or Cancel to drop them.',
      tone: 'error',
    });
  };
  const exitEdit = async () => {
    if (dirtyCount > 0 && !(await askConfirm({
      title: `Discard ${dirtyCount} unsaved change${dirtyCount === 1 ? '' : 's'}?`,
      body: 'The edited rows go back to their saved values.',
      confirmLabel: 'Discard',
      danger: true,
    }))) return;
    setPendingEdits({});
    setEditMode(false);
  };
  const [tier, setTier] = useState<Tier>('PRICE_2');
  const [modelFilter, setModelFilter] = useState<string>('all');
  const [noSupplierOnly, setNoSupplierOnly] = useState(false);

  const { data: products, isLoading, isFetching, error } = useMfgProducts({
    category: category === 'all' ? undefined : category,
    search: debouncedSearch.trim() || undefined,
    anchorState: true,
  });
  const searching =
    search.trim() !== debouncedSearch.trim() || (!isLoading && isFetching);
  const boundCodes = useMfgProductBoundCodes();
  const config = useMaintenanceConfig('master');
  const brandingPool = useBrandingPool();

  const allRows = useMemo(() => products ?? [], [products]);
  useEffect(() => { rowsByIdRef.current = new Map(allRows.map((r) => [r.id, r])); }, [allRows]);
  const isSofaView = category === 'SOFA';
  const isMattressView = category === 'MATTRESS';
  const sofaSizes = useMemo(
    () => (config.data?.data?.sofaSizes ? maintValues(config.data.data.sofaSizes) : ['24', '26', '28', '30', '32', '35']),
    [config.data],
  );

  const supportsModelFilter = category === 'SOFA' || category === 'BEDFRAME' || category === 'MATTRESS';
  const categoryModels = useMemo<string[]>(() => {
    if (!supportsModelFilter) return [];
    const s = new Set<string>();
    for (const r of allRows) if (modelLabelOf(r)) s.add(modelLabelOf(r));
    return Array.from(s).sort();
  }, [allRows, supportsModelFilter]);
  const codeByModelLabel = useMemo(
    () => new Map(allRows.filter((r) => r.base_model).map((r) => [modelLabelOf(r), r.base_model as string])),
    [allRows],
  );

  const rows = useMemo(() => {
    let base = allRows;
    if (supportsModelFilter && modelFilter !== 'all') {
      base = base.filter((r) => modelLabelOf(r) === modelFilter);
    }
    if (noSupplierOnly && boundCodes.data) {
      base = base.filter((r) => !boundCodes.data!.has(r.code));
    }
    return base;
  }, [allRows, supportsModelFilter, modelFilter, noSupplierOnly, boundCodes.data]);

  const unboundInView = useMemo(
    () => (boundCodes.data ? allRows.reduce((n, r) => n + (boundCodes.data!.has(r.code) ? 0 : 1), 0) : null),
    [allRows, boundCodes.data],
  );
  const { setGridRows, gridEpoch, bumpGridEpoch, shownRows } = useSkuGridOrder(rows);

  useEffect(() => {
    if (!supportsModelFilter && modelFilter !== 'all') setModelFilter('all');
  }, [supportsModelFilter, modelFilter]);

  const [newSkuOpen, setNewSkuOpen] = useState(false);
  const [suppliersRow, setSuppliersRow] = useState<MfgProductRow | null>(null);
  const [importing, setImporting] = useState(false);
  const [merging, setMerging] = useState(false);
  const [newModelOpen, setNewModelOpen] = useState(false);
  const qc = useQueryClient();
  const initialCategoryForDialog: MfgCategory | undefined =
    category === 'all' ? undefined : (category as MfgCategory);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const deleteMut = useDeleteMfgProduct();
  const [statusing, setStatusing] = useState(false);
  const statusMut = useUpdateMfgProductStatus();
  const visibleIds = useMemo(() => shownRows.map((r) => r.id), [shownRows]);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someSelected = !allSelected && visibleIds.some((id) => selectedIds.has(id));
  const toggleRow = useCallback((id: string) =>
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    }), []);
  const toggleAllVisible = () =>
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (allSelected) {
        for (const id of visibleIds) n.delete(id);
      } else {
        for (const id of visibleIds) n.add(id);
      }
      return n;
    });
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const vis = new Set(visibleIds);
      const next = new Set<string>();
      for (const id of prev) if (vis.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, [visibleIds]);
  /* Bulk activate / deactivate selected SKUs (owner 2026-06-19 — "为什么不能
     inactive 掉"). Inactive SKUs drop out of the POS catalog + new-entry pickers
     but stay on existing documents; fully reversible. Server: PATCH
     /mfg-products/:id { status } (useUpdateMfgProductStatus). No usage block —
     unlike delete, inactivating a used SKU is safe. */
  const bulkSetStatus = async (status: 'ACTIVE' | 'INACTIVE') => {
    if (selectedIds.size === 0 || statusing) return;
    const verb = status === 'INACTIVE' ? 'Deactivate' : 'Activate';
    if (!(await askConfirm({
      title: `${verb} ${selectedIds.size} SKU${selectedIds.size === 1 ? '' : 's'}?`,
      body: status === 'INACTIVE'
        ? 'Inactive SKUs are hidden from the POS catalog and new-entry pickers; existing documents keep showing them. You can re-activate any time.'
        : 'The selected SKUs become active again.',
      confirmLabel: verb,
    }))) return;
    setStatusing(true);
    const ids = Array.from(selectedIds);
    const results = await Promise.all(ids.map((id) =>
      statusMut.mutateAsync({ id, status })
        .then(() => ({ ok: true as const }))
        .catch((e) => ({ ok: false as const, err: e instanceof Error ? e.message : 'Something went wrong.' })),
    ));
    setStatusing(false);
    setSelectedIds(new Set());
    const failed = results.filter((r): r is { ok: false; err: string } => !r.ok);
    if (failed.length === 0) {
      notify({ title: `${verb}d ${ids.length} SKU${ids.length === 1 ? '' : 's'}.` });
    } else {
      notify({
        title: `${verb}d ${ids.length - failed.length} / ${ids.length}. ${failed.length} failed.`,
        body: failed.slice(0, 3).map((f) => `· ${f.err.slice(0, 160)}`).join('\n'),
        tone: 'error',
      });
    }
  };
  const bulkDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!(await askConfirm({
      title: `Delete ${selectedIds.size} SKU${selectedIds.size === 1 ? '' : 's'}?`,
      body: 'This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    }))) return;
    setDeleting(true);
    const ids = Array.from(selectedIds);
    const results = await Promise.all(ids.map((id) =>
      deleteMut.mutateAsync(id).then(() => ({ id, ok: true as const })).catch((e) => ({ id, ok: false as const, err: e instanceof Error ? e.message : 'Something went wrong.' })),
    ));
    setDeleting(false);
    const failed = results.filter((r): r is { id: string; ok: false; err: string } => !r.ok);
    setSelectedIds(new Set());
    if (failed.length === 0) return;

    const blockedByRef = failed.filter((f) => /product_in_use|23503|references/i.test(f.err));
    const sample = failed.slice(0, 3).map((f) => `· ${f.err.slice(0, 160)}`).join('\n');
    const overflow = failed.length > 3 ? `\n…and ${failed.length - 3} more.` : '';
    const wantForce = blockedByRef.length > 0 && (await askConfirm({
      title: `Deleted ${results.length - failed.length} / ${results.length}. ${failed.length} failed:`,
      body: `${sample}${overflow}\n\n`
        + `${blockedByRef.length} of the failures look like inventory / supplier bindings.\n`
        + `Force delete will wipe those side-table rows first then drop the SKU. Continue?`,
      confirmLabel: 'Force delete',
      danger: true,
    }));
    if (!wantForce) {
      notify({
        title: `Deleted ${results.length - failed.length} / ${results.length}. ${failed.length} failed.`,
        body: `${sample}${overflow}`,
        tone: 'error',
      });
      return;
    }
    setDeleting(true);
    const retry = await Promise.all(failed.map((f) =>
      deleteMut.mutateAsync({ id: f.id, force: true }).then(() => ({ id: f.id, ok: true as const })).catch((e) => ({ id: f.id, ok: false as const, err: e instanceof Error ? e.message : 'Something went wrong.' })),
    ));
    setDeleting(false);
    const stillFailed = retry.filter((r) => !r.ok);
    if (stillFailed.length === 0) {
      notify({ title: `Force delete cleaned up the remaining ${retry.length} SKU${retry.length === 1 ? '' : 's'}.` });
    } else {
      const stillSample = stillFailed.slice(0, 3).map((r) => `· ${r.ok ? '' : r.err.slice(0, 160)}`).join('\n');
      notify({
        title: 'Force delete',
        body: `${retry.length - stillFailed.length} / ${retry.length} succeeded. ${stillFailed.length} still failed:\n${stillSample}`,
        tone: 'error',
      });
    }
  };

  const colCount = 1 + (isSofaView
    ? 3 + sofaSizes.length + 1
    : isMattressView
      ? 6
      : 7);

  const canVirtualize = editMode && !isLoading && !error && shownRows.length > VIRTUAL_ROW_THRESHOLD;
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  const rowHeightRef = useRef(SKU_ROW_HEIGHT_ESTIMATE);
  const [winRange, setWinRange] = useState<{ start: number; end: number }>({
    start: 0,
    end: VIRTUAL_ROW_THRESHOLD * 2,
  });
  useEffect(() => {
    if (!canVirtualize) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const el = tbodyRef.current;
      if (!el) return;
      const firstRow = el.querySelector<HTMLElement>('tr[data-vrow]');
      if (firstRow && firstRow.offsetHeight > 0) rowHeightRef.current = firstRow.offsetHeight;
      const rh = rowHeightRef.current || SKU_ROW_HEIGHT_ESTIMATE;
      const top = el.getBoundingClientRect().top;
      const vh = window.innerHeight;
      const first = Math.max(0, Math.floor(-top / rh) - VIRTUAL_OVERSCAN);
      const count = Math.ceil(vh / rh) + VIRTUAL_OVERSCAN * 2;
      const last = Math.min(shownRows.length, first + count);
      setWinRange((prev) => (prev.start === first && prev.end === last ? prev : { start: first, end: last }));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [canVirtualize, shownRows.length]);
  const vStart = canVirtualize ? winRange.start : 0;
  const vEnd = canVirtualize ? Math.min(shownRows.length, winRange.end) : shownRows.length;

  /* ── Batch 2: shared DataTable (was DataGrid, owner request 2026-06-12) ──
     Normal viewing renders through DataTable (sorting, per-column filters,
     column show/hide, layout persistence). Row selection moved off the
     hand-rolled checkbox column onto DataTable's first-class `selection`
     (header select-all with indeterminate comes with it, so the old toolbar
     checkbox label is gone). Edit Prices mode keeps the legacy table below —
     the shared table can't host the inline price-edit cells (PriceInput /
     BrandingInput draft buffers live on the memoized ProductRow), so the
     legacy markup stays the editor. Category chips / search / Export /
     Import / bulk actions above are untouched and drive both views. */
  const gridColumns = useMemo<Column<MfgProductRow>[]>(() => {
    const cols: Column<MfgProductRow>[] = [
      {
        key: 'code',
        label: 'Product Code',
        width: '180px',
        getValue: (r) => r.code ?? '',
        render: (r) => (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <button
              type="button"
              aria-label={`View suppliers for ${r.code}`}
              title="View suppliers carrying this SKU"
              onClick={(e) => { e.stopPropagation(); setSuppliersRow(r); }}
              style={{
                background: 'transparent', border: 'none', padding: 0, margin: 0,
                cursor: 'pointer', color: 'var(--hz-c-ink-muted)',
                display: 'inline-flex', alignItems: 'center',
              }}
            >
              <Truck size={13} strokeWidth={1.75} />
            </button>
            <span className={styles.codeChip}>{r.code}</span>
          </span>
        ),
      },
      {
        key: 'desc',
        label: 'Description',
        width: '240px',
        getValue: (r) => r.name ?? '',
        render: (r) => (
          <span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
              <span className={styles.nameCompact}>{r.name}</span>
              {r.one_shot && (
                <span
                  className={styles.catPill}
                  title={r.source_doc_no ? `One-shot from ${r.source_doc_no}` : 'One-shot SKU'}
                  style={{ fontSize: 'var(--fs-11)' }}
                >
                  one-shot
                </span>
              )}
            </span>
            {r.description && <div className={styles.nameSubCompact}>{r.description}</div>}
          </span>
        ),
      },
    ];
    if (isSofaView) {
      cols.push({
        key: 'model',
        label: 'Model',
        width: '120px',
        getValue: (r) => modelLabelOf(r),
        render: (r) => modelLabelOf(r) || '—',
      });
      /* The two columns that make the exported sheet a TEMPLATE and not a
         picture of the screen — docs/bugs/0662. Labelled with the importer's
         own key names, so the round trip needs no alias for either. */
      cols.push({
        key: 'category',
        label: 'category',
        width: '110px',
        getValue: (r) => r.category,
        render: (r) => mfgCategoryLabel(r.category),
      });
      cols.push({
        key: 'price_tier',
        label: 'price_tier',
        width: '110px',
        getValue: () => tier,
        render: () => <span>{tier}</span>,
      });
      for (const s of sofaSizes) {
        cols.push({
          key: `size-${s}`,
          label: s,
          width: '110px',
          align: 'right',
          getValue: (r) => priceForHeightTier(r.seat_height_prices, s, tier) ?? -1,
          render: (r) => {
            const sen = priceForHeightTier(r.seat_height_prices, s, tier);
            return <span className={sen ? styles.price : styles.priceEmpty}>{fmtRm(sen)}</span>;
          },
        });
      }
    } else if (isMattressView) {
      cols.push(
        {
          key: 'branding',
          label: 'Branding',
          width: '130px',
          getValue: (r) => r.branding ?? '',
          render: (r) => r.branding
            ? <span className={styles.catPill}>{r.branding}</span>
            : <span className={styles.priceEmpty}>—</span>,
        },
        {
          key: 'size',
          label: 'Size',
          width: '120px',
          getValue: (r) => r.size_label ?? '',
          render: (r) => r.size_label ?? '—',
        },
        {
          key: 'price',
          label: 'Price',
          width: '120px',
          align: 'right',
          getValue: (r) => r.base_price_sen ?? -1,
          render: (r) => (
            <span className={r.base_price_sen ? styles.price : styles.priceEmpty}>
              {fmtRm(r.base_price_sen)}{costMarker(r.costAnchorState)}
            </span>
          ),
        },
      );
    } else {
      cols.push(
        {
          key: 'category',
          label: 'Category',
          width: '110px',
          getValue: (r) => r.category,
          render: (r) => <span className={styles.catPill}>{mfgCategoryLabel(r.category)}</span>,
        },
        {
          key: 'size',
          label: 'Size',
          width: '120px',
          getValue: (r) => r.size_label ?? '',
          render: (r) => r.size_label ?? '—',
        },
        {
          key: 'price2',
          label: 'Price 2',
          width: '110px',
          align: 'right',
          getValue: (r) => r.base_price_sen ?? -1,
          render: (r) => (
            <span className={r.base_price_sen ? styles.price : styles.priceEmpty}>
              {fmtRm(r.base_price_sen)}{costMarker(r.costAnchorState)}
            </span>
          ),
        },
        {
          key: 'price1',
          label: 'Price 1',
          width: '110px',
          align: 'right',
          getValue: (r) => r.price1_sen ?? -1,
          render: (r) => (
            <span className={r.price1_sen ? styles.price : styles.priceEmpty}>
              {fmtRm(r.price1_sen)}
            </span>
          ),
        },
      );
    }
    cols.push(
      {
        key: 'barcode',
        label: 'Barcode',
        width: '140px',
        getValue: (r) => r.barcode ?? '',
        render: (r) => r.barcode
          ? <span className={styles.codeChip}>{r.barcode}</span>
          : <span className={styles.priceEmpty}>—</span>,
      },
      {
        key: 'unit',
        label: 'Unit (m³)',
        width: '90px',
        align: 'right',
        getValue: (r) => r.unit_m3_milli,
        render: (r) => fmtUnit(r.unit_m3_milli),
      },
      {
        key: 'status',
        label: 'Status',
        width: '90px',
        getValue: (r) => r.status,
        render: (r) => humaniseStatusKey(r.status),
      },
    );
    return withSkuImportHeaders(cols);
  }, [isSofaView, isMattressView, sofaSizes, tier]);

  const gridTableId = `products-sku-${isSofaView ? 'sofa' : isMattressView ? 'mattress' : 'default'}`;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-5">
        <div className="flex gap-2">
          {CATEGORIES.map((c) => (
            <CategoryChip
              key={c.value}
              active={category === c.value}
              onClick={() => setCategory(c.value)}
            >
              {c.label}
            </CategoryChip>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <div className={styles.searchBox}>
            <Search {...ICON_PROPS} className={styles.searchIcon} />
            <input
              type="search"
              className={styles.searchInput}
              placeholder="Search all products..."
              aria-label="Search all products"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {searching && (
            <span role="status" aria-live="polite" className="text-[11px] font-semibold text-primary">
              Searching…
            </span>
          )}
          <Button variant="secondary" onClick={() => exportSkusCsv(rows, sofaSizes, tier, category)} disabled={searching}>
            <Download {...ICON_PROPS} />
            <span>Export SKUs</span>
          </Button>
          <Button variant="secondary" onClick={() => setImporting(true)}>
            <Upload {...ICON_PROPS} />
            <span>Import SKUs</span>
          </Button>
          <Button variant="secondary" onClick={() => setMerging(true)}>
            <span>Merge codes</span>
          </Button>
          <Button variant="secondary" onClick={() => setNewModelOpen(true)}>
            <Plus {...ICON_PROPS} />
            <span>New SKU</span>
          </Button>
          {!searching && selectedIds.size > 0 && (
            <Button
              variant="danger"
              onClick={bulkDelete}
              disabled={deleting}
            >
              <Trash2 {...ICON_PROPS} />
              <span>{deleting ? 'Deleting…' : `Delete ${selectedIds.size}`}</span>
            </Button>
          )}
          {/* Bulk activate / deactivate (owner 2026-06-19). Inactive = hidden from
              POS + new-entry pickers, kept on existing docs, reversible. */}
          {!searching && selectedIds.size > 0 && (
            <>
              <Button variant="secondary" onClick={() => bulkSetStatus('INACTIVE')} disabled={statusing}>
                <EyeOff {...ICON_PROPS} />
                <span>{statusing ? 'Working…' : `Set inactive (${selectedIds.size})`}</span>
              </Button>
              <Button variant="secondary" onClick={() => bulkSetStatus('ACTIVE')} disabled={statusing}>
                <span>Set active</span>
              </Button>
            </>
          )}
          {editMode ? (
            <>
              <Button variant="secondary" onClick={() => void exitEdit()} disabled={savingEdits}>
                <X {...ICON_PROPS} />
                <span>Cancel</span>
              </Button>
              <Button variant="primary" onClick={() => void saveEdits()} disabled={savingEdits || dirtyCount === 0}>
                <Save {...ICON_PROPS} />
                <span>{savingEdits ? 'Saving…' : dirtyCount > 0 ? `Save (${dirtyCount})` : 'Save'}</span>
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={() => setEditMode(true)} disabled={searching}>
              <Edit3 {...ICON_PROPS} />
              <span>Edit Prices</span>
            </Button>
          )}
          {isSofaView && (
            <div className={styles.tierGroup}>
              <span className={styles.tierLabel}>TIER</span>
              <div className={styles.tierChips}>
                {TIER_CHIPS.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => setTier(t.value)}
                    data-active={tier === t.value}
                    className={styles.tierChip}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {supportsModelFilter && categoryModels.length > 1 && (
        <div style={{ marginTop: 'var(--space-2)', width: 300, maxWidth: '100%' }}>
          <SearchableSelect
            value={modelFilter === 'all' ? '' : modelFilter}
            onChange={(v) => setModelFilter(v || 'all')}
            options={[
              { value: '', label: `All models (${categoryModels.length})` },
              ...categoryModels.map((m) => ({ value: m, label: modelFilterLabel(m, codeByModelLabel.get(m)) })),
            ]}
            placeholder={`Search ${categoryModels.length} models…`}
            className="block w-full rounded-md border border-border bg-surface py-1.5 px-2.5 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            ariaLabel="Model filter"
          />
        </div>
      )}

      <label style={{ marginTop: 'var(--space-2)', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-13)', cursor: 'pointer' }} title="Show only SKUs with no supplier bound yet — the gap to fill">
        <input type="checkbox" checked={noSupplierOnly} onChange={(e) => setNoSupplierOnly(e.target.checked)} />
        Only SKUs with no supplier binding{unboundInView != null ? ` (${unboundInView})` : ''}
      </label>

      <p className={styles.eyebrow}>
        {isLoading
          ? 'Loading products…'
          : `${rows.length} products · Production configs from SKU sheet`}
      </p>

      {error && !isLoading && (
        <div className={styles.bannerErr}>
          <strong>Failed to load products.</strong>{' '}
          {error instanceof Error ? error.message : 'Something went wrong.'}
          <div style={{ marginTop: 6, fontSize: 'var(--fs-12)', color: 'var(--hz-c-ink-muted)' }}>
            If this keeps happening, sign out and back in — your session may
            have expired — or let IT know.
          </div>
        </div>
      )}

      <div hidden={editMode}>{
        <DataTable<MfgProductRow>
          key={gridEpoch} tableId={gridTableId} layoutFamily={gridTableId}
          persistFilters={false}
          exportName="sku-master"
          rows={isLoading || searching ? null : rows}
          onFilteredRowsChange={setGridRows}
          loading={isLoading || searching}
          emptyLabel="No products yet. Run the seed import if you just migrated the schema."
          getRowKey={(r) => r.id}
          columns={gridColumns}
          onRowClick={(r) => setSuppliersRow(r)}
          selection={{
            selectedIds,
            onToggle: toggleRow,
            onToggleAll: (keys, all) =>
              setSelectedIds((prev) => {
                const n = new Set(prev);
                if (all) for (const k of keys) n.delete(k);
                else for (const k of keys) n.add(k);
                return n;
              }),
          }}
        />
      }</div>

      {editMode && (
      <div className={styles.tableCard}>
        <div className={styles.skuScroll}>
        <table className={`${styles.table} ${styles.tableCompact}`}>
          <thead>
            <tr>
              <th style={{ width: 32 }}>
                <input
                  type="checkbox"
                  aria-label="Select all visible SKUs"
                  checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = someSelected; }}
                  onChange={toggleAllVisible}
                  style={{ cursor: 'pointer' }}
                />
              </th>
              <th>Product Code</th>
              <th>Description</th>
              {isSofaView ? (
                <>
                  <th>Model</th>
                  {sofaSizes.map((s) => (
                    <th key={s} style={{ textAlign: 'right' }}>{s}</th>
                  ))}
                </>
              ) : isMattressView ? (
                <>
                  <th>Branding</th>
                  <th>Size</th>
                  <th style={{ textAlign: 'right' }}>Price</th>
                </>
              ) : (
                <>
                  <th>Category</th>
                  <th>Size</th>
                  <th style={{ textAlign: 'right' }}>Price 2</th>
                  <th style={{ textAlign: 'right' }}>Price 1</th>
                </>
              )}
              <th style={{ textAlign: 'right' }}>Unit (m³)</th>
            </tr>
          </thead>
          <tbody ref={tbodyRef}>
            {isLoading && <SkeletonRows cols={colCount} rows={12} />}
            {canVirtualize && vStart > 0 && (
              <tr aria-hidden>
                <td colSpan={colCount} style={{ height: vStart * rowHeightRef.current, padding: 0, border: 0 }} />
              </tr>
            )}
            {!isLoading && shownRows.slice(vStart, vEnd).map((row) => (
              <ProductRow
                key={row.id}
                row={row}
                editMode={editMode}
                isSofaView={isSofaView}
                isMattressView={isMattressView}
                sofaSizes={sofaSizes}
                tier={tier}
                onOpenSuppliers={setSuppliersRow}
                selected={selectedIds.has(row.id)}
                onToggleSelected={toggleRow}
                patch={pendingEdits[row.id]}
                onStage={stageEdit}
                brandingPool={brandingPool.pool}
              />
            ))}
            {canVirtualize && vEnd < shownRows.length && (
              <tr aria-hidden>
                <td colSpan={colCount} style={{ height: (shownRows.length - vEnd) * rowHeightRef.current, padding: 0, border: 0 }} />
              </tr>
            )}
            {!isLoading && !error && shownRows.length === 0 && (
              <tr>
                <td colSpan={colCount} style={{ textAlign: 'center', color: 'var(--hz-c-ink-muted)', padding: 'var(--space-7)' }}>
                  <Package size={32} strokeWidth={1.5} />
                  <div style={{ marginTop: 8 }}>No products yet.</div>
                  <div style={{ marginTop: 4, fontSize: 'var(--fs-12)' }}>
                    Run the seed import if you just migrated the schema.
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
        {!isLoading && !error && (
          <div className={styles.tableFoot}>
            <span className={styles.eyebrow}>
              Record 1 of {shownRows.length}
            </span>
            <span className={styles.eyebrow}>{shownRows.length} total products</span>
          </div>
        )}
      </div>
      )}

      {newSkuOpen && <NewSkuDrawer onClose={() => setNewSkuOpen(false)} />}
      {newModelOpen && (
        <NewModelDialog
          onClose={() => setNewModelOpen(false)}
          initialCategory={initialCategoryForDialog}
          onCreated={(_modelId) => {
            // PR #103 — Commander 2026-05-26: "为什么 create code 会跳
            // 第二页的界面". The bulk dialog already generates SKUs in one
            // shot (the "Create 1×5 = 5 SKUs" button) — no reason to also
            // drag commander onto the Model detail page afterwards. Just
            // refresh both Modular + SKU Master lists in place and close
            // the dialog. New rows surface where commander already is.
            qc.invalidateQueries({ queryKey: ['product-models'] });
            qc.invalidateQueries({ queryKey: ['mfg-products'] });
            setNewModelOpen(false);
          }}
        />
      )}
      {suppliersRow && <ProductSuppliersDrawer row={suppliersRow} onClose={() => setSuppliersRow(null)} />}
      {importing && <ImportSkusDialog sofaSizes={sofaSizes} onClose={() => setImporting(false)} />}
      {merging && <MergeCodesDialog codes={rows.map((r) => r.code)} onClose={() => setMerging(false)} />}
    </>
  );
};


const CategoryChip = ({
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
    data-active={active}
    className={
      active
        ? 'whitespace-nowrap rounded-full border border-primary bg-primary px-4 py-1.5 text-[13px] font-semibold tracking-wide text-white shadow-sm transition-all duration-150'
        : 'whitespace-nowrap rounded-full border border-border bg-surface px-4 py-1.5 text-[13px] font-semibold tracking-wide text-ink transition-all duration-150 hover:border-primary/40 hover:bg-primary-soft hover:text-primary'
    }
  >
    {children}
  </button>
);



type MaintenanceListKey =
  | 'bedframeSizes'
  | 'divanHeights'
  | 'totalHeights'
  | 'gaps'
  | 'legHeights'
  | 'specials'
  | 'sofaCompartments'
  | 'sofaSizes'
  | 'sofaLegHeights'
  | 'sofaSpecials'
  | 'sofaQuickPresets'
  | 'mattressSizes'
  | 'brandings'
  | 'supplierCategories'
  | 'fabrics';

export type MaintenanceSection = 'Bedframe' | 'Sofa' | 'Common' | 'Products Maintenance';

const MAINTENANCE_TABS: {
  key: MaintenanceListKey;
  label: string;
  description: string;
  priced: boolean;
  section: MaintenanceSection;
}[] = [
  { key: 'divanHeights', label: 'Divan Heights', description: 'Bedframe divan height options with surcharge pricing', priced: true, section: 'Bedframe' },
  { key: 'totalHeights', label: 'Total Heights', description: 'Total height (Divan + Gap + Leg) surcharge pricing', priced: true, section: 'Bedframe' },
  { key: 'gaps', label: 'Gaps', description: 'Bedframe gap height options (inches)', priced: false, section: 'Bedframe' },
  { key: 'legHeights', label: 'Leg Heights', description: 'Bedframe leg height options with surcharge pricing', priced: true, section: 'Bedframe' },
  { key: 'specials', label: 'Specials', description: 'Bedframe special add-ons — selling-price options (shared with POS).', priced: true, section: 'Bedframe' },

  { key: 'sofaSizes', label: 'Sizes', description: 'Available sofa seat height sizes (inches)', priced: false, section: 'Sofa' },
  { key: 'sofaLegHeights', label: 'Leg Heights', description: 'Sofa leg height options with surcharge pricing', priced: true, section: 'Sofa' },
  { key: 'sofaSpecials', label: 'Specials', description: 'Sofa special add-ons — selling-price options (shared with POS).', priced: true, section: 'Sofa' },

  { key: 'fabrics', label: 'Fabrics', description: 'Fabric price tier assignment — drives Price 1 / Price 2', priced: false, section: 'Common' },

  { key: 'bedframeSizes',    label: 'Bedframe Sizes',    description: 'Bedframe sizes — edit code · label · dimensions (e.g. K · 6FT · 183X190CM). Used in generated SKU names.', priced: false, section: 'Products Maintenance' },
  { key: 'mattressSizes',    label: 'Mattress Sizes',    description: 'Mattress sizes — edit code · label · dimensions. Used in generated SKU names + width/length placeholders.', priced: false, section: 'Products Maintenance' },
  { key: 'sofaCompartments', label: 'Sofa Compartments', description: 'Sofa compartment pool (1A(LHF), 1A(RHF), 1NA, 2A(LHF), ...). Models tick which they offer.', priced: false, section: 'Products Maintenance' },
  { key: 'brandings',        label: 'Brandings',         description: 'Branding pool (e.g. HILTON, SEALY, 2990S). Feeds every Branding input — New SKU, bulk New Models rows, SKU Master inline edit, Model detail.', priced: false, section: 'Products Maintenance' },
  // Supply Category pool (owner spec 2026-06-12) — drives the Suppliers list
  // filter chips and the supplier create/edit form's multi-select toggles.
  // Empty pool falls back to Sofa / Bedframe / Mattress / Accessory / Service.
  { key: 'supplierCategories', label: 'Supplier Categories', description: 'Supply Category pool (e.g. Sofa, Bedframe, Mattress). Feeds the Suppliers list filter chips + the supplier form’s Supply Category toggles. Empty = default five (Sofa / Bedframe / Mattress / Accessory / Service).', priced: false, section: 'Products Maintenance' },
];

/**
 * Maintenance tab.
 *
 * PR #208 (Commander 2026-05-27) — exported + parameterised so SupplierDetail
 * can mount the same UI scoped to a specific supplier. Defaults preserve
 * the original Products-page behaviour: scope='master' and every section
 * is visible.
 *
 *   scope          — maintenance_config_history.scope to read + write.
 *   sectionFilter  — optional allow-list of MaintenanceSection labels. Omit
 *                    to show every section.
 *   emptyHint      — optional message rendered when this scope has no row
 *                    yet AND the master fallback also has none. Supplier
 *                    Detail uses this to nudge "Click Edit to seed".
 *   singleCostColumn — DEPRECATED no-op (owner 2026-06-22). Every priced pool
 *                    now shows exactly ONE price (the single "RM" surcharge IS
 *                    the SO cost), so the old two-column / relabel behaviour is
 *                    gone. The prop is retained so existing callers (Supplier
 *                    Detail) keep compiling; it has no effect.
 */
export const MaintenanceTab = ({
  scope = 'master',
  sectionFilter,
  emptyHint,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  singleCostColumn: _singleCostColumn = false,
}: {
  scope?: string;
  sectionFilter?: MaintenanceSection[];
  emptyHint?: ReactNode;
  singleCostColumn?: boolean;
} = {}) => {
  const resolved = useMaintenanceConfig(scope);
  const history = useMaintenanceConfigHistory(scope);
  const save = useSaveMaintenanceConfig();
  const renameCompartment = useRenameSofaCompartment();
  const brandingPool = useBrandingPool();
  const specialAddonsList = useSpecialAddons();

  const wantMasterFallback =
    scope !== 'master' && !resolved.data?.data && !resolved.isLoading;
  const masterFallback = useMaintenanceConfig('master', {
    enabled: wantMasterFallback,
  });

  const allSections: MaintenanceSection[] = ['Bedframe', 'Sofa', 'Common', 'Products Maintenance'];
  const sections: MaintenanceSection[] = sectionFilter ?? allSections;
  const visibleTabs = useMemo(
    () => MAINTENANCE_TABS.filter((t) =>
      sections.includes(t.section)
      && !((t.key === 'specials' || t.key === 'sofaSpecials') && scope !== 'master')),
    [sections, scope],
  );

  const defaultActiveKey: MaintenanceListKey = visibleTabs[0]?.key ?? 'divanHeights';

  const [activeKey, setActiveKey] = useState<MaintenanceListKey>(defaultActiveKey);

  useEffect(() => {
    if (!visibleTabs.find((t) => t.key === activeKey)) {
      setActiveKey(defaultActiveKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleTabs]);

  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<MaintenanceConfig | null>(null);
  const [showMaintHistory, setShowMaintHistory] = useState(false);
  const askPrompt = usePrompt();
  const notify = useNotify();
  const askConfirm = useConfirm();

  const fabricsList = useFabricTrackings({ includeRetired: false });
  const fabricsCount = fabricsList.data?.length ?? 0;

  const config =
    draft ?? resolved.data?.data ?? masterFallback.data?.data ?? null;
  const active = MAINTENANCE_TABS.find((t) => t.key === activeKey) ?? visibleTabs[0];
  const isSpecials = active?.key === 'specials' || active?.key === 'sofaSpecials';
  const specialsCat = active?.key === 'sofaSpecials' ? 'SOFA' : 'BEDFRAME';
  const isBrandings = active?.key === 'brandings';

  const startEdit = () => {
    const seed = resolved.data?.data ?? masterFallback.data?.data ?? null;
    if (!seed) return;
    const copy = JSON.parse(JSON.stringify(seed)) as MaintenanceConfig;
    if (
      scope === 'master'
      && maintValues(copy.brandings).filter((b) => b.trim().length > 0).length === 0
      && brandingPool.distinct.length > 0
    ) {
      copy.brandings = [...brandingPool.distinct];
    }
    setDraft(copy);
    setEditMode(true);
  };

  const cancelEdit = () => {
    setDraft(null);
    setEditMode(false);
  };

  const handleSave = async () => {
    if (!draft) return;
    // No-op guard (owner 2026-06-22) — if nothing changed, just close. Don't
    // prompt for an effective date and don't append a new history version for
    // an identical config. Compare against the same baseline startEdit seeded
    // the draft from (supplier-scope row, else master fallback).
    const baselineConfig = resolved.data?.data ?? masterFallback.data?.data ?? null;
    if (baselineConfig && JSON.stringify(baselineConfig) === JSON.stringify(draft)) {
      setDraft(null);
      setEditMode(false);
      return;
    }
    const effectiveFrom = await askPrompt({
      title: 'Effective from (YYYY-MM-DD)?',
      body: 'The new pricing applies from this date onward.',
      defaultValue: todayMyt(),
      placeholder: 'YYYY-MM-DD',
      confirmLabel: 'Save',
      validate: (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? null : 'Enter a date as YYYY-MM-DD.'),
    });
    if (!effectiveFrom) return;
    if (scope === 'master') {
      const baseline = maintValues(
        resolved.data?.data?.sofaCompartments ?? masterFallback.data?.data?.sofaCompartments,
      );
      const next = maintValues(draft.sofaCompartments);
      /* A rename is an IN-PLACE edit, so the row count cannot change. When it
         does, the save is an add and/or a delete, and comparing by INDEX reads
         the shift as a rename: deleting `1B` and `2B` while adding `DB` in the
         same save slid DB up into 1B's old slot and offered to cascade
         "1B -> DB" across SKU codes, sales orders INCLUDING HISTORY, delivery
         orders, invoices, GRN/PO lines, Modular ticks, combos and quick picks —
         with no dry run (owner, 2026-08-10). Length equality is the guard: on a
         length change, do nothing and let the plain save handle it. */
      const renames: Array<{ from: string; to: string }> = [];
      if (baseline.length === next.length) {
        for (let i = 0; i < baseline.length; i++) {
          const from = (baseline[i] ?? '').trim();
          const to = (next[i] ?? '').trim();
          if (!from || !to || from === to) continue;
          if (!next.includes(from) && !baseline.includes(to)) renames.push({ from, to });
        }
      }
      if (renames.length > 0) {
        const previews: SofaCompartmentRenameResult[] = [];
        for (const r of renames) {
          try {
            const res = await renameCompartment.mutateAsync({ ...r, apply: false });
            previews.push(res.result);
          } catch (e) {
            void notify({
              title: `Cannot rename ${r.from} → ${r.to}`,
              body: e instanceof Error ? e.message : 'Something went wrong.',
              tone: 'error',
            });
            return;
          }
        }
        const blocked = previews.filter((p) => p.inUseTotal > 0);
        if (blocked.length > 0) {
          void notify({
            title: `${blocked.map((p) => p.from).join(', ')} is in use and cannot be renamed`,
            body: blocked.map((p) => `${p.from}: ${describeRenameCounts(p.inUse)}`).join('\n') +
              '\nTo change the wording staff see, edit the SKU name or the compartment description instead. Nothing was saved.',
            tone: 'error',
          });
          return;
        }
        const ok = await askConfirm({
          title: `Rename compartment code${renames.length > 1 ? 's' : ''}?`,
          body: previews.map((p) =>
            `${p.from} → ${p.to}: ${describeRenameCounts(p.changes) || 'no other records'}` +
            (p.photoCleared ? ' (its uploaded photo must be uploaded again)' : ''),
          ).join('\n') + '\n\nThis company only. SKUs, documents and stock are not touched.',
          confirmLabel: 'Rename',
          danger: true,
        });
        if (!ok) return;
        for (const r of renames) {
          try {
            await renameCompartment.mutateAsync({ ...r, apply: true });
          } catch (e) {
            void notify({
              title: `Rename ${r.from} → ${r.to} failed`,
              body: `${e instanceof Error ? e.message : 'Something went wrong.'}\nNothing was partially renamed for this pair; fix and retry.`,
              tone: 'error',
            });
            return;
          }
        }
      }
    }
    save.mutate(
      { scope, config: draft, effectiveFrom },
      {
        onSuccess: () => {
          setDraft(null);
          setEditMode(false);
        },
      },
    );
  };

  if (resolved.isLoading || (wantMasterFallback && masterFallback.isPending)) {
    return <p className={styles.eyebrow}>Loading maintenance config…</p>;
  }

  if (resolved.isError) {
    return (
      <div className={styles.bannerErr}>
        <strong>Failed to load maintenance config.</strong>{' '}
        {resolved.error instanceof Error ? resolved.error.message : String(resolved.error)}
        <div style={{ marginTop: 6, fontSize: 'var(--fs-12)', color: 'var(--hz-c-ink-muted)' }}>
          The <code>maintenance_config_history</code> table likely doesn't exist
          yet. Run migration <code>0039_hookka_products_port.sql</code> against
          Supabase, then refresh.
        </div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className={styles.bannerWarn}>
        {emptyHint ?? (
          <>
            No maintenance config baseline found. The migration ran but the master
            baseline row is missing — re-apply migration 0039 to seed it.
          </>
        )}
      </div>
    );
  }

  if (!active) {
    return (
      <div className={styles.bannerWarn}>
        No maintenance sections visible for this scope.
      </div>
    );
  }

  const showingMasterFallback =
    scope !== 'master' && !resolved.data?.data && Boolean(masterFallback.data?.data);

  return (
    <div className={styles.maintLayout}>
      <aside className={styles.maintNav}>
        {sections.map((section) => (
          <div key={section}>
            <div className={styles.maintSection}>{section}</div>
            {MAINTENANCE_TABS.filter((t) => t.section === section).map((t) => {
              const count = t.key === 'fabrics'
                ? fabricsCount
                : t.key === 'brandings'
                  ? brandingPool.pool.length
                  : (t.key === 'specials' || t.key === 'sofaSpecials')
                    ? (specialAddonsList.data ?? []).filter((r) => r.categories.includes(t.key === 'sofaSpecials' ? 'SOFA' : 'BEDFRAME')).length
                    : countItems(config, t.key);
              return (
                <button
                  key={t.key}
                  type="button"
                  data-active={activeKey === t.key}
                  className={styles.maintNavItem}
                  onClick={() => setActiveKey(t.key)}
                >
                  <span>{t.label}</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {t.priced && <span className={styles.maintRmPill}>RM</span>}
                    <span className={styles.maintCount}>({count})</span>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </aside>

      <section className={styles.maintPanel}>
        {isSpecials ? (
          <SpecialsMaintenancePanel
            key={specialsCat}
            category={specialsCat}
            label={active.label}
            description={active.description}
          />
        ) : (
        <>
        <header className={styles.maintHeader}>
          <div>
            <h2 className={styles.maintTitle}>{active.label}</h2>
            <p className={styles.maintSubtitle}>{active.description}</p>
            {!isBrandings && resolved.data?.effectiveFrom && (
              <p className={styles.stateInfo} style={{ marginTop: 8 }}>
                Effective from {resolved.data.effectiveFrom}
                {resolved.data.hasPendingPriceChange && (
                  <span style={{ color: 'var(--hz-c-primary-ink)', fontWeight: 600 }}>
                    · Pending change on {resolved.data.pendingEffectiveFrom}
                  </span>
                )}
              </p>
            )}
            {!isBrandings && showingMasterFallback && (
              <p className={styles.stateInfo} style={{ marginTop: 8, color: 'var(--hz-c-primary-ink)' }}>
                No supplier-specific pricing yet — showing the master baseline.
                Hit Edit + Save to override.
              </p>
            )}
          </div>
          {!isBrandings && (
          <div className="flex items-center gap-3">
            {!editMode ? (
              <Button variant="ghost" onClick={startEdit}>
                <Edit3 {...ICON_PROPS} />
                <span>Edit</span>
              </Button>
            ) : (
              <>
                <Button variant="ghost" onClick={cancelEdit}>
                  <span>Cancel</span>
                </Button>
                <Button variant="primary" onClick={handleSave} disabled={save.isPending}>
                  <span>{save.isPending ? 'Saving…' : 'Save'}</span>
                </Button>
              </>
            )}
            <Button variant="ghost" onClick={() => setShowMaintHistory(true)}>
              <History {...ICON_PROPS} />
              <span>History</span>
            </Button>
          </div>
          )}
        </header>

        {isBrandings ? (
          <BrandingsReadOnlyPanel />
        ) : (
          <MaintenanceList
            listKey={active.key}
            config={config}
            editMode={editMode}
            onChange={(next) => setDraft(next)}
            priced={active.priced}
            brandingSuggestions={brandingPool.distinct}
          />
        )}
        </>
        )}
      </section>

      {showMaintHistory && (
        <MaintenanceHistoryDialog
          activeLabel={active.label}
          activeKey={activeKey}
          history={history.data?.history ?? []}
          onClose={() => setShowMaintHistory(false)}
        />
      )}
    </div>
  );
};

const countItems = (cfg: MaintenanceConfig, key: MaintenanceListKey): number => {
  if (key === 'fabrics') return 0;
  if (key === 'sofaQuickPresets') {
    return resolveSofaQuickPresets(cfg.sofaQuickPresets).length;
  }
  const v = cfg[key as keyof MaintenanceConfig];
  return Array.isArray(v) ? v.length : 0;
};

/* ─── Sofa Compartments — POS module catalogue port (PR #220) ─────────
   Commander 2026-05-27: "把我在 POS System 设计好的模块放进 Maintenance Sofa
   Compartments." Each compartment row gets an image + description +
   default price. The compartment-code list (config.sofaCompartments)
   stays a `string[]` so existing readers (ProductModelDetail allowed
   options, SKU generator) keep working untouched. Per-compartment meta
   lives in a parallel `sofaCompartmentMeta` map keyed by code.

   Code-format note: SOFA_MODULES ids, the pool and the meta map all share
   the ONE canonical parens vocabulary (`1A(LHF)`, 2026-06-04).
   normalizeCompartmentCode canonicalizes a stray legacy dash entry so the
   lookup still hits. */

type CompartmentMeta = {
  imageKey?: string;
  description?: string;
  defaultPriceSen?: number;
};

const normalizeCompartmentCode = (raw: string): string => {
  const dash = raw.trim().replace(/\(([^)]*)\)/g, '-$1').replace(/-+$/, '');
  const parts = dash.split('-').filter(Boolean);
  if (parts.length <= 1) return dash;
  return (parts[0] ?? '') + parts.slice(1).map((p) => `(${p})`).join('');
};

const SOFA_MODULE_BY_NORM_ID = new Map(
  SOFA_MODULES.map((m) => [normalizeCompartmentCode(m.id), m]),
);

// Commander 2026-05-27 definitive taxonomy (CORRECTED):
//
//   nS  = N seats with arms on BOTH sides (1S = 1 seat + 2 arms)
//   nA  = N seats with arm on ONE side (LHF/RHF says which side has arm)
//   nB  = N seats — the LHF/RHF side's "arm position" is a Seat Cushion
//         (bench) instead of a real arm. Commander rule: "Left 就是左边是
//         坐垫的意思" — 1B(LHF) means LEFT is bench, RIGHT has the arm.
//   nNA = N seats, NO arms
//   (P) suffix = Power Recliner (electric)
//   (R) suffix = Manual Recliner
//   CNR = Corner piece (90° L-shape connector — NOT a console)
//   WC-45 = Wood Console (45cm) — divider/storage between two seats
// Keys are the canonical parens codes (lookups go through
// normalizeCompartmentCode first, so a stray legacy dash entry still hits).
const COMPARTMENT_DESCRIPTION_OVERRIDE: Record<string, string> = {
  '1S':     '1 seat, arms on BOTH sides',
  '1A(LHF)': '1 seat, ONE arm (left)',
  '1A(RHF)': '1 seat, ONE arm (right)',
  '1B(LHF)': '1 seat — LEFT is Seat Cushion (bench), no arm on the right',
  '1B(RHF)': '1 seat — RIGHT is Seat Cushion (bench), no arm on the left',
  '1NA':    '1 seat, NO arms',

  '1A(P)(LHF)': '1 seat + ONE arm (left) — Power Recliner (electric)',
  '1A(P)(RHF)': '1 seat + ONE arm (right) — Power Recliner (electric)',
  '1A(R)(LHF)': '1 seat + ONE arm (left) — Manual Recliner',
  '1A(R)(RHF)': '1 seat + ONE arm (right) — Manual Recliner',
  '1NA(P)':     '1 seat, NO arms — Power Recliner (electric)',
  '1NA(R)':     '1 seat, NO arms — Manual Recliner',
  // ── Console variants ────────────────────────────────────────────────
  // Commander 2026-05-28: "console 包布的就叫 Console；上面是木的盖那个叫
  // Console/WC". Two distinct codes with different art.
  Console:         'Console — fabric-wrapped console with cup holders',
  'Console/WC':    'Console/WC — wood lid + fabric body, with cup holders',

  '2S':     '2 seats, arms on BOTH sides',
  '2A(LHF)': '2 seats, ONE arm (left)',
  '2A(RHF)': '2 seats, ONE arm (right)',
  '2B(LHF)': '2 seats — LEFT is Seat Cushion (bench), no arm on the right',
  '2B(RHF)': '2 seats — RIGHT is Seat Cushion (bench), no arm on the left',
  '2NA':    '2 seats, NO arms',

  CNR:     'Corner piece — 90° L-shape connector',
  'WC-45': 'Console (Wood, 45cm) — divider/storage between two seats',
  STOOL:   'Ottoman / stool',
};

const EXTRA_MODULE_IMAGE_BY_NORM: Record<string, string> = {
  Console:       'Console',
  'Console(WC)': 'Console-WC',
  'Console/WC':  'Console-WC',
};

const seedCompartmentMeta = (code: string): CompartmentMeta => {
  const norm = normalizeCompartmentCode(code);
  const mod  = SOFA_MODULE_BY_NORM_ID.get(norm);
  // Every sofa module now has a unified hand-drawn SVG plan view
  // (commander 2026-05-27 "你没有统一怎么行呢"). The previous mix of POS PNGs
  // + bespoke SVGs for 1B/2B/CNR was visually inconsistent at the size the
  // Maintenance list renders them — all module + preset designs were
  // redrawn to the same 3-tone flat style (cream body / medium-tan
  // backrest / darkest-tan armrest, dashed seat seams, no labels).
  if (mod) {
    return {
      imageKey:    `sofa-modules/${mod.id}.svg`,
      description: COMPARTMENT_DESCRIPTION_OVERRIDE[mod.id] ?? mod.label,
      defaultPriceSen: 0,
    };
  }
  const extraStem = EXTRA_MODULE_IMAGE_BY_NORM[code.trim()] ?? EXTRA_MODULE_IMAGE_BY_NORM[norm];
  if (extraStem) {
    const desc =
      COMPARTMENT_DESCRIPTION_OVERRIDE[code] ??
      COMPARTMENT_DESCRIPTION_OVERRIDE[norm] ??
      undefined;
    return {
      imageKey:    `sofa-modules/${extraStem}.svg`,
      description: desc,
      defaultPriceSen: 0,
    };
  }
  return {};
};

const resolveCompartmentMeta = (
  code: string,
  stored: CompartmentMeta | undefined,
): CompartmentMeta => {
  const seed = seedCompartmentMeta(code);
  return {
    imageKey:          stored?.imageKey          ?? seed.imageKey,
    description:       stored?.description       ?? seed.description,
    defaultPriceSen: stored?.defaultPriceSen ?? seed.defaultPriceSen,
  };
};

const formatRmFromSen = (centi: number | undefined): string => {
  const n = centi ?? 0;
  return (n / 100).toFixed(2);
};

const parseRmToSen = (rm: string): number => {
  const n = Number(rm);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
};

const SOFA_COMPARTMENT_API_PREFIX = 'sofa-compartments/';
const resolveCompartmentImageSrc = (
  code: string,
  imageKey: string | undefined,
): string | null => {
  if (!imageKey) return null;
  if (/^https?:\/\//i.test(imageKey)) return imageKey;
  if (imageKey.startsWith(SOFA_COMPARTMENT_API_PREFIX)) {
    const API =
      ((import.meta.env.VITE_API_URL ||
        (import.meta.env.PROD ? '' : 'https://autocount-sync-api.houzs-erp.workers.dev')) as string) +
      '/api/scm';
    return `${API}/maintenance-config/sofa-compartments/${encodeURIComponent(code)}/photo/${encodeURIComponent(imageKey)}`;
  }
  return `/${imageKey}`;
};

const SofaCompartmentsList = ({
  config,
  editMode,
  onChange,
  dragRowProps,
  draftValue,
  setDraftValue,
}: {
  config: MaintenanceConfig;
  editMode: boolean;
  onChange: (next: MaintenanceConfig) => void;
  dragRowProps: (i: number) => HTMLAttributes<HTMLDivElement>;
  draftValue: string;
  setDraftValue: (v: string) => void;
}) => {
  const items = config.sofaCompartments ?? [];
  const meta  = config.sofaCompartmentMeta ?? {};
  const uploadPhoto = useUploadSofaCompartmentPhoto();
  const deletePhoto = useDeleteSofaCompartmentPhoto();
  const notify = useNotify();
  const askConfirm = useConfirm();
  const [uploadingCode, setUploadingCode] = useState<string | null>(null);

  const writeMeta = (code: string, patch: Partial<CompartmentMeta>) => {
    const next = JSON.parse(JSON.stringify(config)) as MaintenanceConfig;
    const m    = next.sofaCompartmentMeta ?? {};
    const cur  = m[code] ?? {};
    m[code] = { ...cur, ...patch };
    next.sofaCompartmentMeta = m;
    onChange(next);
  };

  const removeAt = (idx: number) => {
    const next = JSON.parse(JSON.stringify(config)) as MaintenanceConfig;
    const arr  = next.sofaCompartments ?? [];
    arr.splice(idx, 1);
    next.sofaCompartments = arr;
    onChange(next);
  };

  const addItem = () => {
    const v = draftValue.trim();
    if (!v) return;
    const next = JSON.parse(JSON.stringify(config)) as MaintenanceConfig;
    const arr  = next.sofaCompartments ?? [];
    arr.push(v);
    next.sofaCompartments = arr;
    onChange(next);
    setDraftValue('');
  };

  const updateCode = (idx: number, newVal: string) => {
    const next = JSON.parse(JSON.stringify(config)) as MaintenanceConfig;
    const arr  = next.sofaCompartments ?? [];
    const old  = arr[idx] != null ? maintEntryValue(arr[idx]!) : undefined;
    if (arr[idx] != null) arr[idx] = maintEntryWithValue(arr[idx]!, newVal);
    next.sofaCompartments = arr;
    if (old) {
      next.sofaCompartmentMeta = renameCompartmentMeta(
        next.sofaCompartmentMeta ?? {}, old, newVal, seedCompartmentMeta,
      );
    }
    onChange(next);
  };

  /* ACTIVE toggle (owner spec 2026-06-12) — inactive compartments stay in
     the pool (old SKUs/docs keep displaying them) but disappear from every
     NEW-entry picker. Re-activating collapses back to the plain string. */
  const setActiveAt = (idx: number, active: boolean) => {
    const next = JSON.parse(JSON.stringify(config)) as MaintenanceConfig;
    const arr  = next.sofaCompartments ?? [];
    if (arr[idx] != null) arr[idx] = maintEntryWithActive(arr[idx]!, active);
    next.sofaCompartments = arr;
    onChange(next);
  };

  return (
    <div className={styles.maintList}>
      {items.map((entry, i) => {
        const code = maintEntryValue(entry);
        const entryIsActive = maintEntryActive(entry);
        const resolved = resolveCompartmentMeta(code, meta[code]);
        const stored   = meta[code];
        const hasImage = Boolean(resolved.imageKey);
        return (
          <div
            key={`${code}-${i}`}
            className={styles.maintRow}
            {...dragRowProps(i)}
            style={{
              ...(dragRowProps(i).style ?? {}),
              gridTemplateColumns: '32px 56px 1fr auto auto auto',
              gap: 'var(--space-3)',
              alignItems: 'center',
              opacity: entryIsActive ? 1 : 0.55,
            }}
          >
            <span className={styles.maintRowIdx} style={editMode ? { cursor: 'grab' } : undefined}>
              {i + 1}
            </span>
            {(() => {
              const isUploaded = (resolved.imageKey ?? '').startsWith(SOFA_COMPARTMENT_API_PREFIX);
              const isUploading = uploadingCode === code;
              const src = resolveCompartmentImageSrc(code, resolved.imageKey);
              return (
                <div
                  style={{
                    width: 48,
                    height: 48,
                    background: hasImage ? 'var(--hz-c-surface)' : '#EFEAE0',
                    border: '1px solid var(--hz-c-border)',
                    borderRadius: 'var(--radius-sm)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    overflow: 'hidden',
                    position: 'relative',
                    opacity: isUploading ? 0.5 : 1,
                  }}
                  title={
                    isUploading
                      ? 'Uploading…'
                      : hasImage
                        ? `${resolved.imageKey} — click to replace${isUploaded ? ' · right-click / × to remove' : ''}`
                        : 'Click to upload a photo'
                  }
                  onContextMenu={async (e) => {
                    if (!isUploaded || isUploading) return;
                    e.preventDefault();
                    if (!(await askConfirm({
                      title: `Remove uploaded photo for ${code}?`,
                      confirmLabel: 'Remove',
                      danger: true,
                    }))) return;
                    deletePhoto.mutate(code);
                  }}
                >
                  <label
                    style={{
                      width: '100%',
                      height: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: isUploading ? 'wait' : 'pointer',
                    }}
                  >
                    {hasImage && src ? (
                      <img
                        src={src}
                        alt={code}
                        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                      />
                    ) : (
                      <span style={{ fontSize: 'var(--fs-10)', color: 'var(--hz-c-ink-muted)' }}>+ photo</span>
                    )}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/svg+xml"
                      style={{ display: 'none' }}
                      disabled={isUploading}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (!file) return;
                        setUploadingCode(code);
                        uploadPhoto.mutate({ code, file }, {
                          onSettled: () => setUploadingCode(null),
                          onError: (err) => {
                            notify({ title: 'Upload failed', body: `${err instanceof Error ? err.message : 'Something went wrong.'}`, tone: 'error' });
                          },
                        });
                      }}
                    />
                  </label>
                  {isUploaded && !isUploading && (
                    <button
                      type="button"
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!(await askConfirm({
                          title: `Remove uploaded photo for ${code}?`,
                          confirmLabel: 'Remove',
                          danger: true,
                        }))) return;
                        deletePhoto.mutate(code);
                      }}
                      title="Remove uploaded photo"
                      aria-label={`Remove photo for ${code}`}
                      style={{
                        position: 'absolute',
                        top: -6,
                        right: -6,
                        width: 16,
                        height: 16,
                        borderRadius: '50%',
                        background: 'var(--hz-dk-festive-b, #B8331F)',
                        color: 'white',
                        border: '1px solid var(--hz-c-surface)',
                        fontSize: 10,
                        lineHeight: '14px',
                        padding: 0,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <X size={10} strokeWidth={2.5} />
                    </button>
                  )}
                </div>
              );
            })()}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
              {editMode ? (
                <>
                  <input
                    type="text"
                    value={code}
                    onChange={(e) => updateCode(i, e.target.value)}
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--fs-14)',
                      fontWeight: 600,
                      background: 'var(--hz-c-surface-2)',
                      border: '1px solid var(--hz-c-primary)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '4px 8px',
                      outline: 'none',
                      width: 110,
                    }}
                    title="Compartment code (e.g. 1A(LHF))"
                  />
                  <input
                    type="text"
                    placeholder="Description (e.g. 1-Sitter Left-hand facing)"
                    value={stored?.description ?? resolved.description ?? ''}
                    onChange={(e) => writeMeta(code, { description: e.target.value })}
                    style={{
                      fontFamily: 'var(--font-sans)',
                      fontSize: 'var(--fs-13)',
                      background: 'var(--hz-c-surface-2)',
                      border: '1px solid var(--hz-c-border-strong)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '4px 8px',
                      outline: 'none',
                      width: '100%',
                      maxWidth: 360,
                    }}
                  />
                </>
              ) : (
                <>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--fs-14)',
                      fontWeight: 600,
                      color: 'var(--hz-c-ink)',
                    }}
                  >
                    {code}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--font-sans)',
                      fontSize: 'var(--fs-13)',
                      color: resolved.description ? 'var(--hz-c-ink-soft)' : 'var(--hz-c-ink-muted)',
                    }}
                  >
                    {resolved.description ?? '(no design — leave blank)'}
                  </span>
                </>
              )}
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                minWidth: 120,
                justifyContent: 'flex-end',
              }}
            >
              <span className={styles.maintRowRmPrefix}>RM</span>
              {editMode ? (
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={formatRmFromSen(stored?.defaultPriceSen ?? resolved.defaultPriceSen)}
                  onChange={(e) => writeMeta(code, { defaultPriceSen: parseRmToSen(e.target.value) })}
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--fs-14)',
                    background: 'var(--hz-c-surface-2)',
                    border: '1px solid var(--hz-c-border-strong)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '4px 8px',
                    outline: 'none',
                    width: 90,
                    textAlign: 'right',
                  }}
                />
              ) : (
                <span
                  className={`${styles.maintRowPrice} ${
                    (resolved.defaultPriceSen ?? 0) === 0 ? styles.maintRowPriceMuted : ''
                  }`}
                  style={{ minWidth: 0 }}
                >
                  {formatRmFromSen(resolved.defaultPriceSen)}
                </span>
              )}
            </div>
            {/* ACTIVE toggle (owner spec 2026-06-12) — Yes/No checkbox per row.
                Inactive = hidden from NEW-entry pickers; existing docs keep
                displaying the value. */}
            {editMode ? (
              <label style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-11)',
                color: 'var(--hz-c-ink-soft)', cursor: 'pointer',
              }}>
                <input
                  type="checkbox"
                  checked={entryIsActive}
                  onChange={(e) => setActiveAt(i, e.target.checked)}
                  title="Inactive options are hidden from pickers for new entries; existing documents keep showing them"
                />
                Active
              </label>
            ) : (
              <span style={{
                fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-11)',
                color: entryIsActive ? '#1a7a3a' : 'var(--hz-c-ink-muted)',
              }}>
                {entryIsActive ? 'Active' : 'Inactive'}
              </span>
            )}
            {editMode ? (
              <button
                type="button"
                className={styles.maintRowIcon}
                title="Remove"
                onClick={() => removeAt(i)}
                style={{ color: 'var(--hz-dk-festive-b, #B8331F)' }}
              >
                <Trash2 {...ICON_PROPS} />
              </button>
            ) : (
              <span />
            )}
          </div>
        );
      })}

      {editMode && (
        <div
          className={styles.maintRow}
          style={{
            background: 'var(--hz-c-surface)',
            borderColor: '#16695f',
            gridTemplateColumns: '32px 1fr auto',
          }}
        >
          <span className={styles.maintRowIdx}><Plus {...ICON_PROPS} /></span>
          <input
            type="text"
            placeholder="New compartment code (e.g. 1A(LHF))"
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addItem(); }}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-14)',
              background: 'var(--hz-c-surface-2)',
              border: '1px solid var(--hz-c-border)',
              borderRadius: 'var(--radius-sm)',
              padding: '6px 10px',
              outline: 'none',
            }}
          />
          <Button variant="primary" onClick={addItem}>
            <Plus {...ICON_PROPS} />
            <span>Add</span>
          </Button>
        </div>
      )}
    </div>
  );
};

const SofaQuickPresetsList = ({
  config,
  editMode,
  onChange,
  dragRowProps,
}: {
  config: MaintenanceConfig;
  editMode: boolean;
  onChange: (next: MaintenanceConfig) => void;
  dragRowProps: (i: number) => HTMLAttributes<HTMLDivElement>;
}) => {
  const askConfirm = useConfirm();
  const stored = config.sofaQuickPresets;
  const items: SofaQuickPreset[] = stored && stored.length > 0
    ? stored
    : resolveSofaQuickPresets(undefined);
  const isUsingFallback = !stored || stored.length === 0;

  /* Master compartment pool — drives the modules chip picker. Includes the
     dash-form codes from sofaCompartments (commander's master pool); if
     empty we fall back to SOFA_MODULES so the picker still works on day 1.
     ACTIVE only (owner spec 2026-06-12) — presets compose NEW combos, so
     deactivated compartments must not be offered; existing presets that
     already reference one keep displaying it via p.modules. */
  const compartmentPool: string[] = (config.sofaCompartments && config.sofaCompartments.length > 0)
    ? maintActiveValues(config.sofaCompartments)
    : SOFA_MODULES.map((m) => m.id);

  const writeAll = (next: SofaQuickPreset[]) => {
    const cfg = JSON.parse(JSON.stringify(config)) as MaintenanceConfig;
    cfg.sofaQuickPresets = next;
    onChange(cfg);
  };

  const updateAt = (idx: number, patch: Partial<SofaQuickPreset>) => {
    const next = items.map((p, i) => i === idx ? { ...p, ...patch } : p);
    writeAll(next);
  };

  const removeAt = async (idx: number) => {
    if (!(await askConfirm({
      title: `Remove preset "${items[idx]?.label ?? '?'}"?`,
      body: '(Existing combos with this preset_id keep working.)',
      confirmLabel: 'Remove',
      danger: true,
    }))) return;
    writeAll(items.filter((_, i) => i !== idx));
  };

  const toggleModule = (idx: number, code: string) => {
    const cur = items[idx]?.modules ?? [];
    const next = cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code];
    updateAt(idx, { modules: next });
  };

  const addPreset = () => {
    const usedIds = new Set(items.map((p) => p.id));
    let n = items.length + 1;
    while (usedIds.has(`P${n}`)) n += 1;
    const newRow: SofaQuickPreset = {
      id: `P${n}`,
      label: 'New preset',
      modules: [],
      active: true,
    };
    writeAll([...items, newRow]);
  };

  return (
    <div className={styles.maintList}>
      {isUsingFallback && editMode && (
        <div className={styles.bannerWarn} style={{ marginBottom: 8 }}>
          Showing the default 11-entry list. Hit Save to lift these into the
          stored config and start customising — existing combos that reference
          preset_id will keep resolving against the same ids.
        </div>
      )}
      {items.map((p, i) => (
        <div
          key={`${p.id}-${i}`}
          className={styles.maintRow}
          {...dragRowProps(i)}
          style={{
            ...(dragRowProps(i).style ?? {}),
            gridTemplateColumns: '32px 32px 100px 1fr 110px auto auto',
            gap: 'var(--space-3)',
            alignItems: 'center',
          }}
        >
          <button type="button" className={styles.maintRowIcon} title="History">
            <History {...ICON_PROPS} />
          </button>
          <span className={styles.maintRowIdx} style={editMode ? { cursor: 'grab' } : undefined}>
            {i + 1}
          </span>
          {editMode ? (
            <input
              type="text"
              value={p.id}
              onChange={(e) => updateAt(i, { id: e.target.value })}
              placeholder="ID"
              title="Stable key — referenced by combo rules. Don't rename after combos exist."
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-12)',
                fontWeight: 600,
                background: 'var(--hz-c-surface-2)',
                border: '1px solid var(--hz-c-primary)',
                borderRadius: 'var(--radius-sm)',
                padding: '4px 6px',
                outline: 'none',
                width: '100%',
              }}
            />
          ) : (
            <span style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-12)',
              color: 'var(--hz-c-ink-soft)',
            }}>
              {p.id}
            </span>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
            {editMode ? (
              <input
                type="text"
                value={p.label}
                onChange={(e) => updateAt(i, { label: e.target.value })}
                placeholder="Label (e.g. 1-Seater)"
                style={{
                  fontFamily: 'var(--font-sans)',
                  fontSize: 'var(--fs-14)',
                  fontWeight: 600,
                  background: 'var(--hz-c-surface-2)',
                  border: '1px solid var(--hz-c-primary)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '4px 8px',
                  outline: 'none',
                  width: '100%',
                  maxWidth: 280,
                }}
              />
            ) : (
              <span style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--fs-14)',
                fontWeight: 600,
                color: 'var(--hz-c-ink)',
              }}>
                {p.label}
              </span>
            )}
            <div style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-11)',
              color: 'var(--hz-c-ink-soft)',
            }}>
              {p.modules.length === 0 ? (
                <span style={{ color: 'var(--hz-c-ink-muted)', fontStyle: 'italic' }}>
                  No modules selected
                </span>
              ) : (
                p.modules.join(' + ')
              )}
            </div>
            {editMode && (
              <div style={{
                display: 'flex', flexWrap: 'wrap', gap: 4,
                padding: 6,
                background: 'var(--hz-c-surface)',
                border: '1px dashed var(--hz-c-border)',
                borderRadius: 'var(--radius-sm)',
              }}>
                {compartmentPool.map((code) => {
                  const on = p.modules.includes(code);
                  return (
                    <button
                      type="button"
                      key={code}
                      onClick={() => toggleModule(i, code)}
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 'var(--fs-11)',
                        fontWeight: 600,
                        background: on ? 'var(--hz-c-primary)' : 'var(--hz-c-surface)',
                        color: on ? '#fff' : 'var(--hz-c-ink)',
                        border: `1px solid ${on ? '#16695f' : '#c2c6bd'}`,
                        borderRadius: 'var(--radius-sm)',
                        padding: '2px 8px',
                        cursor: 'pointer',
                      }}
                      title={on ? 'Click to remove' : 'Click to add'}
                    >
                      {code}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {editMode ? (
            <select
              value={p.defaultTier ?? ''}
              onChange={(e) => updateAt(i, { defaultTier: (e.target.value || undefined) as SofaPriceTier | undefined })}
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--fs-12)',
                background: 'var(--hz-c-surface-2)',
                border: '1px solid var(--hz-c-border-strong)',
                borderRadius: 'var(--radius-sm)',
                padding: '4px 6px',
                outline: 'none',
              }}
              title="Default tier applied when this preset is used in the New Combo dialog"
            >
              <option value="">— Any tier —</option>
              <option value="PRICE_1">PRICE_1</option>
              <option value="PRICE_2">PRICE_2</option>
              <option value="PRICE_3">PRICE_3</option>
              <option value="PRICE_4">PRICE_4</option>
            </select>
          ) : (
            <span style={{
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-11)',
              color: 'var(--hz-c-ink-soft)',
            }}>
              {p.defaultTier ?? '—'}
            </span>
          )}
          {editMode ? (
            <label style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-11)',
              color: 'var(--hz-c-ink-soft)', cursor: 'pointer',
            }}>
              <input
                type="checkbox"
                checked={p.active !== false}
                onChange={(e) => updateAt(i, { active: e.target.checked })}
                title="Inactive presets stay in history but don't show in pickers"
              />
              Active
            </label>
          ) : (
            <span style={{
              fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-11)',
              color: p.active === false ? 'var(--hz-c-ink-muted)' : '#1a7a3a',
            }}>
              {p.active === false ? 'Inactive' : 'Active'}
            </span>
          )}
          {editMode ? (
            <button
              type="button"
              className={styles.maintRowIcon}
              title="Remove preset"
              onClick={() => removeAt(i)}
              style={{ color: 'var(--hz-dk-festive-b, #B8331F)' }}
            >
              <Trash2 {...ICON_PROPS} />
            </button>
          ) : (
            <span />
          )}
        </div>
      ))}

      {editMode && (
        <div
          className={styles.maintRow}
          style={{
            background: 'var(--hz-c-surface)',
            borderColor: '#16695f',
            gridTemplateColumns: '32px 32px 1fr auto',
          }}
        >
          <span className={styles.maintRowIcon}><Plus {...ICON_PROPS} /></span>
          <span className={styles.maintRowIdx}>+</span>
          <span style={{
            fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)',
            color: 'var(--hz-c-ink-soft)',
          }}>
            Append a blank preset row — fill in ID, label, and pick modules from the chip rail.
          </span>
          <Button variant="primary" onClick={addPreset}>
            <Plus {...ICON_PROPS} />
            <span>Add preset</span>
          </Button>
        </div>
      )}
    </div>
  );
};

const BrandingsReadOnlyPanel = () => {
  const { pool, fromConfig, isLoading } = useBrandingPool();

  return (
    <div className={styles.maintList}>
      <p className={styles.stateInfo} style={{ marginBottom: 12 }}>
        {fromConfig ? (
          <>
            Brandings are maintained in <strong>Project Maintenance</strong>.
            This list is read-only; add, rename, or deactivate a branding there
            and it flows to every Branding input here.
          </>
        ) : (
          <>
            This read-only list is derived from the brandings on this company’s
            own products and models. Maintain brandings centrally in{' '}
            <strong>Project Maintenance</strong>.
          </>
        )}
      </p>
      {isLoading ? (
        <p className={styles.eyebrow}>Loading brandings…</p>
      ) : pool.length === 0 ? (
        <p className={styles.eyebrow}>
          No brandings yet — add them in Project Maintenance.
        </p>
      ) : (
        pool.map((name, i) => (
          <div key={name} className={styles.maintRow} style={{ gridTemplateColumns: '32px 1fr' }}>
            <span className={styles.maintRowIdx}>{i + 1}</span>
            <span className={styles.maintRowValue}>{name}</span>
          </div>
        ))
      )}
    </div>
  );
};

const MaintenanceList = ({
  listKey,
  config,
  editMode,
  onChange,
  priced,
  brandingSuggestions,
}: {
  listKey: MaintenanceListKey;
  config: MaintenanceConfig;
  editMode: boolean;
  onChange: (next: MaintenanceConfig) => void;
  priced: boolean;
  brandingSuggestions?: string[];
}) => {
  const [draftValue, setDraftValue] = useState('');
  const [draftLabel, setDraftLabel] = useState('');
  const [draftDim, setDraftDim] = useState('');
  const [draftPrice, setDraftPrice] = useState('0.00');
  const notify = useNotify();

  /* Commander 2026-05-27: "Maintenance 也要有 Sort 的功能" — drag-and-drop
     row reorder when editMode. Uses native HTML5 drag API (no library).
     dragIdx tracks the row currently being dragged; on drop we splice it
     to the new index and emit onChange so the parent's draft sees the
     new order. Save persists the array order naturally. */
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const moveAt = (from: number, to: number) => {
    if (from === to) return;
    const next = JSON.parse(JSON.stringify(config)) as MaintenanceConfig;
    const arr = ((next as unknown as Record<string, unknown>)[listKey] as unknown[] | undefined) ?? [];
    if (from < 0 || from >= arr.length || to < 0 || to >= arr.length) return;
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    (next as Record<string, unknown>)[listKey] = arr;
    onChange(next);
  };
  const dragRowProps = (i: number): HTMLAttributes<HTMLDivElement> => {
    if (!editMode) return {};
    return {
      draggable: true,
      onDragStart: (e) => {
        setDragIdx(i);
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(i)); } catch { }
      },
      onDragOver: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; },
      onDrop: (e) => {
        e.preventDefault();
        if (dragIdx === null) return;
        moveAt(dragIdx, i);
        setDragIdx(null);
      },
      onDragEnd: () => setDragIdx(null),
      style: dragIdx === i ? { opacity: 0.5 } : undefined,
      title: 'Drag to reorder',
    };
  };

  if (listKey === 'fabrics') {
    return <FabricsMaintenancePanel />;
  }


  if (listKey === 'sofaCompartments') {
    return (
      <SofaCompartmentsList
        config={config}
        editMode={editMode}
        onChange={onChange}
        dragRowProps={dragRowProps}
        draftValue={draftValue}
        setDraftValue={setDraftValue}
      />
    );
  }

  if (listKey === 'sofaQuickPresets') {
    return (
      <SofaQuickPresetsList
        config={config}
        editMode={editMode}
        onChange={onChange}
        dragRowProps={dragRowProps}
      />
    );
  }

  if (
    listKey === 'gaps'
    || listKey === 'sofaSizes'
    || listKey === 'bedframeSizes'
    || listKey === 'mattressSizes'
    || listKey === 'brandings'
    || listKey === 'supplierCategories'
  ) {
    // ACTIVE toggles (owner spec 2026-06-12) — entries are plain strings
    // (= active, the historic shape) or { value, active: false } once
    // toggled off. The editor renders the VALUE everywhere and adds a
    // Yes/No Active checkbox per row in edit mode.
    const items = (config[listKey] as MaintPoolEntry[] | undefined) ?? [];

    const showBrandingSuggestions =
      listKey === 'brandings'
      && !editMode
      && maintValues(items).filter((b) => b.trim().length > 0).length === 0
      && (brandingSuggestions?.length ?? 0) > 0;

    const removeAt = (idx: number) => {
      const next = JSON.parse(JSON.stringify(config)) as MaintenanceConfig;
      const arr = (next[listKey] as MaintPoolEntry[] | undefined) ?? [];
      arr.splice(idx, 1);
      (next as Record<string, unknown>)[listKey] = arr;
      onChange(next);
    };

    const addItem = () => {
      const v = draftValue.trim();
      if (!v) return;
      const next = JSON.parse(JSON.stringify(config)) as MaintenanceConfig;
      const arr = (next[listKey] as MaintPoolEntry[] | undefined) ?? [];
      arr.push(v);
      (next as Record<string, unknown>)[listKey] = arr;
      if (isSizeRow) {
        const label = draftLabel.trim();
        const dimensions = draftDim.trim();
        if (label || dimensions) {
          const labels = (next.sizeLabels ?? {}) as Record<string, { label?: string; dimensions?: string }>;
          labels[v] = {
            ...(label ? { label } : {}),
            ...(dimensions ? { dimensions } : {}),
          };
          next.sizeLabels = labels;
        }
      }
      onChange(next);
      setDraftValue('');
      setDraftLabel('');
      setDraftDim('');
    };

    const updateAt = (idx: number, newVal: string) => {
      const next = JSON.parse(JSON.stringify(config)) as MaintenanceConfig;
      const arr = (next[listKey] as MaintPoolEntry[] | undefined) ?? [];
      if (arr[idx] != null) arr[idx] = maintEntryWithValue(arr[idx]!, newVal);
      (next as Record<string, unknown>)[listKey] = arr;
      onChange(next);
    };

    const setActiveAt = (idx: number, active: boolean) => {
      const next = JSON.parse(JSON.stringify(config)) as MaintenanceConfig;
      const arr = (next[listKey] as MaintPoolEntry[] | undefined) ?? [];
      if (arr[idx] != null) arr[idx] = maintEntryWithActive(arr[idx]!, active);
      (next as Record<string, unknown>)[listKey] = arr;
      onChange(next);
    };

    // PR #92 — Commander 2026-05-26: "King, 6FT, 183 那些，如果我要改的话，
    // 怎么样去改呢？" For bedframe/mattress sizes, editMode now exposes 3
    // columns: code | label | dimensions. The code stays in the
    // bedframeSizes string[]; label + dimensions land in a parallel
    // sizeLabels override keyed by code. Read path goes through
    // resolveSizeInfo() so the rest of the app picks the override up.
    const isSizeRow = listKey === 'bedframeSizes' || listKey === 'mattressSizes';
    const updateLabel = (code: string, field: 'label' | 'dimensions', val: string) => {
      const next = JSON.parse(JSON.stringify(config)) as MaintenanceConfig;
      const labels = (next.sizeLabels ?? {}) as Record<string, { label?: string; dimensions?: string }>;
      const cur    = labels[code] ?? {};
      labels[code] = { ...cur, [field]: val };
      next.sizeLabels = labels;
      onChange(next);
    };
    return (
      <div className={styles.maintList}>
        {showBrandingSuggestions && (
          <>
            <p className={styles.stateInfo} style={{ marginBottom: 8 }}>
              Pool is empty — showing {brandingSuggestions!.length} suggested
              value{brandingSuggestions!.length === 1 ? '' : 's'} found on existing
              products + models. Hit <strong>Edit</strong> then <strong>Save</strong> to
              adopt them into the pool.
            </p>
            {brandingSuggestions!.map((v, i) => (
              <div key={v} className={styles.maintRow} style={{ opacity: 0.7 }}>
                <span className={styles.maintRowIcon} />
                <span className={styles.maintRowIdx}>{i + 1}</span>
                <span className={styles.maintRowValue}>{v}</span>
                <span style={{ fontSize: 'var(--fs-11)', color: 'var(--hz-c-ink-muted)', fontWeight: 600 }}>
                  suggested
                </span>
              </div>
            ))}
          </>
        )}
        {items.map((entry, i) => {
          const v = maintEntryValue(entry);
          const entryIsActive = maintEntryActive(entry);
          const labelOv = config.sizeLabels?.[v];
          const resolved = isSizeRow ? resolveSizeInfo(v, config) : null;
          return (
          <div
            key={`${v}-${i}`}
            className={styles.maintRow}
            {...dragRowProps(i)}
            style={{
              ...(dragRowProps(i).style ?? {}),
              gridTemplateColumns: '32px 1fr auto auto',
              opacity: entryIsActive ? 1 : 0.55,
            }}
          >
            <span className={styles.maintRowIdx} style={editMode ? { cursor: 'grab' } : undefined}>{i + 1}</span>
            <span className={styles.maintRowValue}>
              {editMode ? (
                isSizeRow ? (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      type="text"
                      value={v}
                      onChange={(e) => updateAt(i, e.target.value)}
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 'var(--fs-14)',
                        fontWeight: 600,
                        background: 'var(--hz-c-surface-2)',
                        border: '1px solid var(--hz-c-primary)',
                        borderRadius: 'var(--radius-sm)',
                        padding: '4px 8px',
                        outline: 'none',
                        width: 80,
                      }}
                      title="Size code (e.g. K)"
                    />
                    <span style={{ color: 'var(--hz-c-ink-muted)', fontWeight: 700 }}>·</span>
                    <input
                      type="text"
                      placeholder="Label e.g. 6FT"
                      value={labelOv?.label ?? resolved?.label ?? ''}
                      onChange={(e) => updateLabel(v, 'label', e.target.value)}
                      style={{
                        fontFamily: 'var(--font-sans)',
                        fontSize: 'var(--fs-14)',
                        background: 'var(--hz-c-surface-2)',
                        border: '1px solid var(--hz-c-border-strong)',
                        borderRadius: 'var(--radius-sm)',
                        padding: '4px 8px',
                        outline: 'none',
                        width: 110,
                      }}
                    />
                    <span style={{ color: 'var(--hz-c-ink-muted)', fontWeight: 700 }}>·</span>
                    <input
                      type="text"
                      placeholder="Dimensions e.g. 183X190CM"
                      value={labelOv?.dimensions ?? resolved?.dim ?? ''}
                      onChange={(e) => updateLabel(v, 'dimensions', e.target.value)}
                      style={{
                        fontFamily: 'var(--font-sans)',
                        fontSize: 'var(--fs-14)',
                        background: 'var(--hz-c-surface-2)',
                        border: '1px solid var(--hz-c-border-strong)',
                        borderRadius: 'var(--radius-sm)',
                        padding: '4px 8px',
                        outline: 'none',
                        width: 170,
                      }}
                    />
                  </div>
                ) : (
                  <input
                    type="text"
                    value={v}
                    onChange={(e) => updateAt(i, e.target.value)}
                    style={{
                      fontFamily: 'var(--font-sans)',
                      fontSize: 'var(--fs-16)',
                      fontWeight: 600,
                      background: 'var(--hz-c-surface-2)',
                      border: '1px solid var(--hz-c-primary)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '4px 8px',
                      outline: 'none',
                      width: '100%',
                      maxWidth: 280,
                    }}
                  />
                )
              ) : (
                isSizeRow
                  ? formatSizeRichWithCfg(v, config)
                  : v
              )}
            </span>
            {/* ACTIVE toggle (owner spec 2026-06-12) — inactive values are
                hidden from NEW-entry pickers; documents/SKUs already carrying
                the value keep displaying it. */}
            {editMode ? (
              <label style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-11)',
                color: 'var(--hz-c-ink-soft)', cursor: 'pointer',
              }}>
                <input
                  type="checkbox"
                  checked={entryIsActive}
                  onChange={(e) => setActiveAt(i, e.target.checked)}
                  title="Inactive options are hidden from pickers for new entries; existing documents keep showing them"
                />
                Active
              </label>
            ) : (
              <span style={{
                fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-11)',
                color: entryIsActive ? '#1a7a3a' : 'var(--hz-c-ink-muted)',
              }}>
                {entryIsActive ? 'Active' : 'Inactive'}
              </span>
            )}
            {editMode ? (
              <button
                type="button"
                className={styles.maintRowIcon}
                title="Remove"
                onClick={() => removeAt(i)}
                style={{ color: 'var(--hz-dk-festive-b, #B8331F)' }}
              >
                <Trash2 {...ICON_PROPS} />
              </button>
            ) : (
              <span />
            )}
          </div>
          );
        })}

        {editMode && (
          <div
            className={styles.maintRow}
            style={{
              background: 'var(--hz-c-surface)',
              borderColor: '#16695f',
              gridTemplateColumns: '32px 1fr auto',
            }}
          >
            <span className={styles.maintRowIdx}><Plus {...ICON_PROPS} /></span>
            {isSizeRow ? (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  placeholder="Code e.g. K"
                  value={draftValue}
                  onChange={(e) => setDraftValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addItem(); }}
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--fs-14)',
                    fontWeight: 600,
                    background: 'var(--hz-c-surface-2)',
                    border: '1px solid var(--hz-c-primary)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '4px 8px',
                    outline: 'none',
                    width: 80,
                  }}
                  title="Size code (e.g. K)"
                />
                <span style={{ color: 'var(--hz-c-ink-muted)', fontWeight: 700 }}>·</span>
                <input
                  type="text"
                  placeholder="Label e.g. 6FT"
                  value={draftLabel}
                  onChange={(e) => setDraftLabel(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addItem(); }}
                  style={{
                    fontFamily: 'var(--font-sans)',
                    fontSize: 'var(--fs-14)',
                    background: 'var(--hz-c-surface-2)',
                    border: '1px solid var(--hz-c-border-strong)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '4px 8px',
                    outline: 'none',
                    width: 110,
                  }}
                />
                <span style={{ color: 'var(--hz-c-ink-muted)', fontWeight: 700 }}>·</span>
                <input
                  type="text"
                  placeholder="Dimensions e.g. 183X190CM"
                  value={draftDim}
                  onChange={(e) => setDraftDim(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addItem(); }}
                  style={{
                    fontFamily: 'var(--font-sans)',
                    fontSize: 'var(--fs-14)',
                    background: 'var(--hz-c-surface-2)',
                    border: '1px solid var(--hz-c-border-strong)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '4px 8px',
                    outline: 'none',
                    width: 170,
                  }}
                />
              </div>
            ) : (
              <input
                type="text"
                placeholder="New value (e.g. 28)"
                value={draftValue}
                onChange={(e) => setDraftValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addItem(); }}
                style={{
                  fontFamily: 'var(--font-sans)',
                  fontSize: 'var(--fs-14)',
                  background: 'var(--hz-c-surface-2)',
                  border: '1px solid var(--hz-c-border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '6px 10px',
                  outline: 'none',
                }}
              />
            )}
            <Button variant="primary" onClick={addItem}>
              <Plus {...ICON_PROPS} />
              <span>Add</span>
            </Button>
          </div>
        )}
      </div>
    );
  }

  const items = (config[listKey] as PricedOption[] | undefined) ?? [];

  const removeAt = (idx: number) => {
    const next = JSON.parse(JSON.stringify(config)) as MaintenanceConfig;
    const arr = (next[listKey] as PricedOption[] | undefined) ?? [];
    arr.splice(idx, 1);
    (next as Record<string, unknown>)[listKey] = arr;
    onChange(next);
  };

  const addItem = () => {
    const v = draftValue.trim();
    if (!v) return;
    const price = parseMoneyToSen(draftPrice, 'That surcharge');
    if (!price.ok) {
      void notify({ title: price.message, tone: 'error' });
      return;
    }
    const priceSen = price.sen;
    const next = JSON.parse(JSON.stringify(config)) as MaintenanceConfig;
    const arr = (next[listKey] as PricedOption[] | undefined) ?? [];
    // ONE price (owner 2026-06-22) — new rows carry only the single priceSen
    // surcharge (which IS the SO cost). The legacy costSen field is no longer
    // authored here.
    const row: PricedOption = { value: v, priceSen };
    arr.push(row);
    (next as Record<string, unknown>)[listKey] = arr;
    onChange(next);
    setDraftValue('');
    setDraftPrice('0.00');
  };

  return (
    <div className={styles.maintList}>
      {items.map((opt, i) => (
        <div
          key={`${opt.value}-${i}`}
          className={styles.maintRow}
          {...dragRowProps(i)}
          style={{
            ...(dragRowProps(i).style ?? {}),
            gridTemplateColumns: '32px 1fr auto',
            opacity: opt.active === false ? 0.55 : 1,
          }}
        >
          <span className={styles.maintRowIdx} style={editMode ? { cursor: 'grab' } : undefined}>{i + 1}</span>
          <span className={styles.maintRowValue}>
            {editMode ? (
              <input
                type="text"
                value={opt.value}
                onChange={(e) => {
                  const next = JSON.parse(JSON.stringify(config)) as MaintenanceConfig;
                  (next[listKey] as PricedOption[])[i]!.value = e.target.value;
                  onChange(next);
                }}
                style={{
                  fontFamily: 'var(--font-sans)',
                  fontSize: 'var(--fs-16)',
                  fontWeight: 600,
                  background: 'var(--hz-c-surface-2)',
                  border: '1px solid var(--hz-c-primary)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '4px 8px',
                  outline: 'none',
                  width: '100%',
                  maxWidth: 280,
                }}
              />
            ) : (
              opt.value
            )}
          </span>
          <span style={{ display: 'inline-flex', gap: 'var(--space-3)', alignItems: 'center', justifyContent: 'flex-end' }}>
            {/* ONE price only (owner 2026-06-22). The single "RM" value IS the
                cost used for SO costing — the cost engine reads priceSen first
                (lookupCost: hit.priceSen ?? hit.costSen). The former parallel
                "COST RM" (costSen) column was removed so every priced pool shows
                exactly one surcharge. costSen is left untouched on existing rows
                (it stays a fallback in the engine) but is no longer editable. */}
            <span className={styles.maintRowPrice}>
              <span className={styles.maintRowRmPrefix}>RM</span>
              {editMode ? (
                <MoneyInput
                  bare
                  valueSen={opt.priceSen}
                  onCommit={(sen) => {
                    const next = JSON.parse(JSON.stringify(config)) as MaintenanceConfig;
                    const list = next[listKey] as PricedOption[];
                    list[i]!.priceSen = sen ?? 0;
                    onChange(next);
                  }}
                  style={{
                    width: 90,
                    textAlign: 'right',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--fs-14)',
                    background: 'var(--hz-c-surface-2)',
                    border: '1px solid var(--hz-c-primary)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '4px 8px',
                    outline: 'none',
                  }}
                />
              ) : (
                <span className={opt.priceSen === 0 ? styles.maintRowPriceMuted : undefined}>
                  {(opt.priceSen / 100).toFixed(2)}
                </span>
              )}
            </span>
            {/* ACTIVE toggle (owner spec 2026-06-12) — inactive options are
                hidden from NEW-entry pickers (SO/PO/GRN/PI/PR/adjustment
                variant selects); price/cost lookups still resolve them so
                existing documents keep their values + surcharges. */}
            {editMode ? (
              <label style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-11)',
                color: 'var(--hz-c-ink-soft)', cursor: 'pointer',
              }}>
                <input
                  type="checkbox"
                  checked={opt.active !== false}
                  onChange={(e) => {
                    const next = JSON.parse(JSON.stringify(config)) as MaintenanceConfig;
                    const list = next[listKey] as PricedOption[];
                    if (e.target.checked) {
                      delete list[i]!.active;
                    } else {
                      list[i]!.active = false;
                    }
                    onChange(next);
                  }}
                  title="Inactive options are hidden from pickers for new entries; existing documents keep showing them"
                />
                Active
              </label>
            ) : (
              <span style={{
                fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-11)',
                color: opt.active === false ? 'var(--hz-c-ink-muted)' : '#1a7a3a',
              }}>
                {opt.active === false ? 'Inactive' : 'Active'}
              </span>
            )}
            {editMode && (
              <button
                type="button"
                className={styles.maintRowIcon}
                title="Remove"
                onClick={() => removeAt(i)}
                style={{ color: 'var(--hz-dk-festive-b, #B8331F)' }}
              >
                <Trash2 {...ICON_PROPS} />
              </button>
            )}
          </span>
        </div>
      ))}

      {editMode && (
        <div
          className={styles.maintRow}
          style={{
            background: 'var(--hz-c-surface)',
            borderColor: '#16695f',
            gridTemplateColumns: '32px 1fr auto',
          }}
        >
          <span className={styles.maintRowIdx}><Plus {...ICON_PROPS} /></span>
          <input
            type="text"
            placeholder="New value"
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addItem(); }}
            style={{
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-14)',
              background: 'var(--hz-c-surface-2)',
              border: '1px solid var(--hz-c-border)',
              borderRadius: 'var(--radius-sm)',
              padding: '6px 10px',
              outline: 'none',
            }}
          />
          <span style={{ display: 'inline-flex', gap: 'var(--space-2)', alignItems: 'center' }}>
            {/* ONE price only (owner 2026-06-22) — the single "RM" surcharge IS
                the SO cost. The former parallel "COST RM" add input was removed. */}
            <span className={styles.maintRowRmPrefix}>RM</span>
            <input
              type="number"
              step="0.01"
              value={draftPrice}
              onChange={(e) => setDraftPrice(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addItem(); }}
              style={{
                width: 90,
                textAlign: 'right',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-14)',
                background: 'var(--hz-c-surface-2)',
                border: '1px solid var(--hz-c-border)',
                borderRadius: 'var(--radius-sm)',
                padding: '6px 8px',
                outline: 'none',
              }}
            />
            <Button variant="primary" onClick={addItem}>
              <Plus {...ICON_PROPS} />
              <span>Add</span>
            </Button>
          </span>
        </div>
      )}

      {!priced && !editMode && <p className={styles.eyebrow}>No surcharge pricing for this list.</p>}
    </div>
  );
};



type CodeFormatKey = 'bedframeFormat' | 'sofaFormat' | 'mattressFormat';

interface FormatFieldMap {
  codeKey:    keyof MaintenanceConfig;
  nameKey:    keyof MaintenanceConfig;
  codeDefault: string;
  nameDefault: string;
  sample:     Record<string, string>;
  placeholderHint: string;
}

const FORMAT_FIELDS: Record<CodeFormatKey, FormatFieldMap> = {
  bedframeFormat: {
    codeKey:     'bedframeCodeFormat',
    nameKey:     'bedframeNameFormat',
    codeDefault: '{model_code}-({size})',
    nameDefault: '{branding} {model_name} BEDFRAME ({size_label}) ({dimensions})',
    sample: {
      branding:    'HILTON',
      model_code:  '1003',
      model_name:  'TRION',
      size:        'K',
      size_label:  '6FT',
      dimensions:  '183X190CM',
    },
    placeholderHint: '{branding}, {model_code}, {model_name}, {size}, {size_label}, {dimensions}',
  },
  sofaFormat: {
    codeKey:     'sofaCodeFormat',
    nameKey:     'sofaNameFormat',
    codeDefault: '{model_code}-{compartment}',
    nameDefault: '{model_name} {compartment}',
    sample: {
      branding:    'HOUZS',
      model_code:  '5530',
      model_name:  'SOFA 5530',
      compartment: '1A(LHF)',
    },
    placeholderHint: '{branding}, {model_code}, {model_name}, {compartment}',
  },
  mattressFormat: {
    codeKey:     'mattressCodeFormat',
    nameKey:     'mattressNameFormat',
    codeDefault: '{model_code} MATT ({size})',
    nameDefault: '{model_name} ({width}x{length}x{thickness}CM)',
    sample: {
      branding:    '2990S',
      model_code:  '2990-NF AKKA-FIRM',
      model_name:  '2990 AKKA-FIRM MATTRESS',
      size:        'K',
      size_label:  '6FT',
      width:       '183',
      length:      '190',
      thickness:   '31',
    },
    placeholderHint: '{branding}, {model_code}, {model_name}, {size}, {size_label}, {width}, {length}, {thickness}',
  },
};

function substitute(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_match, k) => vars[k] ?? '');
}

const CodeFormatPanel = ({
  listKey, config, editMode, onChange,
}: {
  listKey: CodeFormatKey;
  config: MaintenanceConfig;
  editMode: boolean;
  onChange: (next: MaintenanceConfig) => void;
}) => {
  const f = FORMAT_FIELDS[listKey];
  const codeVal = (config[f.codeKey] as string | undefined) ?? '';
  const nameVal = (config[f.nameKey] as string | undefined) ?? '';

  const codeEffective = codeVal.trim() || f.codeDefault;
  const nameEffective = nameVal.trim() || f.nameDefault;

  const exampleCode = substitute(codeEffective, f.sample);
  const exampleName = substitute(nameEffective, f.sample);

  const update = (key: keyof MaintenanceConfig, value: string) => {
    const next = JSON.parse(JSON.stringify(config)) as MaintenanceConfig;
    (next as Record<string, unknown>)[key] = value;
    onChange(next);
  };

  const inputStyle = {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--fs-13)',
    padding: 'var(--space-3) var(--space-4)',
    border: '1px solid var(--hz-c-border-strong)',
    borderRadius: 'var(--radius-sm)',
    background: editMode ? 'var(--hz-c-surface)' : 'var(--hz-c-surface-2)',
    color: 'var(--hz-c-ink)',
    width: '100%',
    outline: 'none',
  } as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div>
        <div className="t-eyebrow" style={{ marginBottom: 4 }}>Code template</div>
        <input
          type="text"
          readOnly={!editMode}
          value={codeVal}
          placeholder={f.codeDefault}
          onChange={(e) => update(f.codeKey, e.target.value)}
          style={inputStyle}
        />
        <p style={{ margin: '6px 0 0', fontSize: 'var(--fs-12)', color: 'var(--hz-c-ink-muted)' }}>
          Default if blank: <code>{f.codeDefault}</code>
        </p>
      </div>

      <div>
        <div className="t-eyebrow" style={{ marginBottom: 4 }}>Name template</div>
        <input
          type="text"
          readOnly={!editMode}
          value={nameVal}
          placeholder={f.nameDefault}
          onChange={(e) => update(f.nameKey, e.target.value)}
          style={inputStyle}
        />
        <p style={{ margin: '6px 0 0', fontSize: 'var(--fs-12)', color: 'var(--hz-c-ink-muted)' }}>
          Default if blank: <code>{f.nameDefault}</code>
        </p>
      </div>

      <div style={{
        background: 'var(--hz-c-surface-2)',
        border: '1px solid var(--hz-c-border)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-4)',
      }}>
        <div className="t-eyebrow" style={{ marginBottom: 8 }}>Live preview · sample row</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-12)', color: 'var(--hz-c-ink-muted)' }}>
            code
            <code style={{ marginLeft: 12, background: 'var(--hz-c-primary)', color: '#fff', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>
              {exampleCode}
            </code>
          </div>
          <div style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-12)', color: 'var(--hz-c-ink-muted)' }}>
            name
            <code style={{ marginLeft: 12, background: 'var(--hz-c-primary)', color: '#fff', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>
              {exampleName}
            </code>
          </div>
        </div>
      </div>

      <div style={{ fontSize: 'var(--fs-12)', color: 'var(--hz-c-ink-muted)' }}>
        <strong>Available placeholders:</strong> {f.placeholderHint}
      </div>
    </div>
  );
};

const FabricsMaintenancePanel = () => {
  const [search, setSearch] = useState('');
  const { data, isLoading, error } = useFabricTrackings({
    search: search.trim() || undefined,
    includeRetired: false,
  });
  const rows = data ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
        <div style={{ position: 'relative', flex: 1, maxWidth: 360 }}>
          <Search
            {...ICON_PROPS}
            style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--hz-c-ink-muted)', pointerEvents: 'none' }}
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by code or description…"
            style={{
              width: '100%',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-14)',
              background: 'var(--hz-c-surface)',
              border: '1px solid var(--hz-c-border)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--space-2) var(--space-3) var(--space-2) var(--space-7)',
              color: 'var(--hz-c-ink)',
              outline: 'none',
            }}
          />
        </div>
        <a
          href="/scm/fabric-tracking"
          style={{
            fontSize: 'var(--fs-13)', color: 'var(--hz-c-primary-ink)',
            textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
          <Plus {...ICON_PROPS} />
          <span>New fabric in Fabric Converter →</span>
        </a>
      </div>
      <FabricsTable rows={rows} isLoading={isLoading} error={error} />
    </div>
  );
};


const NewSkuDrawer = ({ onClose }: { onClose: () => void }) => {
  const create = useCreateMfgProduct();
  const notify = useNotify();
  const brandingPool = useBrandingPool();
  type Cat = MfgCategory;
  const [form, setForm] = useState<{
    code: string; name: string; category: Cat;
    description: string; baseModel: string; sizeLabel: string;
    branding: string; fabricColor: string; barcode: string;
    basePrice: string; price1: string; costPrice: string;
    unitM3: string;
  }>({
    code: '', name: '', category: 'BEDFRAME',
    description: '', baseModel: '', sizeLabel: '',
    branding: '', fabricColor: '', barcode: '',
    basePrice: '', price1: '', costPrice: '',
    unitM3: '',
  });
  const set = <K extends keyof typeof form>(k: K, v: typeof form[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  const isMattress = form.category === 'MATTRESS';
  const isSofa = form.category === 'SOFA';
  const isService = form.category === 'SERVICE';

  const submit = () => {
    if (!form.code.trim()) { notify({ title: 'Code is required.', tone: 'error' }); return; }
    if (!form.name.trim()) { notify({ title: 'Name is required.', tone: 'error' }); return; }
    const toSen = (s: string): number | null => {
      const t = s.trim();
      if (!t) return null;
      const n = Number(t);
      return Number.isFinite(n) ? Math.round(n * 100) : null;
    };
    const toMilli = (s: string): number => {
      const t = s.trim();
      if (!t) return 0;
      const n = Number(t);
      return Number.isFinite(n) ? Math.round(n * 1000) : 0;
    };
    create.mutate({
      code: form.code.trim(),
      name: form.name.trim(),
      category: form.category,
      description: form.description.trim() || undefined,
      baseModel: form.baseModel.trim() || undefined,
      sizeLabel: form.sizeLabel.trim() || undefined,
      branding: form.branding.trim() || undefined,
      fabricColor: form.fabricColor.trim() || undefined,
      barcode: form.barcode.trim() || undefined,
      basePriceSen: toSen(form.basePrice),
      price1Sen: isMattress || isService ? null : toSen(form.price1),
      costPriceSen: toSen(form.costPrice) ?? 0,
      unitM3Milli: toMilli(form.unitM3),
    }, {
      onSuccess: onClose,
      onError: (e) => notify({ title: e instanceof Error ? e.message : 'Could not create the SKU.', tone: 'error' }),
    });
  };

  return (
    <div className={styles.drawerBackdrop} onClick={onClose}>
      <aside className={styles.drawer} onClick={(e) => e.stopPropagation()}>
        <header className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>New SKU</h2>
          <button type="button" className={styles.iconBtn} onClick={onClose}><X {...ICON_PROPS} /></button>
        </header>
        <div className={styles.drawerBody}>
          <div className={styles.formGrid}>
            <Field label="Code *" value={form.code} onChange={(v) => set('code', v)} />
            <Field label="Name *" value={form.name} onChange={(v) => set('name', v)} />
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Category *</span>
              <select className={styles.fieldSelect} value={form.category}
                onChange={(e) => set('category', e.target.value as Cat)}>
                {CATEGORIES.filter((c) => c.value !== 'all').map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </label>
            <Field label="Size Label" value={form.sizeLabel} onChange={(v) => set('sizeLabel', v)} />
            {isSofa && <Field label="Base Model" value={form.baseModel} onChange={(v) => set('baseModel', v)} />}
            {isMattress && (
              <>
                <Field label="Branding" value={form.branding} onChange={(v) => set('branding', v)} placeholder="e.g. Sealy" list="branding-pool-new-sku" />
                <datalist id="branding-pool-new-sku">
                  {sortByText(brandingPool.pool).map((b) => <option key={b} value={b} />)}
                </datalist>
              </>
            )}
            {isSofa && <Field label="Fabrics" value={form.fabricColor} onChange={(v) => set('fabricColor', v)} />}
            <Field label="Barcode" value={form.barcode} onChange={(v) => set('barcode', v)} placeholder="optional" />
            <Field label="Description" value={form.description} onChange={(v) => set('description', v)} fullWidth />

            <Field label={isMattress ? 'Price (RM)' : 'Base Price / Price 2 (RM)'}
              value={form.basePrice} onChange={(v) => set('basePrice', v)} type="number" />
            {!isMattress && !isService && (
              <Field label="Price 1 (RM)" value={form.price1} onChange={(v) => set('price1', v)} type="number" />
            )}
            <Field label="Cost Price (RM)" value={form.costPrice} onChange={(v) => set('costPrice', v)} type="number" />
            <Field label="Unit (m³)" value={form.unitM3} onChange={(v) => set('unitM3', v)} type="number" step="0.001" />
          </div>
        </div>
        <footer className={styles.drawerFooter}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create SKU'}
          </Button>
        </footer>
      </aside>
    </div>
  );
};

const Field = ({
  label, value, onChange, type, step, placeholder, fullWidth, list,
}: {
  label: string; value: string;
  onChange: (v: string) => void;
  type?: string; step?: string; placeholder?: string;
  fullWidth?: boolean;
  list?: string;
}) => (
  <label className={`${styles.field} ${fullWidth ? styles.formGridFull : ''}`}>
    <span className={styles.fieldLabel}>{label}</span>
    <input
      type={type ?? 'text'}
      step={step}
      placeholder={placeholder}
      className={styles.fieldInput}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      list={list}
    />
  </label>
);



const fmtRmSen = (centi: number): string => fmtSen(centi);


const ProductSuppliersDrawer = ({
  row, onClose,
}: { row: MfgProductRow; onClose: () => void }) => {
  const q = useMfgProductSuppliers(row.id);
  const modelQ = useProductModel(row.model_id ?? undefined);
  const suppliers = q.data?.suppliers ?? [];
  const anchor = q.data?.anchor ?? null;
  const navigate = useNavigate();
  const openSupplier = (supplierId: string | null) => {
    onClose();
    navigate(supplierId ? `/scm/suppliers/${supplierId}` : '/scm/suppliers');
  };
  const update = useUpdateMfgProductPrices();
  const [barcodeDraft, setBarcodeDraft] = useState(row.barcode ?? '');
  const commitBarcode = () => {
    const t = barcodeDraft.trim();
    if (t === (row.barcode ?? '').trim()) return;
    update.mutate({ id: row.id, barcode: t.length ? t : null });
  };

  return (
    <div className={styles.drawerBackdrop} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--hz-c-surface-2)',
          border: '1px solid var(--hz-c-border-strong)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-3)',
          width: 'min(820px, 95vw)',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <header className={styles.drawerHeader}>
          <div>
            <h2 className={styles.drawerTitle}>
              <Truck {...ICON_PROPS} style={{ verticalAlign: 'middle', marginRight: 6 }} />
              Suppliers · <span className={styles.codeChip}>{row.code}</span>
            </h2>
            <p style={{ marginTop: 4, fontSize: 'var(--fs-13)', color: 'var(--hz-c-ink-muted)' }}>
              {row.name}{row.description ? ` — ${row.description}` : ''}
            </p>
            {!row.model_id
              ? <CategorySwapSelect kind="sku" id={row.id} category={row.category} />
              : (
                <div style={{ marginTop: 4 }}>
                  <CategorySwapSelect kind="model" id={row.model_id} category={row.category} />
                  <p style={{ marginTop: 2, fontSize: 'var(--fs-11)', color: 'var(--hz-c-ink-muted)' }}>
                    Belongs to model {modelQ.data?.model.model_code ?? row.base_model ?? ''} — changing the category moves the whole model and all its SKUs.
                  </p>
                </div>
              )}
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
              <span style={{
                fontSize: 'var(--fs-11)', fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: '0.04em', color: 'var(--hz-c-ink-muted)',
              }}>
                Barcode
              </span>
              <input
                type="text"
                value={barcodeDraft}
                onChange={(e) => setBarcodeDraft(e.target.value)}
                /* Commander 2026-06-15 — Enter saves; no blur-auto-save (裸奔). */
                onKeyDown={(e) => { if (e.key === 'Enter') commitBarcode(); }}
                placeholder="scan or type, then Enter"
                disabled={update.isPending}
                style={{
                  width: 220,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--fs-13)',
                  background: 'var(--hz-c-surface)',
                  border: '1px solid var(--hz-c-border-strong)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '3px 8px',
                  outline: 'none',
                }}
              />
            </label>
          </div>
          <button type="button" className={styles.iconBtn} onClick={onClose}>
            <X {...ICON_PROPS} />
          </button>
        </header>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 'var(--space-4)', paddingBottom: 'var(--space-6)' }}>
          {/* Commander 2026-05-29 — "双击点进去要看到 supplier 和 available 什么
              variant". This drill-in now shows BOTH: the model's allowed variant
              options first, then the suppliers carrying the SKU. */}
          {(() => {
            const ao = row.allowed_options as Record<string, string[] | undefined> | null | undefined;
            const groups: Array<[string, string[]]> = [];
            const push = (label: string, vals?: string[]) => { if (vals && vals.length) groups.push([label, vals]); };
            if (ao) {
              push('Sizes', ao.sizes);
              push('Compartments', ao.compartments);
              push('Divan heights', ao.divan_heights);
              push('Total heights', ao.total_heights);
              push('Leg heights', ao.leg_heights);
              push('Specials', ao.specials);
            }
            return (
              <section style={{ marginBottom: 'var(--space-5)' }}>
                <h3 style={{ fontSize: 'var(--fs-12)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--hz-c-ink-muted)', marginBottom: 'var(--space-2)' }}>
                  Available variants
                </h3>
                {groups.length === 0 ? (
                  <p style={{ fontSize: 'var(--fs-13)', color: 'var(--hz-c-ink-muted)' }}>
                    No variant options configured for this model{row.category ? ` (${mfgCategoryLabel(row.category)})` : ''}.
                  </p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                    {groups.map(([label, vals]) => (
                      <div key={label} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <span style={{ minWidth: 120, fontSize: 'var(--fs-11)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--hz-c-ink-muted)' }}>{label}</span>
                        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {vals.map((v) => (
                            <span key={v} className={styles.codeChip} style={{ fontSize: 'var(--fs-12)' }}>{v}</span>
                          ))}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })()}

          {anchor && (
            <CostAnchorCard
              anchor={anchor}
              onOpenSupplier={openSupplier}
              fallbackSupplierId={anchor.anchorSupplierId ?? (suppliers.length > 0 ? suppliers[0].supplier_id : null)}
            />
          )}

          <ProductPriceTimeline row={row} />

          <h3 style={{ fontSize: 'var(--fs-12)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--hz-c-ink-muted)', marginBottom: 'var(--space-2)' }}>
            Suppliers
          </h3>
          {q.isLoading && (
            <p style={{ textAlign: 'center', color: 'var(--hz-c-ink-muted)' }}>Loading suppliers…</p>
          )}
          {!q.isLoading && suppliers.length === 0 && (
            <div style={{ textAlign: 'center', padding: 'var(--space-6)', color: 'var(--hz-c-ink-muted)' }}>
              <Truck size={32} strokeWidth={1.5} />
              <div style={{ marginTop: 8 }}>No suppliers carry this product yet.</div>
              <div style={{ marginTop: 4, fontSize: 'var(--fs-12)' }}>
                Go to Suppliers → Detail → Add Mapping to link a supplier to this SKU.
              </div>
            </div>
          )}
          {!q.isLoading && suppliers.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
            <table className={styles.table} style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ width: 32 }}></th>
                  <th style={{ whiteSpace: 'nowrap' }}>Supplier</th>
                  <th style={{ whiteSpace: 'nowrap' }}>Supplier SKU</th>
                  <th style={{ textAlign: 'right', whiteSpace: 'nowrap', width: '1%' }}>Unit Price</th>
                  <th style={{ textAlign: 'right', whiteSpace: 'nowrap', width: '1%' }}>Lead</th>
                  <th style={{ textAlign: 'right', whiteSpace: 'nowrap', width: '1%' }}>MOQ</th>
                  <th style={{ width: 32 }} aria-label="Remove"></th>
                </tr>
              </thead>
              <tbody>
                {suppliers.map((s: ProductSupplierRow) => (
                  <tr key={s.id} style={{
                    background: s.is_main_supplier ? 'rgba(232, 107, 58, 0.06)' : undefined,
                  }}>
                    <td style={{ textAlign: 'center' }}>
                      {s.is_main_supplier && (
                        <Star size={14} strokeWidth={2} style={{ color: 'var(--hz-c-primary)', fill: 'var(--hz-c-primary)' }} />
                      )}
                    </td>
                    <td>
                      <div style={{ fontWeight: s.is_main_supplier ? 700 : 400 }}>
                        {s.suppliers?.name ?? '—'}
                      </div>
                      <div style={{ fontSize: 'var(--fs-11)', color: 'var(--hz-c-ink-muted)' }}>
                        {s.suppliers?.code ?? ''}{s.suppliers?.phone ? ` · ${formatPhone(s.suppliers.phone)}` : ''}
                      </div>
                    </td>
                    <td>
                      {s.supplier_sku
                        ? <span className={styles.codeChip}>{s.supplier_sku}</span>
                        : <span style={{ color: 'var(--hz-c-ink-muted)' }}>(same as our code)</span>}
                    </td>
                    <td className={styles.numCell} style={{ whiteSpace: 'nowrap' }}>
                      {fmtRmSen(s.unit_price_sen)}{s.currency !== 'MYR' ? ` ${s.currency}` : ''}
                    </td>
                    <td className={styles.numCell} style={{ whiteSpace: 'nowrap' }}>{s.lead_time_days || '—'}</td>
                    <td className={styles.numCell} style={{ whiteSpace: 'nowrap' }}>{s.moq || '—'}</td>
                    <td style={{ textAlign: 'center' }}>
                      <DeleteBindingButton
                        supplierId={s.supplier_id}
                        bindingId={s.id}
                        supplierName={s.suppliers?.name ?? s.supplier_id}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}

          <AddSupplierBinding productCode={row.code} productName={row.name} />

          <SkuHistoryTabs productId={row.id} />
        </div>

        <footer className={styles.drawerFooter}>
          <p style={{ fontSize: 'var(--fs-12)', color: 'var(--hz-c-ink-muted)', marginRight: 'auto' }}>
            <Star size={11} strokeWidth={2} style={{ verticalAlign: 'middle', color: 'var(--hz-c-primary)', fill: 'var(--hz-c-primary)' }} />
            {' '}Main supplier — used by default when generating POs.
          </p>
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </footer>
      </div>
    </div>
  );
};


/* ════════════════════════════════════════════════════════════════════════
   Specials / Sofa Specials Maintenance panel (owner 2026-06-22)
   ────────────────────────────────────────────────────────────────────────
   TRUE Edit -> Save(effective-date) + History for the Specials pools, matching
   the other Maintenance pools. Specials are the scm.special_addons TABLE (richer
   than a flat config pool: follow-up questions, multi-category, so-description),
   so we version the TABLE: Edit mutates a draft of THIS category's whole set,
   Save prompts for an effective date and appends a full snapshot (POST
   /special-addons/save), which the backend applies onto the live table. SO
   costing keeps reading the live table via loadSpecialAddons — unchanged.

   ONE box: each add-on shows a SINGLE "Cost (RM)" — the surcharge that feeds
   SO costing — written to cost_price_sen ONLY. It used to be written to
   selling_price_sen too, which charged the cost to the customer (docs/bugs/0859).
   Selling surcharges are a Sales Director's deliberate value, never a copy.
   Follow-up choice extras stay selling-only, as in the configurator.
   ════════════════════════════════════════════════════════════════════════ */

const senToRmStr = (sen: number): string =>
  `${sen < 0 ? '−' : ''}RM ${Math.abs(Math.round(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const rowToSpecialInput = (r: SpecialAddonRow): SpecialAddonInput => ({
  code: r.code, label: r.label, soDescription: r.soDescription,
  categories: [...r.categories], sellingPriceSen: r.sellingPriceSen,
  costPriceSen: r.costPriceSen, optionGroups: JSON.parse(JSON.stringify(r.optionGroups)),
  active: r.active, sortOrder: r.sortOrder,
});

const SpecialsMaintenancePanel = ({
  category,
  label,
  description,
}: {
  category: 'BEDFRAME' | 'SOFA';
  label: string;
  description: string;
}) => {
  const list = useSpecialAddons();
  const historyQ = useSpecialAddonsHistory();
  const saveAll = useSaveSpecialAddons();
  const askPrompt = usePrompt();
  const askConfirm = useConfirm();

  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<SpecialAddonInput[] | null>(null);
  const [detached, setDetached] = useState<SpecialAddonInput[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allRows = list.data ?? [];
  const inCat = (r: { categories: string[] }) => r.categories.includes(category);
  const viewRows = allRows.filter(inCat);
  const latestApplied = (historyQ.data ?? []).find((h) => !h.isPending) ?? (historyQ.data ?? [])[0] ?? null;

  const startEdit = () => {
    setError(null);
    setDetached([]);
    setDraft(viewRows.map(rowToSpecialInput));
    setEditMode(true);
  };
  const cancelEdit = () => { setDraft(null); setDetached([]); setEditMode(false); setError(null); };

  const patchRow = (i: number, p: Partial<SpecialAddonInput>) =>
    setDraft((d) => (d ? d.map((r, idx) => (idx === i ? { ...r, ...p } : r)) : d));
  const addRow = () =>
    setDraft((d) => [
      ...(d ?? []),
      { code: '', label: '', soDescription: '', categories: [category], sellingPriceSen: 0, costPriceSen: 0, optionGroups: [], active: true, sortOrder: (d?.length ?? 0) },
    ]);
  const removeRow = (i: number) => setDraft((d) => (d ? d.filter((_, idx) => idx !== i) : d));

  // ── follow-up question (追问) editing on a draft row ──────────────────────
  const setGroups = (i: number, groups: SpecialAddonGroup[]) => patchRow(i, { optionGroups: groups });
  const addGroup = (i: number) => draft && setGroups(i, [...(draft[i]?.optionGroups ?? []), { label: '', required: true, choices: [{ label: '', extraSen: 0 }] }]);
  const removeGroup = (i: number, gi: number) => draft && setGroups(i, (draft[i]?.optionGroups ?? []).filter((_, x) => x !== gi));
  const patchGroup = (i: number, gi: number, p: Partial<SpecialAddonGroup>) =>
    draft && setGroups(i, (draft[i]?.optionGroups ?? []).map((g, x) => (x === gi ? { ...g, ...p } : g)));
  const addChoice = (i: number, gi: number) =>
    draft && patchGroup(i, gi, { choices: [...(draft[i]!.optionGroups[gi]!.choices), { label: '', extraSen: 0 }] });
  const patchChoice = (i: number, gi: number, ci: number, p: Partial<{ label: string; extraSen: number }>) =>
    draft && patchGroup(i, gi, { choices: draft[i]!.optionGroups[gi]!.choices.map((c, x) => (x === ci ? { ...c, ...p } : c)) });
  const removeChoice = (i: number, gi: number, ci: number) =>
    draft && patchGroup(i, gi, { choices: draft[i]!.optionGroups[gi]!.choices.filter((_, x) => x !== ci) });

  const handleSave = async () => {
    if (!draft) return;
    setError(null);
    const seen = new Set<string>();
    for (const r of draft) {
      if (!r.code.trim() || !r.label.trim()) { setError('Every add-on needs a code and a label.'); return; }
      const key = r.code.trim();
      if (seen.has(key)) { setError(`Duplicate code "${key}".`); return; }
      seen.add(key);
      for (const g of r.optionGroups) {
        if (!g.label.trim()) { setError('Every follow-up question needs a label.'); return; }
        if (g.choices.length === 0 || g.choices.some((c) => !c.label.trim())) { setError(`"${g.label || 'question'}" needs at least one named choice.`); return; }
      }
    }
    const baseline = viewRows.map(rowToSpecialInput);
    if (JSON.stringify(baseline) === JSON.stringify(draft)) { cancelEdit(); return; }

    const effectiveFrom = await askPrompt({
      title: 'Effective from (YYYY-MM-DD)?',
      body: 'The new specials apply from this date onward.',
      defaultValue: todayMyt(),
      placeholder: 'YYYY-MM-DD',
      confirmLabel: 'Save',
      validate: (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? null : 'Enter a date as YYYY-MM-DD.'),
    });
    if (!effectiveFrom) return;

    const draftByCode = new Map(draft.map((r) => [r.code.trim(), r]));
    const detachedByCode = new Map(detached.map((r) => [r.code.trim(), r]));
    const otherRows = allRows
      .filter((r) => !inCat(r) && !draftByCode.has(r.code) && !detachedByCode.has(r.code))
      .map(rowToSpecialInput);
    const snapshot: SpecialAddonInput[] = [
      ...otherRows,
      ...detached.map((r) => ({ ...r, code: r.code.trim() })),
      ...draft.map((r) => ({ ...r, code: r.code.trim() })),
    ];

    try {
      await saveAll.mutateAsync({ effectiveFrom, addons: snapshot });
      historyQ.refetch();
      cancelEdit();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    }
  };

  const confirmRemove = async (i: number, lbl: string) => {
    const row = draft?.[i];
    if (!row) return;
    const others = row.categories.filter((x) => x !== category);
    if (others.length > 0) {
      if (!(await askConfirm({
        title: `Remove "${lbl || 'this add-on'}" from ${mfgCategoryLabel(category)}?`,
        body: `It stays available under ${others.map(mfgCategoryLabel).join(', ')}, and existing orders are unaffected.`,
        confirmLabel: 'Remove from this list',
      }))) return;
      setDetached((d) => [...d, { ...row, categories: others }]);
      removeRow(i);
      return;
    }
    if (!(await askConfirm({ title: `Remove "${lbl || 'this add-on'}"?`, body: 'It will be retired on Save (existing orders keep their saved text).', confirmLabel: 'Remove', danger: true }))) return;
    removeRow(i);
  };

  const inputStyle: React.CSSProperties = { width: '100%', padding: '8px 10px', fontSize: 'var(--fs-14)', border: '1px solid var(--hz-c-border-strong)', borderRadius: 'var(--radius-md)', background: 'var(--hz-c-surface-2)' };

  return (
    <>
      <header className={styles.maintHeader}>
        <div>
          <h2 className={styles.maintTitle}>{label}</h2>
          <p className={styles.maintSubtitle}>{description}</p>
          {!editMode && latestApplied && (
            <p className={styles.stateInfo} style={{ marginTop: 8 }}>
              Effective from {latestApplied.effectiveFrom}
              {(historyQ.data ?? []).some((h) => h.isPending) && (
                <span style={{ color: 'var(--hz-c-primary-ink)', fontWeight: 600 }}> · Pending change scheduled</span>
              )}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {!editMode ? (
            <Button variant="ghost" onClick={startEdit}>
              <Edit3 {...ICON_PROPS} />
              <span>Edit</span>
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={cancelEdit}>
                <span>Cancel</span>
              </Button>
              <Button variant="primary" onClick={() => void handleSave()} disabled={saveAll.isPending}>
                <span>{saveAll.isPending ? 'Saving…' : 'Save'}</span>
              </Button>
            </>
          )}
          <Button variant="ghost" onClick={() => setShowHistory(true)}>
            <History {...ICON_PROPS} />
            <span>History</span>
          </Button>
        </div>
      </header>

      {/* COST, not selling (approved mockup) — special add-ons carry an internal
          COST only; the customer is never charged for them (docs/bugs/0859). The
          single RM figure below is that cost, used for SO costing. */}
      <div className={styles.maintCostNote}>
        <Info {...ICON_PROPS} />
        <span>
          <strong>This is cost, not selling.</strong> The customer is not charged for these
          add-ons — the RM figure is the internal cost used for order costing.
        </span>
      </div>

      {error && <div style={{ color: 'var(--hz-c-err)', fontSize: 'var(--fs-13)', margin: 'var(--space-3) 0' }} role="alert">{error}</div>}

      {list.error ? (
        <div style={{ color: 'var(--hz-c-err)', marginTop: 'var(--space-3)' }}>Failed to load: {String(list.error)}</div>
      ) : !editMode ? (
        <div style={{ marginTop: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {viewRows.map((r, i) => (
            <div
              key={r.id}
              style={{
                display: 'grid', gridTemplateColumns: '28px 1fr auto 80px',
                alignItems: 'center', gap: 'var(--space-3)',
                padding: 'var(--space-3) var(--space-4)',
                background: 'var(--hz-c-surface-2)', border: '1px solid var(--hz-c-border)',
                borderRadius: 'var(--radius-md)', opacity: r.active ? 1 : 0.55,
              }}
            >
              <span style={{ fontSize: 'var(--fs-12)', color: 'var(--hz-c-ink-soft)' }}>{i + 1}</span>
              <div style={{ minWidth: 0, fontSize: 'var(--fs-16)', fontWeight: 600, color: 'var(--hz-c-ink)' }}>
                {r.label}
                {r.optionGroups.length > 0 && (
                  <span style={{ fontSize: 'var(--fs-11)', color: 'var(--hz-c-ink-muted)', marginLeft: 8 }}>
                    {r.optionGroups.map((g) => `${g.label} (${g.choices.length})`).join(' · ')}
                  </span>
                )}
              </div>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-15)', color: 'var(--hz-c-ink)', textAlign: 'right', whiteSpace: 'nowrap' }}>{senToRmStr(r.costPriceSen)}</span>
              <span style={{ fontSize: 'var(--fs-12)', fontWeight: 600, textAlign: 'right', color: r.active ? '#1a7a3a' : 'var(--hz-c-ink-muted)' }}>{r.active ? 'Active' : 'Inactive'}</span>
            </div>
          ))}
          {!list.isLoading && viewRows.length === 0 && (
            <div style={{ color: 'var(--hz-c-ink-muted)', fontSize: 'var(--fs-13)', padding: 'var(--space-3)' }}>
              No special add-ons in this category yet — click Edit, then “+ Add special”.
            </div>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {(draft ?? []).map((r, i) => (
            <div key={i} style={{ border: '1px solid var(--hz-c-border-strong)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)', background: 'var(--hz-c-surface)' }}>
              <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
                <label style={{ flex: '1 1 160px' }}>
                  <span style={{ display: 'block', fontSize: 'var(--fs-13)', fontWeight: 600, marginBottom: 4 }}>Code (stable key)</span>
                  <input style={inputStyle} value={r.code} onChange={(e) => patchRow(i, { code: e.target.value })} placeholder="Right Drawer" />
                </label>
                <label style={{ flex: '1 1 160px' }}>
                  <span style={{ display: 'block', fontSize: 'var(--fs-13)', fontWeight: 600, marginBottom: 4 }}>Label</span>
                  <input style={inputStyle} value={r.label} onChange={(e) => patchRow(i, { label: e.target.value })} placeholder="Right Drawer" />
                </label>
                <label style={{ width: 140 }}>
                  <span style={{ display: 'block', fontSize: 'var(--fs-13)', fontWeight: 600, marginBottom: 4 }}>Cost (RM, can be −)</span>
                  {/* COST only: writing selling too charged it to the customer (docs/bugs/0859). */}
                  <input type="number" step={1} style={inputStyle}
                    value={Math.round(r.costPriceSen) / 100}
                    onChange={(e) => { const sen = Math.round((Number(e.target.value) || 0) * 100); patchRow(i, { costPriceSen: sen }); }} />
                </label>
                <label style={{ display: 'flex', alignItems: 'flex-end', gap: 6, fontSize: 'var(--fs-13)' }}>
                  <input type="checkbox" checked={r.active} onChange={(e) => patchRow(i, { active: e.target.checked })} /> Active
                </label>
                <button type="button" onClick={() => void confirmRemove(i, r.label)} style={{ alignSelf: 'flex-end', fontSize: 'var(--fs-12)', background: 'none', border: '1px solid var(--hz-c-border)', borderRadius: 'var(--radius-sm)', padding: '6px 10px', cursor: 'pointer', color: 'var(--hz-c-err)' }}>
                  <Trash2 size={13} strokeWidth={1.75} style={{ verticalAlign: 'middle' }} /> Remove
                </button>
              </div>
              <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
                <span style={{ display: 'block', fontSize: 'var(--fs-13)', fontWeight: 600, marginBottom: 4 }}>SO description (prints under the product)</span>
                <input style={inputStyle} value={r.soDescription} onChange={(e) => patchRow(i, { soDescription: e.target.value })} placeholder="Right pull-out drawer" />
              </label>

              {/* follow-up questions (追问) */}
              <div style={{ borderTop: '1px solid #d6d9d2', paddingTop: 'var(--space-3)' }}>
                <span style={{ display: 'block', fontSize: 'var(--fs-13)', fontWeight: 600, marginBottom: 6 }}>Follow-up questions (optional)</span>
                {r.optionGroups.map((g, gi) => (
                  <div key={gi} style={{ border: '1px solid var(--hz-c-border)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>
                    <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginBottom: 6 }}>
                      <input style={{ ...inputStyle, flex: '1 1 160px' }} placeholder="Question (e.g. Thickness)" value={g.label} onChange={(e) => patchGroup(i, gi, { label: e.target.value })} />
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-12)' }}>
                        <input type="checkbox" checked={g.required} onChange={(e) => patchGroup(i, gi, { required: e.target.checked })} /> required
                      </label>
                      <button type="button" onClick={() => removeGroup(i, gi)} style={{ fontSize: 'var(--fs-12)', color: 'var(--hz-c-err)', background: 'none', border: 'none', cursor: 'pointer' }}>remove ✕</button>
                    </div>
                    {g.choices.map((c, ci) => (
                      <div key={ci} style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 4, paddingLeft: 'var(--space-3)' }}>
                        <input style={{ ...inputStyle, flex: '1 1 120px' }} placeholder={'Choice (e.g. 10")'} value={c.label} onChange={(e) => patchChoice(i, gi, ci, { label: e.target.value })} />
                        <input type="number" step={1} style={{ ...inputStyle, width: 120 }} title="Extra RM (can be −)" value={Math.round(c.extraSen) / 100} onChange={(e) => patchChoice(i, gi, ci, { extraSen: Math.round((Number(e.target.value) || 0) * 100) })} />
                        <button type="button" onClick={() => removeChoice(i, gi, ci)} style={{ fontSize: 'var(--fs-12)', color: 'var(--hz-c-ink-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
                      </div>
                    ))}
                    <button type="button" onClick={() => addChoice(i, gi)} style={{ fontSize: 'var(--fs-12)', marginLeft: 'var(--space-3)', background: 'none', border: '1px dashed var(--hz-c-border-strong)', borderRadius: 'var(--radius-sm)', padding: '2px 8px', cursor: 'pointer' }}>+ choice</button>
                  </div>
                ))}
                <button type="button" onClick={() => addGroup(i)} style={{ fontSize: 'var(--fs-13)', background: 'none', border: '1px dashed var(--hz-c-border-strong)', borderRadius: 'var(--radius-md)', padding: '4px 10px', cursor: 'pointer' }}>+ Add question</button>
              </div>
            </div>
          ))}
          <div>
            <Button variant="ghost" onClick={addRow}>
              <Plus {...ICON_PROPS} />
              <span>Add special</span>
            </Button>
          </div>
        </div>
      )}

      {showHistory && (
        <SpecialsHistoryDialog
          activeLabel={label}
          category={category}
          history={historyQ.data ?? []}
          onClose={() => setShowHistory(false)}
        />
      )}
    </>
  );
};

const SpecialsHistoryDialog = ({
  activeLabel,
  category,
  history,
  onClose,
}: {
  activeLabel: string;
  category: 'BEDFRAME' | 'SOFA';
  history: SpecialAddonsHistoryRow[];
  onClose: () => void;
}) => {
  const { actorNameOf } = useStaffLookup();
  return (
  <div className={styles.drawerBackdrop} onClick={onClose}>
    <div
      onClick={(e) => e.stopPropagation()}
      style={{ background: 'var(--hz-c-surface-2)', border: '1px solid var(--hz-c-border-strong)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-3)', width: 'min(720px, 95vw)', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
    >
      <header className={styles.drawerHeader}>
        <h2 className={styles.drawerTitle}>Specials history · {activeLabel}</h2>
        <button type="button" className={styles.iconBtn} onClick={onClose}><X {...ICON_PROPS} /></button>
      </header>
      <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-4)' }}>
        {history.length === 0 && (
          <p style={{ textAlign: 'center', color: 'var(--hz-c-ink-muted)' }}>No specials changes yet — the baseline snapshot is the only entry.</p>
        )}
        {history.map((entry) => {
          const slice = (entry.addons ?? []).filter((a) => Array.isArray(a.categories) && a.categories.includes(category));
          return (
            <div key={entry.id} style={{ padding: 'var(--space-3)', border: '1px solid var(--hz-c-border)', borderRadius: 'var(--radius-md)', marginBottom: 'var(--space-3)', background: entry.isPending ? 'rgba(232, 107, 58, 0.06)' : '#fff' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontFamily: 'var(--font-mark)', fontSize: 'var(--fs-16)', fontWeight: 700, color: 'var(--hz-c-ink)' }}>Effective from {entry.effectiveFrom}</span>
                {entry.isPending && (
                  <span style={{ background: 'rgba(232, 107, 58, 0.20)', color: 'var(--hz-c-primary-ink)', padding: '2px 8px', borderRadius: 'var(--radius-pill)', fontSize: 'var(--fs-11)', fontWeight: 600 }}>PENDING</span>
                )}
              </div>
              <div style={{ marginTop: 4, fontSize: 'var(--fs-12)', color: 'var(--hz-c-ink-muted)' }}>
                Created {fmtDateTime(entry.createdAt)}{entry.createdBy ? ` by ${actorNameOf(entry.createdBy)}` : ''}
              </div>
              {entry.notes && <p style={{ marginTop: 6, fontSize: 'var(--fs-13)', color: 'var(--hz-c-ink)' }}>Notes: {entry.notes}</p>}
              <pre style={{ marginTop: 8, padding: 'var(--space-2)', background: 'var(--hz-c-surface-2)', border: '1px solid var(--hz-c-border)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--fs-11)', overflow: 'auto', maxHeight: 200 }}>
                {JSON.stringify(slice.map((a) => ({ code: a.code, label: a.label, costRM: Math.round(a.costPriceSen) / 100, active: a.active, followUps: (a.optionGroups ?? []).length })), null, 2)}
              </pre>
            </div>
          );
        })}
      </div>
      <footer className={styles.drawerFooter}>
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </footer>
    </div>
  </div>
  );
};


const MaintenanceHistoryDialog = ({
  activeLabel,
  activeKey,
  history,
  onClose,
}: {
  activeLabel: string;
  activeKey: MaintenanceListKey;
  history: import('../../vendor/scm/lib/mfg-products-queries').MaintenanceHistoryRow[];
  onClose: () => void;
}) => {
  const { actorNameOf } = useStaffLookup();
  return (
  <div className={styles.drawerBackdrop} onClick={onClose}>
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        background: 'var(--hz-c-surface-2)',
        border: '1px solid var(--hz-c-border-strong)',
        borderRadius: 'var(--radius-xl)',
        boxShadow: 'var(--shadow-3)',
        width: 'min(720px, 95vw)',
        maxHeight: '85vh',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <header className={styles.drawerHeader}>
        <h2 className={styles.drawerTitle}>Maintenance history · {activeLabel}</h2>
        <button type="button" className={styles.iconBtn} onClick={onClose}><X {...ICON_PROPS} /></button>
      </header>
      <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-4)' }}>
        {history.length === 0 && (
          <p style={{ textAlign: 'center', color: 'var(--hz-c-ink-muted)' }}>
            No maintenance changes yet — the baseline migration row is the only entry.
          </p>
        )}
        {history.map((entry) => {
          const sectionValue = (entry.config as unknown as Record<string, unknown>)[activeKey];
          return (
            <div key={entry.id} style={{
              padding: 'var(--space-3)',
              border: '1px solid var(--hz-c-border)',
              borderRadius: 'var(--radius-md)',
              marginBottom: 'var(--space-3)',
              background: entry.isPending ? 'rgba(232, 107, 58, 0.06)' : '#fff',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontFamily: 'var(--font-mark)', fontSize: 'var(--fs-16)', fontWeight: 700, color: 'var(--hz-c-ink)' }}>
                  Effective from {entry.effectiveFrom}
                </span>
                {entry.isPending && (
                  <span style={{ background: 'rgba(232, 107, 58, 0.20)', color: 'var(--hz-c-primary-ink)', padding: '2px 8px', borderRadius: 'var(--radius-pill)', fontSize: 'var(--fs-11)', fontWeight: 600 }}>
                    PENDING
                  </span>
                )}
              </div>
              <div style={{ marginTop: 4, fontSize: 'var(--fs-12)', color: 'var(--hz-c-ink-muted)' }}>
                Created {fmtDateTime(entry.createdAt)}{entry.createdBy ? ` by ${actorNameOf(entry.createdBy)}` : ''}
              </div>
              {entry.notes && (
                <p style={{ marginTop: 6, fontSize: 'var(--fs-13)', color: 'var(--hz-c-ink)' }}>Notes: {entry.notes}</p>
              )}
              <pre style={{
                marginTop: 8,
                padding: 'var(--space-2)',
                background: 'var(--hz-c-surface-2)',
                border: '1px solid var(--hz-c-border)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 'var(--fs-11)',
                overflow: 'auto',
                maxHeight: 200,
              }}>
                {JSON.stringify(sectionValue, null, 2)}
              </pre>
            </div>
          );
        })}
      </div>
      <footer className={styles.drawerFooter}>
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </footer>
    </div>
  </div>
  );
};


// PR #104 — Commander 2026-05-26: "fabric_usage_sen / production_time_minutes
// / fabric_color 全删 不需要这个功能". These manufacturing-specific fields
// were ported in from HOOKKA but don't apply to 2990's retail catalogue;
// dropping them from the CSV export so commander's spreadsheet stays focused.
// Schema columns + API field writers also stripped (apps/api/src/routes/
// mfg-products.ts) so future imports don't resurrect the data.
//
// Sofa per-tier export (Wei Siang) — a sofa carries a price per (size × tier).
// The CSV is LONG form: one row per sofa tier (PRICE_1 .. PRICE_4),
// with one money column per size. Non-sofa rows leave the size columns blank
// and carry base_price_sen / price1_sen instead. The old cost_price_sen column
// is dropped entirely — it was the zeroing trap on round-trip.


const normalizeHeight = (h: unknown): string => String(h ?? '').replace('"', '').trim();

// CSV money columns are written in plain RINGGIT with two decimals (1535.00) —
// never raw sen (153500 reads like "RM153,500"). The owner's rule of 2026-09-15
// (every amount reads the way AutoCount prints it) replaces the earlier
// no-".00" choice (Wei Siang 2026-06-09); typing "1535" back in still imports.
// Round-trip stays exact because money is 2dp: import multiplies by 100 back to sen.
const priceColForSize = (size: string) => `price_${size}`;

function exportSkusCsv(rows: MfgProductRow[], sofaSizes: string[], tier: SofaPriceTier, category: MfgCategory | 'all'): void {
  const wantSofa = category === 'all' || category === 'SOFA';
  const wantFlat = category === 'all' || category !== 'SOFA';
  const sizeCols = sofaSizes.map(priceColForSize);
  const columns = [
    'code', 'name', 'category', 'size_label',
    ...(wantSofa ? ['price_tier', ...sizeCols] : []),
    ...(wantFlat ? ['base_price', 'price1'] : []),
  ];

  const cell = (v: unknown): string => {
    if (v == null) return '';
    const s = guardFormula(String(v));
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines: string[] = [columns.join(',')];

  for (const r of rows) {
    const common: Record<string, unknown> = {
      code:        r.code,
      name:        r.name,
      category:    r.category,
      size_label:  r.size_label,
    };

    const emit = (extra: Record<string, unknown>) => {
      const merged = { ...common, ...extra };
      lines.push(columns.map((c) => cell(merged[c])).join(','));
    };

    if (r.category === 'SOFA') {
      const m = new Map<string, number>();
      for (const e of r.seat_height_prices ?? []) {
        if ((e.tier ?? 'PRICE_2') === tier) m.set(normalizeHeight(e.height), e.priceSen);
      }
      const sizeCells: Record<string, unknown> = {};
      for (const size of sofaSizes) {
        sizeCells[priceColForSize(size)] = priceSheetRinggit(m.get(normalizeHeight(size)));
      }
      emit({ price_tier: tier, ...sizeCells });
    } else {
      emit({
        base_price: priceSheetRinggit(r.base_price_sen),
        price1:     priceSheetRinggit(r.price1_sen),
      });
    }
  }

  // BOM: without it Excel opens the file in the PC's codepage and KŌRI-style codes come out garbled (HC-0165).
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const catTag = category === 'all' ? '' : `${category.toLowerCase()}-`;
  a.download = `2990s-skus-${catTag}${todayMyt()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const ImportSkusDialog = ({ sofaSizes, onClose }: { sofaSizes: string[]; onClose: () => void }) => {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BatchImportResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const batchImport = useBatchImportMfgProducts();
  // Parsed rows held for PREVIEW — committed only on explicit Confirm (Commander
  // 2026-06-15, no 裸奔: picking a file must NOT write to the server).
  const [staged, setStaged] = useState<{ rows: BatchImportRow[]; tierErrors: Array<{ code: string; reason: string }> } | null>(null);

  const handleFile = async (file: File) => {
    setBusy(true);
    setResult(null);
    setErrorMsg(null);
    try {
      const parsed = gridToSkuRecords(await readImportGrid(file));
      if (parsed.length === 0) {
        setErrorMsg('That file had no rows. Export a copy first, edit it, then import the same file.');
        setBusy(false);
        return;
      }
      const headersSeen = Object.keys(parsed[0] ?? {});

      const { rows, tierErrors } = buildSkuImportRows(parsed, sofaSizes);

      if (rows.length === 0) {
        if (tierErrors.length > 0) {
          setResult({ upserted: 0, failed: tierErrors.length, failures: tierErrors });
        } else {
          setErrorMsg(importFailureMessage(headersSeen));
        }
        setBusy(false);
        return;
      }

      // Stage for preview — DO NOT commit yet (Commander 2026-06-15, no 裸奔):
      // show what will change and require an explicit Confirm before writing.
      setStaged({ rows, tierErrors });
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const confirmImport = async () => {
    if (!staged) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await batchImport.mutateAsync(staged.rows);
      setResult(staged.tierErrors.length > 0
        ? {
            ...res,
            failed: res.failed + staged.tierErrors.length,
            failures: [...staged.tierErrors, ...(res.failures ?? [])],
          }
        : res);
      setStaged(null);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.drawerBackdrop} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--hz-c-surface-2)',
          border: '1px solid var(--hz-c-border-strong)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-3)',
          width: 'min(560px, 95vw)',
          padding: 'var(--space-5)',
        }}
      >
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-4)' }}>
          <h2 className={styles.drawerTitle}>Import SKUs</h2>
          <button type="button" className={styles.iconBtn} onClick={onClose}><X {...ICON_PROPS} /></button>
        </header>
        <p style={{ fontSize: 'var(--fs-13)', color: 'var(--hz-c-ink-muted)' }}>
          A code that is not in SKU Master creates a new SKU (it needs a name and a category);
          a code already there edits that SKU. Start from the template for new SKUs, or from
          Export SKUs to edit prices. A blank cell is left as it was — it never clears a price.
          Up to 500 SKUs per file. A new category on a SKU that belongs to a model moves the model and all its SKUs.
        </p>
        <Button variant="secondary" onClick={() => void downloadSkuImportTemplate(sofaSizes)} style={{ marginTop: 'var(--space-3)' }}>
          <Download {...ICON_PROPS} />
          <span>Download template</span>
        </Button>
        <br />
        <input
          type="file"
          accept=".csv,.xlsx,.xls"
          disabled={busy || staged !== null}
          style={{ marginTop: 'var(--space-3)' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
        />

        {busy && (
          <p style={{ marginTop: 'var(--space-3)', fontSize: 'var(--fs-13)', color: 'var(--hz-c-ink-muted)' }}>
            Working…
          </p>
        )}

        {/* Preview + explicit Confirm (Commander 2026-06-15 — no 裸奔). Nothing
            is written until the operator confirms this staged batch. */}
        {staged && !result && (
          <div style={{ marginTop: 'var(--space-4)' }}>
            <p style={{ fontSize: 'var(--fs-13)' }}>
              <strong>{staged.rows.length}</strong> SKU{staged.rows.length === 1 ? '' : 's'} ready to import
              {staged.tierErrors.length > 0 && (
                <> · <span style={{ color: 'var(--hz-c-primary-ink)' }}>{staged.tierErrors.length} will be skipped</span></>
              )}. Blank cells keep the current value. <strong>Nothing is saved until you confirm.</strong>
            </p>
            {staged.tierErrors.length > 0 && (
              <ul style={{ margin: 'var(--space-2) 0 0', paddingLeft: 'var(--space-4)', fontSize: 'var(--fs-12)', color: 'var(--hz-c-primary-ink)' }}>
                {staged.tierErrors.slice(0, 8).map((e) => <li key={e.code}>{e.code}: {e.reason}</li>)}
                {staged.tierErrors.length > 8 && <li>…and {staged.tierErrors.length - 8} more</li>}
              </ul>
            )}
            <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end', marginTop: 'var(--space-4)' }}>
              <Button variant="secondary" onClick={() => setStaged(null)} disabled={busy}>Cancel</Button>
              <Button variant="primary" onClick={() => void confirmImport()} disabled={busy}>
                {busy ? 'Importing…' : `Confirm import (${staged.rows.length})`}
              </Button>
            </div>
          </div>
        )}

        {errorMsg && (
          <p style={{ marginTop: 'var(--space-3)', fontSize: 'var(--fs-13)', color: '#b3261e' }}>
            {errorMsg}
          </p>
        )}

        {result && (
          <div style={{ marginTop: 'var(--space-3)', fontSize: 'var(--fs-13)' }}>
            <div style={{
              fontWeight: 700,
              color: result.failed > 0 ? 'var(--hz-c-primary-ink)' : 'var(--hz-dk-secondary-a, #2F5D4F)',
            }}>
              {result.upserted > 0
                ? `Saved — ${savedSummary(result)}${result.failed > 0 ? ` · ${result.failed} failed` : ''}`
                : result.failed > 0
                  ? `Nothing saved — ${result.failed} row${result.failed === 1 ? '' : 's'} failed`
                  : 'Nothing to update — every value already matched what was saved'}
            </div>
            {result.failures.length > 0 && (
              <ul style={{ marginTop: 'var(--space-2)', paddingLeft: '1.2em', color: 'var(--hz-c-ink-muted)' }}>
                {result.failures.slice(0, 5).map((f, i) => (
                  <li key={i}>{f.code || '(no code)'}: {f.reason}</li>
                ))}
                {result.failures.length > 5 && <li>…and {result.failures.length - 5} more.</li>}
              </ul>
            )}
            <ImportModelsMoved moves={result.modelsMoved} />
          </div>
        )}

        <footer style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--space-4)' }}>
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </footer>
      </div>
    </div>
  );
};

