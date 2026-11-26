
import { useState, type ReactNode } from "react";
import { type CoverageState, coveragePlaceholder } from "./coverage-state";
import { buildVariantSummary, fmtSen, orderLineIdentity } from "@2990s/shared";
import { ItemGroupPill } from "../vendor/scm/lib/category-badges";
import type { OriginAssignment } from "../vendor/scm/lib/flow-queries";
import { cn, formatDate } from "../lib/utils";

export type DocumentDrillLine = {
  itemGroup: string | null;
  code: string | null;
  description: string | null;
  description2: string | null;
  variants: Record<string, unknown> | null;
  qty: number;
  amountSen: number;
  assignedSos?: OriginAssignment[];
  // Does a STORED so_item_id back this line's SKU, or is the Assigned SO above
  // only an MRP allocation? The two used to render identically apart from a
  // dashed border, and the owner read a guess as a binding (2026-07-29). It
  // carried a visible "MRP guess · not linked" caption until the owner asked for
  // it gone (2026-08-01); the distinction now lives in the chip's tooltip and in
  // the dashed-vs-solid tone, so the resolution is unchanged — only the caption.
  sourceLinked?: boolean;
  provenance?: OriginAssignment[];
  sourcePos?: string[];
  sourceAdj?: boolean;
  sourceState?: 'locked' | 'worked_out' | null;
  deliveredDos?: Array<{ doNo: string; qty: number; soDocNo?: string | null }>;
};

export type DrillItemFields = {
  item_group?: string | null;
  item_code?: string | null;
  description?: string | null;
  material_name?: string | null;
  product_name?: string | null;
  description2?: string | null;
  variants?: Record<string, unknown> | null;
  qty?: number | null;
  received_qty?: number | null;
  qty_accepted?: number | null;
  qty_received?: number | null;
  qty_returned?: number | null;
  unit_price_sen?: number | null;
  line_total_sen?: number | null;
  total_sen?: number | null;
  amount_sen?: number | null;
};

const fmtRm = (centi: number): string => fmtSen(centi);

/* ── Three visual identities for a cross-document assignment chip ──────────
   Decision (docs/modules/purchase-order.md, owner 2026-08-06): soft until DO,
   hard from DO. Anything pre-DO is soft and must not dress as execution:
   - ANCHORED  (source 'delivered'): a DO shipped these goods — hard history,
     solid accent chip, unchanged.
   - PROVENANCE (source 'linked', the stored PO→SO raise-link): records why we
     bought, NOT the live assignment — muted tone, never the word "Locked".
   - FLOATING  (source 'mrp' / locked:false): the live MRP allocation,
     recomputed on every view — dashed border + trailing "~".
   One helper trio so desktop cannot drift from itself; the mobile twin
   (mobile/source-chips.tsx) mirrors these by hand — keep them in lockstep. */
export type AssignmentTreatment = "anchored" | "provenance" | "floating";

export const assignmentTreatment = (a: OriginAssignment): AssignmentTreatment =>
  a.locked === false || a.source === "mrp"
    ? "floating"
    : a.source === "delivered"
      ? "anchored"
      : "provenance";

export const FLOATING_ASSIGNMENT_TITLE =
  "Assigned by MRP now - it moves if MRP gives the goods to another order. The SO it was raised for is the SO Doc No. column.";

export const assignmentTitle = (a: OriginAssignment, sourceLinked?: boolean): string => {
  switch (assignmentTreatment(a)) {
    case "floating":
      return FLOATING_ASSIGNMENT_TITLE;
    case "anchored":
      return "Delivered — this line's goods shipped against this Sales Order (anchored history)";
    default:
      return sourceLinked === false
        ? "This Sales Order is an MRP allocation — no stored link on the purchase order line"
        : `Bought for ${a.soDocNo} — procurement provenance, not the live assignment.`;
  }
};

export const assignmentTone = (a: OriginAssignment): string => {
  switch (assignmentTreatment(a)) {
    /* Owner 2026-11-19: the Assigned SO IS MRP's record - a plain chip, no dash
       and no "~" that read as "not sure". */
    case "floating":
      return "border border-border-subtle bg-surface-2 text-ink";
    case "anchored":
      return "border border-border-subtle bg-surface-2 text-accent-ink";
    default:
      return "border border-border-subtle bg-surface-dim text-ink-secondary";
  }
};

export const provenanceExtras = (
  provenance: OriginAssignment[] | undefined | null,
  shownSoDocNos: Iterable<string>,
): OriginAssignment[] => {
  const seen = new Set(shownSoDocNos);
  /* Owner 2026-11-19 ("看到两个？"): beside MRP's order a second, raised-for chip
     read as the PO going to two orders. The raised-for SO is the SO Doc No.
     column; it shows here only when nothing else is assigned. */
  if (seen.size > 0) return [];
  return (provenance ?? [])
    .filter((p) => p.soDocNo && !seen.has(p.soDocNo))
    .map((p) => ({ ...p, locked: true, source: "linked" as const }));
};

export const sourcePoTitle = (poNo: string): string =>
  /^\d+-/.test(poNo)
    ? `Source purchase order ${poNo} — the "${poNo.split("-")[0]}-" prefix is the company that raised it.`
    : `Source purchase order ${poNo} — no company prefix, so it was raised under the base company (Houzs).`;

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

export function WorkedOutTag() {
  return (
    <span
      title="Worked out from stock records — this delivery order was confirmed before PO and rack were locked at dispatch, so a later stock repair can change it."
      className="text-[10.5px] italic text-ink-muted"
    >
      worked out
    </span>
  );
}

/* Committed batch — the hard-from-DO anchor (Decision, docs/modules/
   purchase-order.md 2026-08-06: "soft until DO, hard from DO"). A DO line that
   ships before its goods arrive and resolves exactly ONE live bound PO stores
   that PO's number in `delivery_order_items.committed_po_batch_no` at DO
   creation (mig 0230, `planShipCommitments`). This cell surfaces that STORED
   anchor: solid treatment (the ANCHORED identity — a recorded fact, never a
   floating MRP guess, so no dash and no "~"). Absent → render NOTHING: most
   lines ship from stock on hand and never commit, and a dash would read as
   missing data. Display-only — the write path is ship-commitment.ts. */
export const committedBatchTitle = (poNo: string): string =>
  `Committed batch — this line committed to incoming purchase order ${poNo} when the Delivery Order was created (hard from DO). The commitment is stored on the line; a PO cancelled or raised later cannot move it.`;

export function CommittedBatchCell({ poNo }: { poNo?: string | null }) {
  if (!poNo) return null;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
        Committed PO
      </span>
      <span
        title={committedBatchTitle(poNo)}
        className="rounded border border-border-subtle bg-surface-2 px-1.5 py-0.5 font-docno text-[11px] font-semibold text-accent-ink"
      >
        {poNo}
      </span>
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

function AccessoryAssignmentSummary({
  assigned,
  delivered,
  coverage,
}: {
  assigned: OriginAssignment[];
  delivered: Array<{ doNo: string; qty: number; soDocNo?: string | null }>;
  coverage: CoverageState;
}) {
  const orders = new Set(assigned.map((a) => a.soDocNo)).size;
  const dos = new Set(delivered.map((d) => d.doNo)).size;
  if (orders === 0 && dos === 0) return coveragePlaceholder(coverage) ?? <StockTag />;
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
  provenance,
  coverage,
  onOpenSo,
  onOpenDo,
}: {
  assigned: OriginAssignment[];
  delivered: Array<{ doNo: string; qty: number; soDocNo?: string | null }>;
  coverage: CoverageState;
  sourceLinked?: boolean;
  provenance?: OriginAssignment[];
  onOpenSo?: (soDocNo: string) => void;
  onOpenDo?: (doNo: string) => void;
}) {
  const rows = buildPairedSoRows(assigned, delivered);
  const provExtra = provenanceExtras(provenance, rows.map((r) => r.soDocNo));
  if (rows.length === 0 && provExtra.length === 0) return coveragePlaceholder(coverage) ?? <StockTag />;
  const chipBase = "rounded px-1.5 py-0.5 font-docno text-[11px] font-semibold";
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {rows.map((r) => {
        const a = r.assignment;
        const floating = a ? assignmentTreatment(a) === "floating" : false;
        const soTitle = !a
          ? "This Delivery Order's Sales Order is not among this line's assignments — shown so the shipment stays visible."
          : assignmentTitle(a, sourceLinked);
        const soTone = !a
          ? "border border-border-subtle bg-surface-2 text-accent-ink"
          : assignmentTone(a);
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
                
              </button>
            ) : (
              <span title={soTitle} className={cn(chipBase, soTone)}>
                {r.soDocNo}
                
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
      {provExtra.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {provExtra.map((a) => (
            <span key={a.soDocNo} className="inline-flex items-center gap-1.5">
              {onOpenSo ? (
                <button
                  type="button"
                  title={assignmentTitle(a)}
                  onClick={() => onOpenSo(a.soDocNo)}
                  className={cn(chipBase, assignmentTone(a), "hover:border-accent hover:text-accent")}
                >
                  {a.soDocNo}
                </button>
              ) : (
                <span title={assignmentTitle(a)} className={cn(chipBase, assignmentTone(a))}>
                  {a.soDocNo}
                </span>
              )}
              <span className="whitespace-nowrap font-mono text-[10.5px] text-ink-muted">
                {a.deliveryDate ? formatDate(a.deliveryDate) : "—"}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function DocumentLinesExpansion({
  isLoading,
  coverage,
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
  coverage: CoverageState;
  isError?: boolean;
  errorMessage?: string | null;
  lines: DocumentDrillLine[];
  emptyLabel?: string;
  showAssignment?: boolean;
  showDelivered?: boolean;
  showSourcePo?: boolean;
  onOpenSo?: (soDocNo: string) => void;
  onOpenDo?: (doNo: string) => void;
}) {
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
          const provExtra = provenanceExtras(l.provenance, assigned.map((a) => a.soDocNo));
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
                {fmtRm(l.amountSen)}
              </span>
              {paired && (
                accessory
                  ? <AccessoryAssignmentSummary assigned={assigned} delivered={delivered} coverage={coverage} />
                  : (
                    <PairedSoCell
                      assigned={assigned}
                      delivered={delivered}
                      sourceLinked={l.sourceLinked}
                      provenance={l.provenance}
                      coverage={coverage}
                      onOpenSo={onOpenSo}
                      onOpenDo={onOpenDo}
                    />
                  )
              )}
              {!paired && showAssignment && accessory && (
                <AccessoryAssignmentSummary assigned={assigned} delivered={delivered} coverage={coverage} />
              )}
              {!paired && showAssignment && !accessory && (
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="flex min-w-0 flex-wrap gap-1">
                  {assigned.length > 0 ? (
                    assigned.map((a) => {
                      const floating = assignmentTreatment(a) === "floating";
                      const title = assignmentTitle(a, l.sourceLinked);
                      const base =
                        "rounded px-1.5 py-0.5 font-docno text-[11px] font-semibold";
                      const tone = assignmentTone(a);
                      return onOpenSo ? (
                        <button
                          type="button"
                          key={a.soDocNo}
                          title={title}
                          onClick={() => onOpenSo(a.soDocNo)}
                          className={cn(base, tone, "hover:border-accent hover:text-accent")}
                        >
                          {a.soDocNo}
                          
                        </button>
                      ) : (
                        <span key={a.soDocNo} title={title} className={cn(base, tone)}>
                          {a.soDocNo}
                          
                        </span>
                      );
                    })
                  ) : provExtra.length === 0 ? (
                    coveragePlaceholder(coverage) ?? <StockTag />
                  ) : null}
                  {provExtra.map((a) => {
                    const base = "rounded px-1.5 py-0.5 font-docno text-[11px] font-semibold";
                    return onOpenSo ? (
                      <button
                        type="button"
                        key={`prov-${a.soDocNo}`}
                        title={assignmentTitle(a)}
                        onClick={() => onOpenSo(a.soDocNo)}
                        className={cn(base, assignmentTone(a), "hover:border-accent hover:text-accent")}
                      >
                        {a.soDocNo}
                      </button>
                    ) : (
                      <span key={`prov-${a.soDocNo}`} title={assignmentTitle(a)} className={cn(base, assignmentTone(a))}>
                        {a.soDocNo}
                      </span>
                    );
                  })}
                  </span>
                </span>
              )}
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
                      {l.sourceState === 'worked_out' && <WorkedOutTag />}
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

export function AssignedSoCell({
  assignments,
  sourceLinked,
  provenance,
  onOpenSo,
  emptyMeans = "dash",
}: {
  assignments: OriginAssignment[] | undefined | null;
  sourceLinked?: boolean;
  provenance?: OriginAssignment[] | null;
  onOpenSo?: (soDocNo: string) => void;
  emptyMeans?: "dash" | "stock";
}) {
  const list = assignments ?? [];
  const provExtra = provenanceExtras(provenance, list.map((a) => a.soDocNo));
  if (list.length === 0 && provExtra.length === 0) {
    return emptyMeans === "stock" ? <StockTag /> : <span className="text-[12px] text-ink-muted">—</span>;
  }
  const base = "rounded px-1.5 py-0.5 font-docno text-[11px] font-semibold";
  const chipOf = (a: OriginAssignment, provSlot: boolean) => {
    const label = (
      <>
        {a.soDocNo}
        
      </>
    );
    const title = provSlot ? assignmentTitle(a) : assignmentTitle(a, sourceLinked);
    return (
      <span key={`${provSlot ? "prov-" : ""}${a.soDocNo}`} className="inline-flex items-center gap-1">
        {onOpenSo ? (
          <button
            type="button"
            title={title}
            onClick={(e) => {
              e.stopPropagation();
              onOpenSo(a.soDocNo);
            }}
            className={cn(base, assignmentTone(a), "hover:border-accent hover:text-accent")}
          >
            {label}
          </button>
        ) : (
          <span title={title} className={cn(base, assignmentTone(a))}>
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
  };
  const chips = [...list.map((a) => chipOf(a, false)), ...provExtra.map((a) => chipOf(a, true))];
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
