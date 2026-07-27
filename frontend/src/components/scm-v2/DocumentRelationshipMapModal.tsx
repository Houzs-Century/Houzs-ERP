// DocumentRelationshipMapModal — shared node-graph modal for the SCM detail
// pages (SO / DO / SI / DR). Nick's 2026-07-08 design handoff specified a
// single chain shape for every doc page:
//   Customer PO → Sales Order → Delivery Order → GRN → Sales Invoice
// The current-doc node paints brass; upstream nodes paint green when linked,
// downstream nodes stay grey (Pending) until the doc actually exists.
//
// Each page passes in a `ChainNode[]` describing which nodes are done /
// current / pending for its own state; the modal owns the SVG canvas + the
// dashed grid + arrow markers, and calls `onNodeClick(type, doc)` when a
// linked non-current node is clicked so the caller can navigate to the
// real document.

import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Share2, X as XIcon } from "lucide-react";
import { cn } from "../../lib/utils";

export type ChainNodeState = "done" | "current" | "pending";

export type ChainNode = {
  type: string;
  doc: string;
  meta: string;
  state: ChainNodeState;
  href?: string;
  // Whether the node has something to do when tapped. Defaults to
  // `state === "done"` (a linked document opens). Set TRUE on a node that is
  // grey/pending but still actionable — e.g. the PO node that lists advisory
  // candidate POs ("N candidates — tap"); without this it renders disabled and
  // the tap is dead.
  actionable?: boolean;
};

// A Sales Order amendment (revision request) surfaced beside the graph. Each is
// a real document, clickable to its job card at /scm/amendments/:id.
export type AmendmentChip = {
  id: string;
  label: string;
  status: string | null;
};

// Turn a raw amendment status key (REQUESTED / SUPPLIER_PENDING / SO_APPROVED /
// PO_APPROVED / SENT / REJECTED …) into a readable label. No canonical status
// map exists for amendments, so lower-case the token and space the underscores.
function humaniseAmendmentStatus(status: string): string {
  const s = status.trim();
  if (!s) return s;
  const spaced = s.replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// ─── Modal shell (portal-anchored so `fixed` latches to the viewport even
// when an ancestor has transform/filter set) ───────────────────────────

export function ModalOverlay({
  open,
  onClose,
  title,
  icon,
  size = "sm",
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  icon?: ReactNode;
  size?: "sm" | "lg";
  children: ReactNode;
  footer?: ReactNode;
}) {
  return createPortal(
    <>
      <div
        onClick={onClose}
        aria-hidden
        className={cn(
          "fixed inset-0 z-[80] bg-ink/45 backdrop-blur-[1px] transition-opacity duration-200",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "fixed left-1/2 top-[8vh] z-[81] flex max-h-[84vh] w-[calc(100%-32px)] -translate-x-1/2 flex-col overflow-hidden rounded-2xl bg-surface shadow-slab transition-all duration-200",
          size === "lg" ? "max-w-[760px]" : "max-w-[480px]",
          open ? "scale-100 opacity-100" : "pointer-events-none scale-[.97] opacity-0"
        )}
      >
        <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-5">
          <div className="flex items-center gap-2.5">
            {icon && <span className="text-accent-ink">{icon}</span>}
            <span className="text-[15px] font-bold text-ink">{title}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-muted hover:text-ink"
            aria-label="Close"
          >
            <XIcon size={18} />
          </button>
        </div>
        <div className="thin-scroll flex-1 overflow-y-auto p-5">{children}</div>
        {footer && (
          <div className="flex shrink-0 items-center gap-2 border-t border-border-subtle bg-surface-2 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </>,
    document.body
  );
}

// ─── Relationship-map modal (5-node graph on a dotted canvas) ──────────────

export function DocumentRelationshipMapModal({
  open,
  onClose,
  nodes,
  onNodeClick,
  amendments,
  onAmendmentClick,
  rowLabels,
  amendmentsLabel,
}: {
  open: boolean;
  onClose: () => void;
  nodes: ChainNode[];
  onNodeClick?: (node: ChainNode) => void;
  // Optional amendments branch (SO / PO maps). When present, a labelled row of
  // clickable amendment chips renders beneath the graph.
  amendments?: AmendmentChip[];
  onAmendmentClick?: (a: AmendmentChip) => void;
  // Optional canvas row-label overrides — the PO map reads the same 5-node
  // shape as a purchase chain ("Purchase chain" / "After goods receipt")
  // instead of the sales-side defaults. Omitted → labels unchanged.
  rowLabels?: { primary: string; secondary: string };
  // Optional heading for the amendments row (default keeps the SO map's
  // "Amendments off the Sales Order").
  amendmentsLabel?: string;
}) {
  // Canvas layout — fixed pixel positions so the graph reads at any modal
  // width. Two shapes:
  //   5 nodes (DO / SI / DR pages, the original Nick 2026-07-08 chain):
  //     top row nodes 0..2, bottom row 3..4 branching down from the DO.
  //   7 nodes (SO pages) — the owner's two chains, verbatim (2026-07-23):
  //     sales    : Sales Order → Delivery Order → Sales Invoice   (top row)
  //     purchase : Sales Order → Purchase Order → GRN → Purchase Invoice
  //   Both start at the SALES ORDER, so the purchase row hangs off it.
  const row1Top = 40;
  const row2Top = 190;
  const x0 = 12;
  const xStep = 176;
  const twoChain = nodes.length >= 7;
  const positions = twoChain
    ? [
        // Sales chain: Customer PO → SO → DO → SI
        { left: x0 + xStep * 0, top: row1Top },
        { left: x0 + xStep * 1, top: row1Top },
        { left: x0 + xStep * 2, top: row1Top },
        { left: x0 + xStep * 3, top: row1Top },
        // Purchase chain, dropping from the SO: PO → GRN → PI
        { left: x0 + xStep * 1, top: row2Top },
        { left: x0 + xStep * 2, top: row2Top },
        { left: x0 + xStep * 3, top: row2Top },
      ]
    : [
        { left: x0 + xStep * 0, top: row1Top },
        { left: x0 + xStep * 1, top: row1Top },
        { left: x0 + xStep * 2, top: row1Top },
        { left: x0 + xStep * 2, top: row2Top },
        { left: x0 + xStep * 3, top: row2Top },
      ];

  const nodeCard = (n: ChainNode, opts: { left: number; top: number }) => {
    const cur = n.state === "current";
    const done = n.state === "done";
    // A node is tappable when the caller wired a handler AND it is not the
    // current tile (you are already there). "Actionable" is what decides it:
    // a linked document (done) opens, but a grey/pending node the builder marks
    // actionable (e.g. the PO node listing candidate POs) must tap too. The old
    // `state === "done"` test left that candidate node disabled and its
    // "N candidates — tap" action dead.
    const actionable = n.actionable ?? done;
    const linked = !!onNodeClick && !cur && actionable;
    return (
      <button
        key={n.type}
        type="button"
        onClick={() => onNodeClick?.(n)}
        disabled={!linked && n.state !== "current"}
        style={{ position: "absolute", left: opts.left, top: opts.top, width: 148 }}
        className={cn(
          "rounded-xl px-3 py-2.5 text-left transition-all",
          cur
            ? "border-2 border-accent bg-accent-soft shadow-[0_10px_22px_-12px_rgba(161,133,47,.55)]"
            : done
              ? "border border-primary/30 bg-primary-soft"
              : "border border-border bg-surface-2",
          linked
            ? "cursor-pointer hover:-translate-y-px hover:shadow-slab"
            : "cursor-default"
        )}
      >
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
              cur
                ? "bg-accent text-white"
                : done
                  ? "bg-primary text-white"
                  : "border border-border-strong bg-surface"
            )}
          >
            {cur ? "◉" : done ? "✓" : ""}
          </span>
          <span
            className={cn(
              "font-mono text-[9px] font-bold uppercase tracking-brand",
              cur ? "text-accent-ink" : done ? "text-primary-ink" : "text-ink-muted"
            )}
          >
            {n.type}
          </span>
        </div>
        <div
          className={cn(
            "mt-1.5 truncate font-mono text-[12.5px] font-bold",
            cur ? "text-accent-ink" : done ? "text-primary-ink" : "text-ink-muted"
          )}
        >
          {n.doc}
        </div>
        <div
          className={cn(
            "mt-0.5 truncate text-[10.5px]",
            cur ? "text-accent-ink/80" : "text-ink-muted"
          )}
        >
          {n.meta}
        </div>
      </button>
    );
  };

  return (
    <ModalOverlay
      open={open}
      onClose={onClose}
      title="Relationship map"
      icon={<Share2 size={16} />}
      size="lg"
    >
      <div className="mb-3 text-[12.5px] leading-relaxed text-ink-secondary">
        How this document links to its source documents and the documents
        generated downstream.
      </div>
      <div
        className="relative h-[320px] overflow-hidden rounded-xl border border-border-subtle"
        style={{
          backgroundImage:
            "radial-gradient(rgba(180, 185, 175, .45) 1px, transparent 1px)",
          backgroundSize: "16px 16px",
          backgroundColor: "var(--surface, #fbfcfa)",
        }}
      >
        <span className="absolute left-3 top-2 font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
          {rowLabels?.primary ?? (twoChain ? "Sales chain" : "Upstream")}
        </span>
        <span
          className="absolute font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted"
          style={twoChain ? { left: x0 + xStep, top: 168 } : { left: 360, top: 168 }}
        >
          {rowLabels?.secondary ?? (twoChain ? "Purchase chain" : "Generated after delivery")}
        </span>

        <svg
          width="100%"
          height="100%"
          className="pointer-events-none absolute inset-0"
          preserveAspectRatio="none"
        >
          <line
            x1={x0 + 150}
            y1={row1Top + 42}
            x2={x0 + xStep}
            y2={row1Top + 42}
            stroke="var(--primary, #16695f)"
            strokeWidth="2"
            markerEnd="url(#arrowP)"
          />
          <line
            x1={x0 + xStep + 150}
            y1={row1Top + 42}
            x2={x0 + xStep * 2}
            y2={row1Top + 42}
            stroke="var(--primary, #16695f)"
            strokeWidth="2"
            markerEnd="url(#arrowP)"
          />
          {/* 7-node only: DO → Sales Invoice closes the SALES row. */}
          {twoChain && (
            <line
              x1={x0 + xStep * 2 + 150}
              y1={row1Top + 42}
              x2={x0 + xStep * 3}
              y2={row1Top + 42}
              stroke="var(--primary, #16695f)"
              strokeWidth="2"
              markerEnd="url(#arrowP)"
            />
          )}
          {/* Branch drop: 7-node hangs the PURCHASE row off the SO (col 1);
              5-node keeps the original drop off the DO (col 2). */}
          <line
            x1={x0 + xStep * (twoChain ? 1 : 2) + 74}
            y1={row1Top + 88}
            x2={x0 + xStep * (twoChain ? 1 : 2) + 74}
            y2={row2Top}
            stroke="var(--border-strong, #b3b8ac)"
            strokeWidth="2"
            strokeDasharray="4 4"
            markerEnd="url(#arrowM)"
          />
          {/* 7-node only: PO → GRN (the 5-node shape has nothing at col 1). */}
          {twoChain && (
            <line
              x1={x0 + xStep + 148}
              y1={row2Top + 40}
              x2={x0 + xStep * 2}
              y2={row2Top + 40}
              stroke="var(--border-strong, #b3b8ac)"
              strokeWidth="2"
              strokeDasharray="4 4"
              markerEnd="url(#arrowM)"
            />
          )}
          {/* Last hop of the bottom row — GRN → PI (7-node) / GRN → SI (5). */}
          <line
            x1={x0 + xStep * 2 + 148}
            y1={row2Top + 40}
            x2={x0 + xStep * 3}
            y2={row2Top + 40}
            stroke="var(--border-strong, #b3b8ac)"
            strokeWidth="2"
            strokeDasharray="4 4"
            markerEnd="url(#arrowM)"
          />
          <defs>
            <marker
              id="arrowP"
              markerWidth="7"
              markerHeight="7"
              refX="6"
              refY="3.5"
              orient="auto"
              markerUnits="strokeWidth"
            >
              <path d="M0,0 L7,3.5 L0,7 z" fill="var(--primary, #16695f)" />
            </marker>
            <marker
              id="arrowM"
              markerWidth="7"
              markerHeight="7"
              refX="6"
              refY="3.5"
              orient="auto"
              markerUnits="strokeWidth"
            >
              <path d="M0,0 L7,3.5 L0,7 z" fill="var(--border-strong, #b3b8ac)" />
            </marker>
          </defs>
        </svg>

        {nodes.slice(0, positions.length).map((n, i) => nodeCard(n, positions[i]!))}
      </div>

      {/* Amendments branch off the Sales Order — revision requests are real
          documents, so they get their own labelled row of clickable chips
          rather than being hidden. Rendered only when the caller supplies them
          (the SO map does; the DO / SI / DR maps do not). */}
      {amendments && amendments.length > 0 && (
        <div className="mt-3 rounded-xl border border-border-subtle bg-surface-2 px-3 py-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
            <Share2 size={11} />
            {amendmentsLabel ?? "Amendments off the Sales Order"}
          </div>
          <div className="flex flex-wrap gap-2">
            {amendments.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => onAmendmentClick?.(a)}
                disabled={!onAmendmentClick}
                className={cn(
                  "rounded-lg border border-accent/30 bg-accent-soft px-3 py-2 text-left transition-all",
                  onAmendmentClick
                    ? "cursor-pointer hover:-translate-y-px hover:shadow-slab"
                    : "cursor-default"
                )}
              >
                <div className="font-mono text-[9px] font-bold uppercase tracking-brand text-accent-ink">
                  Amendment
                </div>
                <div className="mt-1 truncate font-mono text-[12.5px] font-bold text-accent-ink">
                  {a.label}
                </div>
                {a.status && (
                  <div className="mt-0.5 truncate text-[10.5px] text-accent-ink/80">
                    {humaniseAmendmentStatus(a.status)}
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-primary" /> Linked
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-accent" /> Current
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full border border-border-strong bg-surface" />{" "}
          Pending
        </span>
      </div>
    </ModalOverlay>
  );
}
