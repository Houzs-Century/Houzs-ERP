// ----------------------------------------------------------------------------
// SoLineCard — Houzs-pattern single-row line item editor.
//
// Commander 2026-05-27: "我要 Hookka 的 LineCard 排版". Verbatim port of
// houzs-erp/src/components/NewSalesOrderForm.tsx LineCard (lines 208-487)
// translated from Tailwind to CSS Modules + 2990 brand tokens.
//
// Layout (single row, collapsed):
//   [No #] [Item ▼] [Remarks input] [Qty] [Unit Price] [Delivery Date] [Amount $] [Group badge] [🗑]
//
// Below row, per-category variants (only when SKU picked + has variants):
//   BEDFRAME → Fabrics / Gaps / Divan Heights / Leg Heights · Specials accordion
//   SOFA     → Fabrics / Seat Heights / Leg Heights        · Specials accordion
//   MATTRESS / ACCESSORY / OTHERS → no variants section
//
// Wired to:
//   - useMfgProducts (SKU picker, search-as-you-type)
//   - useMaintenanceConfig (variant option lists + per-option surcharges)
//   - useFabricTrackings (fabric dropdown)
//   - useUploadSoItemPhoto / useDeleteSoItemPhoto (per-line photos, PR-F)
//
// State contract unchanged from PR #125: same SoLineDraft shape, same
// onChange(patch) callback. SalesOrderNew + SalesOrderDetail can drop
// this in without touching the parent.
// ----------------------------------------------------------------------------

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, ImagePlus, X } from 'lucide-react';
import {
  computeMfgLinePrice,
  buildSpecialsPoolFromAddons,
  type MfgPricingProduct,
  type MfgFabricTier,
} from '@2990s/shared/mfg-pricing';
import { missingVariantAxes } from '@2990s/shared/so-variant-rule';
import { activeOptions, isColourKiv, lineIdentity, maintPickerValues, fmtMoneySen } from '@2990s/shared';
import {
  useMfgProducts,
  useMaintenanceConfig,
  useSpecialAddons,
  useModelAllowedOptionsByCode,
  useSkuCategoryByCode,
  type MfgProductRow,
  type SpecialAddonRow,
} from '../lib/mfg-products-queries';
import { useFabricTrackings, useFabricColoursSearch, type FabricTrackingRow, type FabricColourRow } from '../lib/fabric-queries';
import { useFabricLibrary } from '../lib/queries';
import {
  useUploadSoItemPhoto,
  useDeleteSoItemPhoto,
} from '../lib/sales-order-queries';
import { cacheSoLinePhotoSignedUrl, useSoLinePhoto } from '../lib/so-line-photo';
import { useDebouncedValue } from '../lib/hooks';
import { useAuth, isAdminLevel, isHatchSales } from '../lib/auth';
import { CATEGORY_BADGE } from '../lib/category-badges';
import { sortByNumeric } from '../lib/sort-options';
import { posRemarkSpecialOf } from '../lib/pos-remark-special';
import { useNotify } from './NotifyDialog';
import { SpecialOrders } from './SpecialOrders';
import styles from './SoLineCard.module.css';
import { DateField } from "./DateField";
const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number, currency = 'MYR'): string => fmtMoneySen(centi, currency);

const isBlankVariant = (v: unknown): boolean =>
  v === undefined || v === null || String(v).trim() === '';

/* The sofa Leg Height carries a standing "Default" option (RM 0.00) in the
   maintenance sofaLegHeights pool (owner 2026-07-13). Resolve its value,
   matched case-insensitively by name, so a sofa line's Leg Height auto-fills to
   it instead of an empty required field. null when the pool has no such option. */
const DEFAULT_SOFA_LEG_RE = /^\s*default\s*$/i;
const defaultSofaLegValue = (
  maint: { sofaLegHeights?: readonly unknown[] } | null | undefined,
): string | null => {
  for (const e of (maint?.sofaLegHeights ?? [])) {
    const v = typeof e === 'string' ? e : String((e as { value?: unknown })?.value ?? '');
    if (DEFAULT_SOFA_LEG_RE.test(v)) return v;
  }
  return null;
};

/** PR #114/#125 — Draft payload for one SO line. Matches the shape POST
 *  /mfg-sales-orders and PATCH /mfg-sales-orders/:docNo/items both expect.
 *  PR #147 — `overriddenKeys` is a client-only audit set (not persisted to
 *  API) that records which variant keys this line has been MANUALLY edited
 *  for. The master-follower cascade in SalesOrderNew uses it to decide
 *  whether to overwrite a follower's variant when LINE 1's changes:
 *    - key NOT in overriddenKeys → cascade overwrites (follower stays in sync)
 *    - key IN overriddenKeys     → cascade leaves alone (follower wins) */
export type SoLineDraft = {
  itemCode:       string;
  itemGroup:      string;        // 'sofa' | 'bedframe' | 'mattress' | 'accessory' | 'others'
  description:    string;
  uom:            string;
  qty:            number;
  unitPriceSen: number;
  discountSen:  number;
  unitCostSen:  number;
  variants:       Record<string, unknown>;
  remark:         string;
  overriddenKeys?: string[];
  /* PR-E — Per-item delivery date + cascade override flag. */
  lineDeliveryDate?:           string | null;
  lineDeliveryDateOverridden?: boolean;
  /* PR-F (Task #79) — Per-line photo R2 object keys (already-saved photos). */
  photoUrls?:                  string[];
  /* Line-card-redesign (Commander 2026-05-27) — Client-only pending File
     uploads staged before the line has a DB id. Parent strips this before
     POST/PATCH and re-uploads each File against the saved itemId after
     create. NEVER persisted to the API. */
  pendingPhotoFiles?:          File[];
};

/** Factory for a fresh empty SO line draft. */
export const emptySoLine = (): SoLineDraft => ({
  itemCode: '', itemGroup: 'others', description: '', uom: 'UNIT',
  qty: 1, unitPriceSen: 0, discountSen: 0, unitCostSen: 0,
  variants: {}, remark: '',
  lineDeliveryDate: null,
  lineDeliveryDateOverridden: false,
  photoUrls: [],
  pendingPhotoFiles: [],
});

/** Strip client-only fields (pendingPhotoFiles, photoUrls) from a draft
 *  before POST / PATCH. The API doesn't accept File objects and photo
 *  keys are managed by the dedicated /items/:id/photos endpoints. */
export const stripClientOnlyFields = (
  draft: SoLineDraft,
): Omit<SoLineDraft, 'pendingPhotoFiles' | 'photoUrls'> => {
  const { pendingPhotoFiles: _f, photoUrls: _p, ...rest } = draft;
  void _f; void _p;
  return rest;
};

/* posRemarkSpecialOf — the POS "special add-on" row (note + folded extra) for
   the Special Orders accordion — lives in ../lib/pos-remark-special (pure +
   unit-tested). Loo 2026-06-13: it reads variants.extraAddonNote, NOT the item
   remark (variants.remark), which is now a separate field. */

/* ── Per-category badge swatches ──────────────────────────────────────
   2026-05-27: extracted to lib/category-badges.ts so MfgSalesOrdersList +
   SalesOrderDetailListing can share the same chip palette. Re-import here
   so the inline references below stay one-line. */

/* ──────────────────────────────────────────────────────────────────────
   SoLineCard
   ────────────────────────────────────────────────────────────────────── */

/* Task #103 — Wrap in React.memo at module bottom. The parent (SO Detail)
   now passes stable per-row callbacks via a useMemo'd Map keyed off
   editingLineIds, so the memo comparator can rely on shallow-equal props.
   `inheritVariantsByCategory` from SalesOrderNew is a fresh object on every
   render but the only state it captures is LINE 1's variants, which change
   exactly when the user is interacting with LINE 1 anyway — i.e. exactly
   when we DO want the follower rows to re-render. */
const SoLineCardInner = ({
  index,
  draft,
  onChange,
  onRemove,
  canRemove,
  inheritVariantsByCategory,
  onAddProducts,
  docNo,
  itemId,
  isEditing = true,
  variantsRequired,
  searchHint,
}: {
  index:     number;
  draft:     SoLineDraft;
  onChange:  (patch: Partial<SoLineDraft>) => void;
  onRemove:  () => void;
  canRemove: boolean;
  inheritVariantsByCategory?: Record<string, Record<string, unknown> | undefined>;
  /* Multi-add (desktop parity with MobileSkuPicker.onPickMany). When provided,
     the SKU picker gains a multi-select mode: the operator ticks several SKUs
     and hits "Add N" — the FIRST fills THIS line (via onChange, so cascades +
     inherit still fire) and the REST are appended as new lines by the parent.
     Absent → single-pick behavior only. */
  onAddProducts?: (rows: MfgProductRow[]) => void;
  docNo?:    string;
  itemId?:   string;
  isEditing?: boolean;
  /* Whether the category-mandatory variants (fabric / seat / divan / leg / gap)
     are REQUIRED on this line — drives the ` *` marker + red invalid ring.

     MANDATORY PROP, no default, deliberately. It used to default to `true` "so
     Consignment + any other consumer is unchanged" (owner 2026-07-14), and that
     default is what shipped the bug: nine of the eleven render sites never
     passed it, so every consignment and downstream form demanded fabric / seat /
     leg on a line its OWN SERVER would have accepted. A Consignment Order's
     route runs the check only `procDate ? ... : []` (consignment-orders.ts:687),
     and consignment notes / returns, delivery returns and sales invoices do not
     run it at all — findIncompleteVariantLines appears zero times in those
     files.

     A silent default cannot be reviewed. Requiring the prop turns "someone
     forgot" from a red ring the operator cannot get past into a compile error,
     which is the only version of this that stays fixed.

     THE RULE, so a new caller can decide in one read:
       · an ORDER that carries a Processing Date  -> !!processingDate
         (SO New/Detail, Consignment Order New/Detail — matches their servers)
       · a DOWNSTREAM document built from one     -> false
         (DO, consignment note/return, delivery return, sales invoice — the
          variants ride in with the items and are not re-specified here) */
  variantsRequired: boolean;
  /* Scan-Order (Task #73) — the OCR rawText for a NO-MATCH line, shown as the
     SKU picker's placeholder so the operator sees what was on the slip while
     they pick a real SKU. It is a HINT ONLY — never committed as the product
     value (a no-match line must be filled from the dropdown, not free-typed). */
  searchHint?: string;
}) => {
  const notify = useNotify();
  const maintQ   = useMaintenanceConfig('master');
  const maint    = maintQ.data?.data ?? null;
  /* fabric_trackings stays ONLY for the read-only pricing-tier breakdown
     (pickedFabric below) — the Fabrics DROPDOWN now sources the selling-side
     fabric_colours, same as POS (SO-parity, Loo 2026-06-06). */
  const fabricsQ = useFabricTrackings();
  const fabrics = useMemo(() => fabricsQ.data ?? [], [fabricsQ.data]);
  const fabricLibQ     = useFabricLibrary();
  /* Special Add-ons (the per-Model system POS sells from + the server prices
     from). Replaces the legacy maintenance_config specials/sofaSpecials pools. */
  const specialAddonsQ = useSpecialAddons();
  const specialDefs    = useMemo(() => specialAddonsQ.data ?? [], [specialAddonsQ.data]);

  /* SO-SKU spec P4 (D4, Loo 2026-06-05) — the unit price is LOCKED to the
     SKU Master sell price for everyone below admin. It auto-fills on pick and
     the server recompute is authoritative at save; only admin-level roles can
     hand-edit (the audited /override route is gated server-side too).
     TEMPORARY (Loo 2026-06-10, SO emergency hatch) — the POS selling roles
     creating raw SOs through the hatch may also type the price: their new
     items often carry no sell_price_sen, so the locked field booked RM 0
     lines. The server still enforces the catalog price on lines it CAN price
     (isHatchSales in lib/auth.tsx — remove with the hatch). */
  const { staff } = useAuth();
  const canEditPrice = isAdminLevel(staff?.role) || isHatchSales(staff?.role);
  /* Special-order price DISPLAY is off for EVERYONE on the order-entry
     documents (owner 2026-07-17: costing leaves the SO/DO/SI/DR forms entirely
     and moves to the separate Finance "Fulfillment Costing" module — even
     Sales Director / Finance do not need to see it while opening documents).
     So the preset "+MYR …" surcharges, the retired-line prices, the follow-up
     option-group amounts, and the manual "Extra charge (RM)" field are all
     hidden — the option NAME + checkbox stay, only the money is gone. The
     server still applies every surcharge; this removes the DISPLAY only. Was
     `isAdminLevel(staff?.role)` (the same gate the Unit Price locks on). */
  const showPrices = false;

  const [search, setSearch] = useState(draft.description || draft.itemCode || '');
  const [picked, setPicked]         = useState<MfgProductRow | null>(null);
  const [showPicker, setShowPicker]   = useState(false);
  // The SKU dropdown is rendered in a portal (document.body) and positioned with
  // position:fixed from the input's live rect. Without this it lived inside the
  // section `.card`, whose `overflow:hidden` (rounded corners) clipped it off —
  // the options got cut at the card's bottom edge on every doc that uses this
  // card (SO / DO / DR / consignment). Wei Siang 2026-06-06.
  const pickerWrapRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);
  /* Multi-add (desktop MobileSkuPicker.onPickMany parity) — when the parent
     wires onAddProducts, ticked SKUs collect here; "Add N" commits them (first
     → this line, rest → new lines). Keyed by MfgProductRow.id. */
  const multiEnabled = typeof onAddProducts === 'function';
  const [multiMode, setMultiMode] = useState(false);
  const [multiPicked, setMultiPicked] = useState<MfgProductRow[]>([]);
  /* Auto-open when the line carries a POS remark/extra special (Loo
     2026-06-12) so the coordinator sees it without a click. */
  const [specialsOpen, setSpecialsOpen] = useState(() => posRemarkSpecialOf(draft.variants) != null);
  /* Commander 2026-05-30 — Unit Price is a free-typed field. Keep the raw
     typed text in local state so multi-digit entry (e.g. 1000) and
     clear-then-retype work without the value being reformatted to "x.00" on
     every keystroke (which jumps the cursor and blocks typing). Synced back
     from the canonical centi only when it changes from outside, e.g. a
     product pick resets it to 0. */
  const [priceText, setPriceText] = useState((draft.unitPriceSen / 100).toFixed(2));
  /* Task #102 — Same gate the debtor autocomplete got in PR #99. Without
     this the product picker fired one /mfg-products?search=… request per
     keystroke even when the picker wasn't open (every render of an
     already-saved line re-issued the query for the description text). The
     200 ms debounce smooths fast typists; the length>=2 + showPicker
     enabled-flag guards the closed-picker + single-character cases. */
  const debouncedSearch = useDebouncedValue(search, 200);
  const trimmedSearch   = debouncedSearch.trim();
  const productsQuery = useMfgProducts({
    search:  trimmedSearch || undefined,
    enabled: showPicker && trimmedSearch.length >= 2,
  });
  const candidates = productsQuery.data ?? [];
  /* Owner 2026-08-08 ("square pillow", HC-SO-2607-013) — typed text the
     catalog does not match must read as an ERROR, not sit quietly in the box:
     the operator once read the silence as "saved". True only when the line has
     no committed product, the search term is a real query (>=2 chars), and the
     server answered it with zero candidates. */
  const unmatchedFreeText =
    !draft.itemCode && trimmedSearch.length >= 2 &&
    productsQuery.isSuccess && !productsQuery.isFetching && candidates.length === 0;

  /* Effective category (owner 2026-07-13) — draft/backdoor lines (scan-OCR,
     hatch) can persist a sofa/bedframe SKU under a GENERIC itemGroup ('others'),
     which used to render as a "General item" with no configurator and let the
     line confirm without the mandatory fabric/seat variants. Drive the whole
     configurator off the line's REAL category instead: a freshly-picked
     product's category, else the SKU's category resolved by its item code, else
     the persisted itemGroup. This makes an already-malformed draft show the
     right configurator the moment it's opened — not only future lines. */
  const skuCategoryQ = useSkuCategoryByCode(draft.itemCode || undefined);
  const resolvedCategory = String(picked?.category ?? skuCategoryQ.data ?? '').toLowerCase();
  const category = resolvedCategory || draft.itemGroup.toLowerCase();

  /* Heal the persisted line + seed the sofa Leg default (owner 2026-07-13).
     When the SKU's real category is sofa/bedframe but the saved itemGroup is
     generic, rewrite itemGroup so the committed line equals a manually-picked
     one. For sofa, also default Leg Height to the "Default" maintenance option
     (RM 0.00) when unset, so it is never an empty required field and never
     blocks Confirm. Edit-mode only — a read-only view still RENDERS the
     configurator (driven by `category` above) but must not mutate. */
  useEffect(() => {
    if (!isEditing || !draft.itemCode) return;
    const patch: Partial<SoLineDraft> = {};
    if ((category === 'sofa' || category === 'bedframe')
        && draft.itemGroup.toLowerCase() !== category) {
      patch.itemGroup = category;
    }
    if (category === 'sofa' && maint
        && isBlankVariant(draft.variants.legHeight)
        && isBlankVariant(draft.variants.sofaLegHeight)) {
      const def = defaultSofaLegValue(maint);
      if (def) patch.variants = { ...draft.variants, ...(patch.variants ?? {}), legHeight: def };
    }
    if (Object.keys(patch).length > 0) onChange(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, category, draft.itemCode, maint]);

  /* PR-F (Task #79) — Per-line photo state.
     Line-card-redesign (Commander 2026-05-27): also support DRAFT mode
     where the line hasn't been saved yet. In draft mode we stage File
     objects in `draft.pendingPhotoFiles` and preview them via
     URL.createObjectURL(). The parent (SalesOrderNew / SalesOrderDetail
     Add Line flow) drains pendingPhotoFiles after save and uploads each
     file against the freshly-minted itemId. */
  const uploadPhoto = useUploadSoItemPhoto();
  const deletePhoto = useDeleteSoItemPhoto();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const photoUrls = draft.photoUrls ?? [];
  const pendingFiles = useMemo(() => draft.pendingPhotoFiles ?? [], [draft.pendingPhotoFiles]);
  const isSaved = Boolean(docNo) && Boolean(itemId);
  const canShowPhotos = Boolean(draft.itemCode);
  const canMutatePhotos = canShowPhotos && isSaved && isEditing;
  const canStagePhotos = canShowPhotos && !isSaved && isEditing;

  /* Object URL lifecycle: mint a URL per pending File and revoke when
     the file changes or the component unmounts. Keyed by index because
     File objects don't have stable IDs and the Array reference shifts
     on every patch. */
  const pendingPreviews = useMemo(
    () => pendingFiles.map((f) => ({ name: f.name, url: URL.createObjectURL(f) })),
    [pendingFiles],
  );
  useEffect(() => () => {
    pendingPreviews.forEach((p) => URL.revokeObjectURL(p.url));
  }, [pendingPreviews]);

  // Sync picker search box to the description after picking.
  useEffect(() => { setSearch(draft.description ?? ''); }, [draft.description]);

  // Reflect external Unit Price changes (e.g. product pick → 0) into the
  // local text box, but leave the operator's in-progress typing untouched.
  useEffect(() => {
    const parsed = Math.round(Number(priceText) * 100) || 0;
    if (parsed !== draft.unitPriceSen) setPriceText((draft.unitPriceSen / 100).toFixed(2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.unitPriceSen]);

  const pickProduct = (p: MfgProductRow) => {
    setPicked(p);
    const category = p.category.toLowerCase();
    /* PR #141 — Sofa-set inherit: same-category follower lines copy the
       master's variants on pick. PR #147 — reset overriddenKeys on a fresh
       pick so cascade can repopulate everything cleanly. */
    const inherited = inheritVariantsByCategory?.[category];
    const seedVariants: Record<string, unknown> =
      inherited && Object.keys(inherited).length > 0 ? { ...inherited } : {};
    onChange({
      itemCode:       p.code,
      itemGroup:      category,
      description:    p.name,
      /* SO-SKU spec P4 (D4, Loo 2026-06-05) — the SELLING unit price defaults
         from the SKU Master's sell_price_sen (POS Master / Main Account
         authored), replacing the manual-0 default (Commander 2026-05-29 — that
         predates the cost/sell split; base_price_sen remains COST and still
         never auto-populates). The server recompute stays authoritative at
         save; sofa module / seat-height pools land their exact figure there. */
      unitPriceSen: p.sell_price_sen ?? 0,
      variants:       seedVariants,
      overriddenKeys: [],
    });
    setSearch(p.name);
  };

  /* Multi-add helpers (only meaningful when onAddProducts is wired). */
  const toggleMultiPick = (p: MfgProductRow) =>
    setMultiPicked((prev) =>
      prev.some((x) => x.id === p.id)
        ? prev.filter((x) => x.id !== p.id)
        : [...prev, p],
    );
  const commitMulti = () => {
    if (multiPicked.length === 0) return;
    const [first, ...rest] = multiPicked;
    // First selection fills THIS line — reuse pickProduct so inherit + cascade
    // + price seeding all fire exactly as a single pick would.
    if (first) pickProduct(first);
    if (rest.length > 0) onAddProducts?.(rest);
    setMultiPicked([]);
    setMultiMode(false);
    setShowPicker(false);
  };

  /* PR #136 — Auto-compute bedframe Total Height = Divan + Leg + Gap. */
  const parseInches = (s: unknown): number => {
    if (s === null || s === undefined) return 0;
    const m = String(s).match(/(-?\d+(?:\.\d+)?)/);
    return m && m[1] ? Number(m[1]) : 0;
  };
  const computedTotalHeight = useMemo(() => {
    if (category !== 'bedframe') return '';
    const d = parseInches(draft.variants.divanHeight);
    const l = parseInches(draft.variants.legHeight);
    const g = parseInches(draft.variants.gap);
    if (d === 0 && l === 0 && g === 0) return '';
    return `${d + l + g}"`;
  }, [category, draft.variants.divanHeight, draft.variants.legHeight, draft.variants.gap]);

  useEffect(() => {
    if (category !== 'bedframe') return;
    if (!computedTotalHeight) return;
    if (String(draft.variants.totalHeight ?? '') === computedTotalHeight) return;
    onChange({ variants: { ...draft.variants, totalHeight: computedTotalHeight } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computedTotalHeight, category]);

  /* PR #147 — Variant edits add the key to overriddenKeys so cascade
     leaves this line alone when LINE 1 changes.
     SO-parity (Loo 2026-06-06) — setVariants writes several keys atomically
     (a fabric pick lands fabricCode + colourId + fabricId + labels in ONE
     patch, mirroring what the POS handover payload sends per line). */
  const setVariants = (patch: Record<string, unknown>) => {
    const nextOverrides = Array.from(new Set([...(draft.overriddenKeys ?? []), ...Object.keys(patch)]));
    onChange({
      variants: { ...draft.variants, ...patch },
      overriddenKeys: nextOverrides,
    });
  };
  const setVariant = (k: string, v: string | number | string[]) => setVariants({ [k]: v });

  /* PR #127 — HOOKKA multi-select Special Orders. */
  const specialsList = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.map(String).filter(Boolean);
    if (typeof v === 'string' && v) return [v];
    return [];
  };

  /* MFG-PRICING-ENGINE — Build pricing inputs from the picked product +
     the fabric tracking row whose code matches the line's fabricCode
     variant. Pull the per-context tier (sofa_price_tier vs
     bedframe_price_tier) so the shared compute function can switch
     basePriceSen ↔ price1Sen exactly the same way the server does. */
  const pickedFabric: FabricTrackingRow | null = useMemo(() => {
    const code = String(draft.variants.fabricCode ?? '');
    if (!code) return null;
    return fabrics.find((f) => f.fabric_code === code) ?? null;
  }, [fabrics, draft.variants.fabricCode]);

  const pricingBreakdown = useMemo(() => {
    if (!picked) return null;
    const catU = category.toUpperCase() as MfgPricingProduct['category'];
    const tier: MfgFabricTier | null = pickedFabric
      ? (catU === 'SOFA'
          ? pickedFabric.sofa_price_tier ?? pickedFabric.price_tier ?? null
          : catU === 'BEDFRAME'
            ? pickedFabric.bedframe_price_tier ?? pickedFabric.price_tier ?? null
            : null)
      : null;
    const product: MfgPricingProduct = {
      category:         (picked.category as MfgPricingProduct['category']) ?? 'ACCESSORY',
      basePriceSen:     picked.base_price_sen ?? null,
      price1Sen:        picked.price1_sen ?? null,
      seatHeightPrices: picked.seat_height_prices ?? null,
    };
    const specs = specialsList(draft.variants.specials ?? draft.variants.special);
    /* SO-parity (Loo 2026-06-06) — price the picked specials from the
       special_addons defs via the SAME pure pool builder the server recompute
       uses (base sellingPriceSen + chosen-choice extras), instead of the
       legacy maintenance string pools. Keeps this preview honest with what
       POST /mfg-sales-orders will actually charge. */
    const choices = (draft.variants.specialChoices && typeof draft.variants.specialChoices === 'object')
      ? (draft.variants.specialChoices as Record<string, string[]>)
      : null;
    const specialsPool = buildSpecialsPoolFromAddons(specialDefs, specs, choices);
    const effMaint = maint ? { ...maint, specials: specialsPool, sofaSpecials: specialsPool } : maint;
    return computeMfgLinePrice(
      {
        product,
        fabric:        pickedFabric ? { tier, surchargeSen: 0 } : null,
        qty:           draft.qty,
        divanHeight:   (draft.variants.divanHeight as string | undefined) ?? null,
        legHeight:     (draft.variants.legHeight as string | undefined) ?? null,
        totalHeight:   (draft.variants.totalHeight as string | undefined) ?? null,
        specials:      specs,
        seatSize:      (draft.variants.seatHeight as string | undefined) ?? null,
        sofaLegHeight: (draft.variants.sofaLegHeight as string | undefined) ?? null,
      },
      effMaint,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, pickedFabric, draft.variants, category, draft.qty, maint, specialDefs]);

  /* Commander 2026-05-29 — the SELLING unit price is operator-authored. It
     defaults to 0 on product pick (see pickProduct) and is typed manually;
     it must NEVER be auto-overwritten from a computed value. The previous
     auto-recompute effect (which wrote computeMfgLinePrice's selling total
     into the Unit Price field) is intentionally removed. `pricingBreakdown`
     is kept ONLY to drive the read-only variant-surcharge display in the
     right rail — it does not write the editable Unit Price. */

  /* Commander 2026-05-29 — only show variant choices the SKU's Model allows
     (allowed_options). An empty/absent pool = no restriction. Stops the editor
     offering e.g. a leg height the SKU rejects on save (variant_not_allowed).
     SO-parity (Loo 2026-06-06) — `picked` only exists for a freshly-picked
     product; EDITING a saved line on SO Detail used to render unrestricted.
     Resolve the pools by item code too so saved lines filter identically.

     THIS DOES NOT MAKE variant_not_allowed UNREACHABLE, and reading it that way
     is what left a bedframe refusal with no message for months (2026-08-18).
     Filtering a picker can only cover fields that HAVE a picker: `totalHeight`
     is computed below and has no control here, and `size_code` / `compartment`
     come off the product row, so all three can still refuse on save. The
     refusal is now rendered for the operator on the error path — see
     vendor/scm/lib/refusal-detail.ts; do not add a second copy of that
     wording here.

     `restrictP`/`restrictS` also compare RAW, so a pool value spelled with a
     curly inch mark (prod's `gaps` pool holds ten of them) matches no
     maintenance value and the option is silently dropped from the dropdown.
     The SERVER-side gate folds those spellings now (allowed-options-check.ts
     `inPool`); these two filters deliberately still do not, because widening
     them CHANGES WHICH OPTIONS APPEAR — an owner's call, not a bug fix. */
  const allowedByCodeQ = useModelAllowedOptionsByCode(draft.itemCode || undefined);
  const allowOpts = picked?.allowed_options ?? allowedByCodeQ.data ?? null;
  const restrictP = (opts: Array<{ value: string; priceSen: number }>, pool?: string[] | null) =>
    (Array.isArray(pool) && pool.length > 0) ? opts.filter((o) => pool.includes(o.value)) : opts;
  const restrictS = (opts: string[], pool?: string[] | null) =>
    (Array.isArray(pool) && pool.length > 0) ? opts.filter((o) => pool.includes(o)) : opts;

  /* ── Fabrics picker (SO-parity, Loo 2026-06-06 · SERVER-typeahead 2026-07-14) ──
     Scaling (owner #1 pain): the fabric picker used to pull EVERY active
     fabric_colours row on every line card and render them all as <option>s.
     It is now a searchable combobox (FabricColourCombobox) backed by
     GET /fabric-colours?q= (see useFabricColoursSearch). The pool/inactive
     filters that used to prune the option list are handed to the combobox,
     which applies them to the SERVER results:
       • pool  = Model's allowed_options.fabrics (colour codes). Non-empty =
                 restrict (same as the server gate); empty/null = any active.
       • inactive = fabric_trackings.is_active===false (Migration 0167) — hidden
                 from NEW picks; a saved line's deactivated code still displays.
     A saved line's fabric ALWAYS renders (the combobox shows the stored code),
     so the picker never blanks a previously-selected fabric. */
  const inactiveFabricCodes = useMemo(
    () => new Set(fabrics.filter((f) => f.is_active === false).map((f) => f.fabric_code)),
    [fabrics],
  );

  /* Picking a colour writes the SAME variant keys the POS handover payload
     sends (pos-handover-so.ts buildVariants): fabricCode + colourId satisfy
     the server's allowed-fabric gate + cost lookup; fabricId (the SERIES,
     fabric_library.id) is what the selling fabric-tier add-on keys on — the
     Backend never sent it before, so a configured tier Δ silently priced
     RM 0 on Backend-keyed lines. Now takes the full FabricColourRow straight
     from the combobox's selection (identical shape to the old library row), so
     the written variant payload is byte-for-byte what the <select> produced. */
  const pickFabricColour = (c: FabricColourRow) => {
    const colourId = c.colourId;
    const seriesLabel = (fabricLibQ.data ?? []).find((f) => f.id === c.fabricId)?.label ?? null;
    setVariants({
      fabricCode: colourId,
      colourId,
      fabricId: c.fabricId,
      ...(seriesLabel ? { fabricLabel: seriesLabel } : {}),
      ...(c.label ? { colourLabel: c.label } : {}),
      ...(c.swatchHex ? { colourHex: c.swatchHex } : {}),
    });
  };

  /* ── Special Add-ons (SO-parity, Loo 2026-06-06) ──────────────────────
     Active special_addons rows for this line's category, intersected with the
     Model's allowed_options.specials pool. Owner 2026-07-14 — the pool is now
     OPT-OUT, matching the height pools + the backend (allowed-options-check
     only gates specials when the pool is non-empty; honest-pricing prices any
     picked code): an EMPTY/absent pool ⇒ offer ALL active specials for the
     category; a NON-EMPTY pool restricts to the ticked codes. */
  const catUpper = category.toUpperCase();
  const specialOptions = useMemo(() => {
    const pool = allowOpts?.specials;
    const restricted = Array.isArray(pool) && pool.length > 0;
    const allowed = new Set(pool ?? []);
    return specialDefs.filter(
      (a) => a.active && a.categories.includes(catUpper) && (!restricted || allowed.has(a.code)),
    );
  }, [specialDefs, catUpper, allowOpts]);

  /* Commander 2026-05-29 — the right-rail "Pricing" summary reflects the
     operator-authored SELLING unit price, not a computed cost base. extraSen
     collapses the SELLING variant surcharges (sellingPriceSen via
     computeMfgLinePrice) — 0 today, non-zero only once a Sales Director sets
     a selling surcharge. The product's cost base is never shown here as the
     selling base. */
  const extraSen = pricingBreakdown
    ? pricingBreakdown.divanSurchargeSen
    + pricingBreakdown.legSurchargeSen
    + pricingBreakdown.totalHeightSurchargeSen
    + pricingBreakdown.specialsSurchargeSen
    + pricingBreakdown.fabricSurchargeSen
    : 0;

  const lineTotal = useMemo(
    () => Math.max(0, draft.qty * draft.unitPriceSen - draft.discountSen),
    [draft.qty, draft.unitPriceSen, draft.discountSen],
  );

  /* Colour KIV (owner 2026-07-24, SO-2607-016) — the line committed to a
     fabric SERIES but the colour is still open. The Fabrics box already shows
     the required-red border; this names WHY it is red and what blocks next:
     the server refuses a Processing Date while any line is still KIV. */
  const colourKiv = isColourKiv(draft.variants);
  const badge = CATEGORY_BADGE[category] ?? CATEGORY_BADGE.others!;
  /* Drive the configurator off the EFFECTIVE category (resolved above), NOT the
     raw persisted itemGroup — so a scan/backdoor sofa/bedframe draft whose
     itemGroup came in generic still renders its fabric/seat/leg configurator and
     requires those variants, exactly like a manually-picked line (owner
     2026-07-13). */
  const hasVariants = Boolean(draft.itemCode) && Boolean(maint) && (category === 'bedframe' || category === 'sofa');
  const specials = specialsList(draft.variants.specials ?? draft.variants.special);
  const posRemarkSpecial = posRemarkSpecialOf(draft.variants);
  /* SO-parity (Loo 2026-06-06) — mattress lines can carry Special Add-ons too
     (POS prices MATTRESS specials since PR #456). Render JUST the accordion
     for them — no fabric/height grid. Hidden until a mattress Model has
     specials ticked in Modular (none today) or the line already carries one
     (a configured pick OR the POS remark/extra special). */
  const hasMattressSpecials = Boolean(draft.itemCode) && category === 'mattress'
    && (specialOptions.length > 0 || specials.length > 0 || posRemarkSpecial != null);

  /* ── Render ─────────────────────────────────────────────────────── */

  // Keep the portal'd SKU dropdown pinned under its input while open; reposition
  // on scroll/resize so it tracks the page.
  useEffect(() => {
    if (!showPicker || !isEditing) { setMenuPos(null); return; }
    const update = () => {
      const el = pickerWrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setMenuPos({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [showPicker, isEditing]);

  return (
    <div className={styles.card}>
      {/* ── Main single row ────────────────────────────────────────── */}
      <div className={styles.row}>
        {/* 1. No # */}
        <span className={styles.lineNo}>{index + 1}</span>

        {/* 2. Item picker (SKU search → the picked line names itself ONCE) */}
        <div className={styles.pickerWrap} ref={pickerWrapRef}>
          {draft.itemCode && search === draft.description && !showPicker ? (
            <button
              type="button"
              className={styles.input}
              style={{ textAlign: 'left', cursor: isEditing ? 'pointer' : 'not-allowed', padding: '2px 8px', height: 'auto', minHeight: 28 }}
              disabled={!isEditing}
              /* Owner 2026-08-09 — opening the picker must NOT lose the
                 current SKU: keep the description visible (select-all so
                 typing replaces it), and blur-without-pick restores it. */
              onClick={() => { setShowPicker(true); setSearch(draft.description ?? ''); }}
              title="Click to change product"
            >
              {/* Description ONCE, code NOT displayed — the shared rule
                  (vendor/shared/line-identity.ts). The dropdown BELOW this
                  button has shown description-only since Commander 2026-05-27
                  ("picker rows show description only — one scannable line per
                  SKU. The code still binds on click"); the PICKED line kept
                  showing code-over-description, so the same row contradicted the
                  list it was chosen from. The code still BINDS — draft.itemCode
                  is untouched and still travels to the payload; the button's own
                  gate compares `search` against `description`, not the code. */}
              <div className={styles.pickerInputCol}>
                <span className={styles.pickerCode}>
                  {lineIdentity({ code: draft.itemCode, description: draft.description }).primary}
                </span>
              </div>
            </button>
          ) : (
            <>
              <input
                className={styles.input}
                /* Scan-Order no-match (Task #73) — surface the slip's rawText as
                   the placeholder so the operator sees what was written while
                   picking a real SKU, without it being committed as a value. */
                placeholder={searchHint ? `Slip: ${searchHint} — pick a SKU` : 'Click to pick or type to filter…'}
                value={search}
                disabled={!isEditing}
                /* Owner 2026-08-08 ("square pillow") — typed text that matches
                   NO catalog product can never become a line; the red ring +
                   the note below say so while KEEPING the text for correction.
                   The parent save guards refuse the line either way — this is
                   the inline signal, not the gate. */
                style={unmatchedFreeText ? { borderColor: 'var(--c-festive-b, #B8331F)' } : undefined}
                autoFocus
                onFocus={(e) => { setShowPicker(true); e.currentTarget.select(); }}
                onBlur={() => setTimeout(() => {
                  setShowPicker(false);
                  /* No new pick — bring the picked SKU back (owner 2026-08-09:
                     "点了也不会不见,可以继续 search 别的,再换"). */
                  if (draft.itemCode && draft.description) setSearch(draft.description);
                }, 150)}
                onChange={(e) => { setSearch(e.target.value); setShowPicker(true); }}
              />
              {unmatchedFreeText && !showPicker && (
                <div style={{ fontSize: 10.5, lineHeight: 1.35, color: 'var(--c-festive-b, #B8331F)', marginTop: 2 }}>
                  Not in the catalog — pick a product from the list; free-typed lines cannot be saved.
                </div>
              )}
            </>
          )}
          {showPicker && isEditing && menuPos && createPortal(
            /* Portal to body + position:fixed so the dropdown escapes the
               section card's overflow:hidden clip and floats over whatever is
               below (e.g. the next card). Inline top/left/width override the
               class's absolute top:100%/left/right. */
            <ul
              className={styles.suggestList}
              style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, width: menuPos.width, right: 'auto', marginTop: 0, zIndex: 1000 }}
            >
              {multiEnabled && candidates.length > 0 && (
                /* Multi-add toggle (MobileSkuPicker.onPickMany parity). onMouseDown
                   + preventDefault keeps the search input focused so the portal
                   stays open while ticking rows. */
                <li
                  className={styles.suggestItem}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', fontWeight: 600 }}
                  onMouseDown={(e) => { e.preventDefault(); setMultiMode((m) => !m); if (multiMode) setMultiPicked([]); }}
                >
                  <span>{multiMode ? 'Add multiple — tap to tick' : '+ Add several at once'}</span>
                  <span style={{ color: 'var(--fg-muted)', fontSize: 11 }}>
                    {multiMode ? 'single-pick' : 'multi'}
                  </span>
                </li>
              )}
              {candidates.length > 0 ? (
                /* Commander 2026-05-27: picker rows show description only — one
                   scannable line per SKU. The code still binds on click. */
                candidates.slice(0, 50).map((p) => {
                  const ticked = multiMode && multiPicked.some((x) => x.id === p.id);
                  return (
                    <li
                      key={p.id}
                      className={styles.suggestItem}
                      style={multiMode ? { display: 'flex', alignItems: 'center', gap: 8 } : undefined}
                      onMouseDown={(e) => {
                        if (multiMode) { e.preventDefault(); toggleMultiPick(p); }
                        else { pickProduct(p); setShowPicker(false); }
                      }}
                    >
                      {multiMode && (
                        <input type="checkbox" readOnly checked={ticked} style={{ pointerEvents: 'none' }} />
                      )}
                      <div className={styles.suggestItemMeta}>
                        {p.name}
                      </div>
                    </li>
                  );
                })
              ) : (
                <li className={styles.suggestItem} style={{ color: 'var(--fg-muted)', cursor: 'default' }}>
                  {/* Task #102 — Distinguish "type more" (gate hasn't tripped)
                      from "no matches" (server returned []). */}
                  {trimmedSearch.length < 2
                    ? 'Type at least 2 characters to search…'
                    : productsQuery.isFetching
                      ? 'Searching…'
                      : `No products match "${trimmedSearch}".`}
                </li>
              )}
              {multiMode && multiPicked.length > 0 && (
                <li
                  className={styles.suggestItem}
                  style={{ position: 'sticky', bottom: 0, background: 'var(--accent, #16695f)', color: '#fff', textAlign: 'center', fontWeight: 700, cursor: 'pointer' }}
                  onMouseDown={(e) => { e.preventDefault(); commitMulti(); }}
                >
                  Add {multiPicked.length} product{multiPicked.length > 1 ? 's' : ''}
                </li>
              )}
            </ul>,
            document.body,
          )}
        </div>

        {/* 3. Remarks */}
        <input
          className={styles.input}
          placeholder="Type remarks…"
          value={draft.remark}
          disabled={!isEditing}
          onChange={(e) => onChange({ remark: e.target.value })}
        />

        {/* 4. Qty */}
        <input
          type="number"
          min={1}
          className={styles.numericInput}
          value={draft.qty === 0 ? '' : draft.qty}
          disabled={!isEditing}
          onChange={(e) => {
            const v = e.target.value;
            onChange({ qty: v === '' ? 0 : (parseInt(v) || 0) });
          }}
          onBlur={(e) => {
            if (!e.target.value || parseInt(e.target.value) <= 0) onChange({ qty: 1 });
          }}
        />

        {/* 5. Unit Price — D4: locked to the SKU Master sell price below admin.
             Uses a distinctive brass-tinted `.priceInput` (2026-07-09) so the
             amount cell is impossible to miss between the qty and date
             columns that sit either side of it. */}
        <input
          type="number"
          step="0.01"
          className={styles.priceInput}
          value={priceText}
          disabled={!isEditing || !canEditPrice}
          title={!canEditPrice ? 'Price follows the SKU Master sell price — admin can override' : undefined}
          onChange={(e) => {
            const t = e.target.value;
            setPriceText(t);
            onChange({ unitPriceSen: Math.round(Number(t) * 100) || 0 });
          }}
          onBlur={() => setPriceText((draft.unitPriceSen / 100).toFixed(2))}
        />

        {/* 6. Delivery Date (2990 addition between Unit Price and Amount) */}
        <DateField
          fullWidth
          className={styles.input}
          value={draft.lineDeliveryDate ?? ''}
          disabled={!isEditing}
          title={!draft.lineDeliveryDateOverridden && draft.lineDeliveryDate ? 'Auto-inherited from SO header' : undefined}
          onChange={(iso) => onChange({
            lineDeliveryDate: iso || null,
            lineDeliveryDateOverridden: true,
          })}
          style={
            !draft.lineDeliveryDateOverridden && draft.lineDeliveryDate
              ? { borderColor: 'var(--c-orange)', background: 'var(--c-cream)' }
              : undefined
          }
        />

        {/* 7. Amount */}
        <span className={styles.amount}>{fmtRm(lineTotal)}</span>

        {/* 8. Group badge */}
        <span className={styles.badge} style={{ background: badge.bg, color: badge.fg }}>
          {badge.label}
        </span>

        {/* 9. Trash — hidden when not editing */}
        {isEditing ? (
          <button
            type="button"
            title="Remove this line"
            onClick={onRemove}
            disabled={!canRemove}
            className={styles.trashBtn}
          >
            <Trash2 {...SM_ICON} />
          </button>
        ) : <span />}
      </div>

      {/* ── Two-column body (Commander 2026-05-27 redesign) ──────────
          LEFT  = variants + specials (the "fat" content)
          RIGHT = price summary + photos (the always-visible context)
          The body only renders when there's something to show on either
          side, i.e. picked a product OR have variants. On a fresh empty
          card with no SKU picked yet we collapse to just the header row.

          Commander 2026-05-27 (Fix 2): mattress / accessory / others have no
          per-line variants, so bodyLeft is skipped entirely for them.

          Owner 2026-07-16 ("這些長行的 UI upload photo 為什麼不要放右邊 可以
          重新mockup 協調") — the grid NO LONGER collapses to a single `1fr`
          track when there are no variants. That collapse is exactly what made
          a variant-less line (e.g. a mattress) render its PHOTOS block
          full-width UNDERNEATH the row while a bedframe line put the same
          block in a tidy right rail: with one track and bodyLeft skipped, the
          rail was the only child and took the whole width. The two-track grid
          is now unconditional and bodyRight is pinned to track 2 (see the
          module CSS), so the photo rail holds the right edge on EVERY line and
          the left of a variant-less line is simply the empty track. */}
      {(picked || hasVariants || hasMattressSpecials || canShowPhotos) && (
      <div className={styles.body}>
        {(hasVariants || hasMattressSpecials) && <div className={styles.bodyLeft}>
      {hasVariants && category === 'bedframe' && (
        <div className={styles.variants}>
          <div className={styles.variantsHead}>BEDFRAME VARIANTS</div>
          <div className={styles.variantsGrid}>
            <FabricColourCombobox
              label="Fabrics" required={variantsRequired}
              value={String(draft.variants.fabricCode ?? '')}
              disabled={!isEditing}
              pool={allowOpts?.fabrics ?? null}
              inactiveCodes={inactiveFabricCodes}
              onSelect={pickFabricColour}
            />
            <VariantSelect
              label="Gaps" required={variantsRequired}
              value={String(draft.variants.gap ?? '')}
              disabled={!isEditing}
              options={sortByNumeric(restrictS(maintPickerValues(maint!.gaps, String(draft.variants.gap ?? '')), allowOpts?.gaps).map((g) => ({ value: g, priceSen: 0 })))}
              onChange={(v) => setVariant('gap', v)}
            />
            <VariantSelect
              label="Divan Heights" required={variantsRequired}
              value={String(draft.variants.divanHeight ?? '')}
              disabled={!isEditing}
              options={sortByNumeric(restrictP(activeOptions(maint!.divanHeights, String(draft.variants.divanHeight ?? '')), allowOpts?.divan_heights))}
              onChange={(v) => setVariant('divanHeight', v)}
            />
            <VariantSelect
              label="Leg Heights" required={variantsRequired}
              value={String(draft.variants.legHeight ?? '')}
              disabled={!isEditing}
              options={sortByNumeric(restrictP(activeOptions(maint!.legHeights, String(draft.variants.legHeight ?? '')), allowOpts?.leg_heights))}
              onChange={(v) => setVariant('legHeight', v)}
            />
          </div>
          {colourKiv && (
            <div style={{ fontSize: 'var(--fs-11)', fontWeight: 600, color: 'var(--c-festive-b, #B8331F)' }}>
              Colour KIV — confirm the colour before a Processing Date can be set.
            </div>
          )}
          {/* Computed Total Height marker — Houzs shows this read-only;
              we surface it as a small inline hint instead of a 5th cell. */}
          {computedTotalHeight && (
            <div style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
              Total height (auto):{' '}
              <strong style={{ color: 'var(--c-ink)', fontVariantNumeric: 'tabular-nums' }}>
                {computedTotalHeight}
              </strong>{' '}
              (Divan + Leg + Gap)
            </div>
          )}
          <SpecialOrders
            open={specialsOpen}
            onToggle={() => setSpecialsOpen((o) => !o)}
            options={specialOptions}
            variants={draft.variants}
            onPatch={setVariants}
            disabled={!isEditing}
            showPrices={showPrices}
          />
        </div>
      )}

      {hasVariants && category === 'sofa' && (
        <div className={styles.variants}>
          <div className={styles.variantsHead}>SOFA VARIANTS</div>
          <div className={styles.variantsGrid}>
            <FabricColourCombobox
              label="Fabrics" required={variantsRequired}
              value={String(draft.variants.fabricCode ?? '')}
              disabled={!isEditing}
              pool={allowOpts?.fabrics ?? null}
              inactiveCodes={inactiveFabricCodes}
              onSelect={pickFabricColour}
            />
            <VariantSelect
              label="Seat Heights" required={variantsRequired}
              value={String(draft.variants.seatHeight ?? '')}
              disabled={!isEditing}
              options={sortByNumeric(restrictS(maintPickerValues(maint!.sofaSizes, String(draft.variants.seatHeight ?? '')), allowOpts?.sizes).map((s) => {
                const sh = picked?.seat_height_prices && Array.isArray(picked.seat_height_prices)
                  ? (picked.seat_height_prices as Array<{ height: string; tier: string; priceSen: number }>)
                      .find((p) => p.height === s && p.tier === 'PRICE_2')
                  : null;
                return { value: s, priceSen: sh?.priceSen ?? 0 };
              }))}
              onChange={(v) => setVariant('seatHeight', v)}
            />
            {/* Owner 2026-07-13 — the sofa Leg Height carries a standing
                "Default" option (RM 0.00) and is auto-seeded (see heal effect),
                so it is NOT a required-empty field and never blocks Confirm. */}
            <VariantSelect
              label="Leg Heights"
              value={String(draft.variants.legHeight ?? '')}
              disabled={!isEditing}
              options={sortByNumeric(restrictP(activeOptions(maint!.sofaLegHeights, String(draft.variants.legHeight ?? '')), allowOpts?.leg_heights))}
              onChange={(v) => setVariant('legHeight', v)}
            />
            {/* Empty cell so the 4-col grid stays balanced */}
            <span />
          </div>
          {colourKiv && (
            <div style={{ fontSize: 'var(--fs-11)', fontWeight: 600, color: 'var(--c-festive-b, #B8331F)' }}>
              Colour KIV — confirm the colour before a Processing Date can be set.
            </div>
          )}
          <SpecialOrders
            open={specialsOpen}
            onToggle={() => setSpecialsOpen((o) => !o)}
            options={specialOptions}
            variants={draft.variants}
            onPatch={setVariants}
            disabled={!isEditing}
            showPrices={showPrices}
          />
        </div>
      )}

      {hasMattressSpecials && (
        <div className={styles.variants}>
          <div className={styles.variantsHead}>MATTRESS ADD-ONS</div>
          <SpecialOrders
            open={specialsOpen}
            onToggle={() => setSpecialsOpen((o) => !o)}
            options={specialOptions}
            variants={draft.variants}
            onPatch={setVariants}
            disabled={!isEditing}
            showPrices={showPrices}
          />
        </div>
      )}

        </div>}
        {/* /bodyLeft */}

        {/* ── Right rail (price summary + photos) ───────────────── */}
        <div className={styles.bodyRight}>
          {/* Price summary — only meaningful once a SKU is picked. */}
          {picked && (
            <div className={styles.priceSummary}>
              <div className={styles.priceSummaryHead}>
                <span>Pricing</span>
              </div>
              {/* Commander 2026-05-29 — selling unit price is operator-typed.
                  Show the manually-entered Unit Price (not a computed cost
                  base). Variant selling surcharges only surface once a Sales
                  Director sets them (sellingPriceSen) — 0 today. */}
              {extraSen > 0 && (
                <div className={styles.priceRow}>
                  <span className={styles.priceLabel}>+ Variants</span>
                  <span className={styles.priceValue}>{fmtRm(extraSen)}</span>
                </div>
              )}
              <div className={styles.priceRow}>
                <span className={styles.priceLabel}>
                  Unit × {draft.qty}
                </span>
                <span className={styles.priceValue}>{fmtRm(draft.unitPriceSen)}</span>
              </div>
              {draft.discountSen > 0 && (
                <div className={styles.priceRow}>
                  <span className={styles.priceLabel}>− Discount</span>
                  <span className={styles.priceValue}>{fmtRm(draft.discountSen)}</span>
                </div>
              )}
              <div className={styles.priceTotalRow}>
                <span className={styles.priceLabel}>Subtotal</span>
                <span className={styles.priceTotalValue}>{fmtRm(lineTotal)}</span>
              </div>
            </div>
          )}

          {/* Photos — saved mode (R2 thumbs) + draft mode (object-URL
              previews staged on the draft). canStagePhotos === !isSaved
              && isEditing; canMutatePhotos === isSaved && isEditing. */}
          {canShowPhotos && (
            <div className={styles.photosCard}>
              <div className={styles.photosHead}>
                PHOTOS
                {(photoUrls.length > 0 || pendingFiles.length > 0) && (
                  <span style={{ marginLeft: 6, color: 'var(--c-ink)', fontWeight: 600 }}>
                    · {photoUrls.length + pendingFiles.length}
                  </span>
                )}
              </div>
              <div className={styles.photosStrip}>
                {/* Saved photos (R2 signed URL thumbs) */}
                {photoUrls.map((key) => (
                  <PhotoThumb
                    key={key}
                    photoKey={key}
                    docNo={docNo}
                    itemId={itemId}
                    canDelete={canMutatePhotos && !deletePhoto.isPending}
                    onDelete={() => {
                      if (!docNo || !itemId) return;
                      deletePhoto.mutate({ docNo, itemId, photoKey: key }, {
                        onSuccess: () => {
                          onChange({ photoUrls: photoUrls.filter((k) => k !== key) });
                        },
                      });
                    }}
                  />
                ))}

                {/* Pending (DRAFT) photos — preview from object URL with
                    a small "pending" stripe + a delete X that removes
                    the File from the staged array. */}
                {pendingPreviews.map((p, i) => (
                  <div key={`pending-${i}`} className={styles.photoTile}>
                    <img src={p.url} alt={p.name} />
                    <span className={styles.photoPendingMark}>pending</span>
                    {canStagePhotos && (
                      <button
                        type="button"
                        className={styles.photoDelete}
                        title="Remove (not uploaded yet)"
                        onClick={() => {
                          const next = pendingFiles.filter((_, idx) => idx !== i);
                          onChange({ pendingPhotoFiles: next });
                        }}
                      >
                        <X size={12} strokeWidth={2.5} />
                      </button>
                    )}
                  </div>
                ))}

                {/* Hidden file input + Add button. The same input is used
                    for both saved (immediate upload) and draft (stage in
                    component-state) modes. */}
                {(canMutatePhotos || canStagePhotos) && (
                  <>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      style={{ display: 'none' }}
                      onChange={async (e) => {
                        const files = Array.from(e.target.files ?? []);
                        if (files.length === 0) return;

                        if (canStagePhotos) {
                          // DRAFT mode — stage Files on the draft. Parent
                          // drains pendingPhotoFiles after the line saves.
                          onChange({ pendingPhotoFiles: [...pendingFiles, ...files] });
                          if (fileInputRef.current) fileInputRef.current.value = '';
                          return;
                        }

                        // SAVED mode — upload immediately to R2.
                        if (!docNo || !itemId) return;
                        const newKeys: string[] = [];
                        for (const f of files) {
                          try {
                            const res = await uploadPhoto.mutateAsync({ docNo, itemId, file: f });
                            newKeys.push(res.photoKey);
                            // Task #92 — seed the signed-URL cache with
                            // the URL the API just minted so PhotoThumb
                            // doesn't do a redundant /signed round-trip
                            // on first render of the just-uploaded photo.
                            // WO-7 — carry the thumbUrl the same way.
                            // The startsWith('http') filter is load-bearing:
                            // the upload route's OWN signing fallback returns
                            // photoUrl as a RELATIVE proxy path, which an
                            // <img src> cannot use. Filtered here, the cache
                            // holds only <img>-loadable URLs by construction.
                            if (res.expiresAt && res.photoUrl?.startsWith('http')) {
                              cacheSoLinePhotoSignedUrl(res.photoKey, {
                                signedUrl: res.photoUrl,
                                thumbUrl: res.thumbUrl,
                                expiresAt: new Date(res.expiresAt).getTime(),
                              });
                            }
                          } catch (err) {
                            // eslint-disable-next-line no-console
                            console.error('[so-line-photo] upload failed:', err);
                            notify({ title: `Photo upload failed for ${f.name}`, body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
                          }
                        }
                        if (newKeys.length > 0) {
                          onChange({ photoUrls: [...photoUrls, ...newKeys] });
                        }
                        if (fileInputRef.current) fileInputRef.current.value = '';
                      }}
                    />
                    <button
                      type="button"
                      className={styles.photoAddBtn}
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploadPhoto.isPending}
                      title={
                        uploadPhoto.isPending
                          ? 'Uploading…'
                          : canStagePhotos
                            ? 'Stage photo (uploads on save)'
                            : 'Add photo'
                      }
                    >
                      <ImagePlus {...ICON} />
                    </button>
                  </>
                )}

                {!canMutatePhotos && !canStagePhotos
                  && photoUrls.length === 0 && pendingFiles.length === 0 && (
                  <span className={styles.photoHint}>
                    Read-only — photos can be edited in edit mode.
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
        {/* /bodyRight */}
      </div>
      )}
      {/* /body */}
    </div>
  );
};
SoLineCardInner.displayName = 'SoLineCard';

/* Task #103 — Wrapped in React.memo with the default shallow comparator.
   With the SO Detail page now passing stable per-row callbacks
   (rowCallbacks Map + patchAddingDraft useCallback), the memo skips
   re-renders when an unrelated row's draft state, an unrelated parent
   state (History drawer toggle, Edit-mode flip, payment table activity),
   or the routinely-stable header useQuery cache result changes. */
export const SoLineCard = memo(SoLineCardInner);

/* ──────────────────────────────────────────────────────────────────────
   VariantSelect — uniform <select> with label + optional "+RM x.xx" suffix
   ────────────────────────────────────────────────────────────────────── */

const VariantSelect = ({
  label, options, value, onChange, disabled = false, required = false,
}: {
  label:    string;
  /* Commander 2026-05-28: `priceSen` is COST and must NOT surface in the SO
     create/edit flow. The option label shows the SELLING surcharge only
     (`sellingPriceSen`), and only when a Sales Director has set one (> 0).
     Today sellingPriceSen is unset, so dropdowns render clean ("10"`, `16"`)
     with no MYR cost numbers — exactly what the commander asked for. */
  options:  Array<{ value: string; priceSen: number; sellingPriceSen?: number; display?: string }>;
  value:    string;
  disabled?: boolean;
  /* Commander 2026-05-28: variants are mandatory — a salesperson must NOT be
     able to proceed without picking. When required + empty, the field shows a
     red ring and Save is blocked upstream (SO New / SO Detail). */
  required?: boolean;
  onChange: (v: string) => void;
}) => {
  const invalid = required && !value;
  /* SO-parity (Loo 2026-06-06) — saved lines can hold a value the Model's
     allowed_options pool no longer offers (now that pools also filter on SO
     Detail). Render it as "(current)" instead of blanking the select — the
     coordinator can see what's on the line and re-pick a live option. */
  const hasCurrent = Boolean(value) && options.some((o) => o.value === value);
  return (
    <label className={styles.variantField}>
      <span className={styles.variantLabel}>{label}{required ? ' *' : ''}</span>
      <select
        className={styles.select}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={invalid && !disabled ? { borderColor: 'var(--c-festive-b, #B8331F)' } : undefined}
      >
        {/* Commander 2026-05-28: no selectable blank "—" — the placeholder is
            disabled so it can't be chosen to "proceed without selecting". */}
        <option value="" disabled>Select…</option>
        {value && !hasCurrent && <option value={value}>{value} (current)</option>}
        {options.map((o) => {
          const sell = o.sellingPriceSen ?? 0;
          return (
            <option key={o.value} value={o.value}>
              {o.display ?? o.value}{sell > 0 ? ` (+${fmtRm(sell)})` : ''}
            </option>
          );
        })}
      </select>
    </label>
  );
};

/* ──────────────────────────────────────────────────────────────────────
   FabricColourCombobox — searchable, server-typeahead fabric picker.

   Owner #1 scaling pain (2026-07-14): the fabric field used to be a native
   <select> whose <option>s were EVERY active fabric_colours row (via
   useFabricColoursActive), rendered on every line card. This replaces it with
   a combobox that mirrors this file's PROVEN SKU picker: a text input that, on
   >= 2 typed chars, queries useFabricColoursSearch (GET /fabric-colours?q=…,
   capped at 50 server-side), shows the matches in a body-portalled dropdown,
   and commits a full FabricColourRow on click (identical shape to a library
   row — so pickFabricColour writes the same variant payload the <select> did).

   The pool (Model allowed_options.fabrics) + inactive (fabric_trackings
   is_active) filters are applied to the SERVER results here. CRITICAL: the
   selected value ALWAYS displays — when the picker is closed the input shows
   the stored code (`value`), so a saved SO/CO line renders its fabric even
   when it isn't in the current typeahead result set. A selection is NEVER
   blanked.
   ────────────────────────────────────────────────────────────────────── */

const FabricColourCombobox = ({
  label, value, onSelect, disabled = false, required = false, pool, inactiveCodes,
}: {
  label:    string;
  /** Selected colour code (draft.variants.fabricCode). Shown verbatim when closed. */
  value:    string;
  /** Non-empty = restrict to these colour codes (Model allowed_options.fabrics). */
  pool?:    string[] | null;
  /** fabric_trackings.is_active===false codes — hidden from NEW picks (Mig 0167). */
  inactiveCodes: Set<string>;
  disabled?: boolean;
  required?: boolean;
  onSelect: (c: FabricColourRow) => void;
}) => {
  const [open, setOpen]     = useState(false);
  const [search, setSearch] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);

  /* Same debounce + length>=2 + open gate the SKU picker uses, so the query
     only fires while the operator is actively picking. */
  const debounced = useDebouncedValue(search, 200);
  const trimmed   = debounced.trim();
  const coloursQ  = useFabricColoursSearch(trimmed, { enabled: open && trimmed.length >= 2 });

  /* Apply the pool + inactive gates to the SERVER results (the old option-list
     prune, moved server-side of the fetch). Cap at 50 like the SKU picker. */
  const results = useMemo(() => {
    const rows = coloursQ.data ?? [];
    const restricted = Array.isArray(pool) && pool.length > 0;
    const allow = new Set(pool ?? []);
    return rows
      .filter((c) => !inactiveCodes.has(c.colourId))
      .filter((c) => !restricted || allow.has(c.colourId))
      .slice(0, 50);
  }, [coloursQ.data, pool, inactiveCodes]);

  /* Pin the portalled dropdown under the input (escapes the card's
     overflow:hidden clip), tracking scroll/resize — same as the SKU picker. */
  useEffect(() => {
    if (!open || disabled) { setMenuPos(null); return; }
    const update = () => {
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setMenuPos({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, disabled]);

  const invalid = required && !value;

  return (
    <label className={styles.variantField}>
      <span className={styles.variantLabel}>{label}{required ? ' *' : ''}</span>
      <div ref={wrapRef} style={{ position: 'relative' }}>
        <input
          className={styles.select}
          /* Closed → show the selected code (NEVER blank a saved fabric).
             Open  → show the operator's live search term. */
          value={open ? search : value}
          placeholder={value ? undefined : 'Type 2+ chars to search…'}
          disabled={disabled}
          /* Owner 2026-08-09 — like the native Divan/Gap selects, opening must
             KEEP the current value in view: seed the search with it and
             select-all so typing replaces. Blur already restores `value`. */
          onFocus={(e) => { setOpen(true); setSearch(value ?? ''); e.currentTarget.select(); }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => { setSearch(e.target.value); setOpen(true); }}
          style={invalid && !disabled ? { borderColor: 'var(--c-festive-b, #B8331F)' } : undefined}
          title={value || undefined}
        />
        {open && !disabled && menuPos && createPortal(
          <ul
            className={styles.suggestList}
            style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, width: menuPos.width, right: 'auto', marginTop: 0, zIndex: 1000 }}
          >
            {results.length > 0 ? (
              /* Owner 2026-06-23: show ONLY the fabric code — the code IS the
                 fabric's identity. onMouseDown + preventDefault keeps the input
                 focused so the portal doesn't blur-close before the pick lands. */
              results.map((c) => (
                <li
                  key={c.colourId}
                  className={styles.suggestItem}
                  onMouseDown={(e) => { e.preventDefault(); onSelect(c); setSearch(''); setOpen(false); }}
                >
                  {c.colourId}
                </li>
              ))
            ) : (
              <li className={styles.suggestItem} style={{ color: 'var(--fg-muted)', cursor: 'default' }}>
                {trimmed.length < 2
                  ? 'Type at least 2 characters to search…'
                  : coloursQ.isFetching
                    ? 'Searching…'
                    : `No fabrics match "${trimmed}".`}
              </li>
            )}
          </ul>,
          document.body,
        )}
      </div>
    </label>
  );
};

/* ──────────────────────────────────────────────────────────────────────
   Required-variant validation (Commander 2026-05-28: "一定要选东西才能
   proceed"). Given a line's itemGroup + variants, returns the labels of the
   mandatory variants that are still empty. Only sofa / bedframe lines carry
   variants; everything else returns []. Callers (SO New + SO Detail Save)
   block the save when any line reports a non-empty list.

   2026-06-04 — delegates to the shared so-variant-rule so the rule matches
   the server 409 gate AND recognises the POS vocabulary: a POS-created sofa
   line carries depth + sofaLegHeight for the same physical picks coordinators
   key in as seatHeight + legHeight. The old hand-copied key list flagged
   every POS sofa SO "missing Seat Height / Leg Height" and blocked Save.
   ────────────────────────────────────────────────────────────────────── */
export function missingRequiredVariants(
  itemGroup: string | null | undefined,
  variants: Record<string, unknown> | null | undefined,
  /* REQUIRED, like the rule it wraps. A wrapper that keeps the parameter
     optional re-opens the hole one layer up: the DIVAN ONLY / adjustable-bed
     exemptions key off this code, and a caller that omits it silently gets the
     un-exempted answer with no compile error. Pass null where there is
     genuinely no code — nothing is exempted then. */
  itemCode: string | null,
): string[] {
  return missingVariantAxes(itemGroup, variants, itemCode).map((a) => a.label);
}

/* ──────────────────────────────────────────────────────────────────────
   PhotoThumb — one tile of the edit card's photo strip
   ──────────────────────────────────────────────────────────────────────
   PRESENTATION ONLY. Everything about HOW a photo resolves — the signed-URL
   cache and its expiry skew, the thumb tier, the authed-proxy fallback that is
   the only reason photos display in production at all, the per-effect-run
   attempt that survives StrictMode's double-invoke, and the blob caches —
   lives in ../lib/so-line-photo.useSoLinePhoto, shared with the V2 read-only
   strip. Read that file's header before changing any of it; three separate
   production regressions have lived in there.

   Exported as a test seam: SoLinePhotoFallback.test.tsx drives the real state
   machine through this tile, which is the mount configuration production uses.
   ────────────────────────────────────────────────────────────────────── */
export const PhotoThumb = ({
  photoKey, docNo, itemId, canDelete, onDelete,
}: {
  photoKey:  string;
  docNo?:    string;
  itemId?:   string;
  canDelete: boolean;
  onDelete:  () => void;
}) => {
  const { src, error, onImgError } = useSoLinePhoto(photoKey, docNo, itemId);

  return (
    <div className={styles.photoTile}>
      {src ? (
        <img src={src} alt="Line photo" onError={onImgError} />
      ) : error ? (
        <span className={styles.photoError} title={error}>err</span>
      ) : (
        <span className={styles.photoPlaceholder}>…</span>
      )}
      {canDelete && (
        <button
          type="button"
          className={styles.photoDelete}
          onClick={onDelete}
          title="Remove photo"
        >
          <X size={12} strokeWidth={2.5} />
        </button>
      )}
    </div>
  );
};
