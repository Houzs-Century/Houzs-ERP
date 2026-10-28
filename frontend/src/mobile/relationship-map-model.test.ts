// The mobile Relationship Map's pure render model. The load-bearing
// assertions: (1) the FLOATING pairing rows equal EXACTLY the coverage
// assignments with source 'mrp' — the model delegates to the SAME pinned
// buildFloatingOverlay the desktop canvases merge, so the phone can never
// disagree with the desktop maps or the Assigned-SO chips (one-engine
// symmetry); (2) the stored SO ▸ PO raise-link renders as PROVENANCE, never
// as an execution hop, including the kind-'value' fallback for an older
// cached response; (3) the identity wording matches the desktop verbatim.

import { describe, expect, it } from "vitest";
import type { FlowEdge, FlowNode, PoSoCoverageResp } from "../vendor/scm/lib/flow-queries";
import {
  buildMobileMapModel,
  flowAnchorForModule,
  flowDocNav,
  FLOATING_TITLE,
  PROVENANCE_TITLE,
} from "./relationship-map-model";

const node = (type: FlowNode["type"], id: string, over: Partial<FlowNode> = {}): FlowNode => ({
  key: `${type}:${id}`, type, id, label: over.label ?? id, status: "CONFIRMED", isAnchor: false, ...over,
});
const edge = (from: string, to: string, over: Partial<FlowEdge> = {}): FlowEdge => ({
  from, to, kind: "full", ...over,
});
const coverage = (over: Partial<PoSoCoverageResp>): PoSoCoverageResp => ({
  poNumber: "PO-1", poId: "po-1", origins: [], ...over,
});

describe("identity wording (one-product rule — lockstep with the desktop maps)", () => {
  it("matches the desktop tooltip strings verbatim", () => {
    expect(PROVENANCE_TITLE).toBe("Bought for — procurement provenance");
    expect(FLOATING_TITLE).toBe("Live MRP pairing — recomputed on every view; may change");
  });
});

describe("flowAnchorForModule (which mobile details offer a map)", () => {
  it("maps the four document modules and nothing else", () => {
    expect(flowAnchorForModule("mfg-purchase-orders")).toBe("po");
    expect(flowAnchorForModule("grns")).toBe("grn");
    expect(flowAnchorForModule("purchase-invoices")).toBe("pi");
    expect(flowAnchorForModule("delivery-orders-mfg")).toBe("do");
    expect(flowAnchorForModule("sales-invoices")).toBeNull();
    expect(flowAnchorForModule("inventory")).toBeNull();
  });
});

describe("flowDocNav (where a tapped node goes)", () => {
  it("routes an SO to the dedicated SO detail by doc_no", () => {
    expect(flowDocNav({ type: "so", id: "SO-2607-001" })).toEqual({ kind: "so", docNo: "SO-2607-001" });
  });
  it("routes document types to their generic module screens by uuid", () => {
    expect(flowDocNav({ type: "po", id: "u1" })).toEqual({ kind: "module", moduleKey: "mfg-purchase-orders", id: "u1" });
    expect(flowDocNav({ type: "grn", id: "u2" })).toEqual({ kind: "module", moduleKey: "grns", id: "u2" });
    expect(flowDocNav({ type: "dr", id: "u3" })).toEqual({ kind: "module", moduleKey: "delivery-returns", id: "u3" });
  });
  it("renders AR payments inert (no mobile screen exists)", () => {
    expect(flowDocNav({ type: "payment", id: "u9" })).toBeNull();
  });
});

describe("buildMobileMapModel — chains", () => {
  const flow = {
    nodes: [
      node("so", "SO-1"),
      node("do", "d1", { label: "DO-1" }),
      node("do", "d2", { label: "DO-2" }),
      node("si", "s1", { label: "INV-1" }),
      node("payment", "pay1", { label: "PAY-1", status: null }),
      node("po", "p1", { label: "PO-1", isAnchor: true }),
      node("grn", "g1", { label: "GRN-1", status: "CANCELLED" }),
    ],
    edges: [
      edge("so:SO-1", "do:d1", { linkage: "chain" }),
      edge("so:SO-1", "do:d2", { kind: "partial", linkage: "chain" }),
      edge("do:d1", "si:s1", { linkage: "chain" }),
      edge("si:s1", "payment:pay1", { kind: "payment", linkage: "chain" }),
      edge("so:SO-1", "po:p1", { kind: "value", linkage: "provenance" }),
      edge("po:p1", "grn:g1", { linkage: "chain" }),
    ],
  };

  it("stacks each band in stage order and drops empty stages", () => {
    const m = buildMobileMapModel(flow, undefined);
    expect(m.sales.map((g) => g.map((c) => c.label))).toEqual([
      ["SO-1"], ["DO-1", "DO-2"], ["INV-1"], ["PAY-1"],
    ]);
    expect(m.purchase.map((g) => g.map((c) => c.label))).toEqual([["PO-1"], ["GRN-1"]]);
    expect(m.hasContent).toBe(true);
  });

  it("the SO ▸ PO raise-link is a pairing, never a vertical connector parent", () => {
    const m = buildMobileMapModel(flow, undefined);
    const po = m.purchase[0][0];
    expect(po.fromLabels).toEqual([]); // its only inbound edge is the provenance hop
    expect(m.pairings).toEqual([
      { soDocNo: "SO-1", poLabel: "PO-1", identity: "provenance", soNav: { kind: "so", docNo: "SO-1" } },
    ]);
  });

  it("marks anchor / cancelled and the partial transfer flag", () => {
    const m = buildMobileMapModel(flow, undefined);
    expect(m.purchase[0][0].isAnchor).toBe(true);
    expect(m.purchase[1][0].cancelled).toBe(true);
    const do2 = m.sales[1].find((c) => c.label === "DO-2")!;
    expect(do2.partial).toBe(true);
  });

  it("names chain parents only when the parent stage is ambiguous (>1 node)", () => {
    const m = buildMobileMapModel(flow, undefined);
    // DO's parent stage holds a single SO — unambiguous, no caption.
    expect(m.sales[1].every((c) => c.fromLabels.length === 0)).toBe(true);
    // The SI hangs off one of TWO DOs — its parent must be named.
    expect(m.sales[2][0].fromLabels).toEqual(["DO-1"]);
  });

  it("treats a kind-'value' edge with no linkage (older backend) as provenance", () => {
    const legacy = {
      nodes: [node("so", "SO-1"), node("po", "p1", { label: "PO-1" })],
      edges: [edge("so:SO-1", "po:p1", { kind: "value" as const })],
    };
    const m = buildMobileMapModel(legacy, undefined);
    expect(m.pairings.map((p) => p.identity)).toEqual(["provenance"]);
  });

  it("is empty-safe on missing input", () => {
    const m = buildMobileMapModel(undefined, undefined);
    expect(m.sales).toEqual([]);
    expect(m.purchase).toEqual([]);
    expect(m.pairings).toEqual([]);
    expect(m.hasContent).toBe(false);
  });
});

describe("buildMobileMapModel — the floating overlay (one-engine symmetry)", () => {
  const flow = {
    nodes: [node("po", "po-1", { label: "PO-1", isAnchor: true })],
    edges: [] as FlowEdge[],
  };
  const cov = coverage({
    origins: [
      { itemCode: "A", assignments: [
        { soDocNo: "SO-7", deliveryDate: null, locked: false, source: "mrp" },
        { soDocNo: "SO-8", deliveryDate: null, locked: true, source: "linked" },
        { soDocNo: "SO-9", deliveryDate: null, locked: true, source: "delivered" },
      ] },
    ],
  });

  it("floats EXACTLY the source:'mrp' assignments — linked/delivered never float", () => {
    const m = buildMobileMapModel(flow, cov);
    expect(m.pairings).toEqual([
      { soDocNo: "SO-7", poLabel: "PO-1", identity: "floating", soNav: { kind: "so", docNo: "SO-7" } },
    ]);
  });

  it("synthesises the floating SO as a dashed sales-chain card, still navigable", () => {
    const m = buildMobileMapModel(flow, cov);
    expect(m.sales).toHaveLength(1);
    const soCard = m.sales[0][0];
    expect(soCard.label).toBe("SO-7");
    expect(soCard.floating).toBe(true);
    expect(soCard.nav).toEqual({ kind: "so", docNo: "SO-7" });
    // The stored graph's own PO is untouched by the overlay.
    expect(m.purchase[0][0].floating).toBe(false);
  });

  it("never floats an unlabelled locked:false assignment (older backend)", () => {
    const legacyCov = coverage({
      origins: [{ itemCode: "A", assignments: [{ soDocNo: "SO-7", deliveryDate: null, locked: false }] }],
    });
    const m = buildMobileMapModel(flow, legacyCov);
    expect(m.pairings).toEqual([]);
    expect(m.sales).toEqual([]);
  });

  it("keeps a pair that is BOTH stored-provenance and floating as two rows, provenance first", () => {
    const both = {
      nodes: [node("so", "SO-7"), node("po", "po-1", { label: "PO-1", isAnchor: true })],
      edges: [edge("so:SO-7", "po:po-1", { kind: "value" as const, linkage: "provenance" as const })],
    };
    const m = buildMobileMapModel(both, cov);
    expect(m.pairings.map((p) => `${p.identity}:${p.soDocNo}`)).toEqual([
      "provenance:SO-7",
      "floating:SO-7",
    ]);
  });

  it("without coverage (an SO or DO anchor) no floating row ever appears", () => {
    const m = buildMobileMapModel(flow, undefined);
    expect(m.pairings).toEqual([]);
  });
});
