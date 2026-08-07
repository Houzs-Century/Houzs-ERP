// Vendored SLICE of apps/backend/src/lib/flow-queries.ts — only the document
// relationship-map read (useDocumentFlow + its FlowNode/FlowEdge types) that
// DocumentFlowModal / RelationshipMapButton render on the PO detail page.
//
// The full source module is ~1996 lines (the entire SO/DO/SI/PO/GRN/PI/return
// query surface + verified-save + supabase + serviceNotify). None of that is
// needed for the relationship map, so it is intentionally NOT vendored. The one
// read below is copied verbatim and goes through the vendored authedFetch
// (→ /api/scm/document-flow/:type/:id).

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

/* ── Document relationship map (SAP-style flow diagram) ─────────────────── */
export type FlowNodeType =
  | 'so' | 'do' | 'si' | 'payment' | 'po' | 'grn' | 'pi' | 'dr' | 'pr'
  | 'cso' | 'cdo' | 'cdr' | 'pco' | 'pcr' | 'pcrn';
export type FlowEdgeKind = 'full' | 'partial' | 'value' | 'payment';
/* "Soft until DO, hard from DO" (owner 2026-08-06): every stored edge is either
   a vertical execution FK ('chain' — anchored history, solid) or the SO ▶ PO
   raise-link ('provenance' — why we bought, binds no execution; muted).
   Optional so a response from an older backend degrades to the kind colours. */
export type FlowEdgeLinkage = 'chain' | 'provenance';
export type FlowNode = {
  key: string;
  type: FlowNodeType;
  id: string;
  label: string;
  status: string | null;
  isAnchor: boolean;
};
export type FlowEdge = { from: string; to: string; kind: FlowEdgeKind; linkage?: FlowEdgeLinkage };
// SO amendments (revision requests) hang off the Sales Order. The backend
// returns them as a read-only side list, not graph nodes, so the relationship
// map can branch them off the SO — each clickable to /scm/amendments/:id.
export type FlowAmendment = {
  id: string;
  soDocNo: string;
  amendmentNo: number | string;
  status: string | null;
  createdAt: string | null;
};
// PO amendments (mig 0192) branch off the Purchase Order node — the PO-side
// sibling of FlowAmendment, each clickable to /scm/po-amendments/:id.
export type PoFlowAmendment = {
  id: string;
  poId: string;
  poNumber: string;
  amendmentNo: number | string;
  status: string | null;
  createdAt: string | null;
};

export const useDocumentFlow = (type: FlowNodeType | null, id: string | null) =>
  useQuery({
    queryKey: ['document-flow', type, id],
    queryFn: () => authedFetch<{ nodes: FlowNode[]; edges: FlowEdge[]; rootSos: string[]; amendments?: FlowAmendment[]; poAmendments?: PoFlowAmendment[] }>(
      `/document-flow/${type}/${encodeURIComponent(id!)}`,
    ),
    enabled: Boolean(type && id),
    staleTime: 30_000,
    retry: retryUnlessClientError,
  });

/* ── "Assigned Sales Order" for a purchase document, PER SKU ───────────────
   Resolved by PRECEDENCE on the backend (one MRP engine, symmetric with the SO
   detail's Assigned-PO): (a) DELIVERED → DO-locked SO (static) > (b) the STORED
   origin the PO was RAISED from — so_item_id ∪ "From SOs: …" note (static) >
   (c) live MRP FLOATING coverage matched by SKU (floating) > (d) none → dash.
   Each assignment carries that SO's effective delivery date (amended ?? customer)
   and `locked`: true = STATIC (delivered or a stored raise-link), false = the
   FLOATING MRP coverage (shifts as demand moves, evaporates on delivery). This
   is the exact reverse of the SO detail's covering-PO, so SO→PO and PO→SO can
   never disagree. Backend: GET /po-so-coverage/:type/:id. */
export type OriginAssignment = {
  soDocNo: string;
  deliveryDate: string | null;
  locked?: boolean;
  /* WHY this row exists: 'delivered' (the goods shipped to that SO), 'linked'
     (a stored purchase_order_items.so_item_id / "From SOs" note) or 'mrp' (a
     live allocation only). Absent on responses from an older backend. */
  source?: 'delivered' | 'linked' | 'mrp';
};
/* `storedLink` — do this SKU's PO lines actually carry a stored so_item_id?
   Separate from the assignments on purpose: a SKU can show an MRP-derived SO
   while nothing in the database binds it, and reading that as a binding is the
   2026-07-29 incident. Optional so an older backend degrades to "unknown". */
export type SkuOrigin = { itemCode: string; assignments: OriginAssignment[]; storedLink?: boolean };
/* "Delivered" — the FORWARD companion of the delivered-lock: which Delivery
   Order(s) have shipped this purchase doc's goods (batch_no = the PO number) and
   how many units per DO. Cancelled DOs excluded. Optional so an older backend
   degrades to "unknown" (no column). */
/* soDocNo (2026-08-02): the Sales Order the DO belongs to — pairs each
   delivered chip with its Assigned-SO row in the drill's per-SO sub-table.
   Optional so an older backend degrades to unpaired chips. */
export type DeliveredDo = { doNo: string; qty: number; soDocNo?: string | null };
export type SkuDelivered = { itemCode: string; dos: DeliveredDo[] };
export type PoSoCoverageResp = {
  poNumber: string | null;
  poId: string | null;
  origins: SkuOrigin[];
  delivered?: SkuDelivered[];
};

export const usePoSoCoverage = (type: 'po' | 'grn' | 'pi' | null, id: string | null) =>
  useQuery({
    queryKey: ['po-so-coverage', type, id],
    queryFn: () => authedFetch<PoSoCoverageResp>(
      `/po-so-coverage/${type}/${encodeURIComponent(id!)}`,
    ),
    enabled: Boolean(type && id),
    staleTime: 30_000,
    retry: retryUnlessClientError,
  });

/* Build a per-SKU lookup (material_code → assignments) from the response, so a
   line table can resolve each row's Assigned SO by its code. Null-safe. */
export const originsByCode = (resp: PoSoCoverageResp | undefined): Map<string, OriginAssignment[]> => {
  const m = new Map<string, OriginAssignment[]>();
  for (const o of resp?.origins ?? []) {
    if (o.itemCode) m.set(o.itemCode, o.assignments ?? []);
  }
  return m;
};

/* Build a per-SKU lookup (material_code → delivered DOs) from the response, so a
   drill-down line can resolve its Delivered cell by item code. Null-safe. */
export const deliveredByCode = (resp: PoSoCoverageResp | undefined): Map<string, DeliveredDo[]> => {
  const m = new Map<string, DeliveredDo[]>();
  for (const d of resp?.delivered ?? []) {
    if (d.itemCode) m.set(d.itemCode, d.dos ?? []);
  }
  return m;
};

/* The SKUs whose PO lines carry a REAL stored so_item_id. Everything else that
   shows an Assigned SO is showing an MRP allocation, which moves and can
   evaporate — the two must not read the same on screen. */
export const storedLinkSkus = (resp: PoSoCoverageResp | undefined): Set<string> => {
  const s = new Set<string>();
  for (const o of resp?.origins ?? []) {
    if (o.itemCode && o.storedLink) s.add(o.itemCode);
  }
  return s;
};

/* ── Floating PO↔SO pairing overlay ("soft until DO, hard from DO") ────────
   The pre-DO pairing between a purchase doc and the Sales Orders MRP currently
   assigns it to is FLOATING — recomputed on every view, may change ("会跳动").
   It is deliberately NOT part of the stored /document-flow graph: the overlay
   is assembled CLIENT-SIDE from the po-so-coverage response the opening page
   already fetched (react-query cache + the backend path-cache dedupe it), so
   rendering it adds ZERO backend load (owner constraint — never add a
   computeMrp call to document-flow, never poll).

   One-engine symmetry: the floating edge set equals EXACTLY the coverage
   assignments whose `source` is 'mrp' — the same single computeMrp allocation
   the SO detail reads (mrpLineCoverage / mrpReverseCoverage are two directions
   of one map). A 'delivered' or 'linked' assignment is never floating; an
   assignment without `source` (older backend) is not guessed at. */
export const floatingSoDocNos = (resp: PoSoCoverageResp | undefined): string[] => {
  const docs = new Set<string>();
  for (const o of resp?.origins ?? []) {
    for (const a of o.assignments ?? []) {
      if (a.source === 'mrp' && a.soDocNo) docs.add(a.soDocNo);
    }
  }
  return [...docs];
};

/* What the canvas merges over the stored graph: the floating SO ▶ PO edges,
   plus synthesised nodes for any endpoint the stored graph does not carry (an
   MRP-paired SO is usually NOT in the graph — that is the point: nothing is
   stored). Pure; safe on undefined inputs. */
export type FloatingOverlay = {
  nodes: FlowNode[];
  edges: Array<{ from: string; to: string }>;
};
export const buildFloatingOverlay = (
  flow: { nodes: FlowNode[] } | undefined,
  coverage: PoSoCoverageResp | undefined,
): FloatingOverlay => {
  const poId = coverage?.poId;
  if (!poId) return { nodes: [], edges: [] };
  const soDocs = floatingSoDocNos(coverage);
  if (soDocs.length === 0) return { nodes: [], edges: [] };
  const have = new Set((flow?.nodes ?? []).map((n) => n.key));
  const poKey = `po:${poId}`;
  const nodes: FlowNode[] = [];
  if (!have.has(poKey)) {
    nodes.push({ key: poKey, type: 'po', id: poId, label: coverage?.poNumber ?? poId, status: null, isAnchor: false });
  }
  for (const doc of soDocs) {
    const k = `so:${doc}`;
    if (!have.has(k)) nodes.push({ key: k, type: 'so', id: doc, label: doc, status: null, isAnchor: false });
  }
  return { nodes, edges: soDocs.map((doc) => ({ from: `so:${doc}`, to: poKey })) };
};

/* Advisory candidate POs for an SO with NO linked purchase leg (pre-MRP orders,
   see the backend route). Read-only: matched by material_code, never a stored
   link. Pass a null docNo to disable — the map only asks when its PO node is
   empty, so a normal linked SO never fires this request. */
export type CandidatePo = { id: string; poNumber: string; status: string | null; poDate: string | null };
export const useCandidatePos = (soDocNo: string | null) =>
  useQuery({
    queryKey: ['candidate-pos', soDocNo],
    queryFn: () => authedFetch<{ candidates: CandidatePo[] }>(
      `/document-flow/candidate-pos/${encodeURIComponent(soDocNo!)}`,
    ),
    enabled: Boolean(soDocNo),
    staleTime: 30_000,
    retry: retryUnlessClientError,
  });
