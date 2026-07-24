// ----------------------------------------------------------------------------
// MRP · Stock Status Report (Commander 2026-05-28, redesigned 2026-05-29).
//
// Trading-company finished-goods MRP. Per SKU: how many units the open Sales
// Orders need (Qty Needed) vs what we can supply (Stock + outstanding PO),
// with the leftover = Shortage. Tagged with how each SO line is covered:
//   • stock        → allocated from on-hand
//   • PO-xxxx + ETA → covered by an outstanding PO (expected arrival)
//   • SHORT (orange) → uncovered → this is what you order next
//
// Two tabs (Commander 2026-05-29 — "MRP 分两个地方"):
//   • General — everything except sofa. 3-level hierarchy:
//       Model (e.g. "CODY Bedframe 6\"") → Variant (each fabric/colour) → SO orders.
//       Single-variant models (mattress, accessory) collapse to 2 levels.
//   • Sofa    — same 3-level hierarchy, fed from the per-SO sofa SETS (colour-
//       matched). A sofa is one PO per SO, so selecting any sofa variant selects
//       the whole same-SO set together.
//
// Read-only, recomputed server-side on every load (no persistence — v1).
// Backed by GET /mrp (apps/api/src/routes/mrp.ts).
// ----------------------------------------------------------------------------

import { useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { ChevronRight, ChevronDown, RefreshCw, Truck, ShoppingCart, CalendarRange, Info, Clock } from 'lucide-react';
import {
  useMrp, useCategoryLeadTimes, useUpdateCategoryLeadTime, GLOBAL_LEAD_KEY,
  type MrpSku, type MrpLine, type MrpResponse, type SofaSet, type LeadCategory,
  type MrpWarehouse, type CategoryLeadTimes,
} from '../../vendor/scm/lib/mrp-queries';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { useAuth, isAdminLevel } from '../../vendor/scm/lib/auth';
import { useCreatePosFromSoItems } from '../../vendor/scm/lib/suppliers-queries';
import { newIdempotencyKey } from '../../lib/idempotency';
import { fmtDateOrDash } from '@2990s/shared';
import { DateField } from '../../vendor/scm/components/DateField';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/Layout';
import styles from './Mrp.module.css';

const ICON = { size: 14, strokeWidth: 1.75 } as const;

/* Toolbar utility button — matches the shared <PageHeader> secondaryActions
   button so the MRP toolbar reads as native header chrome (the page's own
   .ghostBtn / .primaryBtn only resolved via the removed .page cascade). */
const TOOLBAR_BTN =
  'inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors hover:border-primary/40 hover:bg-primary-soft hover:text-primary disabled:cursor-default disabled:opacity-50';

// Canonical date format (Commander 2026-05-29) — shared @2990s/shared helper.
const fmtDate = (iso: string | null): string => fmtDateOrDash(iso);

type View = 'sofa' | 'bedframe' | 'mattress' | 'accessory';

// Lead-time maintenance shows the four orderable categories (Service excluded,
// mirroring the MRP tabs). Commander 2026-06-18 — moved here from SO Maintenance.
const MRP_LEAD_CATEGORIES: LeadCategory[] = ['sofa', 'bedframe', 'mattress', 'accessory'];

/* LeadTimesDialog (Commander 2026-06-18, moved from SO Maintenance) — per-
   category "order N days early". When you Proceed PO, the PO delivery date is
   set this many days BEFORE the customer delivery date (see mfg-purchase-orders
   /from-sos). Self-contained: owns its query + per-category draft + save.
   Commander 2026-06-22 (migration 0184 / SCM mig 0036) — also per-WAREHOUSE: a
   Warehouse selector at the top switches which bucket the rows edit. "Global
   Defaults" (warehouseId null) is the fallback; a warehouse with no override yet
   shows the global values until you Save an override. */
function LeadTimesDialog({ onClose, warehouses }: { onClose: () => void; warehouses: MrpWarehouse[] }) {
  const q = useCategoryLeadTimes();
  const update = useUpdateCategoryLeadTime();
  const map = q.data?.leadTimes;
  /* Selected bucket: GLOBAL_LEAD_KEY = the global defaults; else a warehouse id.
     The PUT body warehouseId is null for the global bucket. */
  const [whKey, setWhKey] = useState<string>(GLOBAL_LEAD_KEY);
  const warehouseId = whKey === GLOBAL_LEAD_KEY ? null : whKey;
  const [draft, setDraft] = useState<Partial<Record<LeadCategory, string>>>({});

  const globalBucket: CategoryLeadTimes | undefined = map?.[GLOBAL_LEAD_KEY];
  const whBucket: CategoryLeadTimes | undefined = map?.[whKey];
  /* Stored value for the selected bucket: its own override if present, else fall
     back to the global default (so a warehouse with no override displays the
     global instead of a misleading 0). */
  const storedFor = (cat: LeadCategory): number =>
    whBucket?.[cat] ?? globalBucket?.[cat] ?? 0;
  const valueFor = (cat: LeadCategory) => draft[cat] ?? String(storedFor(cat));
  const dirty = (cat: LeadCategory) =>
    draft[cat] !== undefined && draft[cat] !== String(storedFor(cat));
  const save = (cat: LeadCategory) => {
    const n = Math.max(0, Math.floor(Number(valueFor(cat)) || 0));
    update.mutate(
      { warehouseId, category: cat, leadDays: n },
      { onSuccess: () => setDraft((s) => { const x = { ...s }; delete x[cat]; return x; }) },
    );
  };
  // Switching warehouse clears any half-typed draft so rows reflect the new bucket.
  const switchWh = (key: string) => { setWhKey(key); setDraft({}); };

  return (
    <div className={styles.dialogBackdrop} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2 className={styles.dialogTitle}>Lead Times</h2>
        <p className={styles.dialogBody}>
          How many days <strong>before</strong> the customer delivery date each category&rsquo;s PO is
          ordered. When you Proceed PO, the PO delivery date is set this many days earlier so the
          supplier delivers ahead of the customer date. Set a per-<strong>warehouse</strong> override
          (e.g. Sabah / Sarawak ship longer); a warehouse with no override falls back to the Global
          Defaults shown here.
        </p>
        <label className={styles.dialogField}>
          <span className={styles.filterLabel}>Warehouse</span>
          <select
            className={styles.filterSelect}
            style={{ minWidth: 200 }}
            value={whKey}
            onChange={(e) => switchWh(e.target.value)}
          >
            <option value={GLOBAL_LEAD_KEY}>Global Defaults</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>{w.code}</option>
            ))}
          </select>
        </label>
        {q.isLoading && <p className={styles.dialogBody}>Loading…</p>}
        {!q.isLoading && MRP_LEAD_CATEGORIES.map((cat) => (
          <label key={cat} className={styles.dialogField}>
            <span className={styles.filterLabel} style={{ textTransform: 'capitalize' }}>{cat}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <input
                type="number" min={0} className={styles.filterSelect}
                style={{ width: 110, textAlign: 'right' }}
                value={valueFor(cat)}
                onChange={(e) => setDraft((s) => ({ ...s, [cat]: e.target.value }))}
              />
              <span className="whitespace-nowrap text-ink-muted">days early</span>
              <Button
                type="button" variant="primary"
                disabled={update.isPending || !dirty(cat)}
                onClick={() => save(cat)}
              >Save</Button>
            </span>
          </label>
        ))}
        <div className={styles.dialogActions}>
          <Button type="button" variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}

/* MRP split into four category tabs (Commander 2026-06-15). Each tab is locked
   to its own category; Service is excluded (not an orderable stock item). */
const VIEW_CATEGORY: Record<View, string> = {
  sofa: 'SOFA', bedframe: 'BEDFRAME', mattress: 'MATTRESS', accessory: 'ACCESSORY',
};
const VIEW_TABS: { value: View; label: string }[] = [
  { value: 'sofa', label: 'Sofa' },
  { value: 'bedframe', label: 'Bedframe' },
  { value: 'mattress', label: 'Mattress' },
  { value: 'accessory', label: 'Accessories' },
];

/* A "Model" groups every variant that shares the same SKU code (item_code).
   Bedframe/sofa: one model, many fabric/colour variants. Mattress/accessory:
   one model, one (empty) variant → renders 2-level. */
type ModelGroup = {
  /* Commander 2026-05-31 — a Model is now scoped to ONE warehouse. The same
     SKU in two warehouses is two groups (per-WH MRP, no cross-WH pooling). */
  groupKey: string;          // `${warehouseId ?? 'NOWH'}|${itemCode}` — identity
  warehouseId: string | null;
  warehouseCode: string | null;
  warehouseName: string | null;
  itemCode: string;
  description: string | null;
  category: string | null;
  variants: MrpSku[];
  qtyNeeded: number;
  stock: number;
  poOutstanding: number;
  shortage: number;
  suppliers: MrpSku['suppliers'];
};

const WH_NONE = 'NOWH';
const skuGroupKey = (s: MrpSku) => `${s.warehouseId ?? WH_NONE}|${s.itemCode}`;
const rowKey = (s: MrpSku) => `${s.warehouseId ?? WH_NONE}|${s.itemCode}${s.variantKey}`;

/* The SKU's default supplier id for a freshly-shown shortage line — its main
   supplier (suppliers is main-first), else the first bound supplier, else null
   (unbound SKU: no PO can be raised until a supplier is assigned). */
const skuDefaultSupplierId = (s: MrpSku): string | null =>
  (s.suppliers.find((x) => x.isMain) ?? s.suppliers[0])?.supplierId ?? null;

/* Only SHORTAGE lines are selectable / orderable. */
const shortageLinesOf = (s: MrpSku) => s.lines.filter((l) => l.source === 'shortage' && l.shortageQty > 0 && l.soItemId);

function groupByModel(skus: MrpSku[]): ModelGroup[] {
  const map = new Map<string, ModelGroup>();
  for (const s of skus) {
    const gk = skuGroupKey(s);
    let g = map.get(gk);
    if (!g) {
      g = {
        groupKey: gk,
        warehouseId: s.warehouseId, warehouseCode: s.warehouseCode, warehouseName: s.warehouseName,
        itemCode: s.itemCode, description: s.description, category: s.category,
        variants: [], qtyNeeded: 0, stock: 0, poOutstanding: 0, shortage: 0,
        suppliers: s.suppliers,
      };
      map.set(gk, g);
    }
    g.variants.push(s);
    g.qtyNeeded += s.qtyNeeded;
    g.stock += s.stock;
    g.poOutstanding += s.poOutstanding;
    g.shortage += s.shortage;
  }
  const groups = [...map.values()];
  for (const g of groups) {
    g.variants.sort((a, b) => (a.variantLabel ?? '') < (b.variantLabel ?? '') ? -1 : 1);
  }
  // Shortage models float to the top (the orange ones to act on), then by
  // warehouse, then by code — so each warehouse's rows cluster together.
  groups.sort((a, b) => {
    if ((b.shortage > 0 ? 1 : 0) !== (a.shortage > 0 ? 1 : 0)) {
      return (b.shortage > 0 ? 1 : 0) - (a.shortage > 0 ? 1 : 0);
    }
    const wa = a.warehouseCode ?? a.warehouseName ?? '';
    const wb = b.warehouseCode ?? b.warehouseName ?? '';
    if (wa !== wb) return wa < wb ? -1 : 1;
    return a.itemCode < b.itemCode ? -1 : 1;
  });
  return groups;
}

/* Adapter (F5, Wei Siang 2026-06-15) — fold sofa SETS into PER-SO module SKUs so
   the Sofa tab groups by SO (groupBySo below): one parent row per SO, its sofa
   modules as the variant sub-rows. NOT pooled across SOs (each module SKU belongs
   to one SO), and the variantKey is prefixed with the SO doc no so the render's
   per-variant expand key (rowKey) stays unique across SO rows. Ordering is
   unchanged — selection + Proceed PO still key off each line's soItemId. */
function sofaSetsToSkus(sets: SofaSet[]): MrpSku[] {
  const map = new Map<string, MrpSku>();
  for (const s of sets) {
    const realVariant = s.variantLabel ?? s.colour ?? '';
    // One row per (warehouse, SO, module, variant).
    const key = `${s.warehouseId ?? WH_NONE}|${s.soDocNo}|${s.itemCode}|${realVariant}`;
    let sku = map.get(key);
    if (!sku) {
      const main = s.suppliers.find((x) => x.isMain) ?? null;
      sku = {
        warehouseId: s.warehouseId, warehouseCode: s.warehouseCode, warehouseName: s.warehouseName,
        itemCode: s.itemCode,
        // soDocNo-prefixed so the same module+variant in two SOs gets distinct
        // rowKeys; the visible label shows the module (+ its fabric/colour).
        variantKey: `${s.soDocNo}::${realVariant}`,
        variantLabel: realVariant ? `${s.itemCode} · ${realVariant}` : s.itemCode,
        description: s.description, category: 'SOFA',
        qtyNeeded: 0, stock: 0, poOutstanding: 0, shortage: 0,
        mainSupplierCode: main?.code ?? null, mainSupplierName: main?.name ?? null,
        suppliers: s.suppliers, lines: [],
      };
      map.set(key, sku);
    }
    sku.qtyNeeded += s.qty;
    sku.poOutstanding += s.orderedQty;
    sku.shortage += s.shortageQty;
    sku.lines.push({
      soItemId: s.soItemId, soDocNo: s.soDocNo,
      // Carry the SO line's canonical stored sequence so groupBySo can order
      // an SO's module rows LHF → NA → RHF (same order as the SO PDF/detail).
      lineNo: s.lineNo, createdAt: s.createdAt,
      debtorName: s.debtorName,
      customerState: s.customerState,
      soDate: s.soDate, deliveryDate: s.deliveryDate, processingDate: s.processingDate,
      orderByDate: s.orderByDate, qty: s.qty,
      source: s.shortageQty > 0 ? 'shortage' : 'po', poNumber: s.poNumber, poEta: s.poEta,
      shortageQty: s.shortageQty,
      /* Commander 2026-05-31 — sofa SETs now carry the covering PO's supplier
         (backend mrp.ts), so a PO-covered sofa line shows it read-only instead
         of "—", identical to the General tab. NULL for stock/shortage sets. */
      poSupplierId: s.poSupplierId, poSupplierName: s.poSupplierName,
    });
  }
  return [...map.values()];
}

/* "BOOQIT-1B(LHF)", "BOOQIT-CNR" → "BOOQIT: 1B(LHF) + CNR" when every module
   shares one base model; otherwise the full codes joined. */
function sofaComposition(codes: string[]): string {
  const parts = codes.map((c) => {
    const i = c.indexOf('-');
    return i > 0 ? { base: c.slice(0, i), mod: c.slice(i + 1) } : { base: '', mod: c };
  });
  const bases = new Set(parts.map((p) => p.base).filter(Boolean));
  if (bases.size === 1) return `${[...bases][0]}: ${parts.map((p) => p.mod).join(' + ')}`;
  return codes.join(' + ');
}

/* Canonical stored-sequence comparator for two SO lines (migration 0165): order
   by line_no (NULLS LAST), then created_at, then leave equal. Mirrors the
   backend read order `(line_no NULLS LAST, created_at)` that the SO detail + SO
   PDF derive their LHF → NA → RHF order from, so the Sofa tab matches them. */
const soLineSeqCmp = (a: MrpLine | undefined, b: MrpLine | undefined): number => {
  const an = a?.lineNo, bn = b?.lineNo;
  const aHas = typeof an === 'number', bHas = typeof bn === 'number';
  if (aHas && bHas && an !== bn) return an! - bn!;
  if (aHas !== bHas) return aHas ? -1 : 1;          // numbered lines first (NULLS LAST)
  const ac = a?.createdAt ?? '', bc = b?.createdAt ?? '';
  if (ac !== bc) return ac < bc ? -1 : 1;
  return 0;
};

/* F5 — group the per-SO sofa module SKUs into ONE parent row per SO (the SO doc
   no is the "serial"); the modules become the variant sub-rows. Mirrors
   groupByModel's totals + shortage-first sort. */
function groupBySo(skus: MrpSku[]): ModelGroup[] {
  const map = new Map<string, ModelGroup>();
  for (const s of skus) {
    const soDocNo = s.lines[0]?.soDocNo ?? '—';
    const gk = `${s.warehouseId ?? WH_NONE}|${soDocNo}`;
    let g = map.get(gk);
    if (!g) {
      g = {
        groupKey: gk,
        warehouseId: s.warehouseId, warehouseCode: s.warehouseCode, warehouseName: s.warehouseName,
        itemCode: soDocNo, description: null, category: 'SOFA',
        variants: [], qtyNeeded: 0, stock: 0, poOutstanding: 0, shortage: 0,
        suppliers: s.suppliers,
      };
      map.set(gk, g);
    }
    g.variants.push(s);
    g.qtyNeeded += s.qtyNeeded;
    g.stock += s.stock;
    g.poOutstanding += s.poOutstanding;
    g.shortage += s.shortage;
  }
  const groups = [...map.values()];
  for (const g of groups) {
    /* Order each SO's module rows by the CANONICAL stored sequence (line_no,
       migration 0165) so they read LHF → NA → RHF exactly as the SO detail +
       SO PDF do — NOT an alphabetical item_code sort (which listed XAMMAR-L /
       1NA / 2A as 1NA → 2A → L). Each sofa variant is one module = one SO line,
       so we sort by that line's stored sequence: line_no (NULLS LAST), then
       created_at, then item_code, mirroring the backend's read order. */
    g.variants.sort((a, b) => soLineSeqCmp(a.lines[0], b.lines[0]) || (a.itemCode < b.itemCode ? -1 : a.itemCode > b.itemCode ? 1 : 0));
    // Composition only — no customer name on the parent row (Wei Siang
    // 2026-06-16); the customer still shows in the expanded child order lines.
    g.description = sofaComposition(g.variants.map((v) => v.itemCode));
  }
  groups.sort((a, b) => {
    if ((b.shortage > 0 ? 1 : 0) !== (a.shortage > 0 ? 1 : 0)) {
      return (b.shortage > 0 ? 1 : 0) - (a.shortage > 0 ? 1 : 0);
    }
    const wa = a.warehouseCode ?? a.warehouseName ?? '';
    const wb = b.warehouseCode ?? b.warehouseName ?? '';
    if (wa !== wb) return wa < wb ? -1 : 1;
    return a.itemCode < b.itemCode ? -1 : 1;
  });
  return groups;
}

/* BF-FLAT (Commander 2026-06-16) — bedframe is flattened like the Sofa tab:
   each colour VARIANT becomes its own top row (its Description 2 read straight
   at L1), and expanding jumps straight to the SO orders. No model → variant →
   orders middle level. We emit ONE single-variant ModelGroup per variant SKU so
   ModelRows' existing 2-level "single" path renders L1 → orders with no extra
   click. Mattress / Accessory keep groupByModel (one model, one variant). */
function groupByVariant(skus: MrpSku[]): ModelGroup[] {
  const groups: ModelGroup[] = skus.map((s) => ({
    groupKey: rowKey(s),               // warehouse|itemCode|variantKey — unique per variant
    warehouseId: s.warehouseId, warehouseCode: s.warehouseCode, warehouseName: s.warehouseName,
    itemCode: s.itemCode, description: s.description, category: s.category,
    variants: [s],                     // single → ModelRows jumps straight to orders
    qtyNeeded: s.qtyNeeded, stock: s.stock, poOutstanding: s.poOutstanding, shortage: s.shortage,
    suppliers: s.suppliers,
  }));
  // Same ordering as the other groupers: shortage (orange) first, then warehouse,
  // then code, then the variant label so a model's colours cluster together.
  groups.sort((a, b) => {
    if ((b.shortage > 0 ? 1 : 0) !== (a.shortage > 0 ? 1 : 0)) {
      return (b.shortage > 0 ? 1 : 0) - (a.shortage > 0 ? 1 : 0);
    }
    const wa = a.warehouseCode ?? a.warehouseName ?? '';
    const wb = b.warehouseCode ?? b.warehouseName ?? '';
    if (wa !== wb) return wa < wb ? -1 : 1;
    if (a.itemCode !== b.itemCode) return a.itemCode < b.itemCode ? -1 : 1;
    return (a.variants[0]!.variantLabel ?? '') < (b.variants[0]!.variantLabel ?? '') ? -1 : 1;
  });
  return groups;
}

export const Mrp = () => {
  const navigate = useNavigate();
  const { staff } = useAuth();
  const isAdmin = isAdminLevel(staff?.role);
  const [backfilling, setBackfilling] = useState(false);
  const [showLeadTimes, setShowLeadTimes] = useState(false);
  const [view, setView] = useState<View>('sofa');
  const [warehouseId, setWarehouseId] = useState<string>('all');
  /* Two expand levels: models (itemCode) and variants (rowKey). The sofa flat
     view reuses expandedVariants (each sofa row is variant-level). */
  const [expandedModels, setExpandedModels] = useState<Set<string>>(new Set());
  const [expandedVariants, setExpandedVariants] = useState<Set<string>>(new Set());
  /* Commander 2026-05-31 — selection lives at the SO ORDER-LINE level: each
     individual shortage line (soItemId) has its own checkbox. The Model/Variant
     checkboxes are parent "select all shortage lines beneath me" toggles. */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [poMode, setPoMode] = useState<'combined' | 'per-so'>('combined');
  /* Commander 2026-05-29 — turnover control: order by delivery-date window.
     Single date window with a switchable basis (like the convert page): filter
     by Delivery / Processing / SO date. Delivery basis = the turnover window. */
  const [dateBasis, setDateBasis] = useState<'delivery' | 'processing' | 'soDate' | 'orderBy'>('delivery');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [showUndated, setShowUndated] = useState<boolean>(false);
  /* Commander 2026-05-29 — focus view: hide everything that's fully covered and
     show ONLY the rows that still need ordering (shortage > 0), so the operator
     can go straight to Proceed PO without wading past the Ready ones. */
  const [onlyShort, setOnlyShort] = useState<boolean>(false);
  /* Commander 2026-05-31 — supplier is chosen PER SHORTAGE SO LINE (different
     lines of the same SKU may pick different suppliers). { soItemId: supplierId };
     defaults to the SKU's main supplier when no entry. Covered / already-PO'd
     lines never appear here — they show the PO's supplier read-only. */
  const [lineSupplier, setLineSupplier] = useState<Record<string, string>>({});
  const setLineSupplierId = (soItemId: string, supplierId: string) =>
    setLineSupplier((prev) => ({ ...prev, [soItemId]: supplierId }));
  /* In-app result dialog (Commander 2026-05-29: confirm INSIDE the page, not a
     browser window.confirm/alert). null = closed.
     'confirm' (Commander 2026-05-29) — Proceed PO first opens a confirm step so
     the operator can OPTIONALLY pick one Expected Delivery date for the whole
     batch; blank = keep each SO's own dates (today's behaviour). */
  const [dialog, setDialog] = useState<
    | { kind: 'info'; title: string; body: string }
    | { kind: 'created'; title: string; body: string }
    | { kind: 'confirm'; picks: Array<{ soItemId: string; qty: number; supplierId: string | null }>; orderedCodes: Set<string>; count: number; units: number }
    | null
  >(null);
  /* The Expected Delivery date the operator typed into the confirm dialog
     (YYYY-MM-DD). Blank = send no override → server uses each SO's own date. */
  const [proceedExpectedAt, setProceedExpectedAt] = useState<string>('');

  // Each tab is locked to its own category (Commander 2026-06-15 — four tabs).
  const apiCategory = VIEW_CATEGORY[view];
  const q = useMrp({ category: apiCategory, warehouseId, includeUndated: showUndated });
  const data = q.data;
  const createPos = useCreatePosFromSoItems();

  /* One key per convert RUN — the intent this page DOES have, and the reason
     fix/doc-idempotency's "no bindable intent here" was half right. The MOUNT is
     not the intent (this page stays open and runs convert after convert; a
     per-mount key would make runs 2..N replay run 1 and silently raise NOTHING
     while reporting POs created) and neither is the PAYLOAD (fromMrp converts
     are reference-only and infinite BY DESIGN, so identical picks twice are two
     legitimate POs). The RUN is: it begins when the operator commits a pick
     selection through the Proceed → confirm dialog, and it ends when the server
     answers. A ref, not state — nothing renders from it.

     Why the key must be RETIRED ON LANDING, which lib/idempotency.ts normally
     forbids ("retired by the intent ENDING, never by the write succeeding").
     Both 2xx branches force it:
       · total > 0 → the run landed, onSuccess CLEARS the selection and names the
         POs. The selection IS the intent's representation, so clearing it ends
         the intent — the sanctioned "dies with the row on success" shape, not the
         forbidden rotate(). Keeping the key would make the operator's NEXT,
         genuinely different selection replay this run's response.
       · total === 0 → mfg-purchase-orders.ts:1831 answers 201 { created: [], total: 0 }
         when every bucket's line-insert failed and its header was rolled back.
         NOTHING was created, but the 201 IS claimed. Keeping the key would replay
         that empty answer forever and the operator could never order these lines.
     The module's no-rotate reasoning does not bite here: it guards the case where
     a step AFTER a successful post fails and invites a re-press. Nothing here can
     — setDialog runs synchronously after the (unawaited) refetch, so a stalled
     refetch still shows "Successfully created N POs" with the numbers.

     On ERROR the key is deliberately KEPT. A non-2xx already deletes the claim
     server-side (idempotency.ts:103-108), so a genuinely failed run re-claims and
     re-runs; the key only bites when the post COMMITTED and the response was lost
     — the 4G case — where the selection is still on screen, "Order failed" invites
     the re-press, and fromMrp means the server has NO qty backstop to stop it
     duplicate-ordering the whole shortage. That is the bug this exists for. */
  const runKeyRef = useRef<string | null>(null);

  /* Four category tabs (Commander 2026-06-15): Sofa is fed from the per-SO sofa
     SETS; the other three filter the SKU payload to their own category so a
     stray category can't leak across tabs. */
  const tabSkus = view === 'sofa'
    ? sofaSetsToSkus(data?.sofaSets ?? [])
    : (data?.skus ?? []).filter((s) => s.category === VIEW_CATEGORY[view]);

  /* Delivery-date window: filter child lines + recompute the parent's Qty
     Needed / Shortage to the window. Stock/PO Outstanding stay SKU-level
     (supply isn't date-bucketed). shortageQty per line already reflects the
     date-priority allocation done server-side, so summing visible lines is
     correct. */
  const hasWindow = Boolean(dateFrom || dateTo);
  const lineDate = (l: MrpLine): string | null =>
    dateBasis === 'processing' ? l.processingDate
    : dateBasis === 'soDate' ? l.soDate
    : dateBasis === 'orderBy' ? l.orderByDate
    : l.deliveryDate;
  const lineInWindow = (l: MrpLine): boolean => {
    const d = lineDate(l);
    if (!d) return false;
    const x = d.slice(0, 10);
    if (dateFrom && x < dateFrom) return false;
    if (dateTo && x > dateTo) return false;
    return true;
  };
  const viewSkus: MrpSku[] = tabSkus
    .map((s) => {
      if (!hasWindow) return s;
      const lines = s.lines.filter(lineInWindow);
      const qtyNeeded = lines.reduce((a, l) => a + l.qty, 0);
      const shortage = lines.reduce((a, l) => a + (l.source === 'shortage' ? l.shortageQty : 0), 0);
      return { ...s, lines, qtyNeeded, shortage };
    })
    .filter((s) => !hasWindow || s.lines.length > 0);

  // Sofa tab groups by SO (one parent row per SO, modules as sub-rows, F5);
  // Bedframe flattens to one row per colour variant (BF-FLAT); Mattress /
  // Accessory group by SKU/Model.
  const models = view === 'sofa'
    ? groupBySo(viewSkus)
    : view === 'bedframe'
      ? groupByVariant(viewSkus)
      : groupByModel(viewSkus);

  /* Only-shortages focus filter (Commander 2026-05-29) — affects which ROWS
     render; the summary counts above stay on the full demand set so the
     operator still sees the totals. */
  const displayModels = onlyShort ? models.filter((m) => m.shortage > 0) : models;

  const toggleModel = (code: string) =>
    setExpandedModels((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  const toggleVariant = (key: string) =>
    setExpandedVariants((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  const expandAll = () => {
    setExpandedModels(new Set(models.map((m) => m.groupKey)));
    setExpandedVariants(new Set(viewSkus.map(rowKey)));
  };
  const collapseAll = () => { setExpandedModels(new Set()); setExpandedVariants(new Set()); };

  const switchView = (v: View) => {
    setView(v);
    setSelected(new Set());
    setExpandedModels(new Set());
    setExpandedVariants(new Set());
  };

  /* Fire the (mode-aware) convert-from-SO endpoint for the given picks. Shared
     by the General (per-variant shortage) and Sofa (per-set) order paths.
     `expectedAt` (Commander 2026-05-29) — when set, the server applies it as the
     PO header expected_at AND every PO line's delivery date for the whole batch;
     when blank we send nothing so it keeps using each SO's own dates. */
  const runCreatePos = (
    picks: Array<{ soItemId: string; qty: number; supplierId: string | null }>,
    _orderedCodes: Set<string>,
    expectedAt?: string,
  ) => {
    if (picks.length === 0) {
      setDialog({ kind: 'info', title: 'Nothing to order', body: 'No uncovered (shortage) lines in the current selection / window.' });
      return;
    }
    /* Commander 2026-05-31 — supplier now travels PER PICK (the per-line
       dropdown), so we no longer send supplierByCode from MRP. We DO send the
       Combined/Per-SO `mode` so the toggle works: 'combined' groups by
       (warehouse, supplier); 'per-so' splits further by source SO doc so each
       SO gets its own PO. fromMrp tags every PO line as reference-only so it
       never locks the source SO line (infinite-convert). */
    const body = { picks, mode: poMode, fromMrp: true, ...(expectedAt ? { expectedAt } : {}) };
    const runKey = runKeyRef.current ?? newIdempotencyKey();
    runKeyRef.current = runKey;
    createPos.mutate({ ...body, idempotencyKey: runKey }, {
      onSuccess: (res) => {
        // The run landed (either branch below) — end it, so the next Proceed is a
        // new run with a new key. See runKeyRef for why this is mandatory.
        runKeyRef.current = null;
        if (!res.total) {
          setDialog({
            kind: 'info',
            title: 'No POs created',
            body: "These SKUs aren't bound to a supplier yet. Assign each shortage SKU a main supplier (the “— none —” rows), then proceed again.",
          });
          return;
        }
        // Refresh so coverage updates immediately; keep the result in an in-app
        // dialog (not a browser alert) per commander.
        setSelected(new Set());
        void q.refetch();
        setDialog({
          kind: 'created',
          title: `Successfully created ${res.total} PO${res.total === 1 ? '' : 's'}`,
          body: (res.created ?? []).map((p) => p.poNumber).join(', '),
        });
      },
      onError: (err) => {
        const raw = err instanceof Error ? err.message : 'Something went wrong.';
        let codes: string[] = [];
        let errCode = '';
        try {
          const m = raw.match(/\{.*\}/);
          if (m) {
            const j = JSON.parse(m[0]);
            errCode = typeof j.error === 'string' ? j.error : '';
            if (j.error === 'missing_bindings' && Array.isArray(j.itemCodes)) codes = j.itemCodes;
          }
        } catch { /* generic */ }
        // A stale view can still try to order a line that was already PO'd in
        // another session/tab (server: qty_exceeds_remaining). Refresh so the
        // ordered line drops off, and tell the operator plainly instead of
        // showing the raw error (Commander 2026-05-29).
        if (errCode === 'qty_exceeds_remaining') {
          void q.refetch();
          setDialog({
            kind: 'info',
            title: 'Already ordered',
            body: 'Some of these lines were already put on a PO. The list has been refreshed — review what still needs ordering and proceed again.',
          });
          return;
        }
        setDialog(codes.length > 0
          ? { kind: 'info', title: "SKUs not bound to a supplier", body: 'Assign these to a supplier first, then proceed:\n' + codes.map((c) => `• ${c}`).join('\n') }
          : { kind: 'info', title: 'Order failed', body: raw });
      },
    });
  };

  /* General — picks (+ codes + unit count) from SHORTAGE order-lines. When a
     line-level selection exists, only the selected soItemIds are gathered;
     otherwise every visible shortage line. Each pick carries its per-line
     chosen supplier (defaulting to the SKU's main supplier). */
  const gatherShortages = (skus: MrpResponse['skus'], onlySelected: boolean) => {
    const picks: Array<{ soItemId: string; qty: number; supplierId: string | null }> = [];
    const orderedCodes = new Set<string>();
    let units = 0;
    for (const s of skus) {
      const def = skuDefaultSupplierId(s);
      for (const l of shortageLinesOf(s)) {
        if (onlySelected && !selected.has(l.soItemId)) continue;
        picks.push({ soItemId: l.soItemId, qty: l.shortageQty, supplierId: lineSupplier[l.soItemId] ?? def });
        orderedCodes.add(s.itemCode);
        units += l.shortageQty;
      }
    }
    return { picks, orderedCodes, units };
  };

  /* Sofa — same per-SO-line shortage picks as General (the adapter already
     unified the sets into MrpSku lines), PLUS the pillow pull-in. */
  const gatherSofa = (skus: MrpResponse['skus'], onlySelected: boolean) => {
    const base = gatherShortages(skus, onlySelected);
    const picks = [...base.picks];
    const orderedCodes = new Set(base.orderedCodes);
    let units = base.units;

    /* Commander 2026-05-29 — "pillow 开在 sofa 里面就要跟 sofa 的 PO 一起". For
       every SO we're proceeding a sofa set on, ALSO pull that SO's accessory
       (pillow) shortage lines into the same /from-sos batch. The server groups
       by supplier, so same-supplier pillows land on the sofa's PO and a
       different-supplier pillow splits to its own PO automatically. Accessories
       live in the General tab's SKU list, so read them off the raw payload
       (`data.skus`) — `viewSkus` is sofa-only in this view. Respect the active
       date window so we don't drag in out-of-window pillows. */
    const setDocs = new Set(
      skus.filter((s) => s.shortage > 0).flatMap((s) =>
        s.lines.filter((l) => l.source === 'shortage' && l.shortageQty > 0).map((l) => l.soDocNo)),
    );
    const already = new Set(picks.map((p) => p.soItemId));
    const accessoryLines = (data?.skus ?? [])
      .filter((s) => (s.category ?? '').toUpperCase() === 'ACCESSORY')
      .flatMap((s) => s.lines.map((l) => ({ line: l, itemCode: s.itemCode, supplierId: lineSupplier[l.soItemId] ?? skuDefaultSupplierId(s) })))
      .filter(({ line }) =>
        line.source === 'shortage' && line.shortageQty > 0 && line.soItemId
        && setDocs.has(line.soDocNo) && (!hasWindow || lineInWindow(line)));
    for (const { line, itemCode, supplierId } of accessoryLines) {
      if (already.has(line.soItemId)) continue;
      already.add(line.soItemId);
      picks.push({ soItemId: line.soItemId, qty: line.shortageQty, supplierId });
      orderedCodes.add(itemCode);
      units += line.shortageQty;
    }
    return { picks, orderedCodes, units };
  };

  /* Commander 2026-05-31 — selection is now per SO ORDER-LINE (soItemId). Every
     shortage line in view is one selectable unit. */
  const shortageSkus = viewSkus.filter((s) => s.shortage > 0);
  // All selectable shortage line ids currently in view (header select-all set).
  const allShortageLineIds = shortageSkus.flatMap((s) => shortageLinesOf(s).map((l) => l.soItemId));

  /* Sofa set-selection (Commander 2026-05-30 — "选1 就整套一起选 同个SO"): a sofa
     is colour-matched and proceeded as ONE PO per SO, so selecting any sofa
     shortage line must also select every sofa shortage line on the SAME SO. Now
     that selection is per soItemId, index SO doc ↔ the shortage line ids that
     share it. (General selection stays strictly per line.) */
  const docToLineIds = new Map<string, Set<string>>();
  const lineIdToDocs = new Map<string, Set<string>>();
  if (view === 'sofa') {
    for (const s of shortageSkus) {
      for (const l of shortageLinesOf(s)) {
        let dk = docToLineIds.get(l.soDocNo);
        if (!dk) { dk = new Set(); docToLineIds.set(l.soDocNo, dk); }
        dk.add(l.soItemId);
        let kd = lineIdToDocs.get(l.soItemId);
        if (!kd) { kd = new Set(); lineIdToDocs.set(l.soItemId, kd); }
        kd.add(l.soDocNo);
      }
    }
  }
  /* Expand a set of line ids to include every same-SO sibling line (sofa only;
     in General the input set is returned unchanged). */
  const expandSofaSiblings = (ids: Iterable<string>): Set<string> => {
    const out = new Set<string>();
    for (const id of ids) {
      out.add(id);
      if (view === 'sofa') {
        for (const d of lineIdToDocs.get(id) ?? []) for (const sib of docToLineIds.get(d) ?? []) out.add(sib);
      }
    }
    return out;
  };

  /* Toggle one SO order-line (General = just that line; Sofa = its whole set). */
  const toggleSelectLine = (soItemId: string) => {
    const group = expandSofaSiblings([soItemId]);
    setSelected((prev) => {
      const next = new Set(prev);
      const allOn = [...group].every((k) => next.has(k));
      for (const k of group) { if (allOn) next.delete(k); else next.add(k); }
      return next;
    });
  };
  /* Parent toggle: select / deselect every shortage line beneath the given
     line ids (used by the Model + Variant parent checkboxes). */
  const setLinesSelected = (ids: string[], on: boolean) => {
    const group = expandSofaSiblings(ids);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of group) { if (on) next.add(k); else next.delete(k); }
      return next;
    });
  };

  // View-agnostic counts the header / select-all / summary read from — now
  // line-based (each shortage SO order-line is one unit).
  const shortCount = allShortageLineIds.length;
  const selectedShortCount = allShortageLineIds.filter((id) => selected.has(id)).length;

  const allShortSelected = shortCount > 0 && selectedShortCount === shortCount;
  const someShortSelected = selectedShortCount > 0 && !allShortSelected;
  const toggleSelectAll = () => {
    if (allShortSelected) { setSelected(new Set()); return; }
    setSelected(new Set(allShortageLineIds));
  };

  /* One-click backfill of warehouses onto older SOs that have none (derived
     from each SO's State). Fixes the "—" warehouse on SOs placed before per-line
     warehouse routing / via paths that sent no address. Admin-only. */
  const onBackfillWarehouses = async () => {
    if (backfilling) return;
    setBackfilling(true);
    try {
      const res = await authedFetch<{ filled: number; skipped: number; orders: number }>(
        '/mfg-sales-orders/backfill-warehouses', { method: 'POST' },
      );
      setDialog({
        kind: 'info',
        title: 'Warehouses re-bound',
        body: `Filled ${res.filled} order${res.filled === 1 ? '' : 's'} from their State.${res.skipped > 0 ? ` ${res.skipped} skipped — no / unmapped State (set a location on those SOs, or add the State to State→Warehouse mappings).` : ''}`,
      });
      void q.refetch();
    } catch (e) {
      setDialog({ kind: 'info', title: 'Backfill failed', body: e instanceof Error ? e.message : 'Something went wrong.' });
    } finally {
      setBackfilling(false);
    }
  };

  /* Proceed PO — gather the selected shortage lines (or all visible shortage
     lines if none selected) and open the confirm dialog so the operator can
     OPTIONALLY pick one Expected Delivery date for the whole batch. */
  const onProceed = () => {
    const onlySelected = selectedShortCount > 0;
    const { picks, orderedCodes, units } = view === 'sofa'
      ? gatherSofa(shortageSkus, onlySelected)
      : gatherShortages(shortageSkus, onlySelected);
    if (picks.length === 0) {
      setDialog({ kind: 'info', title: 'Nothing to order', body: 'No uncovered (shortage) lines in the current selection / window.' });
      return;
    }
    setProceedExpectedAt('');
    setDialog({ kind: 'confirm', picks, orderedCodes, count: picks.length, units });
  };

  const basisLabel = dateBasis === 'processing' ? 'Processing Date' : dateBasis === 'soDate' ? 'SO Date' : dateBasis === 'orderBy' ? 'Order-by' : 'Delivery';
  const windowLabel = hasWindow ? `${basisLabel} ${dateFrom || '…'} → ${dateTo || '…'}` : '';

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Planning"
        title="MRP · Stock Status Report"
        actions={
          <>
            {/* Group 1 — VIEW SWITCH: segmented toggle, one connected control with
                the active option highlighted (same semantics as Create-PO-from-SO).
                Reskinned to the reference FilterPills slab. */}
            <div
              className="inline-flex items-center gap-0.5 rounded-md border border-border bg-surface p-1 shadow-stone"
              role="group"
              aria-label="PO generation mode"
            >
              {([
                { mode: 'combined' as const, label: 'Combined', title: 'One PO per supplier' },
                { mode: 'per-so' as const, label: 'Per SO', title: 'One PO per SO (sofa / bedframe)' },
              ]).map(({ mode, label, title }) => (
                <button
                  key={mode}
                  type="button"
                  data-active={poMode === mode}
                  onClick={() => setPoMode(mode)}
                  title={title}
                  className={
                    poMode === mode
                      ? 'whitespace-nowrap rounded bg-primary px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-white shadow-sm transition-all duration-150'
                      : 'whitespace-nowrap rounded px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-all duration-150 hover:bg-primary-soft hover:text-primary'
                  }
                >
                  {label}
                </button>
              ))}
            </div>

            <span className="hidden h-5 w-px self-center bg-border sm:block" aria-hidden="true" />

            {/* Group 2 — UTILITIES: lighter, secondary buttons grouped together. */}
            <div className="inline-flex items-center gap-1.5" role="group" aria-label="Table utilities">
              <button type="button" className={TOOLBAR_BTN} onClick={collapseAll}>Collapse</button>
              <button type="button" className={TOOLBAR_BTN} onClick={expandAll}>Expand</button>
              <button type="button" className={TOOLBAR_BTN} onClick={() => void q.refetch()} disabled={q.isFetching}>
                <RefreshCw {...ICON} className={q.isFetching ? 'animate-spin' : undefined} /> Refresh
              </button>
              {isAdmin && (
                <button type="button" className={TOOLBAR_BTN} onClick={onBackfillWarehouses} disabled={backfilling}
                  title="Bind a warehouse to older SOs that have none, derived from each SO's State">
                  {backfilling ? 'Re-binding…' : 'Re-bind WH'}
                </button>
              )}
              {isAdmin && (
                <button type="button" className={TOOLBAR_BTN} onClick={() => setShowLeadTimes(true)}
                  title="Set how many days early each category's PO is ordered (applied when you Proceed PO)">
                  <Clock {...ICON} /> Lead Times
                </button>
              )}
            </div>
          </>
        }
        primaryAction={
          /* Group 3 — PRIMARY CTA: the strongest action, far right. */
          <Button
            type="button"
            variant="primary"
            icon={<ShoppingCart {...ICON} />}
            disabled={createPos.isPending || shortCount === 0}
            onClick={onProceed}
            title={
              selectedShortCount > 0 ? 'Order the selected SKUs'
              : hasWindow ? `Order everything in ${windowLabel} as one batch`
              : view === 'sofa' ? 'Order all sofa sets still to order' : 'Order all shortage SKUs'
            }
          >
            {createPos.isPending
              ? 'Processing…'
              : selectedShortCount > 0
                ? `Proceed PO (${selectedShortCount})`
                : hasWindow
                  ? `Proceed PO · window (${shortCount})`
                  : `Proceed PO (${shortCount})`}
          </Button>
        }
      />

      {/* Tabs — Commander 2026-06-15: one tab per category (Service excluded).
          Underline strip matching the shared <TabStrip>; hand-rolled so the
          tablist/tab/aria-selected semantics this page already had survive. */}
      <div className="no-scrollbar -mx-4 flex items-center gap-1 overflow-x-auto border-b border-border px-4 sm:mx-0 sm:px-0 [&>*]:shrink-0" role="tablist">
        {VIEW_TABS.map((t) => (
          <button key={t.value} type="button" role="tab" aria-selected={view === t.value}
            data-active={view === t.value} onClick={() => switchView(t.value)}
            className={
              view === t.value
                ? 'relative -mb-px flex items-center gap-2 whitespace-nowrap border-b-2 border-primary px-4 py-2.5 text-[12px] font-semibold text-primary transition-colors'
                : 'relative -mb-px flex items-center gap-2 whitespace-nowrap border-b-2 border-transparent px-4 py-2.5 text-[12px] font-semibold text-ink-secondary transition-colors hover:text-ink'
            }>
            {t.label}
          </button>
        ))}
      </div>

      {/* Summary pills removed (Commander 2026-06-15 — "那个不需要,删掉"); the
          active date-window chip stays since it reflects the live filter. */}
      {data && hasWindow && (
        <div className="flex flex-wrap gap-3">
          <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-[13px] font-semibold text-ink shadow-stone">
            <CalendarRange {...ICON} /> Window {windowLabel}
          </span>
        </div>
      )}

      {/* Sofa is ordered as a colour-matched SET, one PO per SO. */}
      {view === 'sofa' && (
        <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary-soft px-4 py-2.5 text-[12.5px] leading-relaxed text-ink-secondary">
          <Info {...ICON} className="mt-0.5 shrink-0 text-primary" />
          <span>
            Expand a sofa model to see its colour <strong className="font-semibold text-primary">variants</strong>, then
            which Sales Orders need each. A sofa is colour-matched and ordered as
            a whole set — selecting one selects the whole same-SO set. Orange rows
            still need ordering.
          </span>
        </div>
      )}

      {/* Bedframe flattened (BF-FLAT): one row per colour variant. */}
      {view === 'bedframe' && (
        <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary-soft px-4 py-2.5 text-[12.5px] leading-relaxed text-ink-secondary">
          <Info {...ICON} className="mt-0.5 shrink-0 text-primary" />
          <span>
            Each row is one bedframe <strong className="font-semibold text-primary">colour / variant</strong> (its
            Description 2). Expand a row to see which Sales Orders need it. Orange
            rows still need ordering.
          </span>
        </div>
      )}

      {/* Filters — switchable date basis drives the window; Warehouse over
          Category on the right. Category sub-filter only on the General tab. */}
      <div className={styles.filterRow}>
        <label className={styles.filterField}>
          <span className={styles.filterLabel}>Date</span>
          <select className={styles.filterSelect} value={dateBasis}
            onChange={(e) => setDateBasis(e.target.value as typeof dateBasis)}
            title="Which date the From–To window filters on">
            <option value="delivery">Delivery date</option>
            <option value="orderBy">Order-by date</option>
            <option value="processing">Processing date</option>
            <option value="soDate">SO date</option>
          </select>
        </label>
        <label className={styles.filterField}>
          <span className={styles.filterLabel}>from</span>
          <DateField value={dateFrom} onChange={setDateFrom} aria-label="From date" />
        </label>
        <label className={styles.filterField}>
          <span className={styles.filterLabel}>to</span>
          <DateField value={dateTo} onChange={setDateTo} aria-label="To date" />
        </label>
        {hasWindow && (
          <button type="button" className={TOOLBAR_BTN}
            onClick={() => { setDateFrom(''); setDateTo(''); }}>Clear window</button>
        )}
        <label className={styles.filterField} title="Show SO lines that have no delivery date (not ready to order)">
          <input type="checkbox" checked={showUndated} onChange={(e) => setShowUndated(e.target.checked)} />
          <span className={styles.filterLabel}>Show no-date</span>
        </label>
        <label className={styles.filterField} title="Hide fully-covered rows — show only what still needs ordering">
          <input type="checkbox" checked={onlyShort} onChange={(e) => setOnlyShort(e.target.checked)} />
          <span className={styles.filterLabel}>Only shortages</span>
        </label>
        {/* Commander 2026-05-29 — "排版整理一下": Warehouse + Category used to sit
            in a right-aligned vertical stack (pushed by a spacer), which read as
            mis-indented. Flattened into the same left-aligned wrapping row as the
            date/checkbox filters so everything lines up on one consistent grid. */}
        <label className={styles.filterField}>
          <span className={styles.filterLabel}>Warehouse</span>
          <select className={styles.filterSelect} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="all">All warehouses</option>
            {sortByText(data?.warehouses ?? []).map((w) => (
              <option key={w.id} value={w.id}>{w.code}</option>
            ))}
          </select>
        </label>
        {/* Category sub-filter removed — each tab IS its own category now (M1). */}
      </div>

      {/* Table — 3-level Model → Variant → SO orders, identical for both tabs.
          Sofa feeds the same renderer via the sofaSetsToSkus adapter; only the
          select handlers differ (sofa selects the whole same-SO set). */}
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.colSelect}>
                <input
                  type="checkbox"
                  aria-label="Select all shortage rows"
                  title="Select all shortage rows"
                  disabled={shortCount === 0}
                  checked={allShortSelected}
                  ref={(el) => { if (el) el.indeterminate = someShortSelected; }}
                  onChange={toggleSelectAll}
                />
              </th>
              <th className={styles.colCaret} />
              {/* Commander 2026-05-31 — per-warehouse MRP: each Model row is
                  scoped to one warehouse (no cross-WH pooling). */}
              <th>Warehouse</th>
              {/* Sofa tab is one row per SALES ORDER (F5), so the lead column is
                  the SO No there, not an item code — label it honestly per tab. */}
              <th>{view === 'sofa' ? 'Sales Order' : 'Item Code'}</th>
              <th>Description</th>
              <th className={styles.num}>Qty Needed</th>
              <th className={styles.num}>Stock</th>
              <th className={styles.num}>PO Outstanding</th>
              <th className={styles.num}>Shortage</th>
              {/* Delivery date + supplier dropped from the Model rows (Commander
                  2026-05-31): both vary PER SO LINE, so showing one value on the
                  SKU rollup is misleading. Warehouse + supplier now live on each
                  SO order row in the expanded child table below. Lead time still
                  drives the sort. */}
            </tr>
          </thead>
          <tbody>
            {q.isLoading && (
              <tr><td colSpan={9} className={styles.stateCell}>Loading MRP…</td></tr>
            )}
            {q.isError && (
              <tr><td colSpan={9} className={styles.stateCell}>Failed to load: {(q.error as Error)?.message}</td></tr>
            )}
            {data && displayModels.length === 0 && (
              <tr><td colSpan={9} className={styles.stateCell}>
                {onlyShort ? 'Nothing needs ordering — everything in view is covered.'
                  : hasWindow ? 'No demand delivering in this window.'
                  : 'No open Sales-Order demand for this filter.'}
              </td></tr>
            )}
            {displayModels.map((g) => (
              <ModelRows
                key={g.groupKey}
                group={g}
                modelOpen={expandedModels.has(g.groupKey)}
                onToggleModel={() => toggleModel(g.groupKey)}
                expandedVariants={expandedVariants}
                onToggleVariant={toggleVariant}
                selected={selected}
                onToggleLine={toggleSelectLine}
                onSetLinesSelected={setLinesSelected}
                lineSupplier={lineSupplier}
                onLineSupplierChange={setLineSupplierId}
                flatModules={view === 'sofa'}
                variantAtL1={view === 'bedframe'}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* In-app result dialog — Commander 2026-05-29: confirm/result inside the
          page, not a browser alert. The 'confirm' kind is the Proceed-PO step
          that lets the operator OPTIONALLY pick one Expected Delivery date. */}
      {dialog && dialog.kind === 'confirm' && (
        <div className={styles.dialogBackdrop} onClick={() => setDialog(null)}>
          <div className={styles.dialog} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h2 className={styles.dialogTitle}>Proceed PO</h2>
            <p className={styles.dialogBody}>
              Generate purchase orders for {dialog.count} {dialog.count === 1 ? 'line' : 'lines'}
              {' '}({dialog.units} {dialog.units === 1 ? 'unit' : 'units'}) in{' '}
              {poMode === 'combined' ? 'Combined (one PO per supplier)' : 'Per SO (one PO per SO)'} mode.
            </p>
            <label className={styles.dialogField}>
              <span className={styles.filterLabel}>Expected Delivery (optional — leave blank to use each SO's own date)</span>
              <DateField
                fullWidth
                value={proceedExpectedAt}
                onChange={setProceedExpectedAt}
                aria-label="Expected delivery date"
                title="Apply one delivery date to the whole batch (PO header + every line). Leave blank to keep each SO's own date."
              />
            </label>
            <div className={styles.dialogActions}>
              <Button type="button" variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
              <Button
                type="button"
                variant="primary"
                disabled={createPos.isPending}
                onClick={() => {
                  const { picks, orderedCodes } = dialog;
                  setDialog(null);
                  runCreatePos(picks, orderedCodes, proceedExpectedAt || undefined);
                }}
              >
                {createPos.isPending ? 'Processing…' : 'Confirm'}
              </Button>
            </div>
          </div>
        </div>
      )}
      {dialog && dialog.kind !== 'confirm' && (
        <div className={styles.dialogBackdrop} onClick={() => setDialog(null)}>
          <div className={styles.dialog} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h2 className={styles.dialogTitle}>{dialog.title}</h2>
            <p className={styles.dialogBody}>{dialog.body}</p>
            <div className={styles.dialogActions}>
              {dialog.kind === 'created' ? (
                <>
                  <Button type="button" variant="secondary" onClick={() => setDialog(null)}>Stay here</Button>
                  <Button type="button" variant="primary" onClick={() => { setDialog(null); navigate('/scm/purchase-orders'); }}>
                    Open Purchase Orders
                  </Button>
                </>
              ) : (
                <Button type="button" variant="primary" onClick={() => setDialog(null)}>OK</Button>
              )}
            </div>
          </div>
        </div>
      )}

      {showLeadTimes && (
        <LeadTimesDialog
          onClose={() => setShowLeadTimes(false)}
          warehouses={data?.warehouses ?? []}
        />
      )}
    </div>
  );
};

/* Per-shortage-line supplier dropdown (Commander 2026-05-31). Each shortage SO
   line picks its own supplier, defaulting to the SKU's main supplier; different
   lines of the same SKU MAY differ. Unbound SKU → "— none —" (can't be ordered
   until a supplier is assigned). */
const LineSupplierCell = ({ suppliers, chosenSupplierId, onSupplierChange }: {
  suppliers: MrpSku['suppliers']; chosenSupplierId: string | null;
  onSupplierChange: (supplierId: string) => void;
}) => {
  if (suppliers.length === 0) return <span className={styles.noSupplier}>— none —</span>;
  const defaultSupplierId = suppliers.find((s) => s.isMain)?.supplierId ?? suppliers[0]!.supplierId;
  return (
    <select
      className={styles.supplierSelect}
      value={chosenSupplierId ?? defaultSupplierId}
      onChange={(e) => onSupplierChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      title="Supplier for this SO line — defaults to the SKU's main supplier"
    >
      {sortByText(suppliers).map((s) => (
        <option key={s.supplierId} value={s.supplierId}>
          {s.name}{s.isMain ? ' ★' : ''} · {s.code}
        </option>
      ))}
    </select>
  );
};

/* All shortage line ids beneath a variant (sku). */
const shortageLineIdsOf = (s: MrpSku): string[] =>
  s.lines.filter((l) => l.source === 'shortage' && l.shortageQty > 0 && l.soItemId).map((l) => l.soItemId);

/* General tab — one Model and its variants. Multi-variant models expand into
   variant sub-rows (each expandable to its SO orders). Single-variant models
   (mattress, accessory) expand straight to their SO orders. Selection + supplier
   live on each SO ORDER LINE; the Model / Variant checkboxes are parent toggles. */
const ModelRows = ({
  group, modelOpen, onToggleModel, expandedVariants, onToggleVariant,
  selected, onToggleLine, onSetLinesSelected, lineSupplier, onLineSupplierChange,
  flatModules, variantAtL1,
}: {
  group: ModelGroup;
  modelOpen: boolean;
  onToggleModel: () => void;
  expandedVariants: Set<string>;
  onToggleVariant: (key: string) => void;
  selected: Set<string>;
  onToggleLine: (soItemId: string) => void;
  onSetLinesSelected: (ids: string[], on: boolean) => void;
  lineSupplier: Record<string, string>;
  onLineSupplierChange: (soItemId: string, supplierId: string) => void;
  flatModules?: boolean;
  /* BF-FLAT — bedframe groups are single-variant (one colour each). Show the
     variant (Description 2) right on the L1 row so colours of the same model are
     distinguishable, and skip the redundant spec label inside the expand. */
  variantAtL1?: boolean;
}) => {
  const short = group.shortage > 0;
  // Parent (Model) checkbox state — over every shortage line beneath the model.
  const modelLineIds = group.variants.flatMap(shortageLineIdsOf);
  const modelSel = modelLineIds.filter((id) => selected.has(id));
  const allSel = modelLineIds.length > 0 && modelSel.length === modelLineIds.length;
  const someSel = modelSel.length > 0 && !allSel;
  /* Single-variant models (mattress, single-variant bedframe, single-config
     sofa) collapse to 2 levels: expanding the model jumps straight to its SO
     orders (Commander 2026-05-30 — bedframe must show which SO needs it without
     a second click). The variant's spec still shows as a label above the
     orders. A "N variants" pill appears whenever the model has named variants. */
  const variantCount = group.variants.length;
  const hasNamedVariant = group.variants.some((v) => v.variantKey !== '');
  const single = variantCount === 1;
  const onlyVariant = group.variants[0]!;

  return (
    <>
      <tr className={`${styles.skuRow} ${short ? styles.skuRowShort : ''}`} onClick={onToggleModel}>
        <td className={styles.colSelect} onClick={(e) => e.stopPropagation()}>
          {modelLineIds.length > 0 && (
            <input
              type="checkbox"
              checked={allSel}
              ref={(el) => { if (el) el.indeterminate = someSel; }}
              onChange={(e) => onSetLinesSelected(modelLineIds, e.target.checked)}
              aria-label={`Select all shortage lines under ${group.itemCode}`}
            />
          )}
        </td>
        <td className={styles.colCaret}>
          {modelOpen ? <ChevronDown {...ICON} /> : <ChevronRight {...ICON} />}
        </td>
        <td className={styles.whCell}>
          {group.warehouseCode
            ? <span className={styles.whTag} title={group.warehouseName ?? undefined}>{group.warehouseCode}</span>
            : <span className={styles.whNone}>—</span>}
        </td>
        <td className={styles.codeCell}>{group.itemCode}</td>
        <td className={styles.descCell}>
          {group.description ?? '—'}
          {variantAtL1
            ? (onlyVariant.variantLabel
                ? <span className={styles.variantTag}>{onlyVariant.variantLabel}</span>
                : null)
            : (hasNamedVariant
                ? <span className={styles.countTag}>{variantCount} variant{variantCount === 1 ? '' : 's'}</span>
                : null)}
        </td>
        <td className={styles.num}>{group.qtyNeeded}</td>
        <td className={styles.num}>{group.stock}</td>
        <td className={styles.num}>{group.poOutstanding || '—'}</td>
        <td className={`${styles.num} ${short ? styles.shortNum : ''}`}>{short ? group.shortage : '—'}</td>
        {/* Supplier column removed from the Model row (Commander 2026-05-31):
            different SO lines under one SKU can pick different suppliers, so a
            single value here was misleading. Supplier lives per SO line below. */}
      </tr>

      {/* Sofa flat view (M-S1): one table per SO, one row per module — module +
          its order-line detail (coverage / supplier / delivery) on the same row,
          no second drill. */}
      {modelOpen && flatModules && (
        <tr className={styles.detailRow}>
          <td /><td />
          <td colSpan={7}>
            <SofaSoTable group={group} selected={selected} onToggleLine={onToggleLine}
              lineSupplier={lineSupplier} onLineSupplierChange={onLineSupplierChange} />
          </td>
        </tr>
      )}

      {/* Single-variant model → orders directly (2-level). Show the variant
          spec as a label above the orders when there is one (bedframe/sofa). */}
      {modelOpen && !flatModules && single && (
        <tr className={styles.detailRow}>
          <td /><td />
          <td colSpan={7}>
            {/* variantAtL1 (bedframe): the variant already shows on the L1 row,
                so don't repeat it as a spec label above the orders. */}
            {!variantAtL1 && onlyVariant.variantLabel && (
              <div className={styles.singleSpec}>
                <span className={styles.variantBranch}>↳</span>
                <span className={styles.variantTag}>{onlyVariant.variantLabel}</span>
              </div>
            )}
            <OrderLines sku={onlyVariant} selected={selected} onToggleLine={onToggleLine}
              lineSupplier={lineSupplier} onLineSupplierChange={onLineSupplierChange} />
          </td>
        </tr>
      )}

      {/* Multi-variant model → variant sub-rows (each expandable to orders). */}
      {modelOpen && !flatModules && !single && group.variants.map((v) => {
        const k = rowKey(v);
        const vShort = v.shortage > 0;
        const vOpen = expandedVariants.has(k);
        // Variant parent checkbox — over this variant's shortage lines.
        const vLineIds = shortageLineIdsOf(v);
        const vSel = vLineIds.filter((id) => selected.has(id));
        const vAllSel = vLineIds.length > 0 && vSel.length === vLineIds.length;
        const vSomeSel = vSel.length > 0 && !vAllSel;
        return (
          <FragmentRow key={k}>
            <tr className={`${styles.variantRow} ${vShort ? styles.variantRowShort : ''}`} onClick={() => onToggleVariant(k)}>
              <td className={styles.colSelect} onClick={(e) => e.stopPropagation()}>
                {vLineIds.length > 0 && (
                  <input
                    type="checkbox"
                    checked={vAllSel}
                    ref={(el) => { if (el) el.indeterminate = vSomeSel; }}
                    onChange={(e) => onSetLinesSelected(vLineIds, e.target.checked)}
                    aria-label={`Select all shortage lines under ${v.variantLabel ?? v.itemCode}`}
                  />
                )}
              </td>
              <td className={styles.colCaret}>
                {vOpen ? <ChevronDown {...ICON} /> : <ChevronRight {...ICON} />}
              </td>
              <td />{/* warehouse — inherited from parent model row */}
              <td />
              <td className={styles.variantDescCell}>
                <span className={styles.variantBranch}>↳</span>
                <span className={styles.variantTag}>{v.variantLabel ?? '(no variant)'}</span>
              </td>
              <td className={styles.num}>{v.qtyNeeded}</td>
              <td className={styles.num}>{v.stock}</td>
              <td className={styles.num}>{v.poOutstanding || '—'}</td>
              <td className={`${styles.num} ${vShort ? styles.shortNum : ''}`}>{vShort ? v.shortage : '—'}</td>
            </tr>
            {vOpen && (
              <tr className={styles.detailRow}>
                <td /><td />
                <td colSpan={7}>
                  <OrderLines sku={v} selected={selected} onToggleLine={onToggleLine}
                    lineSupplier={lineSupplier} onLineSupplierChange={onLineSupplierChange} />
                </td>
              </tr>
            )}
          </FragmentRow>
        );
      })}
    </>
  );
};

/* Tiny helper so multi-element returns inside .map keep a single key. */
const FragmentRow = ({ children }: { children: ReactNode }) => <>{children}</>;

/* The SO-order child table — shared by every leaf level. Each shortage line has
   its own select checkbox + supplier dropdown; covered lines show the covering
   PO's supplier read-only (Commander 2026-05-31). */
const OrderLines = ({ sku, selected, onToggleLine, lineSupplier, onLineSupplierChange }: {
  sku: MrpSku;
  selected: Set<string>;
  onToggleLine: (soItemId: string) => void;
  lineSupplier: Record<string, string>;
  onLineSupplierChange: (soItemId: string, supplierId: string) => void;
}) => (
  <table className={styles.childTable}>
    <thead>
      <tr>
        <th className={styles.colSelect} />
        <th>SO No</th>
        <th>Warehouse</th>
        <th>Customer</th>
        <th>State</th>
        <th>Processing Date</th>
        <th>Delivery Date</th>
        <th className={styles.num}>Qty</th>
        <th>Coverage</th>
        <th>Supplier</th>
      </tr>
    </thead>
    <tbody>
      {sku.lines.map((ln, i) => (
        <ChildLine
          key={`${ln.soDocNo}-${i}`}
          ln={ln}
          suppliers={sku.suppliers}
          whCode={sku.warehouseCode}
          whName={sku.warehouseName}
          selected={selected.has(ln.soItemId)}
          onToggleLine={() => onToggleLine(ln.soItemId)}
          chosenSupplierId={lineSupplier[ln.soItemId] ?? null}
          onSupplierChange={(sid) => onLineSupplierChange(ln.soItemId, sid)}
        />
      ))}
    </tbody>
  </table>
);

const ChildLine = ({ ln, suppliers, whCode, whName, selected, onToggleLine, chosenSupplierId, onSupplierChange }: {
  ln: MrpLine;
  suppliers: MrpSku['suppliers'];
  whCode: string | null;
  whName: string | null;
  selected: boolean;
  onToggleLine: () => void;
  chosenSupplierId: string | null;
  onSupplierChange: (supplierId: string) => void;
}) => {
  const short = ln.source === 'shortage' && ln.shortageQty > 0 && Boolean(ln.soItemId);
  return (
    <tr className={short ? styles.childShort : undefined}>
      <td className={styles.colSelect}>
        {short && (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleLine}
            aria-label={`Select ${ln.soDocNo} to order`}
          />
        )}
      </td>
      <td className={styles.codeCell}>{ln.soDocNo}</td>
      <td className={styles.whCell}>
        {whCode
          ? <span className={styles.whTag} title={whName ?? undefined}>{whCode}</span>
          : <span className={styles.whNone}>—</span>}
      </td>
      <td>{ln.debtorName ?? '—'}</td>
      <td>{ln.customerState ?? '—'}</td>
      <td>{fmtDate(ln.processingDate)}</td>
      <td>{fmtDate(ln.deliveryDate)}</td>
      <td className={styles.num}>{ln.qty}</td>
      <td>
        {ln.source === 'stock' && <span className={`${styles.tag} ${styles.tagStock}`}>stock</span>}
        {ln.source === 'po' && (
          <span className={`${styles.tag} ${styles.tagPo}`}>
            {ln.poNumber
              ? `${ln.poNumber}${ln.poEta ? ` · ETA ${fmtDate(ln.poEta)}` : ''}`
              : 'ordered'}
          </span>
        )}
        {short && (
          <span className={`${styles.tag} ${styles.tagShort}`}>
            SHORT{ln.shortageQty > 1 ? ` ×${ln.shortageQty}` : ''}
          </span>
        )}
      </td>
      <td className={styles.supplierCell}>
        {short
          /* Shortage line → editable per-line supplier dropdown. */
          ? <LineSupplierCell suppliers={suppliers} chosenSupplierId={chosenSupplierId} onSupplierChange={onSupplierChange} />
          /* Covered / already-PO'd line → the PO's supplier, READ-ONLY (a raised
             PO's supplier can't change). Stock lines show a dash. */
          : ln.source === 'po'
            ? <span className={styles.poSupplierRO} title="Supplier locked — this line is already on a PO">
                <Truck {...ICON} /> {ln.poSupplierName ?? '—'}
              </span>
            : <span className={styles.whNone}>—</span>}
      </td>
    </tr>
  );
};

/* Sofa-only flat view (M-S1, Wei Siang 2026-06-16): ONE table per SO, one row
   per module, with the order-line detail (coverage / supplier / delivery) on the
   SAME row — instead of the module → order-line two-level drill. Each sofa module
   has exactly one SO line; selection + supplier reuse the per-line handlers, so
   ordering (Proceed PO) is unchanged. */
const SofaSoTable = ({ group, selected, onToggleLine, lineSupplier, onLineSupplierChange }: {
  group: ModelGroup;
  selected: Set<string>;
  onToggleLine: (soItemId: string) => void;
  lineSupplier: Record<string, string>;
  onLineSupplierChange: (soItemId: string, supplierId: string) => void;
}) => (
  <table className={styles.childTable}>
    <thead>
      <tr>
        <th className={styles.colSelect} />
        <th>SO No</th>
        <th>Warehouse</th>
        <th>Module</th>
        <th>Customer</th>
        <th>State</th>
        <th>Processing Date</th>
        <th>Delivery Date</th>
        <th className={styles.num}>Qty</th>
        <th>Coverage</th>
        <th>Supplier</th>
      </tr>
    </thead>
    <tbody>
      {group.variants.flatMap((v) => v.lines.map((ln, i) => {
        const short = ln.source === 'shortage' && ln.shortageQty > 0 && Boolean(ln.soItemId);
        return (
          <tr key={`${v.itemCode}-${ln.soDocNo}-${i}`} className={short ? styles.childShort : undefined}>
            <td className={styles.colSelect}>
              {short && (
                <input
                  type="checkbox"
                  checked={selected.has(ln.soItemId)}
                  onChange={() => onToggleLine(ln.soItemId)}
                  aria-label={`Select ${v.variantLabel ?? v.itemCode} to order`}
                />
              )}
            </td>
            <td className={styles.codeCell}>{ln.soDocNo}</td>
            <td className={styles.whCell}>
              {v.warehouseCode
                ? <span className={styles.whTag} title={v.warehouseName ?? undefined}>{v.warehouseCode}</span>
                : <span className={styles.whNone}>—</span>}
            </td>
            <td><span className={styles.variantTag}>{v.variantLabel ?? v.itemCode}</span></td>
            <td>{ln.debtorName ?? '—'}</td>
            <td>{ln.customerState ?? '—'}</td>
            <td>{fmtDate(ln.processingDate)}</td>
            <td>{fmtDate(ln.deliveryDate)}</td>
            <td className={styles.num}>{ln.qty}</td>
            <td>
              {ln.source === 'stock' && <span className={`${styles.tag} ${styles.tagStock}`}>stock</span>}
              {ln.source === 'po' && (
                <span className={`${styles.tag} ${styles.tagPo}`}>
                  {ln.poNumber ? `${ln.poNumber}${ln.poEta ? ` · ETA ${fmtDate(ln.poEta)}` : ''}` : 'ordered'}
                </span>
              )}
              {short && (
                <span className={`${styles.tag} ${styles.tagShort}`}>
                  SHORT{ln.shortageQty > 1 ? ` ×${ln.shortageQty}` : ''}
                </span>
              )}
            </td>
            <td className={styles.supplierCell}>
              {short
                ? <LineSupplierCell suppliers={v.suppliers} chosenSupplierId={lineSupplier[ln.soItemId] ?? null} onSupplierChange={(sid) => onLineSupplierChange(ln.soItemId, sid)} />
                : ln.source === 'po'
                  ? <span className={styles.poSupplierRO} title="Supplier locked — this line is already on a PO"><Truck {...ICON} /> {ln.poSupplierName ?? '—'}</span>
                  : <span className={styles.whNone}>—</span>}
            </td>
          </tr>
        );
      }))}
    </tbody>
  </table>
);
