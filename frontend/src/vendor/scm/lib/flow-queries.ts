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
export type FlowNode = {
  key: string;
  type: FlowNodeType;
  id: string;
  label: string;
  status: string | null;
  isAnchor: boolean;
};
export type FlowEdge = { from: string; to: string; kind: FlowEdgeKind };
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

export const useDocumentFlow = (type: FlowNodeType | null, id: string | null) =>
  useQuery({
    queryKey: ['document-flow', type, id],
    queryFn: () => authedFetch<{ nodes: FlowNode[]; edges: FlowEdge[]; rootSos: string[]; amendments?: FlowAmendment[] }>(
      `/document-flow/${type}/${encodeURIComponent(id!)}`,
    ),
    enabled: Boolean(type && id),
    staleTime: 30_000,
    retry: retryUnlessClientError,
  });

/* ── Real "assigned Sales Order" for a purchase document, PER SKU ──────────
   The STORED origin: which Sales Order each PO / GRN / PI line was RAISED from
   (purchase_order_items.so_item_id ∪ the PO's "From SOs: …" note), matched BY
   SKU, plus that SO's effective delivery date (amended ?? customer). A REAL
   document link, not an advisory pool — a line with no origin returns no
   assignment and the UI renders a dash. Backend: GET /po-so-coverage/:type/:id. */
export type OriginAssignment = { soDocNo: string; deliveryDate: string | null };
export type SkuOrigin = { itemCode: string; assignments: OriginAssignment[] };
export type PoSoCoverageResp = { poNumber: string | null; poId: string | null; origins: SkuOrigin[] };

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
