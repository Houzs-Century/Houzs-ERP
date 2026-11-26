// Pure render model for the MOBILE Relationship Map (the phone twin of the
// desktop DocumentFlowModal / DocumentRelationshipMapModal, PR #1676).
//
// A phone cannot host the desktop's SVG stage-column canvas, so the mobile
// idiom is a STACKED chain list: the sales chain and the procurement chain
// each render as stage-ordered card groups joined by solid connectors, and
// the SO ▸ PO hop between them renders as explicit pairing rows. The three
// edge identities of the "soft until DO, hard from DO" Decision
// (docs/modules/document-traceability.md §2.11) keep the SAME language as
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

export const PROVENANCE_TITLE = "Bought for — procurement provenance";
export const FLOATING_TITLE = "Live MRP pairing — recomputed on every view; may change";
export const PROVENANCE_LEGEND = "Bought for (provenance)";
export const FLOATING_LEGEND = "Live MRP pairing (floating)";
export const CHAIN_LEGEND = "Executed chain (anchored history)";

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
  title: string;
  label: string;
  status: string | null;
  isAnchor: boolean;
  cancelled: boolean;
  floating: boolean;
  fromLabels: string[];
  partial: boolean;
  nav: FlowDocNav | null;
};

export type MobileMapPairing = {
  soDocNo: string;
  poLabel: string;
  identity: "provenance" | "floating";
  soNav: FlowDocNav | null;
};

export type MobileMapModel = {
  sales: MobileMapCard[][];
  purchase: MobileMapCard[][];
  pairings: MobileMapPairing[];
  hasContent: boolean;
};

export const flowAnchorForModule = (moduleKey: string): FlowNodeType | null => {
  switch (moduleKey) {
    case "mfg-purchase-orders": return "po";
    case "grns": return "grn";
    case "purchase-invoices": return "pi";
    case "delivery-orders-mfg": return "do";
    default: return null;
  }
};

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
  const overlay = buildFloatingOverlay(flow, coverage);
  const nodes = [...(flow?.nodes ?? []), ...overlay.nodes];
  const edges = flow?.edges ?? [];
  const floatingKeys = new Set(overlay.nodes.map((n) => n.key));
  const byKey = new Map(nodes.map((n) => [n.key, n]));

  const sales: MobileMapCard[][] = Array.from({ length: SALES_STAGES }, () => []);
  const purchase: MobileMapCard[][] = Array.from({ length: PURCHASE_STAGES }, () => []);
  const stageOf = new Map<string, { band: "sales" | "purchase"; stage: number }>();
  for (const n of nodes) {
    const sStage = SALES_STAGE[n.type];
    const pStage = PURCHASE_STAGE[n.type];
    if (sStage != null) stageOf.set(n.key, { band: "sales", stage: sStage });
    else if (pStage != null) stageOf.set(n.key, { band: "purchase", stage: pStage });
  }

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

  const groupCount = new Map<string, number>();
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
