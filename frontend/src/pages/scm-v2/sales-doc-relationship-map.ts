// sales-doc-relationship-map — the ONE builder for the Delivery Order / Sales
// Invoice / Delivery Return Relationship Maps, the sales-side siblings of
// so-relationship-map.ts. Every node is read from the LIVE `/document-flow`
// graph (the same company-scoped source the Sales Order map, the vendor
// DocumentFlowModal and the purchase-side maps use) instead of a hand-built
// literal chain.
//
// Why it exists (audit R8): SO / DO / SI / DR detail each rendered a HAND-BUILT
// `chainNodes` array. That drifted from reality on exactly the nodes an operator
// most needs:
//   · DO hard-coded its GRN node to "Not created" forever, even when the SO it
//     descends from had been fully received on a real GRN.
//   · SI dropped its AR-payment nodes entirely (the 5-node chain had a dead
//     "Sales side · no GRN" slot where the payments belong).
//   · DR hard-coded its Sales Order + Sales Invoice nodes to "Upstream …" text,
//     so neither was ever clickable nor showed the real document number.
// so-relationship-map.ts already fixed this for the Sales Order (#600). These
// hooks bring the same live-graph read to the three remaining sales documents,
// keeping ONE logic layer (owner rule) rather than four literal chains.
//
// Semantics match the SO map: the graph resolves the whole document FAMILY off
// the anchor's root Sales Order(s), so a node shows every document of its type
// in that family (one slot, "N documents" when several). Nodes that resolve to a
// real, openable document navigate to it; the rest say why in-app (owner
// 2026-07-16: a node that paints Linked must answer when tapped). Consignment
// anchors keep their existing vendor DocumentFlowModal map — these hooks are the
// bespoke 5-node canvas the regular DO/SI/DR detail pages render.

import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useDocumentFlow, type FlowNode } from '../../vendor/scm/lib/flow-queries';
import type { ChainNode } from '../../components/scm-v2/DocumentRelationshipMapModal';
import { useCustomerPoNotice } from './so-relationship-map';

const flowNodesOf = (data: { nodes: FlowNode[] } | undefined, type: FlowNode['type']) =>
  (data?.nodes ?? []).filter((n) => n.type === type && !n.isAnchor);

/* Shared count/label copy so the three chains read the same way as the SO map:
   0 → "Not created", 1 → the doc's own label, N → "N <plural>". */
function docCell(nodes: FlowNode[], plural: string, emptyDoc: string): { doc: string; multiple: boolean } {
  if (nodes.length === 0) return { doc: emptyDoc, multiple: false };
  if (nodes.length === 1) return { doc: nodes[0]!.label, multiple: false };
  return { doc: `${nodes.length} ${plural}`, multiple: true };
}

/* Procurement guard mirror — the GRN detail route (/scm/grns/:id) is mounted
   <ScmGuard area="scm.procurement.grn"> with NO allowSales, so a salesperson who
   opens a DO through the sales hatch must not be handed a node that navigates
   straight into <Forbidden>. Same OR-shape as the SO map + the Guard itself. */
function useCanOpenGrn() {
  const { can, pageAccess } = useAuth();
  return can('scm.access') || pageAccess('scm.procurement.grn') !== 'none';
}

// ── Delivery Order chain — Customer PO ▶ Sales Order ▶ Delivery Order (current)
//    ▶ GRN ▶ Sales Invoice (Nick 2026-07-08 5-node shape) ─────────────────────
export type DoRelationshipHeader = {
  id: string;
  do_number: string;
  so_doc_no?: string | null;
  po_doc_no?: string | null;
  customer_so_no?: string | null;
};

/** Pure node builder for the DO chain (exported for unit tests). Given the
 *  header + the family nodes resolved off the live graph, returns the 5-node
 *  ChainNode array. This is where the audit-R8 fix lives: a non-empty grnNodes
 *  paints the GRN node 'done' with the real GRN label instead of the old
 *  hard-coded "Not created". */
export function buildDoChainNodes(
  header: DoRelationshipHeader,
  soNodes: FlowNode[],
  grnNodes: FlowNode[],
  siNodes: FlowNode[],
  canOpenGrn: boolean,
): ChainNode[] {
  const poRef = (header.po_doc_no || header.customer_so_no || '').trim();
  const so = docCell(soNodes, 'sales orders', header.so_doc_no || 'Not linked');
  const grn = docCell(grnNodes, 'GRNs', 'Not created');
  const si = docCell(siNodes, 'invoices', 'Not created');
  const soLinked = soNodes.length > 0 || !!header.so_doc_no;
  return [
    {
      type: 'Customer PO',
      doc: poRef || 'Not linked',
      meta: poRef ? "Customer's own doc" : '—',
      state: poRef ? 'done' : 'pending',
    },
    {
      type: 'Sales Order',
      doc: so.doc,
      meta: soLinked ? (soNodes.length > 0 ? 'Tap to open' : 'Source order') : '—',
      state: soLinked ? 'done' : 'pending',
      actionable: soNodes.length > 0 || !!header.so_doc_no,
    },
    {
      type: 'Delivery Order',
      doc: header.do_number,
      meta: 'This document',
      state: 'current',
    },
    {
      type: 'GRN',
      doc: grn.doc,
      meta:
        grnNodes.length === 0
          ? 'On supplier delivery'
          : !canOpenGrn
            ? 'Procurement document'
            : grn.multiple
              ? 'Tap to list'
              : 'Tap to open',
      state: grnNodes.length > 0 ? 'done' : 'pending',
    },
    {
      type: 'Sales Invoice',
      doc: si.doc,
      meta:
        siNodes.length === 0
          ? 'On completion'
          : si.multiple
            ? 'Tap to view all'
            : 'Tap to open',
      state: siNodes.length > 0 ? 'done' : 'pending',
    },
  ];
}

export function useDoRelationshipMap(header: DoRelationshipHeader | null): {
  nodes: ChainNode[];
  onNodeClick: (n: ChainNode) => boolean;
} {
  const navigate = useNavigate();
  const notify = useNotify();
  const showCustomerPo = useCustomerPoNotice();
  const canOpenGrn = useCanOpenGrn();

  const flow = useDocumentFlow('do', header?.id ?? null);
  const soNodes = useMemo(() => flowNodesOf(flow.data, 'so'), [flow.data]);
  const grnNodes = useMemo(() => flowNodesOf(flow.data, 'grn'), [flow.data]);
  const siNodes = useMemo(() => flowNodesOf(flow.data, 'si'), [flow.data]);

  const nodes: ChainNode[] = useMemo(
    () => (header ? buildDoChainNodes(header, soNodes, grnNodes, siNodes, canOpenGrn) : []),
    [header, soNodes, grnNodes, siNodes, canOpenGrn],
  );

  const onNodeClick = useCallback(
    (n: ChainNode): boolean => {
      if (n.type === 'Sales Order') {
        const soDoc = soNodes[0]?.id ?? header?.so_doc_no;
        if (soDoc) {
          navigate(`/scm/sales-orders/${encodeURIComponent(soDoc)}`);
          return true;
        }
        return false;
      }
      if (n.type === 'Sales Invoice' && siNodes.length > 0) {
        navigate(
          siNodes.length === 1
            ? `/scm/sales-invoices/${siNodes[0]!.id}`
            : `/scm/sales-invoices?q=${encodeURIComponent(header?.do_number ?? '')}`,
        );
        return true;
      }
      if (n.type === 'GRN' && grnNodes.length > 0) {
        if (!canOpenGrn) {
          void notify({
            title: 'Goods Received is not open to you',
            body:
              `This order's goods were received on ${grnNodes.map((g) => g.label).join(', ')}. ` +
              `Opening a GRN needs Procurement access — ask an admin if you need it.`,
          });
          return false;
        }
        if (grnNodes.length === 1) {
          navigate(`/scm/grns/${grnNodes[0]!.id}`);
          return true;
        }
        void notify({
          title: 'Received on more than one GRN',
          body:
            `This order's goods were received on ${grnNodes.map((g) => g.label).join(', ')}. ` +
            `Open Goods Received to view them.`,
        });
        return false;
      }
      if (n.type === 'Customer PO' && n.state === 'done') {
        showCustomerPo(n.doc);
      }
      return false;
    },
    [navigate, notify, showCustomerPo, header?.so_doc_no, header?.do_number, soNodes, grnNodes, siNodes, canOpenGrn],
  );

  return { nodes, onNodeClick };
}

// ── Sales Invoice chain — Customer PO ▶ Sales Order ▶ Delivery Order ▶
//    Payments ▶ Sales Invoice (current). The 5-node shape's downstream slot is
//    the AR payments the live graph carries off this invoice (the hand-built
//    chain dropped them for a dead "no GRN" tile). ────────────────────────────
export type SiRelationshipHeader = {
  id: string;
  invoice_number: string;
  so_doc_no?: string | null;
  customer_so_no?: string | null;
  po_doc_no?: string | null;
};

/** Pure node builder for the SI chain (exported for unit tests). The 5-node
 *  shape's downstream slot is the AR Payments the live graph carries off this
 *  invoice — the audit-R8 fix that restores the payment nodes the hand-built
 *  chain dropped for a dead "no GRN" tile. */
export function buildSiChainNodes(
  header: SiRelationshipHeader,
  soNodes: FlowNode[],
  doNodes: FlowNode[],
  paymentNodes: FlowNode[],
): ChainNode[] {
  const poRef = (header.customer_so_no || header.po_doc_no || '').trim();
  const so = docCell(soNodes, 'sales orders', header.so_doc_no || 'Not linked');
  const dov = docCell(doNodes, 'delivery orders', 'Not linked');
  const soLinked = soNodes.length > 0 || !!header.so_doc_no;
  return [
    {
      type: 'Customer PO',
      doc: poRef || 'Not linked',
      meta: poRef ? "Customer's own doc" : '—',
      state: poRef ? 'done' : 'pending',
    },
    {
      type: 'Sales Order',
      doc: so.doc,
      meta: soLinked ? (soNodes.length > 0 ? 'Tap to open' : 'Source order') : '—',
      state: soLinked ? 'done' : 'pending',
      actionable: soNodes.length > 0 || !!header.so_doc_no,
    },
    {
      type: 'Delivery Order',
      doc: dov.doc,
      meta:
        doNodes.length === 0
          ? '—'
          : dov.multiple
            ? 'Tap to view all'
            : 'Tap to open',
      state: doNodes.length > 0 ? 'done' : 'pending',
    },
    {
      type: 'Payments',
      doc:
        paymentNodes.length === 0
          ? 'Not paid'
          : paymentNodes.length === 1
            ? paymentNodes[0]!.label
            : `${paymentNodes.length} payments`,
      meta: paymentNodes.length === 0 ? 'Awaiting payment' : 'Tap for detail',
      state: paymentNodes.length > 0 ? 'done' : 'pending',
      // Payments live on THIS invoice page, so the tile lists them in a notice
      // rather than navigating away — but it must still answer when tapped
      // (owner 2026-07-16), so keep it actionable when any payment exists.
      actionable: paymentNodes.length > 0,
    },
    {
      type: 'Sales Invoice',
      doc: header.invoice_number,
      meta: 'This document',
      state: 'current',
    },
  ];
}

export function useSiRelationshipMap(header: SiRelationshipHeader | null): {
  nodes: ChainNode[];
  onNodeClick: (n: ChainNode) => boolean;
} {
  const navigate = useNavigate();
  const notify = useNotify();
  const showCustomerPo = useCustomerPoNotice();

  const flow = useDocumentFlow('si', header?.id ?? null);
  const soNodes = useMemo(() => flowNodesOf(flow.data, 'so'), [flow.data]);
  const doNodes = useMemo(() => flowNodesOf(flow.data, 'do'), [flow.data]);
  const paymentNodes = useMemo(() => flowNodesOf(flow.data, 'payment'), [flow.data]);

  const nodes: ChainNode[] = useMemo(
    () => (header ? buildSiChainNodes(header, soNodes, doNodes, paymentNodes) : []),
    [header, soNodes, doNodes, paymentNodes],
  );

  const onNodeClick = useCallback(
    (n: ChainNode): boolean => {
      if (n.type === 'Sales Order') {
        const soDoc = soNodes[0]?.id ?? header?.so_doc_no;
        if (soDoc) {
          navigate(`/scm/sales-orders/${encodeURIComponent(soDoc)}`);
          return true;
        }
        return false;
      }
      if (n.type === 'Delivery Order' && doNodes.length > 0) {
        navigate(
          doNodes.length === 1
            ? `/scm/delivery-orders/${doNodes[0]!.id}`
            : `/scm/delivery-orders?q=${encodeURIComponent(header?.invoice_number ?? '')}`,
        );
        return true;
      }
      if (n.type === 'Payments' && paymentNodes.length > 0) {
        void notify({
          title: 'Payments on this invoice',
          body:
            `This invoice has ${paymentNodes.length} recorded payment${paymentNodes.length > 1 ? 's' : ''}:\n\n` +
            paymentNodes.map((p) => `• ${p.label}`).join('\n') +
            `\n\nThe full ledger is on this invoice's Payments section.`,
        });
        return false;
      }
      if (n.type === 'Customer PO' && n.state === 'done') {
        showCustomerPo(n.doc);
      }
      return false;
    },
    [navigate, notify, showCustomerPo, header?.so_doc_no, header?.invoice_number, soNodes, doNodes, paymentNodes],
  );

  return { nodes, onNodeClick };
}

// ── Delivery Return chain — Customer PO ▶ Sales Order ▶ Delivery Order ▶
//    Sales Invoice ▶ Delivery Return (current). The return branches off the DO;
//    the SO + SI nodes are now the real family documents, not "Upstream …". ────
export type DrRelationshipHeader = {
  id: string;
  return_number: string;
  do_doc_no?: string | null;
  customer_so_no?: string | null;
};

/** Pure node builder for the DR chain (exported for unit tests). The audit-R8
 *  fix: the Sales Order + Sales Invoice nodes are the real family documents
 *  resolved off this return's DO, replacing the old hard-coded "Upstream …"
 *  placeholders that never showed a number nor were clickable. */
export function buildDrChainNodes(
  header: DrRelationshipHeader,
  soNodes: FlowNode[],
  doNodes: FlowNode[],
  siNodes: FlowNode[],
): ChainNode[] {
  const poRef = (header.customer_so_no || '').trim();
  const so = docCell(soNodes, 'sales orders', 'Not linked');
  const dov = docCell(doNodes, 'delivery orders', header.do_doc_no || 'Not linked');
  const si = docCell(siNodes, 'invoices', 'Not created');
  const doLinked = doNodes.length > 0 || !!header.do_doc_no;
  return [
    {
      type: 'Customer PO',
      doc: poRef || 'Not linked',
      meta: poRef ? "Customer's own doc" : '—',
      state: poRef ? 'done' : 'pending',
    },
    {
      type: 'Sales Order',
      doc: so.doc,
      meta:
        soNodes.length === 0
          ? '—'
          : so.multiple
            ? 'Tap to view all'
            : 'Tap to open',
      state: soNodes.length > 0 ? 'done' : 'pending',
    },
    {
      type: 'Delivery Order',
      doc: dov.doc,
      meta: doLinked ? (doNodes.length > 0 ? 'Tap to open' : 'Source doc') : '—',
      state: doLinked ? 'done' : 'pending',
      actionable: doNodes.length > 0 || !!header.do_doc_no,
    },
    {
      type: 'Sales Invoice',
      doc: si.doc,
      meta:
        siNodes.length === 0
          ? 'Prior to return'
          : si.multiple
            ? 'Tap to view all'
            : 'Tap to open',
      state: siNodes.length > 0 ? 'done' : 'pending',
    },
    {
      type: 'Delivery Return',
      doc: header.return_number,
      meta: 'This document',
      state: 'current',
    },
  ];
}

export function useDrRelationshipMap(header: DrRelationshipHeader | null): {
  nodes: ChainNode[];
  onNodeClick: (n: ChainNode) => boolean;
} {
  const navigate = useNavigate();
  const notify = useNotify();
  const showCustomerPo = useCustomerPoNotice();

  const flow = useDocumentFlow('dr', header?.id ?? null);
  const soNodes = useMemo(() => flowNodesOf(flow.data, 'so'), [flow.data]);
  const doNodes = useMemo(() => flowNodesOf(flow.data, 'do'), [flow.data]);
  const siNodes = useMemo(() => flowNodesOf(flow.data, 'si'), [flow.data]);

  const nodes: ChainNode[] = useMemo(
    () => (header ? buildDrChainNodes(header, soNodes, doNodes, siNodes) : []),
    [header, soNodes, doNodes, siNodes],
  );

  const onNodeClick = useCallback(
    (n: ChainNode): boolean => {
      if (n.type === 'Sales Order' && soNodes.length > 0) {
        if (soNodes.length === 1) {
          navigate(`/scm/sales-orders/${encodeURIComponent(soNodes[0]!.id)}`);
          return true;
        }
        void notify({
          title: 'Returns against more than one sales order',
          body: `This return covers ${soNodes.map((so) => so.label).join(', ')}.`,
        });
        return false;
      }
      if (n.type === 'Delivery Order' && doNodes.length > 0) {
        navigate(
          doNodes.length === 1
            ? `/scm/delivery-orders/${doNodes[0]!.id}`
            : `/scm/delivery-orders?q=${encodeURIComponent(header?.return_number ?? '')}`,
        );
        return true;
      }
      if (n.type === 'Sales Invoice' && siNodes.length > 0) {
        navigate(
          siNodes.length === 1
            ? `/scm/sales-invoices/${siNodes[0]!.id}`
            : `/scm/sales-invoices?q=${encodeURIComponent(header?.return_number ?? '')}`,
        );
        return true;
      }
      if (n.type === 'Customer PO' && n.state === 'done') {
        showCustomerPo(n.doc);
      }
      return false;
    },
    [navigate, notify, showCustomerPo, header?.return_number, soNodes, doNodes, siNodes],
  );

  return { nodes, onNodeClick };
}
