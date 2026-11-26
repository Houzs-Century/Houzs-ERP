
import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

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
export type FlowAmendment = {
  id: string;
  soDocNo: string;
  amendmentNo: number | string;
  status: string | null;
  createdAt: string | null;
};
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

export type OriginAssignment = {
  soDocNo: string;
  deliveryDate: string | null;
  locked?: boolean;
  source?: 'delivered' | 'linked' | 'mrp';
};
export type SkuOrigin = {
  itemCode: string;
  assignments: OriginAssignment[];
  storedLink?: boolean;
  provenance?: OriginAssignment[];
};
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

export const originsByCode = (resp: PoSoCoverageResp | undefined): Map<string, OriginAssignment[]> => {
  const m = new Map<string, OriginAssignment[]>();
  for (const o of resp?.origins ?? []) {
    if (o.itemCode) m.set(o.itemCode, o.assignments ?? []);
  }
  return m;
};

export const provenanceByCode = (resp: PoSoCoverageResp | undefined): Map<string, OriginAssignment[]> => {
  const m = new Map<string, OriginAssignment[]>();
  for (const o of resp?.origins ?? []) {
    if (o.itemCode && (o.provenance?.length ?? 0) > 0) m.set(o.itemCode, o.provenance ?? []);
  }
  return m;
};

export const deliveredByCode = (resp: PoSoCoverageResp | undefined): Map<string, DeliveredDo[]> => {
  const m = new Map<string, DeliveredDo[]>();
  for (const d of resp?.delivered ?? []) {
    if (d.itemCode) m.set(d.itemCode, d.dos ?? []);
  }
  return m;
};

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
