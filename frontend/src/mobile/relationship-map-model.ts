// Pure render model for the MOBILE Relationship Map (the phone twin of the
// desktop DocumentFlowModal / DocumentRelationshipMapModal, PR #1676).
//
// A phone cannot host the desktop's SVG stage-column canvas, so the mobile
// idiom is a STACKED chain list: the sales chain and the procurement chain
// each render as stage-ordered card groups joined by solid connectors, and
// the SO ▸ PO hop between them renders as explicit pairing rows. The three
// edge identities of the "soft until DO, hard from DO" Decision
// (docs/modules/document-traceability.md §2.10) keep the SAME language as
// the desktop maps — keep the wording constants below in lockstep with
// vendor/scm/components/DocumentFlowModal.tsx:
//   chain      — vertical execution FKs. Solid; anchored history.
//   provenance — the stored SO ▸ PO raise-link. Muted; "Bought for".
//   floating   — the live pre-DO MRP pairing, CLIENT-ASSEMBLED from the
//                po-so-coverage response via the SAME pinned
//                buildFloatingOverlay every desktop canvas merges (one-engine
//                symmetry; flow-floating-overlay.test.ts). Dashed + "~".
//
// Everything here is pure and side-effect free so the mapping is unit-testable
// (relationship-map-model.test.ts) without React or the network.

import {
  buildFloatingOverlay,
  type FlowAmendment,
  type FlowEdge,
  type FlowNode,
  type FlowNodeType,
  type PoFlowAmendment,
  type PoSoCoverageResp,
} from "../vendor/scm/lib/flow-queries";

/* Identity wording — MUST match the desktop maps verbatim (one-product rule).
   Desktop sources: DocumentFlowModal.tsx PROVENANCE_TITLE / FLOATING_TITLE and
   the legend labels; DocumentRelationshipMapModal.tsx pairingTitle. */
export const PROVENANCE_TITLE = "Bought for — procurement provenance";
export const FLOATING_TITLE = "Live MRP pairing — recomputed on every view; may change";
export const PROVENANCE_LEGEND = "Bought for (provenance)";
export const FLOATING_LEGEND = "Live MRP pairing (floating)";
export const CHAIN_LEGEND = "Executed chain (anchored history)";

/* Where a tapped node goes on the phone. `so` is the dedicated MobileSODetail
   screen (keyed by doc_no — document-flow returns doc_no as the SO node id);
   everything else is the generic module-detail screen keyed by uuid. A node
   type with no mobile screen (AR payment) maps to null and renders inert. */
export type FlowDocNav =
  | { kind: "so"; docNo: string }
  | { kind: "module"; moduleKey: string; id: string };

/** The navigation bundle the shell (MobileApp) provides: `can` answers whether
 *  this user's position may open the destination (the same nav gate the menu
 *  rows use — fails closed), `open` performs the screen switch. */
export type FlowNav = {
  can: (nav: FlowDocNav) => boolean;
  open: (nav: FlowDocNav) => void;
};

export type MobileMapCard = {
  key: string;
  type: FlowNodeType;
  /** Stage title, mirroring the desktop TYPE_META titles. */
  title: string;
  label: string;
  status: string | null;
  isAnchor: boolean;
  cancelled: boolean;
  /** Exists ONLY through the floating overlay (nothing stored) — dashed + "~". */
  floating: boolean;
  /** Chain parents' labels — named only when the parent stage holds more than
   *  one node, i.e. exactly when "which parent?" is ambiguous on a phone. */
  fromLabels: string[];
  /** Any inbound chain edge was a partial transfer. */
  partial: boolean;
  nav: FlowDocNav | null;
};

export type MobileMapPairing = {
  soDocNo: string;
  poLabel: string;
  identity: "provenance" | "floating";
  /** Navigate to the SO side of the hop (the PO side is the open document or
   *  reachable through its own card). */
  soNav: FlowDocNav | null;
};

export type MobileMapModel = {
  /** Stage-ordered card groups: sales chain (SO → DO → SI/DR → payment). */
  sales: MobileMapCard[][];
  /** Stage-ordered card groups: procurement chain (PO → GRN → PI/PR). */
  purchase: MobileMapCard[][];
  /** The SO ▸ PO hops, provenance rows first, then floating, each sorted. */
  pairings: MobileMapPairing[];
  hasContent: boolean;
};

/* Which mobile document-detail anchors offer a map. SI/DR/PR and consignment
   documents stay map-less for now, matching the shipped desktop anchor set
   (vendor RelationshipMapButton on PO/GRN/PI + the scm-v2 SO/PO/DO modals). */
export const flowAnchorForModule = (moduleKey: string): FlowNodeType | null => {
  switch (moduleKey) {
    case "mfg-purchase-orders": return "po";
    case "grns": return "grn";
    case "purchase-invoices": return "pi";
    case "delivery-orders-mfg": return "do";
    default: return null;
  }
};

/* Stage layout — mirrors the desktop TYPE_META columns, split by band. Stage
   index orders the stacked groups top-to-bottom within each chain section. */
const SALES_STAGE: Partial<Record<FlowNodeType, number>> = {
  so: 0, cso: 0,
  do: 1, cdo: 1,
  si: 2, dr: 2, cdr: 2,
  payment: 3,
};
const PURCHASE_STAGE: Partial<Record<FlowNodeType, number>> = {
  po: 0, pco: 0,
  grn: 1, pcr: 1,
  pi: 2, pr: 2, pcrn: 2,
};
const SALES_STAGES = 4;
const PURCHASE_STAGES = 3;

const TYPE_TITLE: Record<FlowNodeType, string> = {
  so: "Sales Order",
  do: "Delivery Order",
  si: "Invoice",
  payment: "AR Payment",
  po: "Purchase Order",
  grn: "Goods Receive",
  pi: "Purchase Invoice",
  dr: "Delivery Return",
  pr: "Purchase Return",
  cso: "Consignment Order",
  cdo: "Consignment Note",
  cdr: "Consignment Return",
  pco: "PC Order",
  pcr: "PC Receive",
  pcrn: "PC Return",
};

/* Node type → the generic mobile module screen that renders it (the same
   MODULE_CONFIGS keys MobileApp routes). AR payments have no screen — they
   live on their document's Payments card — so they render inert. */
const NAV_MODULE: Partial<Record<FlowNodeType, string>> = {
  do: "delivery-orders-mfg",
  si: "sales-invoices",
  po: "mfg-purchase-orders",
  grn: "grns",
  pi: "purchase-invoices",
  dr: "delivery-returns",
  pr: "purchase-returns",
  cso: "consignment-orders",
  cdo: "consignment-notes",
  cdr: "consignment-returns",
  pco: "purchase-consignment-orders",
  pcr: "purchase-consignment-receives",
  pcrn: "purchase-consignment-returns",
};

export const flowDocNav = (node: Pick<FlowNode, "type" | "id">): FlowDocNav | null => {
  if (node.type === "so") return node.id ? { kind: "so", docNo: node.id } : null;
  const moduleKey = NAV_MODULE[node.type];
  return moduleKey && node.id ? { kind: "module", moduleKey, id: node.id } : null;
};

/* The stored SO ▸ PO raise-link edge. `value` fallback: every value edge IS
   the raise-link, so an older cached response (no linkage) still reads as
   provenance, never as execution — same rule as the desktop canvases. */
const isProvenanceEdge = (e: FlowEdge): boolean =>
  e.linkage === "provenance" || (e.linkage == null && e.kind === "value");

type FlowResp = {
  nodes: FlowNode[];
  edges: FlowEdge[];
  amendments?: FlowAmendment[];
  poAmendments?: PoFlowAmendment[];
};

export function buildMobileMapModel(
  flow: FlowResp | undefined,
  coverage: PoSoCoverageResp | undefined,
): MobileMapModel {
  /* The floating hop comes from the SAME pinned overlay builder every desktop
     canvas merges — the model never re-derives "floating" from the coverage
     rows itself, so it can never disagree with the desktop maps or the
     Assigned-SO chips (one-engine symmetry). */
  const overlay = buildFloatingOverlay(flow, coverage);
  const nodes = [...(flow?.nodes ?? []), ...overlay.nodes];
  const edges = flow?.edges ?? [];
  const floatingKeys = new Set(overlay.nodes.map((n) => n.key));
  const byKey = new Map(nodes.map((n) => [n.key, n]));

  /* Stage groups. A node type in neither band (unknown future type) is
     dropped rather than mis-shelved. */
  const sales: MobileMapCard[][] = Array.from({ length: SALES_STAGES }, () => []);
  const purchase: MobileMapCard[][] = Array.from({ length: PURCHASE_STAGES }, () => []);
  const stageOf = new Map<string, { band: "sales" | "purchase"; stage: number }>();
  for (const n of nodes) {
    const sStage = SALES_STAGE[n.type];
    const pStage = PURCHASE_STAGE[n.type];
    if (sStage != null) stageOf.set(n.key, { band: "sales", stage: sStage });
    else if (pStage != null) stageOf.set(n.key, { band: "purchase", stage: pStage });
  }

  /* Chain parents per node — stored edges only, EXCLUDING the SO ▸ PO hop
     (that is the pairing section, never a vertical connector), and only
     within one band: every non-provenance edge is intra-band by construction
     (document-flow stamps 'provenance' at the one SO→PO callsite). */
  const chainParents = new Map<string, FlowNode[]>();
  const partialInto = new Set<string>();
  for (const e of edges) {
    if (isProvenanceEdge(e)) continue;
    const from = byKey.get(e.from);
    if (!from || !byKey.has(e.to)) continue;
    const list = chainParents.get(e.to) ?? [];
    list.push(from);
    chainParents.set(e.to, list);
    if (e.kind === "partial") partialInto.add(e.to);
  }

  /* Group sizes first (fromLabels needs "is the parent stage ambiguous"). */
  const groupCount = new Map<string, number>(); // `${band}:${stage}` → node count
  for (const { band, stage } of stageOf.values()) {
    const k = `${band}:${stage}`;
    groupCount.set(k, (groupCount.get(k) ?? 0) + 1);
  }

  for (const n of nodes) {
    const slot = stageOf.get(n.key);
    if (!slot) continue;
    const parents = chainParents.get(n.key) ?? [];
    const ambiguous = parents.some((p) => {
      const ps = stageOf.get(p.key);
      return !!ps && (groupCount.get(`${ps.band}:${ps.stage}`) ?? 0) > 1;
    });
    const card: MobileMapCard = {
      key: n.key,
      type: n.type,
      title: TYPE_TITLE[n.type],
      label: n.label,
      status: n.status,
      isAnchor: n.isAnchor,
      cancelled: (n.status ?? "").toUpperCase() === "CANCELLED",
      floating: floatingKeys.has(n.key),
      fromLabels: ambiguous ? parents.map((p) => p.label).sort() : [],
      partial: partialInto.has(n.key),
      nav: flowDocNav(n),
    };
    (slot.band === "sales" ? sales : purchase)[slot.stage].push(card);
  }
  for (const g of sales) g.sort((a, b) => a.label.localeCompare(b.label));
  for (const g of purchase) g.sort((a, b) => a.label.localeCompare(b.label));

  /* The SO ▸ PO hops. Provenance rows come from the stored graph; floating
     rows are EXACTLY the overlay's edge set. A pair can legitimately appear
     under both identities (a stored link on one SKU, a live MRP pairing on
     another) — the desktop draws both edges too, so both rows stay. */
  const pairings: MobileMapPairing[] = [];
  const seen = new Set<string>();
  const pushPairing = (fromKey: string, toKey: string, identity: "provenance" | "floating") => {
    const so = byKey.get(fromKey);
    const po = byKey.get(toKey);
    if (!so || !po) return;
    const dedupe = `${identity}|${so.label}|${po.label}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    pairings.push({ soDocNo: so.label, poLabel: po.label, identity, soNav: flowDocNav(so) });
  };
  for (const e of edges) {
    if (isProvenanceEdge(e)) pushPairing(e.from, e.to, "provenance");
  }
  for (const e of overlay.edges) pushPairing(e.from, e.to, "floating");
  pairings.sort((a, b) =>
    a.identity === b.identity
      ? a.soDocNo.localeCompare(b.soDocNo) || a.poLabel.localeCompare(b.poLabel)
      : a.identity === "provenance" ? -1 : 1);

  return {
    sales: sales.filter((g) => g.length > 0),
    purchase: purchase.filter((g) => g.length > 0),
    pairings,
    hasContent: nodes.length > 0,
  };
}
