// DocumentLinesExpansion — shared inline per-line breakdown rendered under a
// document row when the DataTable chevron is toggled. It is the DRY twin of the
// SO list's SoLinesExpansion (frontend/src/pages/scm-v2/MfgSalesOrdersListV2.tsx):
// Group pill + item CODE/variant identity + Qty + Amount. The SO/DO list keeps
// its own richer variant (Stock pill + Incoming PO/ETA columns) because those
// fields ride the SO detail payload; the six purchase/sales document lists that
// consume THIS component do not carry per-line MRP coverage, so they render the
// four columns their existing detail hooks actually return.
//
// Each caller owns its own detail hook and field quirks (which column is Qty,
// which is the line amount, how the code resolves) and maps its raw items into
// DocumentDrillLine[] before handing them here — this component is purely
// presentational so no list's field mapping leaks into another's.

import { useState, type ReactNode } from "react";
import { buildVariantSummary, fmtCenti, orderLineIdentity } from "@2990s/shared";
import { ItemGroupPill } from "../vendor/scm/lib/category-badges";
import type { OriginAssignment } from "../vendor/scm/lib/flow-queries";
import { cn, formatDate } from "../lib/utils";

// A single normalised drill line. Callers resolve `code` (e.g. material_code ||
// item_code), `qty` (ordered / received / returned as the document means) and
// `amountCenti` (line_total_centi / total_centi) themselves; `itemGroup` +
// `variants` feed the same live buildVariantSummary the detail drawers use.
export type DocumentDrillLine = {
  itemGroup: string | null;
  code: string | null;
  description: string | null;
  description2: string | null;
  variants: Record<string, unknown> | null;
  qty: number;
  amountCenti: number;
  // The REAL origin Sales Order(s) this line was raised from, matched by SKU
  // (purchase docs only). Empty / absent → the Assigned SO + delivery cells show
  // a dash, exactly like the SO detail's Stock / Incoming PO columns.
  assignedSos?: OriginAssignment[];
  // Does a STORED so_item_id back this line's SKU, or is the Assigned SO above
  // only an MRP allocation? The two used to render identically apart from a
  // dashed border, and the owner read a guess as a binding (2026-07-29). It
  // carried a visible "MRP guess · not linked" caption until the owner asked for
  // it gone (2026-08-01); the distinction now lives in the chip's tooltip and in
  // the dashed-vs-solid tone, so the resolution is unchanged — only the caption.
  sourceLinked?: boolean;
  // SALES docs (DO / SI): the source PO(s) the shipped/invoiced goods actually
  // came from — the durable batch_no = source-PO hard link, not a guess. Empty /
  // absent → the Source PO cell shows a dash (plain FIFO / pre-batch stock).
  sourcePos?: string[];
  // SALES docs: the line shipped (at least partly) from a PO-less stock
  // ADJUSTMENT lot (free gift / add-back). Renders a "STOCK ADJ" chip so the
  // cell is explained rather than blank.
  sourceAdj?: boolean;
  // PURCHASE docs (PO / GRN / PI): the Delivery Order(s) that have shipped this
  // line's goods (batch_no = this PO) with the qty shipped per DO. Empty / absent
  // → the Delivered cell shows a dash (nothing delivered against this line yet).
  // soDocNo (2026-08-02) pairs each DO with its Assigned-SO row in the per-SO
  // sub-table — a DO belongs to ONE Sales Order (delivery_orders.so_doc_no).
  deliveredDos?: Array<{ doNo: string; qty: number; soDocNo?: string | null }>;
};

// Permissive superset of the per-line fields the six document detail hooks
// return. Each list's items are cast to this in its wrapper (the same shape the
// SI/DR detail drawers already cast to inline), so a wrapper never has to
// import that list's exact item type — it just reads the fields it means and
// picks its own Qty / amount source. Every field is optional; a document that
// omits one falls through to the `??` defaults in the wrapper.
export type DrillItemFields = {
  item_group?: string | null;
  material_code?: string | null;
  item_code?: string | null;
  product_code?: string | null;
  description?: string | null;
  material_name?: string | null;
  product_name?: string | null;
  description2?: string | null;
  variants?: Record<string, unknown> | null;
  qty?: number | null;
  received_qty?: number | null;
  qty_returned?: number | null;
  unit_price_centi?: number | null;
  line_total_centi?: number | null;
  total_centi?: number | null;
  amount_centi?: number | null;
};

// Shared centi → RM string, same helper the lists use.
const fmtRm = (centi: number): string => fmtCenti(centi);

/* A Source-PO chip is the batch_no the ledger stored, which is the source PO's
   `po_number` VERBATIM — nothing here adds, strips or normalises a prefix, and
   nothing may start to. Doc numbers are namespaced PER COMPANY
   (scm/lib/companyScope.ts `companyDocPrefix`): the base company HOUZS mints
   BARE numbers (`PO-2607-002`) and every other company prefixes with its code
   (`2990-PO-2607-002`). So the two forms are two namespaces that can BOTH hold
   the same tail — "unifying" them by stamping `2990-` on a bare number would
   name a DIFFERENT, possibly real, document on the batch→lot→COGS trail. Owner
   asked why the column looks inconsistent (2026-08-01); the honest answer is a
   tooltip, not a rewrite. */
export const sourcePoTitle = (poNo: string): string =>
  /^\d+-/.test(poNo)
    ? `Source purchase order ${poNo} — the "${poNo.split("-")[0]}-" prefix is the company that raised it.`
    : `Source purchase order ${poNo} — no company prefix, so it was raised under the base company (Houzs).`;

/* "STOCK ADJ" — goods that entered stock through a positive ADJUSTMENT (free
   gift / cancel add-back), which is legitimately PO-less BY DESIGN. The owner's
   rule is that a READY / delivered line must never show a blank source, so
   these lines say what they are instead of a dash. */
export function StockAdjChip() {
  return (
    <span
      title="Stock adjustment — these goods entered stock without a purchase order (free gift / cancel add-back). PO-less by design."
      className="rounded border border-border-subtle bg-surface-dim px-1.5 py-0.5 font-docno text-[11px] font-semibold text-ink-secondary"
    >
      STOCK ADJ
    </span>
  );
}

/* "STOCK" — a purchase-doc line with NO assignment is surplus stock, not
   missing data (owner 2026-08-02, off 2990-PO-2607-001/-005: ANGGN stock
   replenishment with no open demand read as a bare dash). Subtle by design —
   it explains the emptiness without competing with real SO chips. MRP layer
   (c) float-assigns automatically once matching demand appears. */
export function StockTag() {
  return (
    <span
      title="Stock replenishment — no open Sales Order demand is assigned to this line. MRP will float-assign it automatically when matching demand appears."
      className="rounded border border-dashed border-border-subtle bg-surface-dim px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-muted"
    >
      STOCK
    </span>
  );
}

/* ChipOverflow — the LIST-cell scale rule (owner 2026-08-01: "枕头订500个…
   100张SO…UI直接爆开"). A list cell renders the first `limit` chips plus an
   inline "+N" toggle that EXPANDS IN PLACE to the full list — nothing is
   hover-only, nothing is hidden without a visible count, and the toggle is a
   real button so it works on mobile tap. Drill-down / detail rows do NOT use
   this — they always render the full list (this supersedes the 2026-07-31
   "no collapse anywhere" rule for LIST cells only; the no-hidden-information
   intent survives because the expansion is one tap and in place). */
export function ChipOverflow({ chips, limit = 4 }: { chips: ReactNode[]; limit?: number }) {
  const [expanded, setExpanded] = useState(false);
  if (chips.length === 0) return <span className="text-[12px] text-ink-muted">—</span>;
  const shown = expanded ? chips : chips.slice(0, limit);
  const hidden = chips.length - shown.length;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {shown}
      {(hidden > 0 || expanded) && chips.length > limit && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          title={expanded ? "Collapse" : `Show all ${chips.length}`}
          className="rounded border border-dashed border-border px-1.5 py-0.5 font-docno text-[11px] font-semibold text-ink-secondary hover:border-accent hover:text-accent"
        >
          {expanded ? "less" : `+${hidden}`}
        </button>
      )}
    </span>
  );
}

/* One rule for the Delivered chips' quantity suffix (owner 2026-08-01, off the
   2990-GRN-2607-020 screenshot): a MULTI-DO line must show EVERY qty — two
   bare chips read as one unit shipped twice, when it is really a 2-unit batch
   split 1+1 (audit 10c proved zero double-attribution). A single-DO chip keeps
   the earlier rule: the multiplier only when qty > 1 ("x1" is noise there). */
export const showDeliveredQty = (qty: number, chipCount: number): boolean =>
  chipCount > 1 || qty > 1;

// Column widths are driven by which optional columns are on, so the template is
// built at RUNTIME and applied via an inline style — a dynamically-joined
// `grid-cols-[...]` class would never be seen by Tailwind's JIT scanner.
// `paired` (2026-08-02): Assigned SO + SO Delivery Date + Delivered collapse
// into ONE per-SO sub-table column (owner's pillow case — three parallel
// UNALIGNED stacks made "which SO has shipped" unreadable).
function buildGrid(opts: { assign: boolean; delivered: boolean; sourcePo: boolean; paired: boolean }): {
  cols: string;
  minW: number;
} {
  const cols = ["92px", "minmax(180px,1fr)", "56px", "104px"];
  let minW = 540;
  if (opts.paired) {
    cols.push("minmax(340px,1.4fr)");
    minW += 380;
  } else {
    if (opts.assign) { cols.push("minmax(150px,190px)", "120px"); minW += 300; }
    if (opts.delivered) { cols.push("minmax(150px,200px)"); minW += 200; }
  }
  if (opts.sourcePo) { cols.push("minmax(140px,190px)"); minW += 200; }
  return { cols: cols.join(" "), minW };
}

/* ── Per-SO paired rows (2026-08-02, owner's PO-2606-021 pillow screenshot) ──
   One row per assigned SO: [SO chip | SO delivery date | the delivered-DO
   chips for THAT SO | status]. Status: DELIVERED once any DO for that SO has
   shipped this line's goods; PENDING otherwise (an unshipped SO with a future
   date must read PENDING, never blank). Delivered DOs whose soDocNo matches no
   assignment still render (an extra row) — pairing must never hide a shipment. */
type PairedSoRow = {
  soDocNo: string;
  deliveryDate: string | null;
  assignment: OriginAssignment | null;
  dos: Array<{ doNo: string; qty: number }>;
};

export function buildPairedSoRows(
  assigned: OriginAssignment[],
  delivered: Array<{ doNo: string; qty: number; soDocNo?: string | null }>,
): PairedSoRow[] {
  const rows = new Map<string, PairedSoRow>();
  for (const a of assigned) {
    rows.set(a.soDocNo, { soDocNo: a.soDocNo, deliveryDate: a.deliveryDate ?? null, assignment: a, dos: [] });
  }
  const orphans: PairedSoRow[] = [];
  for (const d of delivered) {
    const key = d.soDocNo ?? "";
    const hit = key ? rows.get(key) : undefined;
    if (hit) {
      hit.dos.push({ doNo: d.doNo, qty: d.qty });
    } else {
      let orphan = orphans.find((o) => o.soDocNo === (key || "—"));
      if (!orphan) {
        orphan = { soDocNo: key || "—", deliveryDate: null, assignment: null, dos: [] };
        orphans.push(orphan);
      }
      orphan.dos.push({ doNo: d.doNo, qty: d.qty });
    }
  }
  return [...rows.values(), ...orphans];
}

/* ACCESSORIES DO NOT LIST THEIR ORDERS on a purchase document.
   Owner, 2026-08-04: "因为我的枕头进 500 粒，然后分配的话，它整个的 listing 会太
   长了 … 关于整个 accessories 它不需要显示出来，没关系的。不过，你的 Stock
   Movement Control 那边一定要有这个".
   A pillow arrives 500 at a time and is spread over dozens of orders, so one GRN
   line grows a sub-table taller than the rest of the document put together. */
const isAccessoryLine = (group: string | null | undefined): boolean =>
  String(group ?? "").trim().toLowerCase() === "accessory";

/* …but NOT a blank cell. An empty assignment column reads as "this stock is
   unassigned", and a document that quietly under-states its own linkage is the
   exact ambiguity behind the duplicate-delivery incident
   (docs/unlinked-line-duplicate-coe.md). The counts stay; only the list goes.
   The underlying links are untouched — they are what the remaining-qty ceiling
   counts — and the movement-by-movement trail is on Stock Movement, which
   records the source document for every IN and OUT. */
function AccessoryAssignmentSummary({
  assigned,
  delivered,
}: {
  assigned: OriginAssignment[];
  delivered: Array<{ doNo: string; qty: number; soDocNo?: string | null }>;
}) {
  const orders = new Set(assigned.map((a) => a.soDocNo)).size;
  const dos = new Set(delivered.map((d) => d.doNo)).size;
  if (orders === 0 && dos === 0) return <StockTag />;
  return (
    <span
      className="text-[11px] leading-snug text-ink-secondary"
      title="Accessories are received in bulk and spread across many orders, so the per-order list is not shown here. The links themselves are intact — open Stock Movement for the document-by-document trail."
    >
      {orders > 0 && `${orders} order${orders === 1 ? "" : "s"}`}
      {orders > 0 && dos > 0 && " · "}
      {dos > 0 && `${dos} deliver${dos === 1 ? "y" : "ies"}`}
      <span className="block text-ink-muted">see Stock Movement</span>
    </span>
  );
}

function PairedSoCell({
  assigned,
  delivered,
  sourceLinked,
  onOpenSo,
  onOpenDo,
}: {
  assigned: OriginAssignment[];
  delivered: Array<{ doNo: string; qty: number; soDocNo?: string | null }>;
  sourceLinked?: boolean;
  onOpenSo?: (soDocNo: string) => void;
  onOpenDo?: (doNo: string) => void;
}) {
  const rows = buildPairedSoRows(assigned, delivered);
  if (rows.length === 0) return <StockTag />;
  const chipBase = "rounded px-1.5 py-0.5 font-docno text-[11px] font-semibold";
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {rows.map((r) => {
        const a = r.assignment;
        const floating = a?.locked === false;
        const soTitle = !a
          ? "This Delivery Order's Sales Order is not among this line's assignments — shown so the shipment stays visible."
          : floating
            ? "MRP guess — a live allocation, not a stored link. It moves as demand moves and can disappear."
            : a.source === "delivered"
              ? "Locked — this line's goods were delivered against this Sales Order"
              : sourceLinked === false
                ? "This Sales Order is an MRP allocation — no stored link on the purchase order line"
                : "Locked — a stored link to this Sales Order";
        const soTone = floating
          ? "border border-dashed border-border text-ink-secondary"
          : "border border-border-subtle bg-surface-2 text-accent-ink";
        const shipped = r.dos.length > 0;
        const doChipCount = r.dos.length;
        return (
          <div key={r.soDocNo} className="flex min-w-0 flex-wrap items-center gap-1.5">
            {onOpenSo && r.soDocNo !== "—" ? (
              <button
                type="button"
                title={soTitle}
                onClick={() => onOpenSo(r.soDocNo)}
                className={cn(chipBase, soTone, "hover:border-accent hover:text-accent")}
              >
                {r.soDocNo}
                {floating && <span className="text-ink-muted">{" ~"}</span>}
              </button>
            ) : (
              <span title={soTitle} className={cn(chipBase, soTone)}>
                {r.soDocNo}
                {floating && <span className="text-ink-muted">{" ~"}</span>}
              </span>
            )}
            <span className="whitespace-nowrap font-mono text-[10.5px] text-ink-muted">
              {r.deliveryDate ? formatDate(r.deliveryDate) : "—"}
            </span>
            {r.dos.map((d) => {
              const label = (
                <>
                  {d.doNo}
                  {showDeliveredQty(d.qty, doChipCount) && (
                    <span className="text-ink-muted">{` x${d.qty}`}</span>
                  )}
                </>
              );
              const doBase =
                "rounded border border-border-subtle bg-surface-2 px-1.5 py-0.5 font-docno text-[11px] font-semibold text-ink-secondary";
              return onOpenDo ? (
                <button
                  type="button"
                  key={d.doNo}
                  title="The Delivery Order that shipped this line's goods for this Sales Order"
                  onClick={() => onOpenDo(d.doNo)}
                  className={cn(doBase, "hover:border-accent hover:text-accent")}
                >
                  {label}
                </button>
              ) : (
                <span key={d.doNo} className={doBase}>
                  {label}
                </span>
              );
            })}
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider",
                shipped ? "bg-synced-bg text-synced" : "bg-surface-dim text-ink-muted",
              )}
              title={shipped
                ? "Delivered — at least one Delivery Order has shipped this line's goods for this Sales Order"
                : "Pending — assigned, nothing shipped for this Sales Order yet (delivery date shown)"}
            >
              {shipped ? "DELIVERED" : "PENDING"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function DocumentLinesExpansion({
  isLoading,
  isError,
  errorMessage,
  lines,
  emptyLabel = "No lines on this document.",
  showAssignment = false,
  showDelivered = false,
  showSourcePo = false,
  onOpenSo,
  onOpenDo,
}: {
  isLoading: boolean;
  isError?: boolean;
  errorMessage?: string | null;
  lines: DocumentDrillLine[];
  emptyLabel?: string;
  // Purchase docs (PO / GRN / PI): render the Assigned SO + SO Delivery Date
  // columns from each line's `assignedSos`. onOpenSo makes the SO chip clickable
  // (desktop deep-link); omit it for a display-only surface.
  showAssignment?: boolean;
  // Purchase docs (PO / GRN / PI): render a Delivered column from each line's
  // `deliveredDos` — the DO(s) that shipped this line's goods.
  showDelivered?: boolean;
  // Sales docs (DO / SI): render a Source PO column from each line's `sourcePos`.
  showSourcePo?: boolean;
  onOpenSo?: (soDocNo: string) => void;
  onOpenDo?: (doNo: string) => void;
}) {
  /* Paired mode (2026-08-02): a purchase doc showing BOTH assignments and
     deliveries renders them as one per-SO sub-table — never three unaligned
     stacks. */
  const paired = showAssignment && showDelivered;
  const { cols: gridCols, minW: minWpx } = buildGrid({
    assign: showAssignment,
    delivered: showDelivered,
    sourcePo: showSourcePo,
    paired,
  });
  const gridStyle = { gridTemplateColumns: gridCols } as const;
  if (isLoading) {
    return (
      <div className="py-4 text-center text-[12px] text-ink-muted">
        Loading lines…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="py-4 text-center text-[12px] text-err">
        {errorMessage || "Failed to load lines."}
      </div>
    );
  }
  if (lines.length === 0) {
    return (
      <div className="py-4 text-center text-[12px] text-ink-muted">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <div style={{ minWidth: `${minWpx}px` }}>
        <div
          style={gridStyle}
          className="grid items-start gap-2 border-b border-border-subtle bg-surface-2 px-4 py-2 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted"
        >
          <span>Group</span>
          <span>Item</span>
          <span className="text-right">Qty</span>
          <span className="text-right">Amount</span>
          {paired && <span>Assigned SO · Delivery Date · Delivered · Status</span>}
          {!paired && showAssignment && <span>Assigned SO</span>}
          {!paired && showAssignment && <span>SO Delivery Date</span>}
          {!paired && showDelivered && <span>Delivered</span>}
          {showSourcePo && <span>Source PO</span>}
        </div>
        {lines.map((l, i) => {
          // Item CODE first, then the variant subtitle; live variant summary
          // wins over the stored description2 (which can be stale on older rows
          // with no variants blob) — the same shared order-line rule the detail
          // drawers already apply.
          const { primary, secondary } = orderLineIdentity({
            code: l.code ?? undefined,
            description: l.description ?? undefined,
            variant:
              buildVariantSummary(l.itemGroup ?? "others", l.variants ?? null) ||
              (l.description2 ?? ""),
          });
          const assigned = l.assignedSos ?? [];
          const delivered = l.deliveredDos ?? [];
          const sourcePos = l.sourcePos ?? [];
          /* Purchase docs only. On a sales document (DO / SI) the assignment IS
             the document, so there is nothing to collapse. */
          const accessory = isAccessoryLine(l.itemGroup);
          return (
            <div
              key={i}
              style={gridStyle}
              className="grid items-start gap-2 border-b border-border-subtle px-4 py-2.5 last:border-b-0"
            >
              <span>
                <ItemGroupPill group={l.itemGroup} />
              </span>
              <div className="min-w-0">
                <div className="text-[12.5px] font-semibold text-ink">
                  {primary || "—"}
                </div>
                {secondary && (
                  <div className="mt-0.5 text-[11px] leading-snug text-ink-secondary">
                    {secondary}
                  </div>
                )}
              </div>
              <span className="text-right font-money text-[12px] text-ink-secondary">
                {l.qty}
              </span>
              <span className="text-right font-money text-[12px] font-semibold text-ink">
                {fmtRm(l.amountCenti)}
              </span>
              {paired && (
                accessory
                  ? <AccessoryAssignmentSummary assigned={assigned} delivered={delivered} />
                  : (
                    <PairedSoCell
                      assigned={assigned}
                      delivered={delivered}
                      sourceLinked={l.sourceLinked}
                      onOpenSo={onOpenSo}
                      onOpenDo={onOpenDo}
                    />
                  )
              )}
              {!paired && showAssignment && accessory && (
                <AccessoryAssignmentSummary assigned={assigned} delivered={delivered} />
              )}
              {!paired && showAssignment && !accessory && (
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="flex min-w-0 flex-wrap gap-1">
                  {assigned.length > 0 ? (
                    assigned.map((a) => {
                      // Floating (live MRP coverage) reads as a dashed chip with a
                      // trailing "~"; static (delivered→DO-locked or raised-from-SO)
                      // reads as a solid chip. Owner distinguishes the two.
                      const floating = a.locked === false;
                      const title = floating
                        ? "MRP guess — a live allocation, not a stored link. It moves as demand moves and can disappear."
                        : a.source === "delivered"
                          ? "Locked — this PO's goods were delivered against this Sales Order"
                          : l.sourceLinked === false
                            ? "This Sales Order is an MRP allocation — no stored link on the purchase order line"
                            : "Locked — this PO line stores a link to this Sales Order";
                      const base =
                        "rounded px-1.5 py-0.5 font-docno text-[11px] font-semibold";
                      const tone = floating
                        ? "border border-dashed border-border text-ink-secondary"
                        : "border border-border-subtle bg-surface-2 text-accent-ink";
                      return onOpenSo ? (
                        <button
                          type="button"
                          key={a.soDocNo}
                          title={title}
                          onClick={() => onOpenSo(a.soDocNo)}
                          className={cn(base, tone, "hover:border-accent hover:text-accent")}
                        >
                          {a.soDocNo}
                          {floating && <span className="text-ink-muted">{" ~"}</span>}
                        </button>
                      ) : (
                        <span key={a.soDocNo} title={title} className={cn(base, tone)}>
                          {a.soDocNo}
                          {floating && <span className="text-ink-muted">{" ~"}</span>}
                        </span>
                      );
                    })
                  ) : (
                    <StockTag />
                  )}
                  </span>
                </span>
              )}
              {/* SO Delivery Date — one date per assignment, so it grows at the
                  same rate as the assignment list and has to collapse with it. */}
              {!paired && showAssignment && (
                <span className="flex min-w-0 flex-col gap-0.5">
                  {accessory ? (
                    <span className="text-[11px] text-ink-muted">—</span>
                  ) : assigned.length > 0 ? (
                    assigned.map((a) => (
                      <span
                        key={a.soDocNo}
                        className="whitespace-nowrap font-mono text-[11px] text-ink-secondary"
                      >
                        {a.deliveryDate ? formatDate(a.deliveryDate) : "—"}
                      </span>
                    ))
                  ) : (
                    <span className="text-[11px] text-ink-muted">—</span>
                  )}
                </span>
              )}
              {!paired && showDelivered && accessory && (
                <span className="text-[11px] text-ink-secondary">
                  {new Set(delivered.map((d) => d.doNo)).size || "—"}
                </span>
              )}
              {!paired && showDelivered && !accessory && (
                <span className="flex min-w-0 flex-wrap items-center gap-1">
                  {delivered.length > 0 ? (
                    delivered.map((d) => {
                      const base =
                        "rounded border border-border-subtle bg-surface-2 px-1.5 py-0.5 font-docno text-[11px] font-semibold text-ink-secondary";
                      // Multi-DO lines ALWAYS show each qty (a 1+1 batch split
                      // must not read as one unit shipped twice); a single-DO
                      // chip keeps the "no x1 noise" rule (owner 2026-08-01).
                      const label = (
                        <>
                          {d.doNo}
                          {showDeliveredQty(d.qty, delivered.length) && (
                            <span className="text-ink-muted">{` x${d.qty}`}</span>
                          )}
                        </>
                      );
                      return onOpenDo ? (
                        <button
                          type="button"
                          key={d.doNo}
                          onClick={() => onOpenDo(d.doNo)}
                          className={cn(base, "hover:border-accent hover:text-accent")}
                        >
                          {label}
                        </button>
                      ) : (
                        <span key={d.doNo} className={base}>
                          {label}
                        </span>
                      );
                    })
                  ) : (
                    <span className="text-[11px] text-ink-muted">—</span>
                  )}
                </span>
              )}
              {showSourcePo && (
                <span className="flex min-w-0 flex-wrap items-center gap-1">
                  {sourcePos.length > 0 || l.sourceAdj ? (
                    <>
                      {sourcePos.map((po) => (
                        <span
                          key={po}
                          title={sourcePoTitle(po)}
                          className="rounded border border-border-subtle bg-surface-2 px-1.5 py-0.5 font-docno text-[11px] font-semibold text-accent-ink"
                        >
                          {po}
                        </span>
                      ))}
                      {l.sourceAdj && <StockAdjChip />}
                    </>
                  ) : (
                    <span className="text-[11px] text-ink-muted">—</span>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AssignedSoCell — the COLLAPSED header-row "Assigned SO" summary, shared by the
// PO / GRN / PI / DO lists. It is the one-line twin of the drill-down's per-line
// Assigned-SO cell above: a FLOATING (live MRP) assignment reads as a dashed
// chip with a trailing "~"; a STATIC one (delivered → DO-locked, a stored
// raise-link, or a DO's own intrinsic SO) reads as a solid chip. LIST cells
// render the first few chips + an in-place "+N" toggle (ChipOverflow — owner
// 2026-08-01 scale ruling, superseding the 2026-07-31 "no collapse" rule for
// LIST cells; drill-downs still render every chip). The primary assignment's
// delivery date rides inline. `sourceLinked === false` is threaded into the
// tooltip so the guess-vs-binding distinction (2026-07-29 incident) survives
// even in the compact column.
// ---------------------------------------------------------------------------
export function AssignedSoCell({
  assignments,
  sourceLinked,
  onOpenSo,
  emptyMeans = "dash",
}: {
  assignments: OriginAssignment[] | undefined | null;
  sourceLinked?: boolean;
  onOpenSo?: (soDocNo: string) => void;
  /* "stock" (purchase docs, 2026-08-02): an empty cell means surplus stock, so
     it reads "STOCK" instead of a bare dash — no open demand is not missing
     data. Sales surfaces keep the dash (an ad-hoc DO simply has no SO). */
  emptyMeans?: "dash" | "stock";
}) {
  const list = assignments ?? [];
  if (list.length === 0) {
    return emptyMeans === "stock" ? <StockTag /> : <span className="text-[12px] text-ink-muted">—</span>;
  }
  const base = "rounded px-1.5 py-0.5 font-docno text-[11px] font-semibold";
  const chipTitle = (a: OriginAssignment): string =>
    a.locked === false
      ? "MRP guess — a live allocation, not a stored link. It moves as demand moves and can disappear."
      : a.source === "delivered"
        ? "Locked — the goods were delivered against this Sales Order"
        : sourceLinked === false
          ? "This Sales Order is an MRP allocation — no stored link on the purchase order line"
          : "Locked — a stored link to this Sales Order";
  const chipTone = (a: OriginAssignment): string =>
    a.locked === false
      ? "border border-dashed border-border text-ink-secondary"
      : "border border-border-subtle bg-surface-2 text-accent-ink";
  // Each SO carries its OWN delivery date inline; the chip + its date form one
  // wrapping unit. ChipOverflow applies the list-cell "+N" rule.
  const chips = list.map((a) => {
    const label = (
      <>
        {a.soDocNo}
        {a.locked === false && <span className="text-ink-muted">{" ~"}</span>}
      </>
    );
    return (
      <span key={a.soDocNo} className="inline-flex items-center gap-1">
        {onOpenSo ? (
          <button
            type="button"
            title={chipTitle(a)}
            onClick={(e) => {
              e.stopPropagation();
              onOpenSo(a.soDocNo);
            }}
            className={cn(base, chipTone(a), "hover:border-accent hover:text-accent")}
          >
            {label}
          </button>
        ) : (
          <span title={chipTitle(a)} className={cn(base, chipTone(a))}>
            {label}
          </span>
        )}
        {a.deliveryDate && (
          <span className="whitespace-nowrap font-mono text-[10.5px] text-ink-muted">
            {formatDate(a.deliveryDate)}
          </span>
        )}
      </span>
    );
  });
  return <ChipOverflow chips={chips} />;
}

// ---------------------------------------------------------------------------
// DeliveredCell — the COLLAPSED header-row "Delivered" summary for the PO / GRN /
// PI lists: every Delivery Order that has shipped this purchase document's goods
// (batch_no = the PO number), with the qty shipped per DO. A MULTI-DO cell shows
// each chip's qty even when it is 1 — a 2-unit batch split 1+1 across two DOs
// must not read as one unit shipped twice (owner 2026-08-01, off the
// 2990-GRN-2607-020 screenshot; audit 10c proved zero double-attribution). A
// single-DO chip keeps the "no x1 noise" rule. List cells overflow past a few
// chips into an in-place "+N" toggle (ChipOverflow). A dash when nothing has
// shipped yet.
// ---------------------------------------------------------------------------
export function DeliveredCell({
  dos,
  onOpenDo,
}: {
  dos: Array<{ doNo: string; qty: number }> | undefined | null;
  onOpenDo?: (doNo: string) => void;
}) {
  const list = dos ?? [];
  if (list.length === 0) return <span className="text-[12px] text-ink-muted">—</span>;
  const base =
    "rounded border border-border-subtle bg-surface-2 px-1.5 py-0.5 font-docno text-[11px] font-semibold text-ink-secondary";
  const chips = list.map((d) => {
    const label = (
      <>
        {d.doNo}
        {showDeliveredQty(d.qty, list.length) && (
          <span className="text-ink-muted">{` x${d.qty}`}</span>
        )}
      </>
    );
    return onOpenDo ? (
      <button
        type="button"
        key={d.doNo}
        title="A Delivery Order that shipped this document's goods"
        onClick={(e) => {
          e.stopPropagation();
          onOpenDo(d.doNo);
        }}
        className={cn(base, "hover:border-accent hover:text-accent")}
      >
        {label}
      </button>
    ) : (
      <span key={d.doNo} className={base}>
        {label}
      </span>
    );
  });
  return <ChipOverflow chips={chips} />;
}

export default DocumentLinesExpansion;
