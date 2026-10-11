// ----------------------------------------------------------------------------
// Products & Maintenance — manufacturer SKU master + variant config editor.
//
// Ported from HOOKKA src/pages/products/index.tsx (~2839 LOC).
//
// Reskinned to the app design system (batch 3): the bespoke grey "framed
// card" .page wrapper is gone — the page is full-bleed on the app background
// and the header/tab rail ride the shared <PageHeader>. Buttons come from
// ../../components/Button. Chrome is Tailwind design tokens (bg-surface,
// border-border, text-ink, bg-primary…); the kept module.css holds only the
// repeated CONTENT primitives (tables, drawers, modals, fields, maint rows).
//
// NOTE the old .page block re-declared --c-cream / --c-paper / --line as a
// local cascade, so those tokens meant something DIFFERENT inside this page
// than they do globally (cream and paper are effectively swapped). Removing
// .page removes the overrides, so every surviving colour is pinned to hex.
// Do not "restore" them to var(--c-*) — that silently re-themes the page.
//   - Merriweather title, Poppins body, Raleway eyebrow + caps tracking-loud
//   - Archivo Black for the price column (--font-mark, 80% stretch)
//   - Lucide icons stroke 1.75, no emoji
//   - exactly ONE primary CTA per screen (Edit Prices / Save)
//   - rounded-only tokens (no literal px on border-radius)
//
// Tabs:
//   [SKU Master] — list of mfg_products, filterable by category, with the
//       Edit Prices / Export / Import actions in the top-right.
//   [Maintenance] — left-rail of sub-tabs grouped Bedframe / Sofa / Common,
//       right-panel list editor for the focused sub-tab. Save opens an
//       effective-date drawer.
// ----------------------------------------------------------------------------

import { memo, useCallback, useEffect, useMemo, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
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
} from 'lucide-react';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/Layout';
import { useDebouncedValue } from '../../vendor/scm/lib/hooks';
import { SearchableSelect } from '../../vendor/scm/components/SearchableSelect';
import { fmtCenti, fmtDate, fmtDateTime, maintActiveValues, maintEntryActive, maintEntryValue, maintEntryWithActive, maintEntryWithValue, maintValues, normalizeSofaTier, resolveSofaQuickPresets, SOFA_MODULES, type MaintPoolEntry, type SofaQuickPreset } from '@2990s/shared';
import {
  useMfgProducts,
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
  type MfgProductRow,
  type BatchImportRow,
  type BatchImportResult,
  type MaintenanceConfig,
  type PricedOption,
  type SeatHeightPrice,
  type SofaPriceTier,
  type ProductSupplierRow,
  type MfgProductPriceChangeRow,
  type SpecialAddonRow,
  type SpecialAddonInput,
  type SpecialAddonGroup,
  type SpecialAddonsHistoryRow,
} from '../../vendor/scm/lib/mfg-products-queries';
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
import { Categories } from './Categories';
import { useBrandingPool } from '../../vendor/scm/lib/product-models-queries';
import { useQueryClient } from '@tanstack/react-query';
import { parseMoneyToSen } from '../../lib/money';
import styles from './Products.module.css';
import { DateField } from "../../vendor/scm/components/DateField";

const ICON_PROPS = { size: 16, strokeWidth: 1.75 } as const;

type TopTab = 'sku' | 'modular' | 'maintenance' | 'combos' | 'variants' | 'fabric' | 'categories';


export const Products = () => {
  /* URL-state the top tab so deep-links land on the right view (the Variants
     tab is the new entry — owners coming from the design handoff should be
     able to bookmark /scm/products?tab=variants). Reads/writes ?tab on every
     change; the legacy default (no query string) still lands on SKU Master. */
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
          /* Tab rail — reskinned to the reference FilterPills slab (same seat
             the bespoke .tabSwitch had inside the old .headerRow). The tab
             set, order, labels and ?tab wiring are unchanged; only the chrome
             moved onto the shared PageHeader. */
          <div
            role="tablist"
            className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md border border-border bg-surface p-1 shadow-stone [&>*]:shrink-0"
          >
            {([
              { value: 'sku' as const, label: 'SKU Master' },
              /* PR #84 — Commander 2026-05-26 wanted a dedicated place to
                 manage per-Model specs (allowed options, thickness, etc.)
                 separately from "create code" and SKU adjustments. The
                 Modular tab routes into the same ProductModels list that
                 used to live under /product-models — restoring an entry
                 point (PR #73 removed the old Models tab; this is its
                 replacement with a clearer name). */
              { value: 'modular' as const, label: 'Modular' },
              { value: 'maintenance' as const, label: 'Maintenance' },
              /* PR #237 — Sofa Combo Pricing (Commander 2026-05-28
                 "去查看 hookka 的 combo module 把整个 copy 过来"). Module-set
                 combo deals that OVERRIDE per-Model compartment pricing. */
              { value: 'combos' as const, label: 'Combo Pricing' },
              /* PR — Variants editor (design handoff item 5). Lives next to
                 Combo Pricing because the two work together: combos set the
                 bundle, this tab tunes the per-SKU enable / price-override on
                 the underlying variants. Writes go through the same
                 /mfg-products PATCH the SKU Master grid uses. */
              { value: 'variants' as const, label: 'Variants' },
              /* Fabric Converter — moved out of the sidebar to sit next to
                 Combo Pricing (commander 2026-05-28). Renders the existing
                 FabricTracking page inline; the /fabric-tracking route is kept
                 for back-compat / direct links. */
              { value: 'fabric' as const, label: 'Fabric Converter' },
              /* Categories — brought in from the standalone /scm/categories
                 route (same pattern as Fabric Converter): the standalone
                 route stays for back-compat / direct links, but this tab is
                 now the canonical entry so operators managing products can
                 edit the category tree without leaving the page. */
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

/* ════════════════════════════════════════════════════════════════════════
   SKU Master tab
   ════════════════════════════════════════════════════════════════════════ */

const CATEGORIES: { value: MfgCategory | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'ACCESSORY', label: 'Accessory' },
  { value: 'BEDFRAME', label: 'Bedframe' },
  { value: 'SOFA', label: 'Sofa' },
  { value: 'MATTRESS', label: 'Mattress' },
  { value: 'BEDLINES', label: 'Bedlines' },
  { value: 'DINING', label: 'Dining' },
  { value: 'DIFFUSER', label: 'Diffuser' },
  { value: 'CARPET', label: 'Carpet' },
  { value: 'SERVICE', label: 'Service' },
];

const fmtRm = (sen: number | null): string => fmtCenti(sen);

const fmtUnit = (milli: number): string =>
  (milli / 1000).toFixed(3);

type Tier = SofaPriceTier;

const TIER_CHIPS: { value: Tier; label: string }[] = [
  { value: 'PRICE_1', label: 'P1' },
  { value: 'PRICE_2', label: 'P2' },
  { value: 'PRICE_3', label: 'P3' },
];

// Look up the priceSen for a given (height, tier) pair. Legacy rows with no
// `tier` field count as PRICE_2 (HOOKKA's historic default).
const priceForHeightTier = (
  arr: SeatHeightPrice[] | null | undefined,
  height: string,
  tier: Tier,
): number | null => {
  if (!Array.isArray(arr)) return null;
  const hit = arr.find((p) => p.height === height && (p.tier ?? 'PRICE_2') === tier);
  return hit ? hit.priceSen : null;
};

// Replace (or insert) the priceSen for one (height × tier) slot in the array.
const upsertHeightTier = (
  arr: SeatHeightPrice[] | null | undefined,
  height: string,
  tier: Tier,
  priceSen: number | null,
): SeatHeightPrice[] => {
  const next = Array.isArray(arr) ? [...arr] : [];
  const idx = next.findIndex(
    (p) => p.height === height && (p.tier ?? 'PRICE_2') === tier,
  );
  if (priceSen == null || priceSen === 0) {
    if (idx >= 0) next.splice(idx, 1);
    return next;
  }
  const entry: SeatHeightPrice = { height, priceSen, tier };
  if (idx >= 0) next[idx] = entry;
  else next.push(entry);
  return next;
};

/* Staged inline-edit patch for one SKU row (Edit Prices mode). Mirrors the
   fields useUpdateMfgProductPrices accepts (minus id). Nothing is sent to the
   server until Save (Commander 2026-06-15 — no 裸奔). */
type ProductEditPatch = {
  code?: string;
  name?: string;
  branding?: string | null;
  seatHeightPrices?: SeatHeightPrice[];
  basePriceSen?: number | null;
  price1Sen?: number | null;
};

// Row windowing (Edit Prices legacy table). Past this many rows we render only
// the slice scrolled into view; short catalogs render in full (byte-identical
// to before). Mirrors components/DataTable.tsx's window-scroll virtualization.
const VIRTUAL_ROW_THRESHOLD = 40;
const VIRTUAL_OVERSCAN = 12;
const SKU_ROW_HEIGHT_ESTIMATE = 34; // px; corrected at runtime by measuring a real row

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
  const stageEdit = useCallback((id: string, patch: ProductEditPatch) => {
    setPendingEdits((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }, []);
  const dirtyCount = Object.keys(pendingEdits).length;
  const saveEdits = async () => {
    const entries = Object.entries(pendingEdits);
    if (entries.length === 0) { setEditMode(false); return; }
    setSavingEdits(true);
    try {
      for (const [id, patch] of entries) {
        await updatePrices.mutateAsync({ id, ...patch });
      }
      setPendingEdits({});
      setEditMode(false);
    } finally {
      setSavingEdits(false);
    }
  };
  const exitEdit = () => { setPendingEdits({}); setEditMode(false); };
  const [tier, setTier] = useState<Tier>('PRICE_2');
  // PR #39 — Model filter chip row (visible only on Sofa view).
  // Distinct base_model values pulled from current rows. 'all' = no filter.
  const [modelFilter, setModelFilter] = useState<string>('all');
  // One-shot filter — narrows the grid to one_shot=true rows only.
  const [oneShotOnly, setOneShotOnly] = useState(false);

  // NOTE: this fetch is unbounded — it pulls the full mfg_products set for the
  // category/search (no limit/pagination). The DOM is now windowed below, but
  // the payload still scales with catalog size; a server-side cap / cursor is a
  // separate follow-up (out of scope for this DOM-virtualization change).
  const { data: products, isLoading, isFetching, error } = useMfgProducts({
    category: category === 'all' ? undefined : category,
    search: debouncedSearch.trim() || undefined,
  });
  const searching =
    search.trim() !== debouncedSearch.trim() || (!isLoading && isFetching);
  const config = useMaintenanceConfig('master');
  // Branding datalist options for the inline Mattress branding edit — pool
  // first, DISTINCT fallback. Rendered ONCE below (datalist#branding-pool-sku-master)
  // so every row's BrandingInput can reference it.
  const brandingPool = useBrandingPool();

  const allRows = useMemo(() => products ?? [], [products]);
  const isSofaView = category === 'SOFA';
  const isMattressView = category === 'MATTRESS';
  // Memoized so its reference is stable across renders — otherwise the fallback
  // array literal would change every render and defeat ProductRow's React.memo.
  // ACTIVE-toggle note: the SKU grid renders a price column for EVERY size
  // (maintValues, not maintActiveValues) — existing SKUs may carry prices on
  // a deactivated size and those must stay visible/exportable.
  const sofaSizes = useMemo(
    () => (config.data?.data?.sofaSizes ? maintValues(config.data.data.sofaSizes) : ['24', '26', '28', '30', '32', '35']),
    [config.data],
  );

  // PR #39 + #107 — distinct base_model values for the current category.
  // Commander 2026-05-26: "为什么 bedframe 没有像 sofa 那样". Extended from
  // SOFA-only to BEDFRAME + MATTRESS too so commander can narrow the SKU
  // list to a single Model (Hilton bedframes, Purezone mattresses, etc.).
  // ACCESSORY + SERVICE skip the filter — they don't carry a base_model.
  const supportsModelFilter = category === 'SOFA' || category === 'BEDFRAME' || category === 'MATTRESS';
  const categoryModels = useMemo<string[]>(() => {
    if (!supportsModelFilter) return [];
    const s = new Set<string>();
    for (const r of allRows) if (r.base_model) s.add(r.base_model);
    return Array.from(s).sort();
  }, [allRows, supportsModelFilter]);

  // Apply Model filter (only when current category supports it + a specific
  // model is picked), then apply the one-shot filter.
  const rows = useMemo(() => {
    let base = allRows;
    if (supportsModelFilter && modelFilter !== 'all') {
      base = base.filter((r) => r.base_model === modelFilter);
    }
    if (oneShotOnly) {
      base = base.filter((r) => r.one_shot === true);
    }
    return base;
  }, [allRows, supportsModelFilter, modelFilter, oneShotOnly]);

  // Reset Model filter when leaving a category that doesn't support it
  useEffect(() => {
    if (!supportsModelFilter && modelFilter !== 'all') setModelFilter('all');
  }, [supportsModelFilter, modelFilter]);

  // Drawer + modal state
  const [newSkuOpen, setNewSkuOpen] = useState(false);
  const [suppliersRow, setSuppliersRow] = useState<MfgProductRow | null>(null);
  const [importing, setImporting] = useState(false);
  // PR #73 — "+ New SKU" now opens the Model creation dialog (with the
  // active category filter pre-filled). The legacy single-SKU drawer
  // stays around in `newSkuOpen` for the ACCESSORY / SERVICE fall-back
  // where a Model template isn't useful.
  const [newModelOpen, setNewModelOpen] = useState(false);
  const qc = useQueryClient();
  // Map the SKU Master category-filter values to MfgCategory. `all` becomes
  // undefined so the dialog defaults to SOFA on its own.
  const initialCategoryForDialog: MfgCategory | undefined =
    category === 'all' ? undefined : (category as MfgCategory);

  // PR #82 (Commander 2026-05-26) — multi-select delete. Set<id> tracks
  // ticked rows; select-all checkbox toggles every visible row.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const deleteMut = useDeleteMfgProduct();
  const [statusing, setStatusing] = useState(false);
  const statusMut = useUpdateMfgProductStatus();
  const visibleIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someSelected = !allSelected && visibleIds.some((id) => selectedIds.has(id));
  // Stable identity so it can be passed straight to the memoized ProductRow
  // (no per-row inline closure → only the toggled row re-renders).
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
  // Drop selections that disappeared from the visible list (category /
  // search change). Prevents "Delete 3" claiming rows that aren't on
  // screen.
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

    // PR #94 — Commander 2026-05-26: the "Deleted 0 / 6. 6 failed" alert
    // hid the actual reason behind a generic message. Surface per-row
    // errors so commander can see WHAT is blocking (inventory lot,
    // supplier binding, etc.) and offer Force delete as a follow-up.
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

  // Total column count (header colspan for loading/empty states):
  //   PR #82 — leading checkbox column added (+1).
  //   PR #38 — Configure + History columns removed. Double-click a row to
  //   open the Suppliers drawer.
  //   - Sofa: select + code + desc + model + N sizes + unit
  //   - Mattress: select + code + desc + branding + size + price + unit
  //   - Other: select + code + desc + category + size + P2 + P1 + unit
  const colCount = 1 + (isSofaView
    ? 3 + sofaSizes.length + 1
    : isMattressView
      ? 6
      : 7);

  // ── Row windowing (Edit Prices legacy table) ────────────────────────────
  // Normal viewing goes through the shared DataGrid (own virtualization). The
  // Edit Prices editor keeps this hand-built <table> because DataGrid can't host
  // the inline PriceInput / BrandingInput cells. It used to mount EVERY ProductRow
  // (each with inputs) — at ~1141 SKUs, thousands at 10x, that froze the page.
  // Mirror components/DataTable.tsx: a capturing `window` scroll listener (catches
  // the .skuScroll container's non-bubbling scroll too) measures the tbody against
  // the viewport and renders only rows.slice(vStart, vEnd), bracketed by two spacer
  // <tr>s that reserve the off-screen height so the internal scrollbar + sticky
  // header behave exactly as before. Row height is measured from a real [data-vrow]
  // row so the spacers can't drift. Gated to editMode + long lists → short catalogs
  // and the existing layout stay byte-identical.
  const canVirtualize = editMode && !isLoading && !error && rows.length > VIRTUAL_ROW_THRESHOLD;
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
      const top = el.getBoundingClientRect().top; // tbody top relative to viewport
      const vh = window.innerHeight;
      const first = Math.max(0, Math.floor(-top / rh) - VIRTUAL_OVERSCAN);
      const count = Math.ceil(vh / rh) + VIRTUAL_OVERSCAN * 2;
      const last = Math.min(rows.length, first + count);
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
  }, [canVirtualize, rows.length]);
  const vStart = canVirtualize ? winRange.start : 0;
  const vEnd = canVirtualize ? Math.min(rows.length, winRange.end) : rows.length;

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
                cursor: 'pointer', color: '#767b6e',
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
        getValue: (r) => r.base_model ?? '',
        render: (r) => r.base_model ?? '—',
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
              {fmtRm(r.base_price_sen)}
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
          render: (r) => <span className={styles.catPill}>{r.category}</span>,
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
              {fmtRm(r.base_price_sen)}
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
        // 0166 — SKU barcode. Shown by default (purchaser request). Edit from
        // the SKU detail drawer (click a row) or set it when creating a SKU.
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
        render: (r) => r.status,
      },
    );
    return cols;
  }, [isSofaView, isMattressView, sofaSizes, tier]);

  const gridTableId = `products-sku-${isSofaView ? 'sofa' : isMattressView ? 'mattress' : 'default'}`;

  return (
    <>
      {/* Branding now uses a hard <select> on each Mattress row (2026-07-23
          owner rule — no free-text). The datalist that used to render here
          became dead weight the moment BrandingInput stopped being an input. */}
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
          <Button variant="secondary" onClick={() => setNewModelOpen(true)}>
            <Plus {...ICON_PROPS} />
            <span>New SKU</span>
          </Button>
          {/* PR #82 — only render the bulk Delete button when at least one row
              is ticked, so the toolbar stays compact in normal use. */}
          {!searching && selectedIds.size > 0 && (
            /* Was a secondary button tinted red via an inline --c-festive-b
               style; the design system has a first-class danger variant that
               carries the same read (err border + err text on surface). */
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
              <Button variant="secondary" onClick={exitEdit} disabled={savingEdits}>
                <X {...ICON_PROPS} />
                <span>Cancel</span>
              </Button>
              <Button variant="primary" onClick={saveEdits} disabled={savingEdits || dirtyCount === 0}>
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

      {/* PR #39 + #107 — Model filter, available on SOFA / BEDFRAME /
          MATTRESS. ACCESSORY + SERVICE skip — no base_model on those rows.
          Owner 2026-08-07 ("SKU side also ah"): the pill rail (12 inline +
          "More (N)" popover) is retired for the system-standard
          SearchableSelect — one type-to-filter control, "All models" as the
          empty pick, same idiom as the Variants tab. */}
      {supportsModelFilter && categoryModels.length > 1 && (
        <div style={{ marginTop: 'var(--space-2)', width: 300, maxWidth: '100%' }}>
          <SearchableSelect
            value={modelFilter === 'all' ? '' : modelFilter}
            onChange={(v) => setModelFilter(v || 'all')}
            options={[
              { value: '', label: `All models (${categoryModels.length})` },
              ...categoryModels.map((m) => ({ value: m, label: m })),
            ]}
            placeholder={`Search ${categoryModels.length} models…`}
            className="block w-full rounded-md border border-border bg-surface py-1.5 px-2.5 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            ariaLabel="Model filter"
          />
        </div>
      )}

      <p className={styles.eyebrow}>
        {isLoading
          ? 'Loading products…'
          : `${rows.length} products · Production configs from SKU sheet`}
      </p>

      {error && !isLoading && (
        <div className={styles.bannerErr}>
          <strong>Failed to load products.</strong>{' '}
          {error instanceof Error ? error.message : 'Something went wrong.'}
          <div style={{ marginTop: 6, fontSize: 'var(--fs-12)', color: '#767b6e' }}>
            If this keeps happening, sign out and back in — your session may
            have expired — or let IT know.
          </div>
        </div>
      )}

      {!editMode && (
        /* Batch 2: normal viewing — shared DataTable. Row CLICK — or the truck
           icon — opens the Suppliers drawer (was double-click on DataGrid;
           same Inventory-Balances convention). Selection is DataTable's
           first-class checkbox column: header select-all (indeterminate)
           replaces the old toolbar label, per-row ticks feed the same bulk
           Delete / status actions as Edit Prices mode. Page search stays the
           server-backed box above — no table search. */
        <DataTable<MfgProductRow>
          tableId={gridTableId}
          layoutFamily={gridTableId}
          exportName="sku-master"
          rows={isLoading || searching ? null : rows}
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
      )}

      {editMode && (
      <div className={styles.tableCard}>
        {/* PR — viewport-fill scroll wrapper (matches DataGrid .scroll). The
            SKU table used to leave dead space below it; now it stretches to
            near the full viewport and scrolls internally with a sticky header.
            The record footer below stays pinned to the card. */}
        <div className={styles.skuScroll}>
        <table className={`${styles.table} ${styles.tableCompact}`}>
          <thead>
            <tr>
              {/* PR #82 — leading select-all checkbox. Indeterminate when
                  partial selection on visible rows. */}
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
            {!isLoading && rows.slice(vStart, vEnd).map((row) => (
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
            {canVirtualize && vEnd < rows.length && (
              <tr aria-hidden>
                <td colSpan={colCount} style={{ height: (rows.length - vEnd) * rowHeightRef.current, padding: 0, border: 0 }} />
              </tr>
            )}
            {!isLoading && !error && rows.length === 0 && (
              <tr>
                <td colSpan={colCount} style={{ textAlign: 'center', color: '#767b6e', padding: 'var(--space-7)' }}>
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
              Record 1 of {rows.length}
            </span>
            <span className={styles.eyebrow}>{rows.length} total products</span>
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
    </>
  );
};

const ProductRow = memo(({
  row, editMode, isSofaView, isMattressView, sofaSizes, tier, onOpenSuppliers,
  selected, onToggleSelected, patch, onStage, brandingPool,
}: {
  row: MfgProductRow;
  editMode: boolean;
  isSofaView: boolean;
  isMattressView: boolean;
  sofaSizes: string[];
  tier: Tier;
  onOpenSuppliers?: (row: MfgProductRow) => void;
  /** Canonical branding pool (Project Maintenance -> Brands). Drives the
      Mattress-row Branding <select>. Owner 2026-07-23 rule: no free-text. */
  brandingPool: string[];
  /** PR #82 — multi-select state lives on SkuMasterTab; row just renders
      the checkbox + reports clicks. */
  selected:         boolean;
  onToggleSelected: (id: string) => void;
  /** Edit→Save (Commander 2026-06-15) — staged edits for THIS row (undefined =
      none yet) + the parent stager. Cells read the staged value over the stored
      one; nothing commits until the parent's Save. No more blur-auto-save. */
  patch?: ProductEditPatch;
  onStage: (id: string, patch: ProductEditPatch) => void;
}) => {
  // Effective values — a staged patch wins over the stored row while editing.
  const seatArr = patch?.seatHeightPrices ?? row.seat_height_prices ?? [];
  // Prices can be staged as null (a deliberate clear), so test key presence,
  // not nullishness, before falling back to the stored value.
  const baseSen = patch && 'basePriceSen' in patch ? patch.basePriceSen ?? null : row.base_price_sen;
  const p1Sen = patch && 'price1Sen' in patch ? patch.price1Sen ?? null : row.price1_sen;
  const brandingVal = patch?.branding ?? row.branding ?? '';

  const updateSofaCell = (size: string, newPriceSen: number | null) => {
    onStage(row.id, { seatHeightPrices: upsertHeightTier(seatArr, size, tier, newPriceSen) });
  };

  return (
    <tr
      data-vrow=""
      className={styles.rowCompact}
      onDoubleClick={() => !editMode && onOpenSuppliers?.(row)}
      title={editMode
        ? 'Click the truck icon to see suppliers (double-click is disabled in Edit Prices mode)'
        : 'Double-click row — or click the truck icon — to see suppliers for this product'}
      style={{ cursor: editMode ? 'default' : 'pointer' }}
    >
      {/* PR #82 — row checkbox. stopPropagation so clicking the box
          doesn't bubble into the double-click "open suppliers" handler. */}
      <td style={{ width: 32 }} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          aria-label={`Select ${row.code}`}
          checked={selected}
          onChange={() => onToggleSelected(row.id)}
          style={{ cursor: 'pointer' }}
        />
      </td>
      {/* PR #89 — click code chip to edit.
          PR #95 — Commander 2026-05-26: "容易不小心点到 Edit，你应该点 Edit
          Price 那边就可以进来修改了". Gate click-to-edit behind editMode so
          the chip is read-only until commander explicitly hits "Edit Prices".
          When editMode is off the cell stops bubble propagation but stays
          a plain text/chip, so accidental clicks during row drilldown can't
          drop into the input.
          PR — Commander 2026-05-28 ("双击点不进去，看得到里面的 supplier
          是谁"): add an explicit Truck icon next to the code chip that ALWAYS
          opens the Suppliers drawer (including during edit-mode where the
          row-level double-click is intentionally disabled). */}
      <td onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <button
            type="button"
            aria-label={`View suppliers for ${row.code}`}
            title="View suppliers carrying this SKU"
            onClick={() => onOpenSuppliers?.(row)}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 0,
              margin: 0,
              cursor: 'pointer',
              color: '#767b6e',
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            <Truck size={13} strokeWidth={1.75} />
          </button>
          <EditableTextCell
            value={row.code}
            chipClassName={styles.codeChip}
            ariaLabel="Edit product code"
            editable={editMode}
            onSave={(val) => onStage(row.id, { code: val })}
          />
        </span>
      </td>
      {/* PR #89 — click description to edit. Description stored in the
          `name` column on mfg_products (commander calls it "description"
          in the UI). */}
      <td onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          <EditableTextCell
            value={row.name}
            chipClassName={styles.nameCompact}
            inline
            ariaLabel="Edit description"
            editable={editMode}
            onSave={(val) => onStage(row.id, { name: val })}
          />
          {row.one_shot && (
            <span
              className={styles.catPill}
              title={row.source_doc_no ? `One-shot from ${row.source_doc_no}` : 'One-shot SKU'}
              style={{ fontSize: 'var(--fs-11)' }}
            >
              one-shot
            </span>
          )}
        </span>
        {row.description && <div className={styles.nameSubCompact}>{row.description}</div>}
      </td>
      {isSofaView ? (
        <>
          <td className={styles.numCellMuted} style={{ textAlign: 'left' }}>
            {row.base_model ?? '—'}
          </td>
          {sofaSizes.map((s) => {
            const sen = priceForHeightTier(seatArr, s, tier);
            // When user is on P1 or P3 and the cell is empty, surface the P2
            // baseline as a placeholder so they have a reference price.
            const baselineSen = tier !== 'PRICE_2'
              ? priceForHeightTier(seatArr, s, 'PRICE_2')
              : null;
            return (
              <td key={s} className={sen ? styles.price : styles.priceEmpty}>
                {editMode ? (
                  <PriceInput
                    valueSen={sen}
                    baselineSen={baselineSen}
                    onCommit={(v) => updateSofaCell(s, v)}
                  />
                ) : (
                  fmtRm(sen)
                )}
              </td>
            );
          })}
        </>
      ) : isMattressView ? (
        <>
          {/* Branding cell — editable text input in edit mode. */}
          <td>
            {editMode ? (
              <BrandingInput
                value={brandingVal}
                pool={brandingPool}
                onCommit={(v) => onStage(row.id, { branding: v })}
              />
            ) : (
              row.branding
                ? <span className={styles.catPill}>{row.branding}</span>
                : <span className={styles.priceEmpty}>—</span>
            )}
          </td>
          <td>{row.size_label ?? '—'}</td>
          {/* Single Price column for mattress — uses base_price_sen. */}
          <td className={baseSen ? styles.price : styles.priceEmpty}>
            {editMode ? (
              <PriceInput
                valueSen={baseSen}
                onCommit={(v) => onStage(row.id, { basePriceSen: v })}
              />
            ) : (
              fmtRm(row.base_price_sen)
            )}
          </td>
        </>
      ) : (
        <>
          <td><span className={styles.catPill}>{row.category}</span></td>
          <td>{row.size_label ?? '—'}</td>
          <td className={baseSen ? styles.price : styles.priceEmpty}>
            {editMode ? (
              <PriceInput
                valueSen={baseSen}
                onCommit={(v) => onStage(row.id, { basePriceSen: v })}
              />
            ) : (
              fmtRm(row.base_price_sen)
            )}
          </td>
          <td className={p1Sen ? styles.price : styles.priceEmpty}>
            {editMode ? (
              <PriceInput
                valueSen={p1Sen}
                onCommit={(v) => onStage(row.id, { price1Sen: v })}
              />
            ) : (
              fmtRm(row.price1_sen)
            )}
          </td>
        </>
      )}
      <td className={styles.numCell}>{fmtUnit(row.unit_m3_milli)}</td>
    </tr>
  );
});
ProductRow.displayName = 'ProductRow';

/* Dropdown-only branding picker for Mattress rows. Commits on change.
   Owner 2026-07-23: "根据我们维护那边 dropdown 去做选择的那一个" — no more
   free-text entry. New brand names have to be added centrally in Project
   Maintenance -> Brands (which then flows into `useBrandingPool()` and
   surfaces here on the next fetch). A stored value that isn't in the current
   pool (legacy) still renders as a selectable option so the row remains
   editable while the operator picks a proper canonical brand. */
const BrandingInput = ({
  value,
  pool,
  onCommit,
}: {
  value: string;
  pool: string[];
  onCommit: (v: string | null) => void;
}) => {
  const current = value.trim();
  const inPool = current && pool.some((b) => b.toUpperCase() === current.toUpperCase());
  const options = useMemo(() => {
    const sorted = [...pool].sort((a, b) => a.localeCompare(b));
    return current && !inPool ? [current, ...sorted] : sorted;
  }, [pool, current, inPool]);
  return (
    <select
      value={current}
      onChange={(e) => {
        const v = e.target.value.trim();
        if (v === current) return;
        onCommit(v.length ? v : null);
      }}
      title={inPool || !current
        ? undefined
        : `"${current}" is not in the current branding pool. Add it in Project Maintenance -> Brands.`}
      style={{
        width: 160,
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--fs-13)',
        background: inPool || !current ? '#f4f6f3' : '#fef3c7',
        border: `1px solid ${inPool || !current ? '#16695f' : '#b45309'}`,
        borderRadius: 'var(--radius-sm)',
        padding: '3px 8px',
        outline: 'none',
      }}
    >
      <option value="">—</option>
      {options.map((b) => (
        <option key={b} value={b}>
          {b}{current && !inPool && b === current ? ' (legacy)' : ''}
        </option>
      ))}
    </select>
  );
};

/* Compact RM input — accepts blank (= clear). Commits on blur or Enter. */
const PriceInput = ({
  valueSen,
  onCommit,
  baselineSen,
}: {
  valueSen: number | null;
  onCommit: (v: number | null) => void;
  /** P2-tier baseline to surface as placeholder when P1/P3 cell is empty —
      shows what the default price would be so user knows the reference. */
  baselineSen?: number | null;
}) => {
  const [local, setLocal] = useState<string>(
    valueSen == null ? '' : (valueSen / 100).toFixed(2),
  );

  const commit = () => {
    const trimmed = local.trim();
    if (trimmed === '') {
      onCommit(null);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return;
    onCommit(Math.round(parsed * 100));
  };

  const placeholder = baselineSen && baselineSen > 0
    ? `P2: ${(baselineSen / 100).toFixed(2)}`
    : undefined;

  return (
    <input
      type="number"
      step="0.01"
      value={local}
      placeholder={placeholder}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      style={{
        width: 84,
        textAlign: 'right',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--fs-13)',
        background: '#f4f6f3',
        border: '1px solid #16695f',
        borderRadius: 'var(--radius-sm)',
        padding: '3px 6px',
        outline: 'none',
      }}
    />
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
  /* Reskin: was an inline-styled ink/paper pill. Now the design-system
     filter pill — active fills petrol (same emphasis colour as the tab rail
     and selected rows) instead of ink-black. */
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


/* ════════════════════════════════════════════════════════════════════════
   Maintenance tab
   ════════════════════════════════════════════════════════════════════════ */

type MaintenanceListKey =
  | 'bedframeSizes'    // PR #50 — Bedframe size pool (K/Q/S/SS/SK/SP)
  | 'divanHeights'
  | 'totalHeights'
  | 'gaps'
  | 'legHeights'
  | 'specials'
  | 'sofaCompartments' // PR #50 — Sofa compartment pool (1A(LHF), 1A(RHF), 1NA, ...)
  | 'sofaSizes'
  | 'sofaLegHeights'
  | 'sofaSpecials'
  | 'sofaQuickPresets' // PR (Commander 2026-05-28) — module-composition presets
  | 'mattressSizes'    // PR #50 — Mattress size pool (K/Q/S/SS)
  | 'brandings'        // Branding pool (HILTON/SEALY/2990S/...) — feeds Branding datalists
  | 'supplierCategories' // Supply Category pool — feeds Suppliers list chips + supplier form toggles
  | 'fabrics';

// PR #208 — exported so SupplierDetail can pass a `sectionFilter` prop to
// the reused MaintenanceTab.
export type MaintenanceSection = 'Bedframe' | 'Sofa' | 'Common' | 'Products Maintenance';

const MAINTENANCE_TABS: {
  key: MaintenanceListKey;
  label: string;
  description: string;
  priced: boolean;
  section: MaintenanceSection;
}[] = [
  // ── Bedframe (commander-edited variant pools) ───────────────────────────
  { key: 'divanHeights', label: 'Divan Heights', description: 'Bedframe divan height options with surcharge pricing', priced: true, section: 'Bedframe' },
  { key: 'totalHeights', label: 'Total Heights', description: 'Total height (Divan + Gap + Leg) surcharge pricing', priced: true, section: 'Bedframe' },
  { key: 'gaps', label: 'Gaps', description: 'Bedframe gap height options (inches)', priced: false, section: 'Bedframe' },
  { key: 'legHeights', label: 'Leg Heights', description: 'Bedframe leg height options with surcharge pricing', priced: true, section: 'Bedframe' },
  // Specials re-surfaced here (Commander 2026-06-16) — edits the SAME special_addons
  // data as the Special Add-ons tab, filtered to BEDFRAME (selling-price options).
  { key: 'specials', label: 'Specials', description: 'Bedframe special add-ons — selling-price options (shared with POS).', priced: true, section: 'Bedframe' },

  // ── Sofa (commander-edited variant pools) ───────────────────────────────
  { key: 'sofaSizes', label: 'Sizes', description: 'Available sofa seat height sizes (inches)', priced: false, section: 'Sofa' },
  { key: 'sofaLegHeights', label: 'Leg Heights', description: 'Sofa leg height options with surcharge pricing', priced: true, section: 'Sofa' },
  // Sofa Specials — same special_addons data, filtered to SOFA (Commander 2026-06-16).
  { key: 'sofaSpecials', label: 'Specials', description: 'Sofa special add-ons — selling-price options (shared with POS).', priced: true, section: 'Sofa' },
  // Quick Presets editor entry retired (Chairman 2026-06-02) — removed from the
  // Maintenance rail in both apps. The sofaQuickPresets DATA + the shared
  // DEFAULT_SOFA_QUICK_PRESETS fallback are kept (Sofa Combos reference preset
  // ids; POS Quick Pick reads sofa_quick_picks, a different table).

  // ── Common (cross-category single pool) ─────────────────────────────────
  { key: 'fabrics', label: 'Fabrics', description: 'Fabric price tier assignment — drives Price 1 / Price 2', priced: false, section: 'Common' },

  // ── Products Maintenance (cross-category, drives Model "+ Add Codes") ──
  // PR #74 (Commander 2026-05-26): bedframeSizes / mattressSizes / sofaCompartments
  // live here because they're shared by multiple Models and back the bulk
  // SKU generator — they're conceptually "Products Maintenance" rather than
  // per-category variant config.
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
  // BRANDING pool — `distinct` (DISTINCT branding across mfg_products +
  // product_models) is the read-only suggestion shown when the pool is empty
  // AND the one-click seed for the Edit draft (see startEdit). The pool
  // itself never gets written without an explicit Save.
  const brandingPool = useBrandingPool();
  // Specials (Commander 2026-06-16) — re-surfaced in Maintenance editing the
  // shared special_addons; used for the rail count + the embedded editor.
  const specialAddonsList = useSpecialAddons();

  // PR #208 — when the supplier scope has no row yet, fall through to the
  // master config so commander can see what's there before deciding to
  // override. Save still writes back to the prop scope, never to master —
  // the fallback never silently mutates the global config.
  // Hoisted so the loading gate below can tell "the fallback is still coming"
  // apart from "there is genuinely no config" — see the gate for why.
  const wantMasterFallback =
    scope !== 'master' && !resolved.data?.data && !resolved.isLoading;
  const masterFallback = useMaintenanceConfig('master', {
    enabled: wantMasterFallback,
  });

  // PR #208 — sectionFilter restricts which sections show on the left rail.
  // BEDFRAME-only supplier hides Sofa sub-tabs entirely so commander only
  // edits surcharges that actually apply to what this supplier supplies.
  const allSections: MaintenanceSection[] = ['Bedframe', 'Sofa', 'Common', 'Products Maintenance'];
  const sections: MaintenanceSection[] = sectionFilter ?? allSections;
  const visibleTabs = useMemo(
    () => MAINTENANCE_TABS.filter((t) =>
      sections.includes(t.section)
      // Specials edit GLOBAL special_addons (selling price) — show only on the
      // master Products page, never the per-supplier (cost-overlay) Maintenance.
      && !((t.key === 'specials' || t.key === 'sofaSpecials') && scope !== 'master')),
    [sections, scope],
  );

  // First visible tab — the section filter may have hidden 'divanHeights'.
  const defaultActiveKey: MaintenanceListKey = visibleTabs[0]?.key ?? 'divanHeights';

  const [activeKey, setActiveKey] = useState<MaintenanceListKey>(defaultActiveKey);

  // Keep activeKey valid when the section filter changes (e.g. supplier
  // category switched). Pin to the first visible tab if the current one
  // got filtered out.
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

  // Count fabric_trackings rows for the left-rail "Fabrics (N)" badge.
  // Lightweight query (cached 30s) — uses the same hook as the panel itself.
  // Retired rows are excluded so the badge counts fabrics you can still use.
  // Before this it read 827 while 88 of those were supersede tombstones.
  const fabricsList = useFabricTrackings({ includeRetired: false });
  const fabricsCount = fabricsList.data?.length ?? 0;

  // PR #208 — draft beats supplier-scope-resolved beats master-fallback.
  // Any of those three can be null (commander hasn't seeded yet).
  const config =
    draft ?? resolved.data?.data ?? masterFallback.data?.data ?? null;
  const active = MAINTENANCE_TABS.find((t) => t.key === activeKey) ?? visibleTabs[0];
  // Specials panel (Commander 2026-06-16) — renders the special_addons editor
  // filtered to this category instead of the config-pool editor; the config
  // Edit/Save/History chrome is hidden (special_addons has its own inline CRUD).
  const isSpecials = active?.key === 'specials' || active?.key === 'sofaSpecials';
  const specialsCat = active?.key === 'sofaSpecials' ? 'SOFA' : 'BEDFRAME';
  // Brandings (Houzs re-sourcing) — branding is maintained CENTRALLY in
  // Project Maintenance (PMS, project_brands via /api/projects/brands). This
  // tab is READ-ONLY, mirroring the SO Maintenance "Venues" list: it shows the
  // PMS brand pool the SCM Branding inputs resolve against, and points editors
  // at Project Maintenance for add / rename / deactivate. No config draft/Save.
  const isBrandings = active?.key === 'brandings';

  const startEdit = () => {
    // Seed the draft from whichever config we're currently showing — could
    // be the supplier-scope row or the master fallback. Either way commander
    // edits a copy; save writes back to `scope`.
    const seed = resolved.data?.data ?? masterFallback.data?.data ?? null;
    if (!seed) return;
    const copy = JSON.parse(JSON.stringify(seed)) as MaintenanceConfig;
    // Brandings one-click seed: when the master pool is empty, pre-fill the
    // EDIT DRAFT from the distinct branding values across products + models so
    // a single Save adopts them. Editor-only — config is never written until
    // commander explicitly Saves. Master scope only (supplier scopes are
    // surcharge overlays, never the branding authority).
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
    // Maintenance-is-master cascade (Loo 2026-06-04: "what maintenance change
    // all will follow"). Detect in-place compartment code RENAMES (same row,
    // new text, old code gone from the list, new code not previously there)
    // and run the atomic cascade BEFORE appending the new config row, so the
    // SKU master, every doc snapshot, Modular ticks, combos and quick picks
    // all carry the new name the moment the save lands. Master scope only —
    // supplier scopes are surcharge overlays, never the code authority.
    if (scope === 'master') {
      // ACTIVE toggles — entries may be { value, active } objects now; the
      // rename cascade compares VALUES only (an active flip is not a rename).
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
        const summary = renames.map((r) => `${r.from} → ${r.to}`).join('\n');
        const ok = await askConfirm({
          title: `Rename compartment code${renames.length > 1 ? 's' : ''}?`,
          body: `${summary}\n\n` +
            `This cascades EVERYWHERE: SKU codes + names, sales orders (incl. history), ` +
            `delivery orders, invoices, GRN/PO lines, Modular ticks, Combos and Quick Picks.`,
          confirmLabel: 'Rename',
          danger: true,
        });
        if (!ok) return;
        for (const r of renames) {
          try {
            await renameCompartment.mutateAsync(r);
          } catch (e) {
            notify({
              title: `Rename ${r.from} → ${r.to} failed`,
              body: `${e instanceof Error ? e.message : 'Something went wrong.'}\nNothing was partially renamed for this pair; fix and retry.`,
              tone: 'error',
            });
            return;
          }
        }
      }
    }
    // PR #208 — write back to the same scope this tab was mounted with.
    // Supplier scope (e.g. 'supplier:abc-123') gets its own append-only row;
    // master scope is unchanged for the SO / selling-price flow.
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

  // The master fallback is a DEPENDENT query: it can only be enabled once
  // `resolved` has settled with no row. On that first settled render it is
  // enabled but has not fetched yet, so its data is undefined — and since
  // isLoading is (isPending && isFetching) it reports FALSE, not true. Gating on
  // `resolved` alone therefore let that frame fall through to the `!config`
  // branch and paint "No maintenance config baseline found" before the fallback
  // had run, then swap to the real config a moment later — the "error first,
  // then it loads" the owner reported on Supplier > Maintenance. Hold the
  // loading state while the fallback is genuinely still coming. Guarding
  // isPending behind wantMasterFallback matters: isPending is also true while a
  // query is DISABLED, so an unguarded check would hang this spinner forever on
  // the master scope, where the fallback is permanently disabled.
  if (resolved.isLoading || (wantMasterFallback && masterFallback.isPending)) {
    return <p className={styles.eyebrow}>Loading maintenance config…</p>;
  }

  if (resolved.isError) {
    return (
      <div className={styles.bannerErr}>
        <strong>Failed to load maintenance config.</strong>{' '}
        {resolved.error instanceof Error ? resolved.error.message : String(resolved.error)}
        <div style={{ marginTop: 6, fontSize: 'var(--fs-12)', color: '#767b6e' }}>
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

  // active falls through to the first visible tab when the section filter
  // hides the previously-active key. Should never be null when config is set,
  // but guard anyway.
  if (!active) {
    return (
      <div className={styles.bannerWarn}>
        No maintenance sections visible for this scope.
      </div>
    );
  }

  // PR #208 — show "using fallback" hint when the supplier scope is empty
  // but the master fallback is rendering. Encourages commander to hit Edit
  // → Save which seeds this supplier's own row.
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
                  // Brandings come from PMS (project_brands), not the config blob.
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
                  <span className={styles.maintCount}>({count})</span>
                </button>
              );
            })}
          </div>
        ))}
      </aside>

      <section className={styles.maintPanel}>
        {isSpecials ? (
          /* Specials = the scm.special_addons TABLE, but now with TRUE Edit ->
             Save(effective-date) + History matching the other pools (owner
             2026-06-22). The panel owns its own header chrome + effective-dated
             snapshot Save; SO costing still reads the live special_addons table. */
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
                  <span style={{ color: '#0c3f39', fontWeight: 600 }}>
                    · Pending change on {resolved.data.pendingEffectiveFrom}
                  </span>
                )}
              </p>
            )}
            {!isBrandings && showingMasterFallback && (
              <p className={styles.stateInfo} style={{ marginTop: 8, color: '#0c3f39' }}>
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
          /* Brandings are maintained CENTRALLY in Project Maintenance (PMS,
             project_brands). Read-only here — mirrors the SO Maintenance
             "Venues" list. (Houzs re-sourcing) */
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
  if (key === 'fabrics') return 0; // populated from fabric_trackings, not the JSON blob
  // Quick Presets falls back to DEFAULT_SOFA_QUICK_PRESETS when the
  // maintenance row hasn't been migrated yet — show the resolved count
  // so the left-rail badge isn't misleadingly "0".
  if (key === 'sofaQuickPresets') {
    return resolveSofaQuickPresets(cfg.sofaQuickPresets).length;
  }
  // PR #74 — Code Format tabs removed (Commander 2026-05-26: preset only,
  // not commander-editable). The cfg.{category}CodeFormat / NameFormat
  // columns still exist on the JSONB blob but no longer surface in the UI;
  // the API falls back to its hardcoded templates when those fields are
  // empty (see apps/api/src/routes/product-models.ts §generate).
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
  defaultPriceCenti?: number;
};

// Canonicalize any compartment input to the parens form (mirror of the
// shared normalizeCompartmentCode — kept local so this page stays light).
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
  // ── 1-Seaters ──────────────────────────────────────────────────────
  '1S':     '1 seat, arms on BOTH sides',
  '1A(LHF)': '1 seat, ONE arm (left)',
  '1A(RHF)': '1 seat, ONE arm (right)',
  '1B(LHF)': '1 seat — LEFT is Seat Cushion (bench), no arm on the right',
  '1B(RHF)': '1 seat — RIGHT is Seat Cushion (bench), no arm on the left',
  '1NA':    '1 seat, NO arms',

  // ── 1-Seater Recliners ────────────────────────────────────────────
  // (P) = Power Recliner (electric) · (R) = Manual Recliner
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

  // ── 2-Seaters ──────────────────────────────────────────────────────
  '2S':     '2 seats, arms on BOTH sides',
  '2A(LHF)': '2 seats, ONE arm (left)',
  '2A(RHF)': '2 seats, ONE arm (right)',
  '2B(LHF)': '2 seats — LEFT is Seat Cushion (bench), no arm on the right',
  '2B(RHF)': '2 seats — RIGHT is Seat Cushion (bench), no arm on the left',
  '2NA':    '2 seats, NO arms',

  // ── Corner + Accessories ──────────────────────────────────────────
  CNR:     'Corner piece — 90° L-shape connector',
  'WC-45': 'Console (Wood, 45cm) — divider/storage between two seats',
  STOOL:   'Ottoman / stool',
};

// Extra modules NOT in SOFA_MODULES (the Console/WC alias the shared lib
// doesn't model directly). Hand-mapped here so the Maintenance UI gets
// full coverage. Keys are the CANONICAL code (parens form); the value is
// the SVG filename stem under apps/backend/public/sofa-modules/.
const EXTRA_MODULE_IMAGE_BY_NORM: Record<string, string> = {
  // Console = fabric-wrapped (no wood lid). Console/WC = wood lid + fabric body.
  // Commander 2026-05-28 split the original "Console" into 2 codes — the
  // existing SVG (wood lid + fabric) reads as wood at a glance, so it moves
  // to Console-WC; a new fabric-only design lives at Console.
  Console:       'Console',
  // Legacy dash input 'Console-WC' canonicalizes to 'Console(WC)'.
  'Console(WC)': 'Console-WC',
  // normalizeCompartmentCode doesn't touch '/' so commander's raw "Console/WC"
  // input falls through to this key directly (not via canonicalization).
  'Console/WC':  'Console-WC',
};

// Resolve the seeded default for one compartment code. UI surfaces this
// when the stored meta has no value of its own — commander overrides
// land in sofaCompartmentMeta on Save.
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
      // SOFA_MODULES carries no base price — POS reads pricing from
      // product_compartments per Model. Default to 0 here; commander can
      // type the back-office default into the input.
      defaultPriceCenti: 0,
    };
  }
  // Fallback for codes NOT in SOFA_MODULES (the Console/WC alias). These
  // have bespoke SVGs hand-drawn to the same style.
  const extraStem = EXTRA_MODULE_IMAGE_BY_NORM[code.trim()] ?? EXTRA_MODULE_IMAGE_BY_NORM[norm];
  if (extraStem) {
    const desc =
      COMPARTMENT_DESCRIPTION_OVERRIDE[code] ??
      COMPARTMENT_DESCRIPTION_OVERRIDE[norm] ??
      undefined;
    return {
      imageKey:    `sofa-modules/${extraStem}.svg`,
      description: desc,
      defaultPriceCenti: 0,
    };
  }
  return {};
};

// Merge stored override on top of the seed. Empty/undefined fields on
// the override fall back to the seed value.
const resolveCompartmentMeta = (
  code: string,
  stored: CompartmentMeta | undefined,
): CompartmentMeta => {
  const seed = seedCompartmentMeta(code);
  return {
    imageKey:          stored?.imageKey          ?? seed.imageKey,
    description:       stored?.description       ?? seed.description,
    defaultPriceCenti: stored?.defaultPriceCenti ?? seed.defaultPriceCenti,
  };
};

const formatRmFromCenti = (centi: number | undefined): string => {
  const n = centi ?? 0;
  return (n / 100).toFixed(2);
};

const parseRmToCenti = (rm: string): number => {
  const n = Number(rm);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
};

/* PR — Commander 2026-05-28: resolve the per-compartment image source.
 * Three cases:
 *   1) imageKey starts with `sofa-compartments/` — uploaded via the API.
 *      Render via the Worker proxy (`{API}/maintenance-config/sofa-compartments/{code}/photo/{key}`)
 *      so the auth-free public route streams the R2 object.
 *   2) imageKey starts with `sofa-modules/` — legacy bundled SVG, render
 *      from /public.
 *   3) imageKey is an http(s) URL — render directly. */
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
  // Legacy bundled SVG / PNG from /public.
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
  /* PR — Commander 2026-05-28: per-row photo upload + delete. Always
   * available (not gated by edit mode) because the API writes the imageKey
   * directly to maintenance_config_history without going through the draft
   * → save cycle. uploadingCode tracks which row is mid-upload so we can
   * show a "saving…" hint on the right thumbnail. */
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
    // Migrate the meta key alongside the code rename so the override
    // doesn't get orphaned. If the new code already has meta, leave it.
    if (old && old !== newVal) {
      const m = next.sofaCompartmentMeta ?? {};
      if (m[old] && !m[newVal]) {
        m[newVal] = m[old]!;
        delete m[old];
        next.sofaCompartmentMeta = m;
      }
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
              gridTemplateColumns: '32px 32px 56px 1fr auto auto auto',
              gap: 'var(--space-3)',
              alignItems: 'center',
              opacity: entryIsActive ? 1 : 0.55,
            }}
          >
            <button type="button" className={styles.maintRowIcon} title="History">
              <History {...ICON_PROPS} />
            </button>
            <span className={styles.maintRowIdx} style={editMode ? { cursor: 'grab' } : undefined}>
              {i + 1}
            </span>
            {/* 48px thumbnail — click to upload, × to delete (when uploaded).
                Uploads land in maintenance_config_history.config.sofaCompartmentMeta
                via the Worker (no draft/save cycle — direct mutation). The
                legacy bundled SVGs (imageKey starts with `sofa-modules/`) are
                not deletable since they're shipped in /public; commander
                replaces them by uploading a new R2 photo, which the resolver
                prefers automatically. */}
            {(() => {
              const isUploaded = (resolved.imageKey ?? '').startsWith(SOFA_COMPARTMENT_API_PREFIX);
              const isUploading = uploadingCode === code;
              const src = resolveCompartmentImageSrc(code, resolved.imageKey);
              return (
                <div
                  style={{
                    width: 48,
                    height: 48,
                    background: hasImage ? '#fff' : '#EFEAE0',
                    border: '1px solid #d6d9d2',
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
                    // Right-click on an uploaded photo = delete (matches
                    // commander's "Right-click or × → delete" spec).
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
                      <span style={{ fontSize: 'var(--fs-10)', color: '#767b6e' }}>+ photo</span>
                    )}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/svg+xml"
                      style={{ display: 'none' }}
                      disabled={isUploading}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        // Reset the input so re-selecting the same file fires onChange.
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
                        background: '#B8331F',
                        color: 'white',
                        border: '1px solid #fff',
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
            {/* Code + description column */}
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
                      background: '#f4f6f3',
                      border: '1px solid #16695f',
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
                      background: '#f4f6f3',
                      border: '1px solid #c2c6bd',
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
                      color: '#11140f',
                    }}
                  >
                    {code}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--font-sans)',
                      fontSize: 'var(--fs-13)',
                      color: resolved.description ? '#9aa093' : '#767b6e',
                    }}
                  >
                    {resolved.description ?? '(no design — leave blank)'}
                  </span>
                </>
              )}
            </div>
            {/* Default price column (RM, edits in centi) */}
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
                  value={formatRmFromCenti(stored?.defaultPriceCenti ?? resolved.defaultPriceCenti)}
                  onChange={(e) => writeMeta(code, { defaultPriceCenti: parseRmToCenti(e.target.value) })}
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--fs-14)',
                    background: '#f4f6f3',
                    border: '1px solid #c2c6bd',
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
                    (resolved.defaultPriceCenti ?? 0) === 0 ? styles.maintRowPriceMuted : ''
                  }`}
                  style={{ minWidth: 0 }}
                >
                  {formatRmFromCenti(resolved.defaultPriceCenti)}
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
                color: '#9aa093', cursor: 'pointer',
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
                color: entryIsActive ? '#1a7a3a' : '#767b6e',
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
                style={{ color: '#B8331F' }}
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
            background: '#fff',
            borderColor: '#16695f',
            gridTemplateColumns: '32px 32px 1fr auto',
          }}
        >
          <span className={styles.maintRowIcon}><Plus {...ICON_PROPS} /></span>
          <span className={styles.maintRowIdx}>+</span>
          <input
            type="text"
            placeholder="New compartment code (e.g. 1A(LHF))"
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addItem(); }}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-14)',
              background: '#f4f6f3',
              border: '1px solid #d6d9d2',
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

/* ─── Sofa Quick Presets — module-composition shortcuts (Commander 2026-05-28)
 *
 * Each row: drag handle · label input · modules chip-selector · default tier
 * dropdown · active toggle · delete. The modules chip pool reads from
 * config.sofaCompartments (the master list of compartment codes), so when
 * commander adds a new compartment it becomes available as a preset option
 * automatically. Clicking a chip in the picker toggles membership; selected
 * chips appear in order at the top of the row.
 *
 * Display semantics: the list shown here is the override array as-stored.
 * If the user hasn't seeded anything yet, we surface the DEFAULT_SOFA_QUICK_PRESETS
 * (read-only, watermark style) so commander knows what the historical defaults
 * look like — but the first edit lifts them into the real editable list. */
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
  /* When the override is absent, surface the defaults as the working list so
     commander can edit them inline. Save persists whatever's in the array. */
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
    /* Seed a blank row; commander fills in id/label/modules. The id default
       picks the next "P<N>" so two consecutive adds don't collide. */
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
          {/* id input — stable key referenced by combo rules */}
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
                background: '#f4f6f3',
                border: '1px solid #16695f',
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
              color: '#9aa093',
            }}>
              {p.id}
            </span>
          )}
          {/* label + modules — stack vertically inside the flexible main column */}
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
                  background: '#f4f6f3',
                  border: '1px solid #16695f',
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
                color: '#11140f',
              }}>
                {p.label}
              </span>
            )}
            {/* modules chip rail — selected on top, available below in edit mode */}
            <div style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-11)',
              color: '#9aa093',
            }}>
              {p.modules.length === 0 ? (
                <span style={{ color: '#767b6e', fontStyle: 'italic' }}>
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
                background: '#fff',
                border: '1px dashed #d6d9d2',
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
                        background: on ? '#16695f' : '#fff',
                        color: on ? '#fff' : '#11140f',
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
          {/* default tier select */}
          {editMode ? (
            <select
              value={p.defaultTier ?? ''}
              onChange={(e) => updateAt(i, { defaultTier: (e.target.value || undefined) as SofaPriceTier | undefined })}
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--fs-12)',
                background: '#f4f6f3',
                border: '1px solid #c2c6bd',
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
            </select>
          ) : (
            <span style={{
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-11)',
              color: '#9aa093',
            }}>
              {p.defaultTier ?? '—'}
            </span>
          )}
          {/* active toggle */}
          {editMode ? (
            <label style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-11)',
              color: '#9aa093', cursor: 'pointer',
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
              color: p.active === false ? '#767b6e' : '#1a7a3a',
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
              style={{ color: '#B8331F' }}
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
            background: '#fff',
            borderColor: '#16695f',
            gridTemplateColumns: '32px 32px 1fr auto',
          }}
        >
          <span className={styles.maintRowIcon}><Plus {...ICON_PROPS} /></span>
          <span className={styles.maintRowIdx}>+</span>
          <span style={{
            fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)',
            color: '#9aa093',
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

/* ─── Brandings — read-only PMS pool ───────────────────────────────────
   Houzs re-sourcing: branding is maintained centrally in Project
   Maintenance (PMS, project_brands via /api/projects/brands?full=1). This
   panel shows that pool read-only — the SCM Branding inputs (New SKU, bulk
   New Models, SKU Master inline edit, Model detail) all resolve against it.
   Mirrors the SO Maintenance "Venues" read-only list. Active brands only,
   matching what the Branding datalists offer (useBrandingPool). */
const BrandingsReadOnlyPanel = () => {
  // Resolve the SAME branding pool the SCM Branding inputs use, so the display
  // matches what those inputs actually offer. Under HOUZS that is the PMS
  // project_brands pool; under 2990 the PMS pool is empty (PMS is Houzs-only
  // and project_brands is now company-scoped), so this falls back to the
  // DISTINCT brandings on 2990's OWN products/models instead of showing the
  // other company's brands (or a blank list).
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
  /** DISTINCT branding values across products + models — rendered as a
      read-only suggestion list when the Brandings pool is empty. */
  brandingSuggestions?: string[];
}) => {
  // Empty draft state for the "add new" row at the bottom of the list when
  // edit mode is on. Kept local so toggling tabs cancels in-flight adds.
  const [draftValue, setDraftValue] = useState('');
  /* PR (Commander 2026-06-22) — Bedframe/Mattress size ADD row now carries
     the full triple (code · label · dimensions), mirroring the inline-edit
     block. These two drafts feed sizeLabels on add for size pools; unused
     by every other string pool (single-input add stays as-is). */
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
  /* Per-row props factory — returns the draggable handlers + visual hint.
     Only active in edit mode; otherwise rows are static. */
  const dragRowProps = (i: number): HTMLAttributes<HTMLDivElement> => {
    if (!editMode) return {};
    return {
      draggable: true,
      onDragStart: (e) => {
        setDragIdx(i);
        e.dataTransfer.effectAllowed = 'move';
        // Firefox requires data to start a drag
        try { e.dataTransfer.setData('text/plain', String(i)); } catch { /* noop */ }
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

  // PR #74 — Code Format tab removed (Commander 2026-05-26: preset only).
  // The CodeFormatPanel component is kept in the file dead-code below in
  // case we ever want to re-expose it; the API's hardcoded templates take
  // over when the cfg.{category}CodeFormat / NameFormat fields are blank.

  // ── String[] tabs (gaps, sofaSizes, + PR #50 pool keys) ──────────────
  // Defaulting to [] avoids the "Cannot read properties of undefined
  // (reading 'map')" crash when an older maintenance_config row doesn't
  // carry the new pool keys yet. Editing then saving will materialise the
  // key in the JSONB blob.
  // PR #220 (Commander 2026-05-27) — Sofa Compartments gets its own renderer
  // with image preview + description + default price, ported from the POS
  // module catalogue (SOFA_MODULES). Falls through to the generic string[]
  // branch below for every other pool key.
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

    // Brandings seed/fallback: pool empty → surface the DISTINCT branding
    // values across mfg_products + product_models as a read-only suggestion.
    // Hitting Edit seeds these into the draft (see MaintenanceTab.startEdit)
    // so one Save adopts them — nothing is silently written to config.
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
      // Same defaulting story — the new pool keys (PR #50) may not exist on
      // old maintenance_config rows yet.
      const arr = (next[listKey] as MaintPoolEntry[] | undefined) ?? [];
      arr.push(v);
      (next as Record<string, unknown>)[listKey] = arr;
      // PR (Commander 2026-06-22) — for bedframe/mattress size pools the ADD
      // row also captures label + dimensions. Mirror updateLabel: write into
      // sizeLabels keyed by code, storing only non-empty fields so untouched
      // configs stay byte-identical on save.
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

    /* PR #40 — Commander 2026-05-26: existing rows must be editable, not
       just deletable. The string[] flow (gaps / sofaSizes) was missing
       inline edit — added below. */
    const updateAt = (idx: number, newVal: string) => {
      const next = JSON.parse(JSON.stringify(config)) as MaintenanceConfig;
      const arr = (next[listKey] as MaintPoolEntry[] | undefined) ?? [];
      if (arr[idx] != null) arr[idx] = maintEntryWithValue(arr[idx]!, newVal);
      (next as Record<string, unknown>)[listKey] = arr;
      onChange(next);
    };

    /* ACTIVE toggle — re-activating collapses the entry back to the plain
       string so untouched configs stay byte-identical on Save. */
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
                <span style={{ fontSize: 'var(--fs-11)', color: '#767b6e', fontWeight: 600 }}>
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
              gridTemplateColumns: '32px 32px 1fr auto auto',
              opacity: entryIsActive ? 1 : 0.55,
            }}
          >
            <button type="button" className={styles.maintRowIcon} title="History">
              <History {...ICON_PROPS} />
            </button>
            <span className={styles.maintRowIdx} style={editMode ? { cursor: 'grab' } : undefined}>{i + 1}</span>
            <span className={styles.maintRowValue}>
              {editMode ? (
                isSizeRow ? (
                  // PR #92 — Inline 3-input editor (code · label · dimensions)
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      type="text"
                      value={v}
                      onChange={(e) => updateAt(i, e.target.value)}
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 'var(--fs-14)',
                        fontWeight: 600,
                        background: '#f4f6f3',
                        border: '1px solid #16695f',
                        borderRadius: 'var(--radius-sm)',
                        padding: '4px 8px',
                        outline: 'none',
                        width: 80,
                      }}
                      title="Size code (e.g. K)"
                    />
                    <span style={{ color: '#767b6e', fontWeight: 700 }}>·</span>
                    <input
                      type="text"
                      placeholder="Label e.g. 6FT"
                      value={labelOv?.label ?? resolved?.label ?? ''}
                      onChange={(e) => updateLabel(v, 'label', e.target.value)}
                      style={{
                        fontFamily: 'var(--font-sans)',
                        fontSize: 'var(--fs-14)',
                        background: '#f4f6f3',
                        border: '1px solid #c2c6bd',
                        borderRadius: 'var(--radius-sm)',
                        padding: '4px 8px',
                        outline: 'none',
                        width: 110,
                      }}
                    />
                    <span style={{ color: '#767b6e', fontWeight: 700 }}>·</span>
                    <input
                      type="text"
                      placeholder="Dimensions e.g. 183X190CM"
                      value={labelOv?.dimensions ?? resolved?.dim ?? ''}
                      onChange={(e) => updateLabel(v, 'dimensions', e.target.value)}
                      style={{
                        fontFamily: 'var(--font-sans)',
                        fontSize: 'var(--fs-14)',
                        background: '#f4f6f3',
                        border: '1px solid #c2c6bd',
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
                      background: '#f4f6f3',
                      border: '1px solid #16695f',
                      borderRadius: 'var(--radius-sm)',
                      padding: '4px 8px',
                      outline: 'none',
                      width: '100%',
                      maxWidth: 280,
                    }}
                  />
                )
              ) : (
                /* PR #77 — enrich bedframe/mattress size codes with their
                   imperial label + cm dimensions so the bare "K" row reads
                   as "K · 6FT · 183x190CM". String stored unchanged — only
                   display is enriched. Other list types (gaps, sofa
                   compartments, sofa seat sizes) fall back to raw value.
                   PR #92 — display path now consults sizeLabels override. */
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
                color: '#9aa093', cursor: 'pointer',
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
                color: entryIsActive ? '#1a7a3a' : '#767b6e',
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
                style={{ color: '#B8331F' }}
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
              background: '#fff',
              borderColor: '#16695f',
              gridTemplateColumns: '32px 32px 1fr auto',
            }}
          >
            <span className={styles.maintRowIcon}><Plus {...ICON_PROPS} /></span>
            <span className={styles.maintRowIdx}>+</span>
            {isSizeRow ? (
              /* PR (Commander 2026-06-22) — Bedframe/Mattress ADD row mirrors
                 the inline 3-input editor (code · label · dimensions) so a new
                 size can be created complete in one go, not just the bare code.
                 Writes both the pool array and sizeLabels via addItem. */
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
                    background: '#f4f6f3',
                    border: '1px solid #16695f',
                    borderRadius: 'var(--radius-sm)',
                    padding: '4px 8px',
                    outline: 'none',
                    width: 80,
                  }}
                  title="Size code (e.g. K)"
                />
                <span style={{ color: '#767b6e', fontWeight: 700 }}>·</span>
                <input
                  type="text"
                  placeholder="Label e.g. 6FT"
                  value={draftLabel}
                  onChange={(e) => setDraftLabel(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addItem(); }}
                  style={{
                    fontFamily: 'var(--font-sans)',
                    fontSize: 'var(--fs-14)',
                    background: '#f4f6f3',
                    border: '1px solid #c2c6bd',
                    borderRadius: 'var(--radius-sm)',
                    padding: '4px 8px',
                    outline: 'none',
                    width: 110,
                  }}
                />
                <span style={{ color: '#767b6e', fontWeight: 700 }}>·</span>
                <input
                  type="text"
                  placeholder="Dimensions e.g. 183X190CM"
                  value={draftDim}
                  onChange={(e) => setDraftDim(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addItem(); }}
                  style={{
                    fontFamily: 'var(--font-sans)',
                    fontSize: 'var(--fs-14)',
                    background: '#f4f6f3',
                    border: '1px solid #c2c6bd',
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
                  background: '#f4f6f3',
                  border: '1px solid #d6d9d2',
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

  // ── PricedOption[] tabs (the rest) ────────────────────────────────────
  // Same defaulting as the string[] branch — old maintenance_config rows
  // may not yet carry every key the UI now lists.
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
    /* `Number(draftPrice) || 0` booked an unreadable surcharge as RM 0.00 and
       added the option anyway — the operator saw their row appear and had no
       reason to check the price. Refuse and say so instead. */
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
            opacity: opt.active === false ? 0.55 : 1,
          }}
        >
          <button type="button" className={styles.maintRowIcon} title="History">
            <History {...ICON_PROPS} />
          </button>
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
                  background: '#f4f6f3',
                  border: '1px solid #16695f',
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
                    background: '#f4f6f3',
                    border: '1px solid #16695f',
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
                color: '#9aa093', cursor: 'pointer',
              }}>
                <input
                  type="checkbox"
                  checked={opt.active !== false}
                  onChange={(e) => {
                    const next = JSON.parse(JSON.stringify(config)) as MaintenanceConfig;
                    const list = next[listKey] as PricedOption[];
                    if (e.target.checked) {
                      // Re-activating drops the flag so untouched rows stay
                      // shape-identical (avoids dirty diffs on save).
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
                color: opt.active === false ? '#767b6e' : '#1a7a3a',
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
                style={{ color: '#B8331F' }}
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
            background: '#fff',
            borderColor: '#16695f',
            gridTemplateColumns: '32px 32px 1fr auto',
          }}
        >
          <span className={styles.maintRowIcon}><Plus {...ICON_PROPS} /></span>
          <span className={styles.maintRowIdx}>+</span>
          <input
            type="text"
            placeholder="New value"
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addItem(); }}
            style={{
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-14)',
              background: '#f4f6f3',
              border: '1px solid #d6d9d2',
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
                background: '#f4f6f3',
                border: '1px solid #d6d9d2',
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

/* ════════════════════════════════════════════════════════════════════════
   Fabrics sub-tab body — embeds the shared FabricsTable so the same editor
   shows up on /fabric-tracking and Products → Maintenance → Common → Fabrics.
   Has its own slim search bar so the 122-row list stays usable in-place.
   ════════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════════
   PR #72 — Per-category code/name format editor (DEAD CODE as of PR #74).
   Commander 2026-05-26: revert to preset-only templates — the hardcoded
   ones in apps/api/src/routes/product-models.ts §generate are the source
   of truth. UI editor below kept as dead code in case we re-expose it;
   sidebar no longer routes to it (see MaintenanceList). The
   {category}CodeFormat / NameFormat columns on the JSONB blob are now
   always read as blank → API template fallback kicks in.
   ════════════════════════════════════════════════════════════════════════ */

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
    // PR #100 — include {model_name} so output matches mattress convention
    // (e.g. "TRION BEDFRAME (6FT) (183X190CM)"). Mirrors DEFAULT_FORMATS
    // in ProductModelDetail.tsx and API §BEDFRAME branch.
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
    border: '1px solid #c2c6bd',
    borderRadius: 'var(--radius-sm)',
    background: editMode ? '#fff' : '#f4f6f3',
    color: '#11140f',
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
        <p style={{ margin: '6px 0 0', fontSize: 'var(--fs-12)', color: '#767b6e' }}>
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
        <p style={{ margin: '6px 0 0', fontSize: 'var(--fs-12)', color: '#767b6e' }}>
          Default if blank: <code>{f.nameDefault}</code>
        </p>
      </div>

      <div style={{
        background: '#f4f6f3',
        border: '1px solid #d6d9d2',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-4)',
      }}>
        <div className="t-eyebrow" style={{ marginBottom: 8 }}>Live preview · sample row</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-12)', color: '#767b6e' }}>
            code
            <code style={{ marginLeft: 12, background: '#16695f', color: '#fff', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>
              {exampleCode}
            </code>
          </div>
          <div style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-12)', color: '#767b6e' }}>
            name
            <code style={{ marginLeft: 12, background: '#16695f', color: '#fff', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>
              {exampleName}
            </code>
          </div>
        </div>
      </div>

      <div style={{ fontSize: 'var(--fs-12)', color: '#767b6e' }}>
        <strong>Available placeholders:</strong> {f.placeholderHint}
      </div>
    </div>
  );
};

const FabricsMaintenancePanel = () => {
  const [search, setSearch] = useState('');
  /* This panel is a working list, not the master admin surface — the Fabric
     Converter is, and that is where retired rows stay visible (and toggleable).
     Here they are simply out of the way. */
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
            style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#767b6e', pointerEvents: 'none' }}
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
              background: '#fff',
              border: '1px solid #d6d9d2',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--space-2) var(--space-3) var(--space-2) var(--space-7)',
              color: '#11140f',
              outline: 'none',
            }}
          />
        </div>
        {/* PR #43 — Link to Fabric Converter for "+ New Fabric". Same data,
            same edits. Keeping the create modal on one page only to avoid
            duplicate UI state. */}
        <a
          href="/scm/fabric-tracking"
          style={{
            fontSize: 'var(--fs-13)', color: '#0c3f39',
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

/* ════════════════════════════════════════════════════════════════════════
   New SKU drawer — create a fresh mfg_product. Category drives which
   fields are shown (mattress hides Price 1, sofa shows Base Model, etc.).
   ════════════════════════════════════════════════════════════════════════ */

const NewSkuDrawer = ({ onClose }: { onClose: () => void }) => {
  const create = useCreateMfgProduct();
  const notify = useNotify();
  // Branding datalist — maintenance pool first, DISTINCT fallback. Free text
  // stays possible (datalist, not a hard select) so legacy values aren't blocked.
  const brandingPool = useBrandingPool();
  type Cat = 'BEDFRAME' | 'SOFA' | 'ACCESSORY' | 'MATTRESS' | 'BEDLINES' | 'DINING' | 'DIFFUSER' | 'CARPET' | 'SERVICE';
  /* 2990 is a trading company — no in-house manufacturing. Production-time
     tracking dropped (was HOOKKA legacy). DB column production_time_minutes
     stays for now but the UI no longer collects it. */
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
    }, { onSuccess: onClose });
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
                <option value="BEDFRAME">Bedframe</option>
                <option value="SOFA">Sofa</option>
                <option value="MATTRESS">Mattress</option>
                <option value="ACCESSORY">Accessory</option>
                <option value="SERVICE">Service</option>
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
            {/* Commander 2026-05-28 — unify fabric/colour term → "Fabrics". Key fabricColor unchanged. */}
            {isSofa && <Field label="Fabrics" value={form.fabricColor} onChange={(v) => set('fabricColor', v)} />}
            {/* 0166 — optional SKU barcode (free text; scanner-friendly). */}
            <Field label="Barcode" value={form.barcode} onChange={(v) => set('barcode', v)} placeholder="optional" />
            <Field label="Description" value={form.description} onChange={(v) => set('description', v)} fullWidth />

            <Field label={isMattress ? 'Price (RM)' : 'Base Price / Price 2 (RM)'}
              value={form.basePrice} onChange={(v) => set('basePrice', v)} type="number" />
            {!isMattress && !isService && (
              <Field label="Price 1 (RM)" value={form.price1} onChange={(v) => set('price1', v)} type="number" />
            )}
            <Field label="Cost Price (RM)" value={form.costPrice} onChange={(v) => set('costPrice', v)} type="number" />
            <Field label="Unit (m³)" value={form.unitM3} onChange={(v) => set('unitM3', v)} type="number" step="0.001" />
            {/* Production Time field removed — 2990 is a trading company (PR-strip-production). */}
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
  /** Optional <datalist> id — caller renders the datalist itself. */
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

/* ════════════════════════════════════════════════════════════════════════
   PR #38 — ProductSuppliersDrawer
   Double-click a product row to see every supplier that carries it,
   their supplier-side SKU + unit price + lead time. The MAIN supplier
   (used by default on POs) is starred and pinned to the top.
   ════════════════════════════════════════════════════════════════════════ */


const fmtRmCenti = (centi: number): string => fmtCenti(centi);

/* Effective-dated SELLING price timeline (Pricing "Option B", ph.2). Lives on the
   SKU detail drawer: shows the current price, a "Next: RM X from <date>" badge for
   the pending change, the dated history (date · RM · who), and an "add future
   price" form. Money is integer sen (MoneyInput + fmtCenti). Mirrors the
   maintenance-config effective-date editor's shape.

   NOTE the price amount is held in a REF, not just state: MoneyInput commits on
   blur, and a click on Schedule blurs the field first — reading the ref in the
   handler avoids the stale-closure race a disabled-by-amount button would hit. */
const ProductPriceTimeline = ({ row }: { row: MfgProductRow }) => {
  const q = useMfgProductPriceChanges(row.id);
  const create = useCreateMfgProductPriceChange();
  const [effDate, setEffDate] = useState(todayMyt());
  const [amountSen, setAmountSen] = useState<number | null>(null);
  const amountRef = useRef<number | null>(null);
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const today = todayMyt();
  const history = q.data?.history ?? [];
  const pending = q.data?.pending ?? null;
  const current = q.data?.currentSellPriceSen ?? row.sell_price_sen ?? null;

  const setAmount = (sen: number | null) => { amountRef.current = sen; setAmountSen(sen); };
  const save = () => {
    setFormError(null);
    const amount = amountRef.current;
    if (!effDate) { setFormError('Pick an effective date.'); return; }
    if (amount == null || !Number.isInteger(amount) || amount < 0) { setFormError('Enter a price.'); return; }
    create.mutate(
      { id: row.id, effectiveFrom: effDate, sellPriceSen: amount, notes: notes.trim() || undefined },
      {
        onSuccess: () => { setAmount(null); setNotes(''); setEffDate(todayMyt()); },
        onError: (e) => setFormError(e instanceof Error ? e.message : 'Could not schedule the price.'),
      },
    );
  };

  const h3 = {
    fontSize: 'var(--fs-12)', fontWeight: 700, textTransform: 'uppercase' as const,
    letterSpacing: '0.06em', color: '#767b6e', marginBottom: 'var(--space-2)',
  };
  const fieldLabel = {
    fontSize: 'var(--fs-11)', fontWeight: 700, textTransform: 'uppercase' as const,
    letterSpacing: '0.04em', color: '#767b6e', marginBottom: 4, display: 'block',
  };
  const inputBox = {
    background: '#fff', border: '1px solid #c2c6bd', borderRadius: 'var(--radius-sm)',
    padding: '4px 8px', fontSize: 'var(--fs-13)', outline: 'none',
  };

  return (
    <section style={{ marginBottom: 'var(--space-5)' }}>
      <h3 style={h3}>Selling price timeline</h3>

      {/* Current + pending badges — "today = current, <future> = new". */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
        <span style={{
          display: 'inline-flex', alignItems: 'baseline', gap: 6, padding: '3px 10px',
          background: '#fff', border: '1px solid #c2c6bd', borderRadius: 'var(--radius-pill)',
          fontSize: 'var(--fs-12)', color: '#3a3f36',
        }}>
          <span style={{ color: '#767b6e', textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 'var(--fs-11)', fontWeight: 700 }}>Now</span>
          {fmtCenti(current)}
        </span>
        {pending && (
          <span style={{
            display: 'inline-flex', alignItems: 'baseline', gap: 6, padding: '3px 10px',
            background: 'rgba(232, 107, 58, 0.08)', border: '1px solid rgba(232, 107, 58, 0.35)',
            borderRadius: 'var(--radius-pill)', fontSize: 'var(--fs-12)', color: '#b64a1e',
          }}>
            <span style={{ textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 'var(--fs-11)', fontWeight: 700 }}>Next</span>
            {fmtCenti(pending.sellPriceSen)} from {pending.effectiveFrom}
          </span>
        )}
      </div>

      {/* Add a future price. */}
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
        <div>
          <label style={fieldLabel}>Effective from</label>
          <DateField value={effDate} onChange={(iso) => setEffDate(iso)} style={{ ...inputBox, fontFamily: 'var(--font-mono)' }}/>
        </div>
        <div>
          <label style={fieldLabel}>New price</label>
          <MoneyInput
            bare
            valueSen={amountSen}
            onCommit={setAmount}
            allowBlank
            selectOnFocus
            placeholder="0.00"
            style={{ ...inputBox, width: 120, textAlign: 'right' }}
          />
        </div>
        <div style={{ flex: 1, minWidth: 160 }}>
          <label style={fieldLabel}>Note (optional)</label>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. new-year list price"
            style={{ ...inputBox, width: '100%' }}
          />
        </div>
        <Button variant="primary" onClick={save} disabled={create.isPending}>
          {create.isPending ? 'Scheduling…' : 'Schedule price'}
        </Button>
      </div>
      {formError && (
        <p style={{ margin: '0 0 var(--space-3)', color: '#b3261e', fontSize: 'var(--fs-12)' }}>{formError}</p>
      )}

      {/* Dated history — newest first. */}
      {q.isLoading ? (
        <p style={{ color: '#767b6e', fontSize: 'var(--fs-13)' }}>Loading price timeline…</p>
      ) : history.length === 0 ? (
        <p style={{ color: '#767b6e', fontSize: 'var(--fs-13)' }}>
          No scheduled prices yet. The flat price {fmtCenti(current)} applies until you schedule one.
        </p>
      ) : (
        <table className={styles.table} style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>Effective from</th>
              <th style={{ textAlign: 'right' }}>Price</th>
              <th>Set by</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h: MfgProductPriceChangeRow) => {
              const isFuture = h.effective_from > today;
              return (
                <tr key={h.id} style={{ background: isFuture ? 'rgba(232, 107, 58, 0.06)' : undefined }}>
                  <td>
                    <span style={{ fontFamily: 'var(--font-mono)' }}>{h.effective_from}</span>
                    {isFuture && (
                      <span className={styles.codeChip} style={{ marginLeft: 6, fontSize: 'var(--fs-11)' }}>Scheduled</span>
                    )}
                  </td>
                  <td className={styles.numCell}>{fmtCenti(h.sell_price_sen)}</td>
                  <td style={{ color: '#3a3f36' }}>{h.created_by || '—'}</td>
                  <td style={{ color: '#767b6e', fontSize: 'var(--fs-12)' }}>{h.notes || ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
};

const ProductSuppliersDrawer = ({
  row, onClose,
}: { row: MfgProductRow; onClose: () => void }) => {
  const q = useMfgProductSuppliers(row.id);
  const suppliers = q.data?.suppliers ?? [];
  // 0166 — editable SKU barcode. Local draft commits on Enter (no blur-auto-save,
  // Commander 2026-06-15) via the shared PATCH hook (verified-save reads back).
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
          background: '#f4f6f3',
          border: '1px solid #c2c6bd',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-3)',
          width: 'min(820px, 95vw)',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <header className={styles.drawerHeader}>
          <div>
            <h2 className={styles.drawerTitle}>
              <Truck {...ICON_PROPS} style={{ verticalAlign: 'middle', marginRight: 6 }} />
              Suppliers · <span className={styles.codeChip}>{row.code}</span>
            </h2>
            <p style={{ marginTop: 4, fontSize: 'var(--fs-13)', color: '#767b6e' }}>
              {row.name}{row.description ? ` — ${row.description}` : ''}
            </p>
            {/* 0166 — barcode lives on the SKU detail drawer (the SKU Master
                grid column is read-only + default-hidden). Saves on Enter. */}
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
              <span style={{
                fontSize: 'var(--fs-11)', fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: '0.04em', color: '#767b6e',
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
                  background: '#fff',
                  border: '1px solid #c2c6bd',
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

        <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-4)' }}>
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
                <h3 style={{ fontSize: 'var(--fs-12)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#767b6e', marginBottom: 'var(--space-2)' }}>
                  Available variants
                </h3>
                {groups.length === 0 ? (
                  <p style={{ fontSize: 'var(--fs-13)', color: '#767b6e' }}>
                    No variant options configured for this model{row.category ? ` (${row.category})` : ''}.
                  </p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                    {groups.map(([label, vals]) => (
                      <div key={label} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <span style={{ minWidth: 120, fontSize: 'var(--fs-11)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#767b6e' }}>{label}</span>
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

          <ProductPriceTimeline row={row} />

          <h3 style={{ fontSize: 'var(--fs-12)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#767b6e', marginBottom: 'var(--space-2)' }}>
            Suppliers
          </h3>
          {q.isLoading && (
            <p style={{ textAlign: 'center', color: '#767b6e' }}>Loading suppliers…</p>
          )}
          {!q.isLoading && suppliers.length === 0 && (
            <div style={{ textAlign: 'center', padding: 'var(--space-6)', color: '#767b6e' }}>
              <Truck size={32} strokeWidth={1.5} />
              <div style={{ marginTop: 8 }}>No suppliers carry this product yet.</div>
              <div style={{ marginTop: 4, fontSize: 'var(--fs-12)' }}>
                Go to Suppliers → Detail → Add Mapping to link a supplier to this SKU.
              </div>
            </div>
          )}
          {!q.isLoading && suppliers.length > 0 && (
            <table className={styles.table} style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ width: 32 }}></th>
                  <th>Supplier</th>
                  <th>Supplier SKU</th>
                  <th style={{ textAlign: 'right' }}>Unit Price</th>
                  <th style={{ textAlign: 'right' }}>Lead (d)</th>
                  <th style={{ textAlign: 'right' }}>MOQ</th>
                </tr>
              </thead>
              <tbody>
                {suppliers.map((s: ProductSupplierRow) => (
                  <tr key={s.id} style={{
                    background: s.is_main_supplier ? 'rgba(232, 107, 58, 0.06)' : undefined,
                  }}>
                    <td style={{ textAlign: 'center' }}>
                      {s.is_main_supplier && (
                        <Star size={14} strokeWidth={2} style={{ color: '#16695f', fill: '#16695f' }} />
                      )}
                    </td>
                    <td>
                      <div style={{ fontWeight: s.is_main_supplier ? 700 : 400 }}>
                        {s.suppliers?.name ?? '—'}
                      </div>
                      <div style={{ fontSize: 'var(--fs-11)', color: '#767b6e' }}>
                        {s.suppliers?.code ?? ''}{s.suppliers?.phone ? ` · ${formatPhone(s.suppliers.phone)}` : ''}
                      </div>
                    </td>
                    <td>
                      {s.supplier_sku
                        ? <span className={styles.codeChip}>{s.supplier_sku}</span>
                        : <span style={{ color: '#767b6e' }}>(same as our code)</span>}
                    </td>
                    <td className={styles.numCell}>
                      {fmtRmCenti(s.unit_price_centi)}{s.currency !== 'MYR' ? ` ${s.currency}` : ''}
                    </td>
                    <td className={styles.numCell}>{s.lead_time_days || '—'}</td>
                    <td className={styles.numCell}>{s.moq || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <footer className={styles.drawerFooter}>
          <p style={{ fontSize: 'var(--fs-12)', color: '#767b6e', marginRight: 'auto' }}>
            <Star size={11} strokeWidth={2} style={{ verticalAlign: 'middle', color: '#16695f', fill: '#16695f' }} />
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

   ONE price: each add-on shows a SINGLE "Price (RM)" — the surcharge that feeds
   SO costing — written to BOTH selling_price_sen and cost_price_sen so the
   displayed price and the costing price never diverge (mirrors the other priced
   pools, where the single priceSen IS the cost). Follow-up choice extras stay
   selling-only, as in the configurator.
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
  // Rows taken off THIS category but kept alive under their others. They are no
  // longer in the draft, so the snapshot has to carry them explicitly or /save
  // would retire a code that is still live elsewhere. See confirmRemove.
  const [detached, setDetached] = useState<SpecialAddonInput[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The FULL set (every category) is what a snapshot must carry — Save versions
  // the whole table. The panel only EDITS this category's slice; rows of OTHER
  // categories ride along untouched so a Sofa Save never drops Bedframe add-ons.
  const allRows = list.data ?? [];
  const inCat = (r: { categories: string[] }) => r.categories.includes(category);
  const viewRows = allRows.filter(inCat);
  // Latest applied effective date for this set (newest non-pending snapshot).
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
    // Validate the edited slice.
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
    // No-op guard — identical slice closes without versioning.
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

    // Snapshot = the WHOLE table: this category's edited draft + every OTHER
    // category's rows untouched. Codes can carry multiple categories, so a row
    // shared across categories is taken from the draft when present (the editor
    // owns it here), else preserved from the live set.
    const draftByCode = new Map(draft.map((r) => [r.code.trim(), r]));
    // Detached rows are still inCat in the LIVE set, so otherRows would skip
    // them; carry them explicitly or /save retires a code that is live elsewhere.
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

  /* A code carrying more than one category is SHARED by both panels. Dropping it
     from the draft drops it from the snapshot, and /save retires every live code
     the snapshot omits - so "remove" on a Sofa add-on that also carries BEDFRAME
     used to retire it on Sofa as well. Detach the category instead: the row stays
     active, keeps its other categories, and every order naming the code still
     resolves it. Only a row that belongs to this category ALONE is a real retire. */
  const confirmRemove = async (i: number, lbl: string) => {
    const row = draft?.[i];
    if (!row) return;
    const others = row.categories.filter((x) => x !== category);
    if (others.length > 0) {
      if (!(await askConfirm({
        title: `Remove "${lbl || 'this add-on'}" from ${category}?`,
        body: `It stays available under ${others.join(', ')}, and existing orders are unaffected.`,
        confirmLabel: 'Remove from this list',
      }))) return;
      setDetached((d) => [...d, { ...row, categories: others }]);
      removeRow(i);
      return;
    }
    if (!(await askConfirm({ title: `Remove "${lbl || 'this add-on'}"?`, body: 'It will be retired on Save (existing orders keep their saved text).', confirmLabel: 'Remove', danger: true }))) return;
    removeRow(i);
  };

  const inputStyle: React.CSSProperties = { width: '100%', padding: '8px 10px', fontSize: 'var(--fs-14)', border: '1px solid #c2c6bd', borderRadius: 'var(--radius-md)', background: '#f4f6f3' };

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
                <span style={{ color: '#0c3f39', fontWeight: 600 }}> · Pending change scheduled</span>
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

      {error && <div style={{ color: '#b23a3a', fontSize: 'var(--fs-13)', margin: 'var(--space-3) 0' }} role="alert">{error}</div>}

      {list.error ? (
        <div style={{ color: '#b23a3a', marginTop: 'var(--space-3)' }}>Failed to load: {String(list.error)}</div>
      ) : !editMode ? (
        /* VIEW — calm card rows matching the other Maintenance pools. */
        <div style={{ marginTop: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {viewRows.map((r, i) => (
            <div
              key={r.id}
              style={{
                display: 'grid', gridTemplateColumns: '28px 1fr auto 80px',
                alignItems: 'center', gap: 'var(--space-3)',
                padding: 'var(--space-3) var(--space-4)',
                background: '#f4f6f3', border: '1px solid #d6d9d2',
                borderRadius: 'var(--radius-md)', opacity: r.active ? 1 : 0.55,
              }}
            >
              <span style={{ fontSize: 'var(--fs-12)', color: '#9aa093' }}>{i + 1}</span>
              <div style={{ minWidth: 0, fontSize: 'var(--fs-16)', fontWeight: 600, color: '#11140f' }}>
                {r.label}
                {r.optionGroups.length > 0 && (
                  <span style={{ fontSize: 'var(--fs-11)', color: '#767b6e', marginLeft: 8 }}>
                    {r.optionGroups.map((g) => `${g.label} (${g.choices.length})`).join(' · ')}
                  </span>
                )}
              </div>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-15)', color: '#11140f', textAlign: 'right', whiteSpace: 'nowrap' }}>{senToRmStr(r.sellingPriceSen)}</span>
              <span style={{ fontSize: 'var(--fs-12)', fontWeight: 600, textAlign: 'right', color: r.active ? '#1a7a3a' : '#767b6e' }}>{r.active ? 'Active' : 'Inactive'}</span>
            </div>
          ))}
          {!list.isLoading && viewRows.length === 0 && (
            <div style={{ color: '#767b6e', fontSize: 'var(--fs-13)', padding: 'var(--space-3)' }}>
              No special add-ons in this category yet — click Edit, then “+ Add special”.
            </div>
          )}
        </div>
      ) : (
        /* EDIT — draft rows + follow-up-question editors. Save versions the set. */
        <div style={{ marginTop: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {(draft ?? []).map((r, i) => (
            <div key={i} style={{ border: '1px solid #c2c6bd', borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)', background: '#fff' }}>
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
                  <span style={{ display: 'block', fontSize: 'var(--fs-13)', fontWeight: 600, marginBottom: 4 }}>Price (RM, can be −)</span>
                  {/* ONE price → written to selling + cost so they never diverge. */}
                  <input type="number" step={1} style={inputStyle}
                    value={Math.round(r.sellingPriceSen) / 100}
                    onChange={(e) => { const sen = Math.round((Number(e.target.value) || 0) * 100); patchRow(i, { sellingPriceSen: sen, costPriceSen: sen }); }} />
                </label>
                <label style={{ display: 'flex', alignItems: 'flex-end', gap: 6, fontSize: 'var(--fs-13)' }}>
                  <input type="checkbox" checked={r.active} onChange={(e) => patchRow(i, { active: e.target.checked })} /> Active
                </label>
                <button type="button" onClick={() => void confirmRemove(i, r.label)} style={{ alignSelf: 'flex-end', fontSize: 'var(--fs-12)', background: 'none', border: '1px solid #d6d9d2', borderRadius: 'var(--radius-sm)', padding: '6px 10px', cursor: 'pointer', color: '#b23a3a' }}>
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
                  <div key={gi} style={{ border: '1px solid #d6d9d2', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>
                    <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginBottom: 6 }}>
                      <input style={{ ...inputStyle, flex: '1 1 160px' }} placeholder="Question (e.g. Thickness)" value={g.label} onChange={(e) => patchGroup(i, gi, { label: e.target.value })} />
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-12)' }}>
                        <input type="checkbox" checked={g.required} onChange={(e) => patchGroup(i, gi, { required: e.target.checked })} /> required
                      </label>
                      <button type="button" onClick={() => removeGroup(i, gi)} style={{ fontSize: 'var(--fs-12)', color: '#b23a3a', background: 'none', border: 'none', cursor: 'pointer' }}>remove ✕</button>
                    </div>
                    {g.choices.map((c, ci) => (
                      <div key={ci} style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 4, paddingLeft: 'var(--space-3)' }}>
                        <input style={{ ...inputStyle, flex: '1 1 120px' }} placeholder={'Choice (e.g. 10")'} value={c.label} onChange={(e) => patchChoice(i, gi, ci, { label: e.target.value })} />
                        <input type="number" step={1} style={{ ...inputStyle, width: 120 }} title="Extra RM (can be −)" value={Math.round(c.extraSen) / 100} onChange={(e) => patchChoice(i, gi, ci, { extraSen: Math.round((Number(e.target.value) || 0) * 100) })} />
                        <button type="button" onClick={() => removeChoice(i, gi, ci)} style={{ fontSize: 'var(--fs-12)', color: '#767b6e', background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
                      </div>
                    ))}
                    <button type="button" onClick={() => addChoice(i, gi)} style={{ fontSize: 'var(--fs-12)', marginLeft: 'var(--space-3)', background: 'none', border: '1px dashed #c2c6bd', borderRadius: 'var(--radius-sm)', padding: '2px 8px', cursor: 'pointer' }}>+ choice</button>
                  </div>
                ))}
                <button type="button" onClick={() => addGroup(i)} style={{ fontSize: 'var(--fs-13)', background: 'none', border: '1px dashed #c2c6bd', borderRadius: 'var(--radius-md)', padding: '4px 10px', cursor: 'pointer' }}>+ Add question</button>
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

/* Specials history dialog — effective-dated snapshots of the special_addons set,
   filtered to this category. Mirrors MaintenanceHistoryDialog. */
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
  // createdBy is a scm.staff uuid — resolve it, never print the id.
  const { actorNameOf } = useStaffLookup();
  return (
  <div className={styles.drawerBackdrop} onClick={onClose}>
    <div
      onClick={(e) => e.stopPropagation()}
      style={{ background: '#f4f6f3', border: '1px solid #c2c6bd', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-3)', width: 'min(720px, 95vw)', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
    >
      <header className={styles.drawerHeader}>
        <h2 className={styles.drawerTitle}>Specials history · {activeLabel}</h2>
        <button type="button" className={styles.iconBtn} onClick={onClose}><X {...ICON_PROPS} /></button>
      </header>
      <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-4)' }}>
        {history.length === 0 && (
          <p style={{ textAlign: 'center', color: '#767b6e' }}>No specials changes yet — the baseline snapshot is the only entry.</p>
        )}
        {history.map((entry) => {
          const slice = (entry.addons ?? []).filter((a) => Array.isArray(a.categories) && a.categories.includes(category));
          return (
            <div key={entry.id} style={{ padding: 'var(--space-3)', border: '1px solid #d6d9d2', borderRadius: 'var(--radius-md)', marginBottom: 'var(--space-3)', background: entry.isPending ? 'rgba(232, 107, 58, 0.06)' : '#fff' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontFamily: 'var(--font-mark)', fontSize: 'var(--fs-16)', fontWeight: 700, color: '#11140f' }}>Effective from {entry.effectiveFrom}</span>
                {entry.isPending && (
                  <span style={{ background: 'rgba(232, 107, 58, 0.20)', color: '#0c3f39', padding: '2px 8px', borderRadius: 'var(--radius-pill)', fontSize: 'var(--fs-11)', fontWeight: 600 }}>PENDING</span>
                )}
              </div>
              <div style={{ marginTop: 4, fontSize: 'var(--fs-12)', color: '#767b6e' }}>
                Created {fmtDateTime(entry.createdAt)}{entry.createdBy ? ` by ${actorNameOf(entry.createdBy)}` : ''}
              </div>
              {entry.notes && <p style={{ marginTop: 6, fontSize: 'var(--fs-13)', color: '#11140f' }}>Notes: {entry.notes}</p>}
              <pre style={{ marginTop: 8, padding: 'var(--space-2)', background: '#f4f6f3', border: '1px solid #d6d9d2', borderRadius: 'var(--radius-sm)', fontSize: 'var(--fs-11)', overflow: 'auto', maxHeight: 200 }}>
                {JSON.stringify(slice.map((a) => ({ code: a.code, label: a.label, priceRM: Math.round(a.sellingPriceSen) / 100, active: a.active, followUps: (a.optionGroups ?? []).length })), null, 2)}
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

/* ════════════════════════════════════════════════════════════════════════
   Maintenance History dialog — shows config snapshots over time
   ════════════════════════════════════════════════════════════════════════ */

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
  // createdBy is a scm.staff uuid — resolve it, never print the id.
  const { actorNameOf } = useStaffLookup();
  return (
  <div className={styles.drawerBackdrop} onClick={onClose}>
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        background: '#f4f6f3',
        border: '1px solid #c2c6bd',
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
          <p style={{ textAlign: 'center', color: '#767b6e' }}>
            No maintenance changes yet — the baseline migration row is the only entry.
          </p>
        )}
        {history.map((entry) => {
          const sectionValue = (entry.config as unknown as Record<string, unknown>)[activeKey];
          return (
            <div key={entry.id} style={{
              padding: 'var(--space-3)',
              border: '1px solid #d6d9d2',
              borderRadius: 'var(--radius-md)',
              marginBottom: 'var(--space-3)',
              background: entry.isPending ? 'rgba(232, 107, 58, 0.06)' : '#fff',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontFamily: 'var(--font-mark)', fontSize: 'var(--fs-16)', fontWeight: 700, color: '#11140f' }}>
                  Effective from {entry.effectiveFrom}
                </span>
                {entry.isPending && (
                  <span style={{ background: 'rgba(232, 107, 58, 0.20)', color: '#0c3f39', padding: '2px 8px', borderRadius: 'var(--radius-pill)', fontSize: 'var(--fs-11)', fontWeight: 600 }}>
                    PENDING
                  </span>
                )}
              </div>
              <div style={{ marginTop: 4, fontSize: 'var(--fs-12)', color: '#767b6e' }}>
                Created {fmtDateTime(entry.createdAt)}{entry.createdBy ? ` by ${actorNameOf(entry.createdBy)}` : ''}
              </div>
              {entry.notes && (
                <p style={{ marginTop: 6, fontSize: 'var(--fs-13)', color: '#11140f' }}>Notes: {entry.notes}</p>
              )}
              <pre style={{
                marginTop: 8,
                padding: 'var(--space-2)',
                background: '#f4f6f3',
                border: '1px solid #d6d9d2',
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

/* ════════════════════════════════════════════════════════════════════════
   CSV Export + Import
   ════════════════════════════════════════════════════════════════════════ */

// PR #104 — Commander 2026-05-26: "fabric_usage_centi / production_time_minutes
// / fabric_color 全删 不需要这个功能". These manufacturing-specific fields
// were ported in from HOOKKA but don't apply to 2990's retail catalogue;
// dropping them from the CSV export so commander's spreadsheet stays focused.
// Schema columns + API field writers also stripped (apps/api/src/routes/
// mfg-products.ts) so future imports don't resurrect the data.
//
// Sofa per-tier export (Wei Siang) — a sofa carries a price per (size × tier).
// The CSV is LONG form: one row per sofa tier (PRICE_1 / PRICE_2 / PRICE_3),
// with one money column per size. Non-sofa rows leave the size columns blank
// and carry base_price_sen / price1_sen instead. The old cost_price_sen column
// is dropped entirely — it was the zeroing trap on round-trip.


/** Normalize a stored seat height to its bare size token so '28"' matches '28'. */
const normalizeHeight = (h: unknown): string => String(h ?? '').replace('"', '').trim();

/** Fixed leading + trailing columns. The per-size price columns are spliced
 *  in between, derived from the live sofaSizes config at export time. */
// CSV money columns are written in plain RINGGIT (e.g. 1535, or 1535.50 when
// there are cents) — never raw sen (153500 reads like "RM153,500") and never a
// forced ".00" tail (the operator types whole-ringgit prices and doesn't want
// to add decimals every time — Wei Siang 2026-06-09). Round-trip stays exact
// because money is 2dp: import multiplies by 100 back to sen.
const priceColForSize = (size: string) => `price_${size}`;
/** sen → "1535" / "1535.50" (blank when unset, no trailing .00). */
const senToRm = (sen: number | null | undefined): string => {
  if (sen == null) return '';
  const ringgit = Math.trunc(sen / 100);
  const cents = Math.abs(sen % 100);
  return cents === 0 ? String(ringgit) : `${ringgit}.${String(cents).padStart(2, '0')}`;
};

function exportSkusCsv(rows: MfgProductRow[], sofaSizes: string[], tier: SofaPriceTier, category: MfgCategory | 'all'): void {
  // Columns are TAILORED to the category being exported, so an operator only
  // sees cells they can actually fill (Wei Siang 2026-06-09):
  //   • SOFA      → price_tier + one column per sofa size (the per-tier prices)
  //   • non-SOFA  → base_price + price1 (flat pricing; no sofa size columns)
  //   • All       → the union of both (mixed-category dump)
  const wantSofa = category === 'all' || category === 'SOFA';
  const wantFlat = category === 'all' || category !== 'SOFA';
  const sizeCols = sofaSizes.map(priceColForSize);
  // Lean price sheet (Wei Siang 2026-06-15): the match key + the identity
  // columns the import requires (code/name/category) + size_label for human
  // readability + the price columns. Descriptive fields (description,
  // base_model, unit_m3, status, branding) are dropped — a blank/absent cell
  // never changes them, so a price round-trip doesn't need to carry them.
  const columns = [
    'code', 'name', 'category', 'size_label',
    ...(wantSofa ? ['price_tier', ...sizeCols] : []),
    ...(wantFlat ? ['base_price', 'price1'] : []),
  ];

  // RFC4180: quote if contains comma, quote, or newline.
  const cell = (v: unknown): string => {
    if (v == null) return '';
    const s = String(v);
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
      // ONE row per sofa for the CURRENTLY SELECTED tier (the P1/P2/P3 toggle) —
      // matches what the operator filters/edits on screen. Other tiers are left
      // out of this file and preserved on re-import (backend merges by tier).
      const m = new Map<string, number>();
      for (const e of r.seat_height_prices ?? []) {
        if ((e.tier ?? 'PRICE_2') === tier) m.set(normalizeHeight(e.height), e.priceSen);
      }
      const sizeCells: Record<string, unknown> = {};
      for (const size of sofaSizes) {
        sizeCells[priceColForSize(size)] = senToRm(m.get(normalizeHeight(size)));
      }
      emit({ price_tier: tier, ...sizeCells });
    } else {
      // Bedframe / mattress / accessory / service — flat base + price1.
      emit({
        base_price: senToRm(r.base_price_sen),
        price1:     senToRm(r.price1_sen),
      });
    }
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // Stamp the active category into the filename (e.g. 2990s-skus-bedframe-…csv)
  // so a file's contents are obvious — the export only ever holds the rows
  // currently filtered on screen (Wei Siang 2026-06-09).
  const catTag = category === 'all' ? '' : `${category.toLowerCase()}-`;
  a.download = `2990s-skus-${catTag}${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ─── Round-trip CSV parser (RFC4180) for the SKU import ───────────────────
 * Generic header-keyed parser: returns one plain object per data row, keyed by
 * the exact header text (lower-cased, trimmed). Handles quoted fields with
 * embedded commas, quotes ("" escape), and CR/LF inside quotes. Strips a
 * leading UTF-8 BOM so a file saved from Excel parses cleanly. (fabric-csv's
 * parseCsv is fabric-specific — it requires a fabric_code column and remaps to
 * fabric apiKeys — so we keep a small local parser here.) */
/** Read the first sheet of an uploaded Excel workbook (.xlsx/.xls) into rows of
 *  string cells, so an exported CSV that Excel re-saved as a workbook still
 *  imports. CSV stays on parseSkuCsv below. */
async function readXlsxGrid(file: File): Promise<string[][]> {
  const XLSX = await import('../../lib/xlsx-runtime');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const first = wb.SheetNames[0];
  const sheet = first ? wb.Sheets[first] : undefined;
  if (!sheet) return [];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '' });
  return aoa
    .map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : []))
    .filter((r) => r.some((c) => c.trim().length > 0));
}

function parseSkuCsv(text: string): Array<Record<string, string>> {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const grid: string[][] = [];
  let row: string[] = [];
  let cellStr = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cellStr += '"'; i++; continue; }
        inQuotes = false;
      } else {
        cellStr += ch;
      }
      continue;
    }
    if (ch === '"' && cellStr === '') { inQuotes = true; continue; }
    if (ch === ',') { row.push(cellStr); cellStr = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cellStr); grid.push(row); row = []; cellStr = ''; continue; }
    cellStr += ch;
  }
  if (cellStr !== '' || row.length > 0) { row.push(cellStr); grid.push(row); }
  return gridToSkuRecords(grid);
}

/** Header-key a parsed grid (CSV or Excel) into one object per data row, keyed
 *  by lower-cased trimmed header text. */
function gridToSkuRecords(grid: string[][]): Array<Record<string, string>> {
  if (grid.length < 1) return [];
  const header = (grid[0] ?? []).map((h) => h.trim().toLowerCase());
  const out: Array<Record<string, string>> = [];
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r];
    if (!cells || cells.every((c) => c.trim() === '')) continue;
    const obj: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      const key = header[c];
      if (!key) continue;
      obj[key] = (cells[c] ?? '').trim();
    }
    out.push(obj);
  }
  return out;
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
      const fname = file.name.toLowerCase();
      const parsed = (fname.endsWith('.xlsx') || fname.endsWith('.xls'))
        ? gridToSkuRecords(await readXlsxGrid(file))
        : parseSkuCsv(await file.text());
      if (parsed.length === 0) {
        setErrorMsg('That file had no rows. Export a copy first, edit it, then import the same file.');
        setBusy(false);
        return;
      }

      // Group rows by code — a sofa with PRICE_1 / PRICE_2 / PRICE_3 rows
      // becomes ONE product carrying all its size × tier prices.
      const byCode = new Map<string, Array<Record<string, string>>>();
      for (const p of parsed) {
        const code = (p.code ?? '').trim();
        if (!code) continue;
        const list = byCode.get(code);
        if (list) list.push(p); else byCode.set(code, [p]);
      }

      const rows: BatchImportRow[] = [];
      // SKUs skipped because a price row's tier couldn't be recognised — shown
      // to the operator so a mislabelled price is never silently mis-filed.
      const tierErrors: Array<{ code: string; reason: string }> = [];
      for (const [code, group] of byCode) {
        const first = group[0];
        if (!first) continue;
        // A field is only carried when its cell is non-empty, so a blank cell
        // never overwrites existing data on the SKU.
        const has = (v: string | undefined) => v != null && v !== '';
        const out: BatchImportRow = {
          code,
          name:     first.name ?? '',
          category: first.category ?? '',
        };
        if (has(first.description)) out.description = first.description;
        if (has(first.base_model)) out.base_model = first.base_model;
        if (has(first.size_label)) out.size_label = first.size_label;
        if (has(first.status))     out.status = first.status;
        if (has(first.branding))   out.branding = first.branding;

        // Money is read in RINGGIT (new export, e.g. 1535.00 → 153500 sen). A
        // legacy `_sen` column is still honoured as a fallback so any file from
        // an earlier export round-trips. Returns null when neither is present.
        // A bad money cell skips the whole SKU (reported like tier errors)
        // rather than ever writing a corrupted price.
        /* This used to carry its OWN copy of the accept/reject rule (strip
           "RM " and commas, then a regex). It was the right rule — it is where
           the "parseFloat('1,535.00') is RM 1.00" hazard was first written
           down — but a second copy of a money rule is how the two halves come
           to disagree, so it now calls the shared parser. The shared parser is
           strictly stricter: it also catches ambiguous comma grouping and more
           than two decimal places, both of which this regex let through. */
        let moneyError: string | null = null;
        const senOf = (rm: string | undefined, sen: string | undefined): number | null => {
          if (has(rm)) {
            const parsed = parseMoneyToSen(rm, 'That price');
            if (!parsed.ok) {
              moneyError ??= `price "${(rm as string).trim()}" could not be read — ${parsed.message}`;
              return null;
            }
            return parsed.empty ? null : parsed.sen;
          }
          /* Legacy `_sen` column — an integer count of sen, not ringgit. An
             unreadable one used to return null, which this caller reads as
             "the column wasn't filled in", so a corrupt legacy file imported
             as a price-less SKU with nothing said. Report it like the ringgit
             branch does. */
          if (has(sen)) {
            const n = Number(String(sen).trim());
            if (!Number.isFinite(n) || !Number.isInteger(n)) {
              moneyError ??= `price "${String(sen).trim()}" could not be read — this column is a whole number of sen, for example 153500.`;
              return null;
            }
            return n;
          }
          return null;
        };

        // base_price / price1 — take the first row that filled them.
        const baseRow = group.find((g) => has(g.base_price) || has(g.base_price_sen));
        if (baseRow) { const v = senOf(baseRow.base_price, baseRow.base_price_sen); if (v != null) out.base_price_sen = v; }
        const p1Row = group.find((g) => has(g.price1) || has(g.price1_sen));
        if (p1Row) { const v = senOf(p1Row.price1, p1Row.price1_sen); if (v != null) out.price1_sen = v; }
        const m3Row = group.find((g) => has(g.unit_m3_milli));
        if (m3Row) out.unit_m3_milli = Number(m3Row.unit_m3_milli);

        // Sofa per-size × per-tier prices, gathered across all of this code's
        // tier rows. A row that carries any price MUST name a recognisable tier
        // (P1/P2/P3) — otherwise the SKU is skipped with a clear reason so a
        // price never lands in the wrong tier.
        const seat: SeatHeightPrice[] = [];
        let tierError: string | null = null;
        for (const g of group) {
          const hasAnyPrice = sofaSizes.some((size) => has(g[`price_${size}`]) || has(g[`price_${size}_sen`]));
          if (!hasAnyPrice) continue;
          const t = normalizeSofaTier(g.price_tier);
          if (!t) { tierError = (g.price_tier ?? '').trim() || '(blank)'; break; }
          for (const size of sofaSizes) {
            const ps = senOf(g[`price_${size}`], g[`price_${size}_sen`]);
            if (ps == null) continue;
            seat.push({ height: size, priceSen: ps, tier: t });
          }
        }
        if (tierError) {
          tierErrors.push({ code, reason: `price tier "${tierError}" not recognized — use P1, P2, or P3` });
          continue;
        }
        if (moneyError) {
          tierErrors.push({ code, reason: moneyError });
          continue;
        }
        if (seat.length > 0) out.seatHeightPrices = seat;

        rows.push(out);
      }

      if (rows.length === 0) {
        if (tierErrors.length > 0) {
          setResult({ upserted: 0, failed: tierErrors.length, failures: tierErrors });
        } else {
          setErrorMsg('No rows had a code. Every row needs a code, name, and category.');
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

  // Commit the staged rows — the ONLY path that writes to the server.
  const confirmImport = async () => {
    if (!staged) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await batchImport.mutateAsync(staged.rows);
      setResult(staged.tierErrors.length > 0
        ? {
            upserted: res.upserted,
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
          background: '#f4f6f3',
          border: '1px solid #c2c6bd',
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
        <p style={{ fontSize: 'var(--fs-13)', color: '#767b6e' }}>
          Pick a CSV or Excel file exported from this page. Edit the prices in Excel,
          save, and import it back. A blank cell is left as it was — it never clears a price.
          Up to 500 SKUs per file.
        </p>
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
          <p style={{ marginTop: 'var(--space-3)', fontSize: 'var(--fs-13)', color: '#767b6e' }}>
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
                <> · <span style={{ color: '#0c3f39' }}>{staged.tierErrors.length} will be skipped</span></>
              )}. Blank cells keep the current value. <strong>Nothing is saved until you confirm.</strong>
            </p>
            {staged.tierErrors.length > 0 && (
              <ul style={{ margin: 'var(--space-2) 0 0', paddingLeft: 'var(--space-4)', fontSize: 'var(--fs-12)', color: '#0c3f39' }}>
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
              color: result.failed > 0 ? '#0c3f39' : '#2F5D4F',
            }}>
              {result.upserted > 0
                ? `Saved — ${result.upserted} SKU${result.upserted === 1 ? '' : 's'} updated${result.failed > 0 ? ` · ${result.failed} failed` : ''}`
                : result.failed > 0
                  ? `Nothing saved — ${result.failed} row${result.failed === 1 ? '' : 's'} failed`
                  : 'Nothing to update — every value already matched what was saved'}
            </div>
            {result.failures.length > 0 && (
              <ul style={{ marginTop: 'var(--space-2)', paddingLeft: '1.2em', color: '#767b6e' }}>
                {result.failures.slice(0, 5).map((f, i) => (
                  <li key={i}>{f.code || '(no code)'}: {f.reason}</li>
                ))}
                {result.failures.length > 5 && <li>…and {result.failures.length - 5} more.</li>}
              </ul>
            )}
          </div>
        )}

        <footer style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--space-4)' }}>
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </footer>
      </div>
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   PR #89 — Click-to-edit cell for SKU Master code + name columns.
   Same UX as Fabric Converter DescriptionCell: chip → click → input,
   Enter / blur saves, Esc cancels. inline=true uses regular text styling
   (no chip pill); inline=false uses chipClassName for the resting state.
   ════════════════════════════════════════════════════════════════════════ */
const EditableTextCell = ({
  value, chipClassName, ariaLabel, onSave, inline = false, editable = true,
}: {
  value:          string;
  /** CSS-module class — typed loose so `styles.foo` (which TS treats as
      `string | undefined`) flows in without callers having to coalesce.
      PR #87 merge fix: PR #89 landed with this typed `string` which broke
      the build under `tsc -b --noEmit`. */
  chipClassName:  string | undefined;
  ariaLabel:      string;
  onSave:         (val: string) => void;
  inline?:        boolean;
  /** PR #95 — Commander 2026-05-26: gate click-to-edit behind the parent
      table's edit mode. When false, the cell renders as plain text/chip
      and any click is ignored. Defaults to true so existing callers
      (Fabric Converter description cell, etc.) keep working. */
  editable?:      boolean;
}) => {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState(value);

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === value.trim()) {
      setEditing(false);
      setDraft(value);
      return;
    }
    onSave(trimmed);
    setEditing(false);
  };
  const cancel = () => { setDraft(value); setEditing(false); };

  if (!editing) {
    // PR #95 — Read-only mode. Same visual chip / inline text but no
    // click target, no cursor pointer, no "Click to edit" tooltip.
    if (!editable) {
      return inline ? (
        <span className={chipClassName}>{value}</span>
      ) : (
        <span className={chipClassName}>{value}</span>
      );
    }
    return inline ? (
      <div
        role="button"
        tabIndex={0}
        className={chipClassName}
        title="Click to edit"
        onClick={() => { setDraft(value); setEditing(true); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDraft(value); setEditing(true); } }}
        style={{ cursor: 'pointer' }}
      >
        {value}
      </div>
    ) : (
      <button
        type="button"
        className={chipClassName}
        title="Click to edit"
        aria-label={ariaLabel}
        onClick={() => { setDraft(value); setEditing(true); }}
        style={{ cursor: 'pointer' }}
      >
        {value}
      </button>
    );
  }
  return (
    <input
      autoFocus
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter')      { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      }}
      style={{
        fontFamily: inline ? 'var(--font-sans)' : 'var(--font-mono)',
        fontSize:   'var(--fs-13)',
        fontWeight: 600,
        padding:    '4px 8px',
        border:     '1px solid #16695f',
        borderRadius: 'var(--radius-sm)',
        background: '#f4f6f3',
        outline:    'none',
        width:      '100%',
        maxWidth:   320,
      }}
    />
  );
};
