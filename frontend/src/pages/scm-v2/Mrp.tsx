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

import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { RefreshCw, ShoppingCart, CalendarRange, Clock, Download } from 'lucide-react';
import { DataTable, type Column } from '../../components/DataTable';
import {
  useMrp, useRegenerateMrp, useCategoryLeadTimes, useUpdateCategoryLeadTime, GLOBAL_LEAD_KEY,
  leadFallbackLabel, type MrpSku, type MrpLine, type MrpResponse, type MrpWarehouse,
} from '../../vendor/scm/lib/mrp-queries';
import { LeadTimesTable } from './LeadTimesTable';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { useAuth, isAdminLevel } from '../../vendor/scm/lib/auth';
import { useCreatePosFromSoItems } from '../../vendor/scm/lib/suppliers-queries';
import { newIdempotencyKey } from '../../lib/idempotency';
import { mrpViews, mrpCategoryOf } from './mrp-views';
import {
  type ModelGroup, type MrpFilters, rowKey, computeTabModels, lineInWindow, groupEarliestDate,
} from './mrp-model-pipeline';
import { exportMrpWorkbook } from './mrp-export-workbook';
import {
  buildMrpChildRows, distinctLineValues, rollupLabel, shortageLineIdsOf, supplierRollup, type MrpLineControls,
} from './mrp-tree-rows';
import { isSofaAccessory } from './mrp-sofa-accessory';
import { checkSofaSetsBeforePo } from './mrp-sofa-set-gate';
import { fmtDate, fmtDateTime, fmtQty } from '../../../../shared/src/vendor/shared/format';
import { DateField } from '../../vendor/scm/components/DateField';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/Layout';
import styles from './Mrp.module.css';

const ICON = { size: 14, strokeWidth: 1.75 } as const;

const TOOLBAR_BTN =
  'inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors hover:border-primary/40 hover:bg-primary-soft hover:text-primary disabled:cursor-default disabled:opacity-50';


type View = string;

function LeadTimesDialog({ onClose, warehouses }: { onClose: () => void; warehouses: MrpWarehouse[] }) {
  const q = useCategoryLeadTimes();
  const update = useUpdateCategoryLeadTime();
  const map = q.data?.leadTimes;
  const categories = q.data?.categories ?? [];
  const labelOf = (c: string) => categories.find((o) => o.key === c)?.label ?? c;
  const [whKey, setWhKey] = useState<string>(GLOBAL_LEAD_KEY);
  const warehouseId = whKey === GLOBAL_LEAD_KEY ? null : whKey;
  const own = (c: string) => map?.[whKey]?.[c];
  const global = (c: string) => map?.[GLOBAL_LEAD_KEY]?.[c];
  const layers = warehouseId === null ? [global] : [own, global];

  return (
    <div className={styles.dialogBackdrop} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2 className={styles.dialogTitle}>Lead Times</h2>
        <p className={styles.dialogBody}>
          How many days <strong>before</strong> the customer delivery date each category&rsquo;s PO is
          ordered. When you Proceed PO, the PO delivery date is set this many days earlier so the
          supplier delivers ahead of the customer date. Set a per-<strong>warehouse</strong> number
          (e.g. Sabah / Sarawak ship longer); a blank box uses what the last column says.
        </p>
        <label className={styles.dialogField}>
          <span className={styles.filterLabel}>Warehouse</span>
          <select
            className={styles.filterSelect}
            style={{ minWidth: 200 }}
            value={whKey}
            onChange={(e) => setWhKey(e.target.value)}
          >
            <option value={GLOBAL_LEAD_KEY}>Global Defaults</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>{w.code}</option>
            ))}
          </select>
        </label>
        {q.isLoading && <p className={styles.dialogBody}>Loading…</p>}
        {!q.isLoading && (
          <LeadTimesTable
            key={whKey}
            categories={categories}
            stored={layers[0]!}
            fallbackLabel={(c) => leadFallbackLabel(c, layers, labelOf, 'Global default')}
            canClear={false}
            onSave={async (changes) => {
              for (const ch of changes) {
                if (ch.leadDays !== null) await update.mutateAsync({ warehouseId, category: ch.category, leadDays: ch.leadDays });
              }
            }}
          />
        )}
        <div className={styles.dialogActions}>
          <Button type="button" variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}



const skuDefaultSupplierId = (s: MrpSku): string | null =>
  (s.suppliers.find((x) => x.isMain) ?? s.suppliers[0])?.supplierId ?? null;

const shortageLinesOf = (s: MrpSku) => s.lines.filter((l) => l.source === 'shortage' && l.shortageQty > 0 && l.soItemId);


export const Mrp = () => {
  const navigate = useNavigate();
  const { staff, canWriteScmConfig } = useAuth();
  const isAdmin = isAdminLevel(staff?.role);
  const [backfilling, setBackfilling] = useState(false);
  const [showLeadTimes, setShowLeadTimes] = useState(false);
  const [view, setView] = useState<View>('sofa');
  const [warehouseId, setWarehouseId] = useState<string>('all');
  const [expandedModels, setExpandedModels] = useState<Set<string>>(new Set());
  const [expandedVariants, setExpandedVariants] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [poMode, setPoMode] = useState<'combined' | 'per-so'>('combined');
  const [dateBasis, setDateBasis] = useState<'delivery' | 'processing' | 'soDate' | 'orderBy'>('delivery');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  /* HIDDEN by default (owner, 2026-08-18, ruling on a build that had it shown):
     "这个应该是要把没有日期的藏起来的,不过我点 show no date 它才会出来." This is
     the ordering worklist and undated demand is not orderable yet, so it stays
     off the list until asked for. The "Show no-date" checkbox in the filter row
     is the ONLY affordance that flips this — it is always rendered, so the state
     is never stranded. Ticking shows the rows, tagged "No date" and sorted last.
     See parseIncludeUndated in mrp.ts.

     There used to be a yellow summary banner above the filters carrying the
     withheld count in both directions with a one-click Show/Hide. The owner
     removed it on 2026-08-20 (「黄色的也delete掉」) after being told it carried
     data rather than instruction — a deliberate deletion, not a slip. The count
     itself is still computed and tested server-side (MrpResult.undated,
     backend/src/scm/routes/mrp.test.ts); nothing on this page reads it now. */
  const [showUndated, setShowUndated] = useState<boolean>(false);
  const [onlyShort, setOnlyShort] = useState<boolean>(false);
  /* Owner 2026-09-11 — "我的 MRP 也要有 search 的功能，要不然我都找不出 MRP 的
     list,那版太长了". A find box over the rows already in view: matches item
     code, description, variant/module label, and each SO line's doc no +
     customer. It never changes what the server returns — purely a client-side
     narrowing of the current tab — and a non-empty query force-expands the
     matches so the hit is visible without a manual drill. */
  const [search, setSearch] = useState<string>('');
  const [lineSupplier, setLineSupplier] = useState<Partial<Record<string, string>>>({});
  const setLineSupplierId = (soItemId: string, supplierId: string) =>
    setLineSupplier((prev) => ({ ...prev, [soItemId]: supplierId }));
  const [dialog, setDialog] = useState<
    | { kind: 'info'; title: string; body: string }
    | { kind: 'created'; title: string; body: string }
    | { kind: 'confirm'; picks: Array<{ soItemId: string; qty: number; supplierId: string | null }>; orderedCodes: Set<string>; count: number; units: number; allowSofaSupplierSplit: boolean }
    | { kind: 'suppliers'; body: string; picks: Array<{ soItemId: string; qty: number; supplierId: string | null }>; orderedCodes: Set<string>; count: number; units: number }
    | null
  >(null);
  const [proceedExpectedAt, setProceedExpectedAt] = useState<string>('');

  /* Each tab is locked to its own category (Commander 2026-06-15) — EXCEPT the
     Sofa tab, which asks for the full plan (no category filter).

     WHY THE SOFA TAB IS DIFFERENT. A sofa order's cover (皮套) / pillow is an
     ACCESSORY line, and the owner's standing rule is that it must ride on the
     SAME PO as the sofa. The page pulls those accessory lines into the sofa's
     convert batch off `data.skus` (gatherSofa below). But `?category=SOFA`
     makes the engine drop every non-SOFA row (mrp.ts section 6), so `data.skus`
     held only sofa and the accessory pull matched NOTHING — the cover never
     joined the sofa PO from this page. Requesting no filter puts the accessory
     lines back in `data.skus`; the sofa TABLE is unaffected (it renders from
     `data.sofaSets`, which ignores the filter either way). It is also the
     DEFAULT view, so this serves the stored snapshot instantly instead of
     recomputing the plan live on every open (mrp-snapshot.ts isDefaultMrpView).
     See docs/bugs/ — the sofa-cover pull-in was dead since the per-category
     tab split. */
  const apiCategory = view === 'sofa' ? null : mrpCategoryOf(view);
  const q = useMrp({ category: apiCategory, warehouseId, includeUndated: showUndated });
  const data = q.data;
  const views = mrpViews(data?.categories);
  const regenerate = useRegenerateMrp();
  const recalculatePlan = () => {
    if (data?.stored) regenerate.mutate(undefined, { onSettled: () => { void q.refetch(); } });
    else void q.refetch();
  };
  const createPos = useCreatePosFromSoItems();

  const runKeyRef = useRef<string | null>(null);

  const activeView = views.find((v) => v.value === view) ?? views[0]!;
  const filters: MrpFilters = { dateFrom, dateTo, dateBasis, onlyShort, search };
  const hasWindow = Boolean(dateFrom || dateTo);
  /* Tab category funnel -> date window -> grouper -> only-shortages -> search,
     as ONE shared function so the screen and the workbook export can never
     disagree ("看到怎么样的 就出来怎么样的"). */
  const { viewSkus, models, displayModels, accessoryBySoDoc, forceOpen } =
    computeTabModels(data, activeView, filters);

  const [exporting, setExporting] = useState(false);
  // scope: 'all' keeps the owner-approved v7 workbook (one sheet per category
  // tab) unchanged; 'tab' exports only the tab currently open (owner 2026-09-17:
  // someone still wants the full multi-sheet export, so this is additive, not a
  // replacement).
  const runExportWorkbook = (scope: 'all' | 'tab') => {
    if (exporting) return;
    setExporting(true);
    const warehouseLabel = warehouseId === 'all'
      ? 'All'
      : (data?.warehouses.find((w) => w.id === warehouseId)?.code ?? warehouseId);
    const activeView = views.find((v) => v.value === view) ?? views[0];
    void exportMrpWorkbook({
      views: scope === 'tab' ? [activeView] : views,
      warehouseId, includeUndated: showUndated, filters,
      asOf: data?.asOf ?? null, warehouseLabel,
      onError: (e) => setDialog({
        kind: 'info', title: 'Export failed',
        body: e instanceof Error ? e.message : 'Something went wrong.',
      }),
    }).finally(() => setExporting(false));
  };
  const onExportWorkbook = () => runExportWorkbook('all');
  const onExportCurrentTab = () => runExportWorkbook('tab');

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
    setSearch('');
  };

  const runCreatePos = (
    picks: Array<{ soItemId: string; qty: number; supplierId: string | null }>,
    _orderedCodes: Set<string>,
    expectedAt: string | undefined,
    allowSofaSupplierSplit: boolean,
  ) => {
    if (picks.length === 0) {
      setDialog({ kind: 'info', title: 'Nothing to order', body: 'No uncovered (shortage) lines in the current selection / window.' });
      return;
    }
    const body = { picks, mode: poMode, fromMrp: true, planAsOf: data?.computedAt ?? null, allowSofaSupplierSplit, ...(expectedAt ? { expectedAt } : {}) };
    const runKey = runKeyRef.current ?? newIdempotencyKey();
    runKeyRef.current = runKey;
    createPos.mutate({ ...body, idempotencyKey: runKey }, {
      onSuccess: (res) => {
        runKeyRef.current = null;
        if (!res.total) {
          setDialog({
            kind: 'info',
            title: 'No POs created',
            body: "These SKUs aren't bound to a supplier yet. Assign each shortage SKU a main supplier (the “— none —” rows), then proceed again.",
          });
          return;
        }
        setSelected(new Set());
        recalculatePlan();
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
          const rawBody = (err as { body?: unknown }).body;
          const m = (typeof rawBody === 'string' ? rawBody : raw).match(/\{.*\}/s);
          if (m) {
            const j = JSON.parse(m[0]);
            errCode = typeof j.error === 'string' ? j.error : '';
            if (j.error === 'missing_bindings' && Array.isArray(j.itemCodes)) codes = j.itemCodes;
            if ((j.error === 'sofa_set_supplier_split' || j.error === 'sofa_set_suppliers_unconfirmed') && typeof j.reason === 'string') {
              setDialog({ kind: 'info', title: 'Sofa set suppliers', body: j.reason });
              return;
            }
          }
        } catch { }
        if (errCode === 'qty_exceeds_remaining' || errCode === 'mrp_plan_stale') {
          recalculatePlan();
          setDialog({
            kind: 'info',
            title: 'Already ordered',
            body: 'Some of these lines were put on a PO after this plan was calculated. The plan has been recalculated. Review what still needs ordering and proceed again.',
          });
          return;
        }
        setDialog(codes.length > 0
          ? { kind: 'info', title: "SKUs not bound to a supplier", body: 'Assign these to a supplier first, then proceed:\n' + codes.map((c) => `• ${c}`).join('\n') }
          : { kind: 'info', title: 'Order failed', body: raw });
      },
    });
  };

  const gatherShortages = (skus: MrpResponse['skus'], onlySelected: boolean) => {
    const picks: Array<{ soItemId: string; qty: number; supplierId: string | null }> = [];
    const orderedCodes = new Set<string>();
    let units = 0;
    for (const s of skus) {
      const def = skuDefaultSupplierId(s);
      for (const l of shortageLinesOf(s)) {
        if (onlySelected && !selected.has(l.soItemId)) continue;
        picks.push({ soItemId: l.soItemId, qty: l.shortageQty, supplierId: lineSupplier[l.soItemId] ?? l.ruleSupplierId ?? def });
        orderedCodes.add(s.itemCode);
        units += l.shortageQty;
      }
    }
    return { picks, orderedCodes, units };
  };

  const gatherSofa = (skus: MrpResponse['skus'], onlySelected: boolean) => {
    const base = gatherShortages(skus, onlySelected);
    const picks = [...base.picks];
    const orderedCodes = new Set(base.orderedCodes);
    let units = base.units;

    /* The set checks look at the sofa MODULES only (HC-0203, Sim 2026-11-02): a
       Sofa Accessory (stool, pillow) is not part of the dye lot the allocator
       binds, and po-grouping already splits a different-supplier accessory onto
       its own PO. */
    const lineByItem = new Map<string, { line: MrpLine; itemCode: string; accessory: boolean }>();
    const supplierNames = new Map<string, string>();
    for (const s of skus) {
      for (const l of s.lines) lineByItem.set(l.soItemId, { line: l, itemCode: s.itemCode, accessory: isSofaAccessory(s.category) });
      for (const sup of s.suppliers) supplierNames.set(sup.supplierId, sup.name);
    }
    const gate = checkSofaSetsBeforePo(
      picks.flatMap((p) => {
        const hit = lineByItem.get(p.soItemId);
        if (!hit || hit.accessory) return [];
        return [{ soDocNo: hit.line.soDocNo, itemCode: hit.itemCode, supplierId: p.supplierId, poNumber: hit.line.poNumber }];
      }),
      (supplierId) => supplierNames.get(supplierId) ?? 'no supplier',
    );
    if (gate.kind === 'blocked') {
      return { picks: [], orderedCodes, units: 0, blocked: { title: gate.title, body: gate.body }, confirmSuppliers: undefined };
    }
    const confirmSuppliers = gate.kind === 'confirmSuppliers' ? gate.body : undefined;

    /* Commander 2026-05-29 — "pillow 开在 sofa 里面就要跟 sofa 的 PO 一起". For
       every SO we're proceeding a sofa set on, ALSO pull that SO's accessory
       (pillow / 皮套) shortage lines into the same /from-sos batch. The server
       groups by the per-category rule (po-grouping.ts): in Combined a same-
       supplier cover lands on the sofa's PO, in Per-SO it splits to its own —
       either way the whole order is proceeded in one action. Accessories live
       in the General tab's SKU list; they reach `data.skus` here only because
       the Sofa tab requests the FULL plan (apiCategory). Respect the active date
       window so we don't drag in out-of-window pillows.

       setDocs is the SO docs we are ACTUALLY ordering a sofa set on — derived
       from the sofa picks so selecting ONE order pulls only THAT order's cover,
       not every sofa order's. (It keyed off all sofa docs with shortage before;
       that was harmless only while the pull-in was dead — bug ledger.) */
    const soDocByItem = new Map<string, string>();
    for (const s of skus) for (const l of s.lines) soDocByItem.set(l.soItemId, l.soDocNo);
    const setDocs = new Set(
      base.picks.map((p) => soDocByItem.get(p.soItemId)).filter((d): d is string => Boolean(d)),
    );
    const already = new Set(picks.map((p) => p.soItemId));
    const accessoryLines = (data?.skus ?? [])
      .filter((s) => (s.category ?? '').toUpperCase() === 'ACCESSORY')
      .flatMap((s) => s.lines.map((l) => ({ line: l, itemCode: s.itemCode, supplierId: lineSupplier[l.soItemId] ?? l.ruleSupplierId ?? skuDefaultSupplierId(s) })))
      .filter(({ line }) =>
        line.source === 'shortage' && line.shortageQty > 0 && line.soItemId
        && setDocs.has(line.soDocNo) && (!hasWindow || lineInWindow(line, filters)));
    for (const { line, itemCode, supplierId } of accessoryLines) {
      if (already.has(line.soItemId)) continue;
      already.add(line.soItemId);
      picks.push({ soItemId: line.soItemId, qty: line.shortageQty, supplierId });
      orderedCodes.add(itemCode);
      units += line.shortageQty;
    }
    return { picks, orderedCodes, units, blocked: undefined, confirmSuppliers };
  };

  const shortageSkus = viewSkus.filter((s) => s.shortage > 0);
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

  const toggleSelectLine = (soItemId: string) => {
    const group = expandSofaSiblings([soItemId]);
    setSelected((prev) => {
      const next = new Set(prev);
      const allOn = [...group].every((k) => next.has(k));
      for (const k of group) { if (allOn) next.delete(k); else next.add(k); }
      return next;
    });
  };
  const setLinesSelected = (ids: string[], on: boolean) => {
    const group = expandSofaSiblings(ids);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of group) { if (on) next.add(k); else next.delete(k); }
      return next;
    });
  };

  const shortCount = allShortageLineIds.length;
  const selectedShortCount = allShortageLineIds.filter((id) => selected.has(id)).length;

  const allShortSelected = shortCount > 0 && selectedShortCount === shortCount;
  const someShortSelected = selectedShortCount > 0 && !allShortSelected;
  const toggleSelectAll = () => {
    if (allShortSelected) { setSelected(new Set()); return; }
    setSelected(new Set(allShortageLineIds));
  };

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

  const onProceed = () => {
    const onlySelected = selectedShortCount > 0;
    const { picks, orderedCodes, units, blocked, confirmSuppliers } = view === 'sofa'
      ? gatherSofa(shortageSkus, onlySelected)
      : { ...gatherShortages(shortageSkus, onlySelected), blocked: undefined, confirmSuppliers: undefined };
    if (blocked) {
      setDialog({ kind: 'info', title: blocked.title, body: blocked.body });
      return;
    }
    if (picks.length === 0) {
      setDialog({ kind: 'info', title: 'Nothing to order', body: 'No uncovered (shortage) lines in the current selection / window.' });
      return;
    }
    setProceedExpectedAt('');
    if (confirmSuppliers) {
      setDialog({ kind: 'suppliers', body: confirmSuppliers, picks, orderedCodes, count: picks.length, units });
      return;
    }
    setDialog({ kind: 'confirm', picks, orderedCodes, count: picks.length, units, allowSofaSupplierSplit: false });
  };

  const basisLabel = dateBasis === 'processing' ? 'Processing Date' : dateBasis === 'soDate' ? 'SO Date' : dateBasis === 'orderBy' ? 'Order-by' : 'Delivery';
  const windowLabel = hasWindow ? `${basisLabel} ${dateFrom || '…'} → ${dateTo || '…'}` : '';

  /* The report table is now the shared <DataTable> (owner 2026-09-11 — "MRP
     table 也要有其他 table 那些功能": freeze row title, per-column filter, sort,
     column show/hide, export, Reset layout). MRP was the last list keeping a
     hand-built Model -> Variant -> SO <table>, which is exactly why the frozen
     header never worked here (docs/bugs/0753, 0768 — the standalone hook fought
     this page's no-page-scroll layout twice). Migrating onto DataTable inherits
     its proven freeze + funnel filters at once and retires the odd-table-out.

     The TOP-LEVEL row (one per Model / SO / colour variant) is a DataTable row
     described by `columns` below; what opens under it is drawn by
     buildMrpChildRows as rows in these same columns, so it follows the user's
     column order and hiding. Selection stays at the SO-LINE level (soItemId) —
     the leading `select` column keeps the parent indeterminate state and the
     select-all; the per-line checkboxes sit in the same column on the lines. */
  const isSofa = view === 'sofa';
  const lineControls: MrpLineControls = {
    selected,
    onToggleLine: toggleSelectLine,
    onSetLinesSelected: setLinesSelected,
    lineSupplier,
    onLineSupplierChange: setLineSupplierId,
  };
  const columns: Column<ModelGroup>[] = [
    {
      key: 'select', label: '', width: '38px', align: 'center',
      alwaysVisible: true, disableSort: true, disableFilter: true,
      renderHeader: () => (
        <input
          type="checkbox"
          aria-label="Select all shortage rows"
          title="Select all shortage rows"
          disabled={shortCount === 0}
          checked={allShortSelected}
          ref={(el) => { if (el) el.indeterminate = someShortSelected; }}
          onChange={toggleSelectAll}
          onClick={(e) => e.stopPropagation()}
        />
      ),
      render: (g) => {
        const ids = g.variants.flatMap(shortageLineIdsOf);
        if (ids.length === 0) return null;
        const sel = ids.filter((id) => selected.has(id));
        const all = sel.length === ids.length;
        const some = sel.length > 0 && !all;
        return (
          <input
            type="checkbox"
            checked={all}
            ref={(el) => { if (el) el.indeterminate = some; }}
            onChange={(e) => setLinesSelected(ids, e.target.checked)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select all shortage lines under ${g.itemCode}`}
          />
        );
      },
    },
    {
      key: 'warehouse', label: 'Warehouse', width: '150px', align: 'center',
      getValue: (g) => g.warehouseCode ?? g.warehouseName ?? '',
      render: (g) => (g.warehouseCode
        ? <span className={styles.whTag} title={g.warehouseName ?? undefined}>{g.warehouseCode}</span>
        : <span className={styles.whNone}>—</span>),
    },
    {
      key: 'itemCode', label: isSofa ? 'Sales Order' : 'Item Code', width: '160px', align: 'center',
      getValue: (g) => g.itemCode,
      render: (g) => <span className={styles.codeCell}>{g.itemCode}</span>,
    },
    /* Every non-sofa tab shows the SO no beside the item code (owner 2026-09-11:
       "bedframe 需要和 sofa 一样显示 SO no", then "mattress, accessories, other 也要
       加上 sales order"). Sofa's lead column already IS the SO (groupBySo). The
       other tabs group by item/variant and a row can serve MORE THAN ONE order
       (bedframe pools by colour; mattress/accessory pool by model), so this shows
       the first SO doc no + "+N" when shared, with the full list in the drilldown. */
    ...(!isSofa
      ? [{
          key: 'soNo', label: 'Sales Order', width: '150px', align: 'center',
          getValue: (g: ModelGroup) =>
            [...new Set(g.variants.flatMap((v) => v.lines.map((l) => l.soDocNo)))].join(', '),
          render: (g: ModelGroup) => {
            const docs = [...new Set(g.variants.flatMap((v) => v.lines.map((l) => l.soDocNo)))];
            return docs.length === 0
              ? '—'
              : <span className={styles.codeCell}>{docs[0]}{docs.length > 1 ? ` +${docs.length - 1}` : ''}</span>;
          },
        }] satisfies Column<ModelGroup>[]
      : []),
    {
      key: 'description', label: 'Description',
      // Bounded + wrapping: bedframe variant specs (fabric / divan / gap / seat
      // heights / special notes) are long, and DataTable cells default to
      // nowrap+ellipsis (2026-05-08). Without a width Description was the elastic
      // column — it stretched to the longest line and absorbed every other
      // column's resize. A fixed width + `whitespace-normal` wraps the text and
      // stops the row from running off the right edge (owner 2026-09-11).
      width: '360px', align: 'center', className: 'whitespace-normal break-words align-top',
      getValue: (g) => g.description ?? '',
      render: (g) => {
        const named = g.variants.some((v) => v.variantKey !== '');
        const count = g.variants.length;
        return (
          <span className={styles.descCell}>
            {g.description ?? '—'}
            {view === 'bedframe'
              ? (g.variants[0]?.variantLabel ? <span className={styles.variantTag}>{g.variants[0]!.variantLabel}</span> : null)
              : (named ? <span className={styles.countTag}>{count} variant{count === 1 ? '' : 's'}</span> : null)}
          </span>
        );
      },
    },
    { key: 'qtyNeeded', label: 'Qty Needed', width: '120px', align: 'center', className: styles.num, getValue: (g) => g.qtyNeeded, render: (g) => fmtQty(g.qtyNeeded) },
    { key: 'stock', label: 'Stock', width: '110px', align: 'center', className: styles.num, getValue: (g) => g.stock, render: (g) => fmtQty(g.stock) },
    { key: 'poOutstanding', label: 'PO Outstanding', width: '150px', align: 'center', className: styles.num, getValue: (g) => g.poOutstanding, render: (g) => g.poOutstanding || '—' },
    {
      key: 'shortage', label: 'Shortage', width: '120px', align: 'center', className: styles.num,
      getValue: (g) => g.shortage,
      render: (g) => (g.shortage > 0 ? <span className={styles.shortNum}>{g.shortage}</span> : '—'),
    },
    /* Planning dates (owner 2026-09-17). A Model row can span several SO lines, so
       each shows the EARLIEST of the group's lines on that basis (the leading edge
       the plan sorts by); the expanded lines show their own dates in the same
       column. Processing and Delivery are shown by default because the lines carry
       their dates (and the "No date" tag) there; SO Date stays opt-in. */
    {
      key: 'processingDate', label: 'Processing Date', group: 'Logistics',
      width: '150px', align: 'center', exportFormat: 'date',
      getValue: (g) => groupEarliestDate(g, 'processing') ?? '',
      render: (g) => fmtDate(groupEarliestDate(g, 'processing')),
    },
    {
      key: 'soDate', label: 'SO Date', group: 'Logistics',
      width: '130px', align: 'center', defaultHidden: true, exportFormat: 'date',
      getValue: (g) => groupEarliestDate(g, 'soDate') ?? '',
      render: (g) => fmtDate(groupEarliestDate(g, 'soDate')),
    },
    {
      key: 'deliveryDate', label: 'Delivery Date', group: 'Logistics',
      width: '140px', align: 'center', exportFormat: 'date',
      getValue: (g) => groupEarliestDate(g, 'delivery') ?? '',
      render: (g) => fmtDate(groupEarliestDate(g, 'delivery')),
    },
    {
      key: 'customer', label: 'Customer', group: 'Basic', width: '170px', align: 'center',
      className: 'whitespace-normal break-words',
      getValue: (g) => distinctLineValues(g, (l) => l.debtorName).join(', '),
      render: (g) => rollupLabel(distinctLineValues(g, (l) => l.debtorName)),
    },
    {
      key: 'state', label: 'State', group: 'Basic', width: '130px', align: 'center',
      getValue: (g) => distinctLineValues(g, (l) => l.customerState).join(', '),
      render: (g) => rollupLabel(distinctLineValues(g, (l) => l.customerState)),
    },
    {
      key: 'supplier', label: 'Supplier', group: 'Purchasing', width: '190px', align: 'center',
      canHide: false, disableSort: true, disableFilter: true,
      render: (g) => supplierRollup(g, lineControls),
    },
  ];

  const modelExpandedIds = forceOpen
    ? new Set(displayModels.map((m) => m.groupKey))
    : expandedModels;

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Planning"
        title="MRP · Stock Status Report"
        actions={
          <>
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

            <div className="inline-flex items-center gap-1.5" role="group" aria-label="Table utilities">
              <button type="button" className={TOOLBAR_BTN} onClick={collapseAll}>Collapse</button>
              <button type="button" className={TOOLBAR_BTN} onClick={expandAll}>Expand</button>
              <button type="button" className={TOOLBAR_BTN} onClick={() => void q.refetch()} disabled={q.isFetching}>
                <RefreshCw {...ICON} className={q.isFetching ? 'animate-spin' : undefined} /> Refresh
              </button>
              <button type="button" className={TOOLBAR_BTN} onClick={() => regenerate.mutate()} disabled={regenerate.isPending}
                title="Recompute the MRP plan from current stock, orders and deliveries, and save it">
                <RefreshCw {...ICON} className={regenerate.isPending ? 'animate-spin' : undefined} /> {regenerate.isPending ? 'Regenerating…' : 'Regenerate'}
              </button>
              {data?.stored && data.computedAt && (
                <span className="inline-flex items-center gap-1 text-xs opacity-70" title="When this plan was last calculated">
                  <Clock {...ICON} /> as of {fmtDateTime(data.computedAt)}
                </span>
              )}
              {isAdmin && (
                <button type="button" className={TOOLBAR_BTN} onClick={onBackfillWarehouses} disabled={backfilling}
                  title="Bind a warehouse to older SOs that have none, derived from each SO's State">
                  {backfilling ? 'Re-binding…' : 'Re-bind WH'}
                </button>
              )}
              {canWriteScmConfig && (
                <button type="button" className={TOOLBAR_BTN} onClick={() => setShowLeadTimes(true)}
                  title="Set how many days early each category's PO is ordered (applied when you Proceed PO)">
                  <Clock {...ICON} /> Lead Times
                </button>
              )}
            </div>
          </>
        }
        primaryAction={
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

      <div className="no-scrollbar -mx-4 flex items-center gap-1 overflow-x-auto border-b border-border px-4 sm:mx-0 sm:px-0 [&>*]:shrink-0" role="tablist">
        {views.map((t) => (
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

      <div className={styles.filterRow}>
        {/* Search (owner 2026-09-11) moved into the DataTable toolbar (its
            `search` slot) so it sits with the column funnels / Reset, like every
            other list. Still client-side narrowing of the current tab — the
            matching still runs through matchModel over code / description /
            module label / each SO line's doc no + customer, and a hit force-opens
            the row (modelExpandedIds). */}
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
      </div>

      <DataTable<ModelGroup>
        tableId="mrp"
        documentLabel="MRP · Stock Status"
        /* Fixed column widths (owner 2026-09-11): resizing a column grows only
           that column and scrolls horizontally, instead of squeezing the others. */
        fixedColumnWidths
        columns={columns}
        rows={data ? displayModels : null}
        loading={q.isLoading}
        error={q.isError ? (q.error instanceof Error ? q.error.message : 'Failed to load') : null}
        getRowKey={(g) => g.groupKey}
        getRowClassName={(g) => (g.shortage > 0 ? styles.rowShort : undefined)}
        exportName={`mrp-${view}`}
        exportLabel="Export all"
        onExport={onExportWorkbook}
        toolbarExtra={
          <button type="button" className={TOOLBAR_BTN} onClick={onExportCurrentTab} disabled={exporting}
            title={`Download only the ${views.find((v) => v.value === view)?.label ?? view} tab as a workbook`}>
            <Download {...ICON} /> Export current tab ({displayModels.length})
          </button>
        }
        search={{
          value: search,
          onChange: setSearch,
          placeholder: isSofa ? 'SO no, customer, model…' : 'Code, description, SO no, customer…',
          debounceMs: 0,
          scope: 'loaded',
        }}
        expandable={{
          rowKey: (g) => g.groupKey,
          expandedIds: modelExpandedIds,
          onExpandedChange: setExpandedModels,
          childRows: (g) => buildMrpChildRows(g, {
            ...lineControls,
            shape: isSofa ? 'sofa' : view === 'bedframe' ? 'bedframe' : 'model',
            expandedVariants,
            onToggleVariant: toggleVariant,
            isEveryVariantOpen: forceOpen,
            accessoryRiders: isSofa ? (accessoryBySoDoc.get(g.itemCode) ?? []) : [],
            poMode,
          }),
        }}
        emptyLabel={
          search.trim() ? `No rows match "${search.trim()}" on this tab.`
          : onlyShort ? 'Nothing needs ordering — everything in view is covered.'
          : hasWindow ? 'No demand delivering in this window.'
          : 'No open Sales-Order demand for this filter.'
        }
      />

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
                  const { picks, orderedCodes, allowSofaSupplierSplit } = dialog;
                  setDialog(null);
                  runCreatePos(picks, orderedCodes, proceedExpectedAt || undefined, allowSofaSupplierSplit);
                }}
              >
                {createPos.isPending ? 'Processing…' : 'Confirm'}
              </Button>
            </div>
          </div>
        </div>
      )}
      {dialog && dialog.kind === 'suppliers' && (
        <div className={styles.dialogBackdrop} onClick={() => setDialog(null)}>
          <div className={styles.dialog} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h2 className={styles.dialogTitle}>Use more than one supplier?</h2>
            <p className={styles.dialogBody}>{dialog.body}</p>
            <div className={styles.dialogActions}>
              <Button type="button" variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
              <Button
                type="button"
                variant="primary"
                onClick={() => {
                  const { picks, orderedCodes, count, units } = dialog;
                  setDialog({ kind: 'confirm', picks, orderedCodes, count, units, allowSofaSupplierSplit: true });
                }}
              >
                Yes, proceed
              </Button>
            </div>
          </div>
        </div>
      )}
      {dialog && (dialog.kind === 'info' || dialog.kind === 'created') && (
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
