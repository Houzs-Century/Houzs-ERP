
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Share2, X as XIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { useEscapeLayer } from "../../lib/escapeStack";

export type ChainNodeState = "done" | "current" | "pending";

export type ChainNode = {
  type: string;
  doc: string;
  meta: string;
  state: ChainNodeState;
  href?: string;
  actionable?: boolean;
  float?: boolean;
};

// How the SO↔PO hop on this chain is paired (the horizontal pairing the
// "soft until DO, hard from DO" model distinguishes from vertical execution):
//   provenance — a STORED raise-link (so_item_id / "From SOs:" note). Muted
//                solid: why we bought, not an execution binding.
//   floating   — the live MRP pairing, recomputed per open ("会跳动").
//                Dashed + pulsing.
// Omitted → the legacy neutral connectors (the sales-side DO/SI/DR maps).
export type PairingKind = "provenance" | "floating";

export type AmendmentChip = {
  id: string;
  label: string;
  status: string | null;
};

function humaniseAmendmentStatus(status: string): string {
  const s = status.trim();
  if (!s) return s;
  const spaced = s.replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}


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
  useEscapeLayer(onClose, open);
  return createPortal(
    <>
      <div
        onClick={onClose}
        aria-hidden
        className={cn(
          "fixed inset-0 z-[100] bg-ink/45 backdrop-blur-[1px] transition-opacity duration-200",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "fixed left-1/2 top-[8vh] z-[101] flex max-h-[84vh] w-[calc(100%-32px)] -translate-x-1/2 flex-col overflow-hidden rounded-2xl bg-surface shadow-slab transition-all duration-200",
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

// ─── Multi-document chooser ────────────────────────────────────────────────
//
// One slot on the chain can stand for SEVERAL real documents — an order
// purchased on two POs, received on two GRNs, billed on two invoices. Those
// used to open a notice that merely NAMED the doc numbers and told the operator
// to go find them in a list ("This order is purchased on 2990-PO-2606-017,
// 2990-PO-2606-016. Open Purchase Orders to view them."). The map's whole job is
// to be the way in, and the list it pointed at cannot even search by the source
// doc no, so the operator was left copying numbers by hand (Nico, 2026-08-03:
// "我要可以直接点开，不要只是给我单号").
//
// Every document named is now a row you click straight through to.

export type DocChoice = {
  id: string;
  label: string;
  sub?: string | null;
  to: string;
};

export type DocChoicePrompt = {
  title: string;
  intro: string;
  docs: DocChoice[];
};

export function DocumentChoiceDialog({
  prompt,
  onClose,
  onPick,
}: {
  prompt: DocChoicePrompt | null;
  onClose: () => void;
  onPick: (doc: DocChoice) => void;
}) {
  if (!prompt) return null;
  return (
    <ModalOverlay open onClose={onClose} title={prompt.title} icon={<Share2 size={16} />}>
      <div className="mb-3 text-[12.5px] leading-relaxed text-ink-secondary">
        {prompt.intro}
      </div>
      <div className="flex flex-col gap-2">
        {prompt.docs.map((d) => (
          <button
            key={d.id}
            type="button"
            onClick={() => onPick(d)}
            className="flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-3.5 py-2.5 text-left transition-all hover:-translate-y-px hover:border-primary/40 hover:shadow-slab"
          >
            <span className="min-w-0">
              <span className="block truncate font-mono text-[13px] font-bold text-primary-ink">
                {d.label}
              </span>
              {d.sub && (
                <span className="mt-0.5 block truncate text-[11px] text-ink-muted">{d.sub}</span>
              )}
            </span>
            <span aria-hidden className="shrink-0 text-[13px] text-ink-muted">
              &rsaquo;
            </span>
          </button>
        ))}
      </div>
    </ModalOverlay>
  );
}

function ChipRow({
  heading,
  kind,
  chips,
  onChipClick,
}: {
  heading: string;
  kind: string;
  chips: AmendmentChip[];
  onChipClick?: (c: AmendmentChip) => void;
}) {
  return (
    <div className="mt-3 rounded-xl border border-border-subtle bg-surface-2 px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
        <Share2 size={11} />
        {heading}
      </div>
      <div className="flex flex-wrap gap-2">
        {chips.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => onChipClick?.(a)}
            disabled={!onChipClick}
            className={cn(
              "rounded-lg border border-accent/30 bg-accent-soft px-3 py-2 text-left transition-all",
              onChipClick
                ? "cursor-pointer hover:-translate-y-px hover:shadow-slab"
                : "cursor-default"
            )}
          >
            <div className="font-mono text-[9px] font-bold uppercase tracking-brand text-accent-ink">
              {kind}
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
  );
}


export function DocumentRelationshipMapModal({
  open,
  onClose,
  nodes,
  onNodeClick,
  amendments,
  onAmendmentClick,
  rowLabels,
  amendmentsLabel,
  returns,
  onReturnClick,
  pairing,
}: {
  open: boolean;
  onClose: () => void;
  nodes: ChainNode[];
  onNodeClick?: (node: ChainNode) => void;
  amendments?: AmendmentChip[];
  onAmendmentClick?: (a: AmendmentChip) => void;
  rowLabels?: { primary: string; secondary: string };
  amendmentsLabel?: string;
  returns?: AmendmentChip[];
  onReturnClick?: (r: AmendmentChip) => void;
  pairing?: { kind: PairingKind } | null;
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
        { left: x0 + xStep * 0, top: row1Top },
        { left: x0 + xStep * 1, top: row1Top },
        { left: x0 + xStep * 2, top: row1Top },
        { left: x0 + xStep * 3, top: row1Top },
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

  const pairingKind = pairing?.kind ?? null;
  const floatingPairing = pairingKind === "floating";
  const pairingTitle = floatingPairing
    ? "Live MRP pairing — recomputed on every view; may change"
    : "Bought for — procurement provenance";
  const pairingStroke = floatingPairing ? "#a16a2e" : "var(--border-strong, #b3b8ac)";
  const pairingDash = floatingPairing ? "6 5" : undefined;
  const anchoredDash = pairingKind ? undefined : "4 4";

  const nodeCard = (n: ChainNode, opts: { left: number; top: number }) => {
    const cur = n.state === "current";
    const done = n.state === "done";
    const actionable = n.actionable ?? done;
    const linked = !!onNodeClick && !cur && actionable;
    return (
      <button
        key={n.type}
        type="button"
        onClick={() => onNodeClick?.(n)}
        disabled={!linked && n.state !== "current"}
        title={n.float ? "Live MRP pairing — recomputed on every view; may change" : undefined}
        style={{ position: "absolute", left: opts.left, top: opts.top, width: 148 }}
        className={cn(
          "rounded-xl px-3 py-2.5 text-left transition-all",
          cur
            ? "border-2 border-accent bg-accent-soft shadow-[0_10px_22px_-12px_rgba(161,133,47,.55)]"
            : done
              ? "border border-primary/30 bg-primary-soft"
              : n.float
                ? "border border-dashed border-accent/50 bg-surface-2"
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
            cur ? "text-accent-ink" : done ? "text-primary-ink" : n.float ? "text-ink-secondary" : "text-ink-muted"
          )}
        >
          {n.doc}
          {n.float && <span className="font-normal text-ink-muted">{" ~"}</span>}
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
            stroke={!twoChain && pairingKind ? pairingStroke : "var(--primary, #16695f)"}
            strokeWidth="2"
            strokeDasharray={!twoChain && pairingKind ? pairingDash : undefined}
            className={!twoChain && floatingPairing ? "animate-pulse" : undefined}
            markerEnd={!twoChain && pairingKind ? (floatingPairing ? "url(#arrowF)" : "url(#arrowM)") : "url(#arrowP)"}
            style={!twoChain && pairingKind ? { pointerEvents: "stroke" } : undefined}
          >
            {!twoChain && pairingKind && <title>{pairingTitle}</title>}
          </line>
          <line
            x1={x0 + xStep + 150}
            y1={row1Top + 42}
            x2={x0 + xStep * 2}
            y2={row1Top + 42}
            stroke="var(--primary, #16695f)"
            strokeWidth="2"
            markerEnd="url(#arrowP)"
          />
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
          <line
            x1={x0 + xStep * (twoChain ? 1 : 2) + 74}
            y1={row1Top + 88}
            x2={x0 + xStep * (twoChain ? 1 : 2) + 74}
            y2={row2Top}
            stroke={twoChain && pairingKind ? pairingStroke : "var(--border-strong, #b3b8ac)"}
            strokeWidth="2"
            strokeDasharray={twoChain ? (pairingKind ? pairingDash : "4 4") : anchoredDash}
            className={twoChain && floatingPairing ? "animate-pulse" : undefined}
            markerEnd={twoChain && floatingPairing ? "url(#arrowF)" : "url(#arrowM)"}
            style={twoChain && pairingKind ? { pointerEvents: "stroke" } : undefined}
          >
            {twoChain && pairingKind && <title>{pairingTitle}</title>}
          </line>
          {twoChain && (
            <line
              x1={x0 + xStep + 148}
              y1={row2Top + 40}
              x2={x0 + xStep * 2}
              y2={row2Top + 40}
              stroke="var(--border-strong, #b3b8ac)"
              strokeWidth="2"
              strokeDasharray={anchoredDash}
              markerEnd="url(#arrowM)"
            />
          )}
          <line
            x1={x0 + xStep * 2 + 148}
            y1={row2Top + 40}
            x2={x0 + xStep * 3}
            y2={row2Top + 40}
            stroke="var(--border-strong, #b3b8ac)"
            strokeWidth="2"
            strokeDasharray={anchoredDash}
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
            <marker
              id="arrowF"
              markerWidth="7"
              markerHeight="7"
              refX="6"
              refY="3.5"
              orient="auto"
              markerUnits="strokeWidth"
            >
              <path d="M0,0 L7,3.5 L0,7 z" fill="#a16a2e" />
            </marker>
          </defs>
        </svg>

        {nodes.slice(0, positions.length).map((n, i) => nodeCard(n, positions[i]!))}
      </div>

      {amendments && amendments.length > 0 && (
        <ChipRow
          heading={amendmentsLabel ?? "Amendments off the Sales Order"}
          kind="Amendment"
          chips={amendments}
          onChipClick={onAmendmentClick}
        />
      )}

      {returns && returns.length > 0 && (
        <ChipRow
          heading="Returned off the Delivery Order"
          kind="Delivery Return"
          chips={returns}
          onChipClick={onReturnClick}
        />
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
        {pairingKind && (
          <span className="inline-flex items-center gap-1.5" title={pairingTitle}>
            <span
              className="inline-block h-0 w-5"
              style={{
                borderTop: floatingPairing ? "2px dashed #a16a2e" : "2px solid #b3b8ac",
              }}
            />
            {floatingPairing
              ? "Floating SO pairing — live MRP, recomputed each view"
              : "SO link — procurement provenance, not execution"}
          </span>
        )}
      </div>
    </ModalOverlay>
  );
}
