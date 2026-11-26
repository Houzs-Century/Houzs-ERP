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
//   SOFA     → Fabrics / Seat Size / Leg Heights           · Specials accordion
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
import { computeTotalHeight, totalHeightPatch } from '../../shared/total-height';
import { activeCompanyTracksVariants } from '../lib/binding-mode';

const totalHeightPartsSig = (v: Record<string, unknown>): string =>
  [v.divanHeight, v.legHeight, v.gap].map((x) => String(x ?? '')).join('|');
import { restrictPricedToPool, restrictStringsToPool } from '../../shared/maintenance-pools';
import { fabricAllowedByPool } from '../../shared/fabric-pool';
import { activeOptions, CONSOLE_ATTACH_KEY, isColourKiv, isDeliveryFeeServiceCode, isServiceCategory, lineIdentity, maintPickerValues, fmtMoneySen, normalizeCompartmentCode } from '@2990s/shared';
import {
  useMfgProducts,
  matchesProductQuery,
  useMaintenanceConfig,
  useSpecialAddons,
  useModelAllowedOptionsByCode,
  useSkuCategoryByCode,
  type MfgProductRow,
  type SpecialAddonRow,
} from '../lib/mfg-products-queries';
import { useFabricTrackingsLite, useFabricColoursSearch, type FabricLite, type FabricColourRow } from '../lib/fabric-queries';
import { fabricColourMeta } from '../lib/fabric-colour-name';
import { useFabricLibrary } from '../lib/queries';
import {
  useUploadSoItemPhoto,
  useDeleteSoItemPhoto,
} from '../lib/sales-order-queries';
import { cacheSoLinePhotoSignedUrl, useSoLinePhoto } from '../lib/so-line-photo';
import { feeAmountSen, feeDiscountForAmount, lockedFeeSemantics } from '../lib/delivery-fee-amount';
import { useDebouncedValue } from '../lib/hooks';
import { specialOrderSurface } from '../lib/special-order-surface';
import { useAuth, isAdminLevel, isHatchSales } from '../lib/auth';
import { CATEGORY_BADGE } from '../lib/category-badges';
import { sortByNumeric } from '../lib/sort-options';
import { posRemarkSpecialOf } from '../lib/pos-remark-special';
import { seedFollowerVariants } from '../lib/so-variant-cascade';
import { pickDefaultVariants } from '../../shared/model-default-variants';
import { priceBoxAuthored, unpricedExtraSen } from '../lib/zeroPriceClaim';
import { useAnchoredPanel, anchoredPanelStyle } from '../../../lib/anchoredPanel';
import { useNotify } from './NotifyDialog';
import { SpecialOrders } from './SpecialOrders';
import styles from './SoLineCard.module.css';
import { DateField } from "./DateField";
import { DiscountInput } from './DiscountInput';
import { NumberInput, cleanNumericText } from './NumberInput';
import { dropOneMultiPick, isSofaGroup, multiPickCount, tapMultiPick } from '../lib/sofa-piece-lines';
const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number, currency = 'MYR'): string => fmtMoneySen(centi, currency);

const SUGGEST_LIST_MAX_H = 460;

const isBlankVariant = (v: unknown): boolean =>
  v === undefined || v === null || String(v).trim() === '';

/* The sofa Leg Height carries a standing "Default" option (RM 0.00) in the
   maintenance sofaLegHeights pool (owner 2026-07-13). Resolve its value,
   matched case-insensitively by name, so a sofa line's Leg Height auto-fills to
   it instead of an empty required field. null when the pool has no such option.
   A Model's own leg list never hides it: goods are bought and stocked under it,
   so a delivery order must be able to pick it (2990-PO-2610-019, KABBIN). */
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
  itemGroup:      string;
  description:    string;
  uom:            string;
  qty:            number;
  unitPriceSen: number;
  discountSen:  number;
  unitCostSen:  number;
  variants:       Record<string, unknown>;
  remark:         string;
  overriddenKeys?: string[];
  priceAuthored?: boolean;
  lineDeliveryDate?:           string | null;
  lineDeliveryDateOverridden?: boolean;
  photoUrls?:                  string[];
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
  lineDateLocked,
  specLockedReason,
  seedSofaLegDefault,
  searchHint,
  attachOptions,
  chargeOnly = false,
}: {
  index:     number;
  draft:     SoLineDraft;
  onChange:  (patch: Partial<SoLineDraft>) => void;
  onRemove:  () => void;
  canRemove: boolean;
  inheritVariantsByCategory?: Record<string, Record<string, unknown> | undefined>;
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
  lineDateLocked: boolean;
  /* Owner 2026-11-10 (shared/do-spec-lock.ts): a shipped DO line keeps its
     product and spec. Non-null = the product picker, variants and specials are
     read-only, this text says why, and nothing auto-fills a variant (the
     computed Total Height re-bucketed 2990-DO-2611-016). Qty, price, remark
     and date are unaffected. Mandatory: every other document passes null. */
  specLockedReason: string | null;
  /* Whether this document may AUTO-FILL a blank sofa Leg Height with the
     maintenance "Default" option (owner 2026-07-13).

     MANDATORY PROP, no default, for a harder reason than the one above: the leg
     height is part of the STOCK BUCKET. computeVariantKey emits `legheight=` for
     a sofa (shared/variant-key.ts), so seeding the field does not merely fill a
     box — it moves the line into a different bucket from the goods reserved for
     it. On 2026-09-08 that blocked HC-SO-012565: the lots stood at BALAKONG
     under `fabriccode=bo315-31|seatheight=26|special=...`, the delivery form
     seeded `legHeight: "Default"`, and the pre-flight read the invented bucket
     as available 0. Three delivery orders that morning (HC-DO-2609-004, -009,
     -011) were shipped through that dialog and their OUT movements consumed no
     lot at all. docs/bugs/0722.

     THE RULE:
       · a document that SPECIFIES the sofa            -> true
         (SO New/Detail, Consignment Order New/Detail — the key it writes is the
          one the purchase order and then the lot inherit, so seeding is
          consistent everywhere downstream)
       · a document that FULFILS one                   -> false
         (DO, consignment note/return, delivery return, sales invoice — the goods
          were already keyed when they were bought; adding an attribute here can
          only disagree with them)

     Leg Height is `required: false` in shared/so-variant-rule.ts, so a blank one
     blocks no Confirm gate on either side. */
  seedSofaLegDefault: boolean;
  searchHint?: string;
  attachOptions: string[] | null;
  chargeOnly?: boolean;
}) => {
  const notify = useNotify();
  const maintQ   = useMaintenanceConfig('master');
  const maint    = maintQ.data?.data ?? null;
  const fabricsQ = useFabricTrackingsLite();
  const fabrics = useMemo(() => fabricsQ.data ?? [], [fabricsQ.data]);
  const fabricLibQ     = useFabricLibrary();
  const specialAddonsQ = useSpecialAddons();
  const specialDefs    = useMemo(() => specialAddonsQ.data ?? [], [specialAddonsQ.data]);

  const { staff } = useAuth();
  const canEditPrice = chargeOnly || isAdminLevel(staff?.role) || isHatchSales(staff?.role);
  /* DELIVERY FEE — the amount cell edits the LINE AMOUNT, not the unit price.
     The fee is derived (owner 2026-08-07, "every ringgit is a LINE"), so a
     typed unit price never survived: the next rebuild re-derived 250 over it
     and the operator watched 250 -> 125 "nuke the line to 0". The sanctioned
     reduction is the line DISCOUNT, which the PATCH has always accepted and
     #2490 taught the rebuild to keep — but nothing on this screen could ever
     enter one, so that road was reachable only from the POS voucher split.
     So on a fee line this cell SHOWS the net and WRITES the difference as a
     discount: type the amount you want charged. Gross stays derived, and the
     printed SO reads unit 250 / discount 125 / total 125, exactly like every
     other price reduction on an order. Raising a fee is NOT expressible this
     way (a discount cannot go negative) — that is what SVC-DELIVERY-ADD is
     for — so a higher figure clamps to no discount rather than pretending. */
  const feeGrossSen = Math.max(0, draft.qty * draft.unitPriceSen);
  const feeVerdictRef = useRef<boolean | null>(null);
  feeVerdictRef.current = lockedFeeSemantics(
    feeVerdictRef.current, isDeliveryFeeServiceCode(draft.itemCode), feeGrossSen,
  );
  const isFeeLine = feeVerdictRef.current === true;
  const amountCellSen = isFeeLine
    ? feeAmountSen(feeGrossSen, draft.discountSen)
    : draft.unitPriceSen;
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
  const pickerWrapRef = useRef<HTMLDivElement>(null);
  const multiEnabled = typeof onAddProducts === 'function';
  const [multiMode, setMultiMode] = useState(false);
  const [multiPicked, setMultiPicked] = useState<MfgProductRow[]>([]);
  const [specialsOpen, setSpecialsOpen] = useState(() => posRemarkSpecialOf(draft.variants) != null);
  const [priceText, setPriceText] = useState((amountCellSen / 100).toFixed(2));
  const [priceTyping, setPriceTyping] = useState(false);
  const priceBeforeEdit = useRef<Pick<SoLineDraft, 'unitPriceSen' | 'priceAuthored'>>({ unitPriceSen: 0 });
  const trimmedSearch = search.trim();
  const productsQuery = useMfgProducts({ enabled: showPicker });
  const allProducts = productsQuery.data ?? [];
  const candidates = useMemo(
    () => (trimmedSearch.length >= 2
      ? allProducts.filter((p) => matchesProductQuery(p, trimmedSearch) && (!chargeOnly || isServiceCategory(p.category)))
      : []),
    [allProducts, trimmedSearch, chargeOnly],
  );
  /* Owner 2026-08-08 ("square pillow", HC-SO-2607-013) — typed text the
     catalog does not match must read as an ERROR, not sit quietly in the box:
     the operator once read the silence as "saved". True only when the line has
     no committed product, the search term is a real query (>=2 chars), and the
     loaded catalog produced zero matches. */
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
     (RM 0.00) when unset — but ONLY where the caller says this document
     specifies the sofa (`seedSofaLegDefault`; see the prop's own note). A
     fulfilment document that seeds it re-buckets the line away from the stock
     reserved for it. Edit-mode only — a read-only view still RENDERS the
     configurator (driven by `category` above) but must not mutate. */
  const specLocked = specLockedReason !== null;
  /* Variant-tracked company (lib/binding-mode.ts): the leg default is seeded only
     for a product PICKED in this card, never for a saved line merely opened
     (PR #5609 follow-up). Company 1 seeds on open as it always has. */
  const variantTracked = activeCompanyTracksVariants();
  const itemCodeAtOpen = useRef(draft.itemCode);
  useEffect(() => {
    if (!isEditing || specLocked || !draft.itemCode) return;
    const patch: Partial<SoLineDraft> = {};
    if ((category === 'sofa' || category === 'bedframe' || category === 'fabric_accessory')
        && draft.itemGroup.toLowerCase() !== category) {
      patch.itemGroup = category;
    }
    if (seedSofaLegDefault && category === 'sofa' && maint
        && (!variantTracked || draft.itemCode !== itemCodeAtOpen.current)
        && isBlankVariant(draft.variants.legHeight)
        && isBlankVariant(draft.variants.sofaLegHeight)) {
      const def = defaultSofaLegValue(maint);
      if (def) patch.variants = { ...draft.variants, ...(patch.variants ?? {}), legHeight: def };
    }
    if (Object.keys(patch).length > 0) onChange(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, category, draft.itemCode, maint, seedSofaLegDefault]);

  const uploadPhoto = useUploadSoItemPhoto();
  const deletePhoto = useDeleteSoItemPhoto();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const photoUrls = draft.photoUrls ?? [];
  const pendingFiles = useMemo(() => draft.pendingPhotoFiles ?? [], [draft.pendingPhotoFiles]);
  const isSaved = Boolean(docNo) && Boolean(itemId);
  const canShowPhotos = Boolean(draft.itemCode);
  const canMutatePhotos = canShowPhotos && isSaved && isEditing;
  const canStagePhotos = canShowPhotos && !isSaved && isEditing;

  const pendingPreviews = useMemo(
    () => pendingFiles.map((f) => ({ name: f.name, url: URL.createObjectURL(f) })),
    [pendingFiles],
  );
  useEffect(() => () => {
    pendingPreviews.forEach((p) => URL.revokeObjectURL(p.url));
  }, [pendingPreviews]);

  useEffect(() => { setSearch(draft.description ?? ''); }, [draft.description]);

  useEffect(() => {
    if (!priceBoxAuthored(priceText)) return;
    const parsed = Math.round(Number(priceText) * 100) || 0;
    if (parsed !== amountCellSen) setPriceText((amountCellSen / 100).toFixed(2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountCellSen]);

  const pickProduct = (p: MfgProductRow) => {
    setPicked(p);
    const category = p.category.toLowerCase();
    const seedVariants = seedFollowerVariants(inheritVariantsByCategory?.[category]);
    const defaults = seedSofaLegDefault
      ? pickDefaultVariants(p.category, p.model_default_variants, p.allowed_options)
      : {};
    onChange({
      itemCode:       p.code,
      itemGroup:      category,
      description:    p.name,
      unitPriceSen: p.sell_price_sen ?? 0,
      priceAuthored:  false,
      variants:       { ...defaults, ...seedVariants },
      overriddenKeys: [],
    });
    setSearch(p.name);
  };

  const toggleMultiPick = (p: MfgProductRow) =>
    setMultiPicked((prev) => tapMultiPick(prev, p, (x) => x.id, isSofaGroup(p.category)));
  const commitMulti = () => {
    if (multiPicked.length === 0) return;
    const [first, ...rest] = multiPicked;
    if (first) pickProduct(first);
    if (rest.length > 0) onAddProducts?.(rest);
    setMultiPicked([]);
    setMultiMode(false);
    setShowPicker(false);
  };

  const computedTotalHeight = useMemo(
    () => computeTotalHeight(category, draft.variants),
    [category, draft.variants.divanHeight, draft.variants.legHeight, draft.variants.gap],
  );

  /* NOT ON OPEN, for a variant-tracked company only (PR #5609 follow-up;
     lib/binding-mode.ts). There the writer runs only once divan, leg or gap has
     changed in this card: opening a saved line must not rewrite its variants,
     which is how a delivery line grew a `totalHeight` the received goods lacked
     and keyed a different stock bucket. Company 1 (PO hard binding) keeps the
     behaviour it has always had: the total is reconciled on open as well. */
  const partsAtOpen = useRef(totalHeightPartsSig(draft.variants));
  useEffect(() => {
    if (specLocked) return;
    if (variantTracked) {
      const sig = totalHeightPartsSig(draft.variants);
      if (sig === partsAtOpen.current) return;
      partsAtOpen.current = sig;
    }
    const patch = totalHeightPatch(category, draft.variants);
    if (!patch) return;
    onChange({ variants: { ...draft.variants, ...patch } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computedTotalHeight, category]);

  const setVariants = (patch: Record<string, unknown>) => {
    const nextOverrides = Array.from(new Set([...(draft.overriddenKeys ?? []), ...Object.keys(patch)]));
    onChange({
      variants: { ...draft.variants, ...patch },
      overriddenKeys: nextOverrides,
    });
  };
  const setVariant = (k: string, v: string | number | string[]) => setVariants({ [k]: v });

  const specialsList = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.map(String).filter(Boolean);
    if (typeof v === 'string' && v) return [v];
    return [];
  };

  const pickedFabric: FabricLite | null = useMemo(() => {
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
    const choices = (draft.variants.specialChoices && typeof draft.variants.specialChoices === 'object')
      ? (draft.variants.specialChoices as Record<string, string[]>)
      : null;
    const lineCells = catU === 'SOFA' && Array.isArray(draft.variants.cells)
      ? (draft.variants.cells as Array<{ moduleId?: unknown } | null>)
      : null;
    const buildCompartments = lineCells
      ? lineCells.map((cl) => normalizeCompartmentCode(String(cl?.moduleId ?? ''))).filter(Boolean)
      : null;
    const specialsPool = buildSpecialsPoolFromAddons(specialDefs, specs, choices, buildCompartments);
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


  const allowedByCodeQ = useModelAllowedOptionsByCode(draft.itemCode || undefined);
  const allowOpts = picked?.allowed_options ?? allowedByCodeQ.data ?? null;
  /* The SHARED restrict helpers, not a private copy. maintenance-pools.ts has
     said "no editor may inline its own copy again" since it was written, and
     this file inlined one anyway - which is why the quote-folding that landed
     there reached mobile and not the desktop. docs/bugs/0814. */
  const restrictP = (opts: Array<{ value: string; priceSen: number }>, pool?: string[] | null) =>
    restrictPricedToPool(opts, pool);
  const restrictS = (opts: string[], pool?: string[] | null) =>
    restrictStringsToPool(opts, pool);

  /* ── Fabrics picker (SO-parity, Loo 2026-06-06 · SERVER-typeahead 2026-07-14) ──
     Scaling (owner #1 pain): the fabric picker used to pull EVERY active
     fabric_colours row on every line card and render them all as <option>s.
     It is now a searchable combobox (FabricColourCombobox) backed by
     GET /fabric-colours?q= (see useFabricColoursSearch). The pool/inactive
     filters that used to prune the option list are handed to the combobox,
     which applies them to the SERVER results:
       • pool  = Model's allowed_options.fabrics (colour codes). Non-empty =
                 restrict (same as the server gate); empty/null = any active.
       • inactive — NO LONGER FILTERED HERE. `GET /fabric-colours` drops a colour
                 whose fabric_trackings CODE has no active row, so the desktop and
                 the mobile sheet get one rule from one place. This filter used to
                 live here and asked the question per ROW: 21 codes carry an
                 active row beside a retired one for the same code, so the dead
                 twin hid a fabric the floor sells - 21 active colours hidden,
                 all 21 wrongly - while mobile, which never filtered, showed them.
                 That split is how the owner found it. docs/bugs/0818.
     A saved line's fabric ALWAYS renders (the combobox shows the stored code),
     so the picker never blanks a previously-selected fabric. */
  const inactiveFabricCodes = useMemo(() => new Set<string>(), []);

  const fabricSeries = useMemo(
    () => new Map((fabricLibQ.data ?? []).map((f) => [f.id, f.label] as [string, string])),
    [fabricLibQ.data],
  );
  const pickFabricColour = (c: FabricColourRow) => {
    const colourId = c.colourId;
    const seriesLabel = fabricSeries.get(c.fabricId) ?? null;
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

  const extraSen = pricingBreakdown
    ? pricingBreakdown.divanSurchargeSen
    + pricingBreakdown.legSurchargeSen
    + pricingBreakdown.totalHeightSurchargeSen
    + pricingBreakdown.specialsSurchargeSen
    + pricingBreakdown.fabricSurchargeSen
    : 0;

  // HC-0198: a blank price still saves base + variant surcharges; show that total, not RM 0.
  const unpricedExtra = isFeeLine ? 0 : unpricedExtraSen(draft.unitPriceSen, draft.priceAuthored === true, extraSen, category === 'sofa');
  const lineTotal = useMemo(
    () => Math.max(0, draft.qty * (draft.unitPriceSen + unpricedExtra) - draft.discountSen),
    [draft.qty, draft.unitPriceSen, unpricedExtra, draft.discountSen],
  );

  /* Colour KIV (owner 2026-07-24, SO-2607-016) — the line committed to a
     fabric SERIES but the colour is still open. The Fabrics box already shows
     the required-red border; this names WHY it is red and what blocks next:
     the server refuses a Processing Date while any line is still KIV. */
  const colourKiv = isColourKiv(draft.variants);
  const badge = CATEGORY_BADGE[category] ?? CATEGORY_BADGE.others!;
  /* fabric_accessory = "Sofa Accessory" (owner 2026-09-14): colour ONLY, from the same
     fabric master and the same picker as a sofa. tasks/PLAN-sofa-accessories-category.md */
  const hasVariants = Boolean(draft.itemCode) && Boolean(maint)
    && (category === 'bedframe' || category === 'sofa' || category === 'fabric_accessory');
  const specials = specialsList(draft.variants.specials ?? draft.variants.special);
  const specialSurface = specialOrderSurface({
    category,
    hasItemCode: Boolean(draft.itemCode),
    pickedSpecialCount: specials.length,
  });
  const hasSpecialOrder = specialSurface.block;


  /* Keep the portal'd SKU dropdown pinned to its input while open. The
     geometry — flip above when there is more room there, clamp the height to
     the room actually available — is the shared house rule in
     lib/anchoredPanel, not a copy. Owner 2026-08-21: he typed a code, the list
     opened downward past the bottom of the window, and the last rows plus the
     green "Add N" bar could not be reached at all. */
  const menuPos = useAnchoredPanel(pickerWrapRef, showPicker && isEditing, SUGGEST_LIST_MAX_H);

  return (
    <div data-grid-row className={styles.card}>
      <div className={styles.row}>
        <span className={styles.lineNo}>{index + 1}</span>

        <div className={styles.pickerWrap} ref={pickerWrapRef}>
          {draft.itemCode && search === draft.description && !showPicker ? (
            <button
              type="button"
              className={styles.input}
              style={{ textAlign: 'left', cursor: isEditing ? 'pointer' : 'not-allowed', padding: '2px 8px', height: 'auto', minHeight: 28 }}
              disabled={!isEditing || specLocked}
              /* Owner 2026-08-09 — opening the picker must NOT lose the
                 current SKU: keep the description visible (select-all so
                 typing replaces it), and blur-without-pick restores it. */
              onClick={() => { setShowPicker(true); setSearch(draft.description ?? ''); }}
              title="Click to change product"
            >
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
                placeholder={searchHint ? `Slip: ${searchHint} — pick a SKU` : 'Click to pick or type to filter…'}
                value={search}
                disabled={!isEditing || specLocked}
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
                <div style={{ fontSize: 10.5, lineHeight: 1.35, color: 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))', marginTop: 2 }}>
                  Not in the catalog — pick a product from the list; free-typed lines cannot be saved.
                </div>
              )}
            </>
          )}
          {showPicker && isEditing && menuPos && createPortal(
            <ul
              className={styles.suggestList}
              style={{ ...anchoredPanelStyle(menuPos), right: 'auto', marginTop: 0 }}
            >
              {multiEnabled && candidates.length > 0 && (
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
                candidates.slice(0, 50).map((p) => {
                  const tickCount = multiMode ? multiPickCount(multiPicked, p.id, (x) => x.id) : 0;
                  const ticked = tickCount > 0;
                  const repeatable = isSofaGroup(p.category);
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
                      {multiMode && repeatable && tickCount > 0 && (
                        <>
                          <span style={{ marginLeft: 'auto', fontWeight: 700 }}>{'×'}{tickCount}</span>
                          <button
                            type="button"
                            aria-label={`Remove one ${p.name}`}
                            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); setMultiPicked((prev) => dropOneMultiPick(prev, p.id, (x) => x.id)); }}
                            style={{ padding: '0 8px', fontWeight: 700, cursor: 'pointer' }}
                          >
                            {'−'}
                          </button>
                        </>
                      )}
                    </li>
                  );
                })
              ) : (
                <li className={styles.suggestItem} style={{ color: 'var(--fg-muted)', cursor: 'default' }}>
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
                  style={{ position: 'sticky', bottom: 0, background: 'var(--accent, var(--hz-c-primary))', color: '#fff', textAlign: 'center', fontWeight: 700, cursor: 'pointer' }}
                  onMouseDown={(e) => { e.preventDefault(); commitMulti(); }}
                >
                  Add {multiPicked.length} product{multiPicked.length > 1 ? 's' : ''}
                </li>
              )}
            </ul>,
            document.body,
          )}
        </div>

        <input
          className={styles.input}
          placeholder="Type remarks…"
          value={draft.remark}
          disabled={!isEditing}
          onChange={(e) => onChange({ remark: e.target.value })}
        />

        <NumberInput
          sign="unsigned"
          decimal={false}
          step={1}
          min={1}
          className={styles.numericInput}
          value={draft.qty === 0 ? null : draft.qty}
          disabled={!isEditing}
          onValueChange={(n) => onChange({ qty: n ?? 0 })}
          onBlur={() => { if (draft.qty <= 0) onChange({ qty: 1 }); }}
        />

        <input
          type="text"
          inputMode="decimal"
          className={styles.priceInput}
          value={!isFeeLine && amountCellSen === 0 && !priceTyping ? '' : priceText}
          placeholder="0.00"
          disabled={!isEditing || !canEditPrice}
          title={
            !canEditPrice ? 'Price follows the SKU Master sell price — admin can override'
              : isFeeLine ? `Delivery fee is derived (${fmtMoneySen(feeGrossSen, 'RM')}). Type the amount to charge — the difference is recorded as a line discount. To charge MORE, add an Additional delivery fee line.`
              : undefined
          }
          onChange={(e) => {
            const t = cleanNumericText(e.target.value, 'signed', true);
            if (!priceTyping) priceBeforeEdit.current = { unitPriceSen: draft.unitPriceSen, priceAuthored: draft.priceAuthored };
            setPriceText(t);
            setPriceTyping(true);
            if (isFeeLine) {
              const n = Number(t);
              if (t.trim() === '' || !Number.isFinite(n)) return;
              onChange({ discountSen: feeDiscountForAmount(feeGrossSen, Math.round(n * 100)) });
              return;
            }
            onChange(priceBoxAuthored(t)
              ? { unitPriceSen: Math.round(Number(t) * 100), priceAuthored: true }
              : priceBeforeEdit.current);
          }}
          onBlur={() => { setPriceTyping(false); setPriceText((amountCellSen / 100).toFixed(2)); }}
        />

        {/* 6. Discount — owner 2026-09-12: the sales side had no discount field
             at all while purchasing had one, so a sales discount could only be
             typed into the price. ONE box: `1000` is ringgit, `25%` is a
             percentage of qty x unit price (DiscountInput). What is stored is
             always the resolved sen amount, which is what the server already
             validates (0 .. qty x unit price).

             A DELIVERY-FEE line is the exception and is disabled here: its
             amount cell IS the discount — typing the amount to charge writes
             `discountSen = gross - charged` (feeDiscountForAmount above), so a
             second control writing the same field would fight it. */}
        {isFeeLine ? (
          <span
            className={styles.priceLabel}
            title="A delivery fee's discount is derived — type the amount to charge in the price cell."
            style={{ textAlign: 'right', opacity: 0.55 }}
          >
            {draft.discountSen > 0 ? fmtRm(draft.discountSen) : '—'}
          </span>
        ) : (
          <DiscountInput
            bare
            align="right"
            inputClassName={styles.priceInput}
            valueSen={draft.discountSen}
            baseSen={draft.qty * draft.unitPriceSen}
            disabled={!isEditing}
            onCommit={(sen) => onChange({ discountSen: sen ?? 0 })}
          />
        )}
        <DateField
          fullWidth
          className={styles.input}
          value={draft.lineDeliveryDate ?? ''}
          disabled={!isEditing || lineDateLocked}
          title={lineDateLocked
            ? 'Set the Processing Date first'
            : !draft.lineDeliveryDateOverridden && draft.lineDeliveryDate ? 'Auto-inherited from SO header' : undefined}
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

        <span className={styles.amount}>{fmtRm(lineTotal)}</span>

        <span className={styles.badge} style={{ background: badge.bg, color: badge.fg }}>
          {badge.label}
        </span>

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
      {(picked || hasVariants || hasSpecialOrder || canShowPhotos) && (
      <div className={styles.body}>
        {(hasVariants || hasSpecialOrder) && <div className={styles.bodyLeft}>
      {specLockedReason && (
        <p role="note" className="mb-2 rounded-md border border-warning-text/25 bg-warning-bg px-3 py-2 text-[12px] text-warning-text">
          {specLockedReason}
        </p>
      )}
      {hasVariants && category === 'bedframe' && (
        <div className={styles.variants}>
          <div className={styles.variantsHead}>BEDFRAME VARIANTS</div>
          <div className={styles.variantsGrid}>
            <FabricColourCombobox
              label="Fabrics" required={variantsRequired}
              value={String(draft.variants.fabricCode ?? '')}
              colourLabel={String(draft.variants.colourLabel ?? '')}
              fabricSeries={fabricSeries}
              disabled={!isEditing || specLocked}
              pool={allowOpts?.fabrics ?? null}
              inactiveCodes={inactiveFabricCodes}
              itemCode={draft.itemCode || null}
              onSelect={pickFabricColour}
            />
            <VariantSelect
              label="Gaps" required={variantsRequired}
              value={String(draft.variants.gap ?? '')}
              disabled={!isEditing || specLocked}
              options={sortByNumeric(restrictS(maintPickerValues(maint!.gaps, String(draft.variants.gap ?? '')), allowOpts?.gaps).map((g) => ({ value: g, priceSen: 0 })))}
              onChange={(v) => setVariant('gap', v)}
            />
            <VariantSelect
              label="Divan Heights" required={variantsRequired}
              value={String(draft.variants.divanHeight ?? '')}
              disabled={!isEditing || specLocked}
              options={sortByNumeric(restrictP(activeOptions(maint!.divanHeights, String(draft.variants.divanHeight ?? '')), allowOpts?.divan_heights))}
              onChange={(v) => setVariant('divanHeight', v)}
            />
            <VariantSelect
              label="Leg Heights" required={variantsRequired}
              value={String(draft.variants.legHeight ?? '')}
              disabled={!isEditing || specLocked}
              options={sortByNumeric(restrictP(activeOptions(maint!.legHeights, String(draft.variants.legHeight ?? '')), allowOpts?.leg_heights))}
              onChange={(v) => setVariant('legHeight', v)}
            />
          </div>
          {colourKiv && (
            <div style={{ fontSize: 'var(--fs-11)', fontWeight: 600, color: 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))' }}>
              Colour KIV — confirm the colour before a Processing Date can be set.
            </div>
          )}
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
            disabled={!isEditing || specLocked}
            showPrices={showPrices}
          />
        </div>
      )}

      {hasVariants && category === 'fabric_accessory' && (
        <div className={styles.variants}>
          <div className={styles.variantsHead}>SOFA ACCESSORY FABRIC</div>
          <div className={styles.variantsGrid}>
            <FabricColourCombobox
              label="Fabrics" required={variantsRequired}
              value={String(draft.variants.fabricCode ?? '')}
              colourLabel={String(draft.variants.colourLabel ?? '')}
              fabricSeries={fabricSeries}
              disabled={!isEditing || specLocked}
              pool={allowOpts?.fabrics ?? null}
              inactiveCodes={inactiveFabricCodes}
              itemCode={draft.itemCode || null}
              onSelect={pickFabricColour}
            />
          </div>
        </div>
      )}
      {hasVariants && category === 'sofa' && (
        <div className={styles.variants}>
          <div className={styles.variantsHead}>SOFA VARIANTS</div>
          <div className={styles.variantsGrid}>
            <FabricColourCombobox
              label="Fabrics" required={variantsRequired}
              value={String(draft.variants.fabricCode ?? '')}
              colourLabel={String(draft.variants.colourLabel ?? '')}
              fabricSeries={fabricSeries}
              disabled={!isEditing || specLocked}
              pool={allowOpts?.fabrics ?? null}
              inactiveCodes={inactiveFabricCodes}
              itemCode={draft.itemCode || null}
              onSelect={pickFabricColour}
            />
            <VariantSelect
              label="Seat Size" required={variantsRequired}
              value={String(draft.variants.seatHeight ?? '')}
              disabled={!isEditing || specLocked}
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
              disabled={!isEditing || specLocked}
              options={sortByNumeric(restrictPricedToPool(activeOptions(maint!.sofaLegHeights, String(draft.variants.legHeight ?? '')), allowOpts?.leg_heights, defaultSofaLegValue(maint)))}
              onChange={(v) => setVariant('legHeight', v)}
            />
            {attachOptions ? (
              <VariantSelect
                label="Attached to"
                value={String(draft.variants[CONSOLE_ATTACH_KEY] ?? '')}
                disabled={!isEditing || specLocked}
                options={attachOptions.map((id) => ({ value: id, priceSen: 0 }))}
                onChange={(v) => setVariant(CONSOLE_ATTACH_KEY, v)}
              />
            ) : (
              <span />
            )}
          </div>
          {colourKiv && (
            <div style={{ fontSize: 'var(--fs-11)', fontWeight: 600, color: 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))' }}>
              Colour KIV — confirm the colour before a Processing Date can be set.
            </div>
          )}
          <SpecialOrders
            open={specialsOpen}
            onToggle={() => setSpecialsOpen((o) => !o)}
            options={specialOptions}
            variants={draft.variants}
            onPatch={setVariants}
            disabled={!isEditing || specLocked}
            showPrices={showPrices}
          />
        </div>
      )}

      {hasSpecialOrder && (
        <div className={styles.variants}>
          <div className={styles.variantsHead}>
            {category === 'mattress' ? 'MATTRESS ADD-ONS' : 'SPECIAL ORDER'}
          </div>
          <SpecialOrders
            open={specialsOpen}
            onToggle={() => setSpecialsOpen((o) => !o)}
            options={specialSurface.optionPicker ? specialOptions : []}
            variants={draft.variants}
            onPatch={setVariants}
            disabled={!isEditing || specLocked}
            showPrices={showPrices}
          />
        </div>
      )}

        </div>}

        <div className={styles.bodyRight}>
          {picked && (
            <div className={styles.priceSummary}>
              <div className={styles.priceSummaryHead}>
                <span>Pricing</span>
              </div>
              {extraSen > 0 && (
                <div className={styles.priceRow}>
                  <span className={styles.priceLabel}>
                    + Variants{unpricedExtra > 0 ? ' (charged: Unit Price is blank; type 0 to charge nothing)' : ''}
                  </span>
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
                          onChange({ pendingPhotoFiles: [...pendingFiles, ...files] });
                          if (fileInputRef.current) fileInputRef.current.value = '';
                          return;
                        }

                        if (!docNo || !itemId) return;
                        const newKeys: string[] = [];
                        for (const f of files) {
                          try {
                            const res = await uploadPhoto.mutateAsync({ docNo, itemId, file: f });
                            newKeys.push(res.photoKey);
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
      </div>
      )}
    </div>
  );
};
SoLineCardInner.displayName = 'SoLineCard';

export const SoLineCard = memo(SoLineCardInner);


const VariantSelect = ({
  label, options, value, onChange, disabled = false, required = false,
}: {
  label:    string;
  options:  Array<{ value: string; priceSen: number; sellingPriceSen?: number; display?: string }>;
  value:    string;
  disabled?: boolean;
  required?: boolean;
  onChange: (v: string) => void;
}) => {
  const invalid = required && !value;
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
  label, value, colourLabel, fabricSeries, onSelect, disabled = false, required = false, pool, inactiveCodes, itemCode,
}: {
  label:    string;
  colourLabel: string;
  fabricSeries: Map<string, string>;
  itemCode: string | null;
  value:    string;
  pool?:    string[] | null;
  inactiveCodes: Set<string>;
  disabled?: boolean;
  required?: boolean;
  onSelect: (c: FabricColourRow) => void;
}) => {
  const [open, setOpen]     = useState(false);
  const [search, setSearch] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  const debounced = useDebouncedValue(search, 200);
  const trimmed   = debounced.trim();
  const coloursQ  = useFabricColoursSearch(trimmed, { enabled: open && trimmed.length >= 2, itemCode });

  const results = useMemo(() => {
    const rows = coloursQ.data ?? [];
    return rows
      .filter((c) => !inactiveCodes.has(c.colourId))
      /* A row passes if the pool names its COLOUR or its SERIES (docs/bugs/0814),
         asked through the SAME module the save gate and the phone sheet read,
         so the folding of stray spaces and quote glyphs agrees too
         (docs/bugs/0889). */
      .filter((c) => fabricAllowedByPool(pool, c.colourId, c.fabricId))
      .slice(0, 50);
  }, [coloursQ.data, pool, inactiveCodes]);

  const menuPos = useAnchoredPanel(wrapRef, open && !disabled, SUGGEST_LIST_MAX_H);

  const invalid = required && !value;
  const shown = value && colourLabel && colourLabel !== value ? `${value} — ${colourLabel}` : value;

  return (
    <label className={styles.variantField}>
      <span className={styles.variantLabel}>{label}{required ? ' *' : ''}</span>
      <div ref={wrapRef} style={{ position: 'relative' }}>
        <input
          className={styles.select}
          value={open ? search : shown}
          placeholder={value ? undefined : 'Type 2+ chars to search…'}
          disabled={disabled}
          /* Owner 2026-08-09 — like the native Divan/Gap selects, opening must
             KEEP the current value in view: seed the search with it and
             select-all so typing replaces. Blur already restores `value`. */
          onFocus={(e) => { setOpen(true); setSearch(value ?? ''); e.currentTarget.select(); }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => { setSearch(e.target.value); setOpen(true); }}
          style={invalid && !disabled ? { borderColor: 'var(--c-festive-b, #B8331F)' } : undefined}
          title={shown || undefined}
        />
        {menuPos && createPortal(
          <ul
            className={styles.suggestList}
            style={{ ...anchoredPanelStyle(menuPos), right: 'auto', marginTop: 0 }}
          >
            {results.length > 0 ? (
              /* The code leads (it IS the fabric's identity, owner 2026-06-23);
                 series and colour name follow on a second line, as on the
                 phone's fabric sheet (DEV-61). onMouseDown + preventDefault
                 keeps the input focused so the portal doesn't blur-close before
                 the pick lands. */
              results.map((c) => {
                const meta = fabricColourMeta(fabricSeries.get(c.fabricId) ?? '', c.colourId, c.label);
                return (
                  <li
                    key={c.colourId}
                    className={styles.suggestItem}
                    onMouseDown={(e) => { e.preventDefault(); onSelect(c); setSearch(''); setOpen(false); }}
                  >
                    <div className={styles.suggestItemCode}>{c.colourId}</div>
                    {meta && <div className={styles.suggestItemMeta}>{meta}</div>}
                  </li>
                );
              })
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
  itemCode: string | null,
): string[] {
  return missingVariantAxes(itemGroup, variants, itemCode).map((a) => a.label);
}

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
