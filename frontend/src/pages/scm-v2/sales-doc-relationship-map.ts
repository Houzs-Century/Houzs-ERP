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

import { customerRefOf, type CustomerRefHeader } from '../../lib/customer-ref';
import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useDocumentFlow, type FlowNode } from '../../vendor/scm/lib/flow-queries';
import type { ChainNode, PairingKind } from '../../components/scm-v2/DocumentRelationshipMapModal';
import { useCustomerPoNotice } from './so-relationship-map';
import { useDocChoice, type DocChoiceApi } from './doc-choice';

const flowNodesOf = (data: { nodes: FlowNode[] } | undefined, type: FlowNode['type']) =>
  (data?.nodes ?? []).filter((n) => n.type === type && !n.isAnchor);

/* Shared count/label copy so the three chains read the same way as the SO map:
   0 → "Not created", 1 → the doc's own label, N → "N <plural>". */
function docCell(nodes: FlowNode[], plural: string, emptyDoc: string): { doc: string; multiple: boolean } {
  if (nodes.length === 0) return { doc: emptyDoc, multiple: false };
  if (nodes.length === 1) return { doc: nodes[0]!.label, multiple: false };
  return { doc: `${nodes.length} ${plural}`, multiple: true };
}

/* Procurement guard mirror — /scm/purchase-orders/:id, /scm/grns/:id and
   /scm/purchase-invoices/:id are each mounted <ScmGuard area="scm.procurement.*">
   with NO allowSales, so a salesperson who opens a DO through the sales hatch
   must not be handed a node that navigates straight into <Forbidden>. Same
   OR-shape as the SO map + the Guards themselves. */
function useProcurementGates(): ProcurementGates {
  const { can, pageAccess } = useAuth();
  const all = can('scm.access');
  return useMemo(
    () => ({
      canOpenPo: all || pageAccess('scm.procurement.po') !== 'none',
      canOpenGrn: all || pageAccess('scm.procurement.grn') !== 'none',
      canOpenPi: all || pageAccess('scm.procurement.pi') !== 'none',
    }),
    [all, pageAccess],
  );
}

// ── Delivery Order chain — the owner's TWO-CHAIN shape (2026-07-23), the same
//    seven nodes the Sales Order map renders:
//      sales    : Customer PO ▶ Sales Order ▶ Delivery Order (current) ▶ Sales Invoice
//      purchase : Sales Order ▼ Purchase Order ▶ GRN ▶ Purchase Invoice
//    It replaces Nick's 2026-07-08 five-node chain, which had the GRN sitting in
//    the sales row with no room for the purchase order that produced it. The DO
//    page had a GRN node and no way to answer "bought on what?" — the graph has
//    carried `po` and `pi` nodes all along (document-flow emits them, and the SO
//    map already draws them); only this builder never read them. ──────────────
export type DoRelationshipHeader = CustomerRefHeader & {
  id: string;
  do_number: string;
  so_doc_no?: string | null;
};

/** The procurement-side route gates, resolved once by the hook and passed in so
 *  the builder stays pure. Each mirrors its route's own <ScmGuard> (no
 *  allowSales), so a salesperson is never handed a node that navigates straight
 *  into <Forbidden> — it says "Procurement document" and answers in a notice. */
export type ProcurementGates = { canOpenPo: boolean; canOpenGrn: boolean; canOpenPi: boolean };

/** Pure node builder for the DO chain (exported for unit tests). Returns the
 *  SEVEN-node ChainNode array in the order the canvas positions them: indices
 *  0-3 are the sales row, 4-6 the purchase row hanging off the Sales Order. */
export function buildDoChainNodes(
  header: DoRelationshipHeader,
  soNodes: FlowNode[],
  siNodes: FlowNode[],
  poNodes: FlowNode[],
  grnNodes: FlowNode[],
  piNodes: FlowNode[],
  gates: ProcurementGates,
): ChainNode[] {
  const poRef = customerRefOf(header);
  const so = docCell(soNodes, 'sales orders', header.so_doc_no || 'Not linked');
  const si = docCell(siNodes, 'invoices', 'Not created');
  const po = docCell(poNodes, 'purchase orders', 'Not created');
  const grn = docCell(grnNodes, 'GRNs', 'Not created');
  const pi = docCell(piNodes, 'invoices', 'Not created');
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
    /* Node 3 closes the SALES row. */
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
    /* Nodes 4-6 = the PURCHASE row, hanging off the Sales Order because that is
       where the supplier order is raised from. */
    {
      type: 'Purchase Order',
      doc: po.doc,
      meta:
        poNodes.length === 0
          ? 'On supplier order'
          : !gates.canOpenPo
            ? 'Procurement document'
            : po.multiple
              ? 'Tap to list'
              : 'Tap to open',
      state: poNodes.length > 0 ? 'done' : 'pending',
    },
    {
      type: 'GRN',
      doc: grn.doc,
      meta:
        grnNodes.length === 0
          ? 'On supplier delivery'
          : !gates.canOpenGrn
            ? 'Procurement document'
            : grn.multiple
              ? 'Tap to list'
              : 'Tap to open',
      state: grnNodes.length > 0 ? 'done' : 'pending',
    },
    {
      type: 'Purchase Invoice',
      doc: pi.doc,
      meta:
        piNodes.length === 0
          ? 'On supplier billing'
          : !gates.canOpenPi
            ? 'Procurement document'
            : pi.multiple
              ? 'Tap to list'
              : 'Tap to open',
      state: piNodes.length > 0 ? 'done' : 'pending',
    },
  ];
}

export function useDoRelationshipMap(header: DoRelationshipHeader | null): {
  nodes: ChainNode[];
  onNodeClick: (n: ChainNode) => boolean;
  /* The SO ▼ PO hop is PROVENANCE — "bought for", muted, never an execution
     binding. Same rule as the SO map: a dash may only ever mean "floating", and
     this map shows no floating hop (usePoSoCoverage is keyed by purchase doc). */
  pairing: { kind: PairingKind } | null;
} & DocChoiceApi {
  const navigate = useNavigate();
  const notify = useNotify();
  /* Several documents in one slot open a chooser whose every row clicks through
     (2026-08-03) — naming them and pointing at a list that cannot be searched by
     this doc no left the operator copying numbers by hand. */
  const { choice, openChoice, closeChoice, pickChoice } = useDocChoice();
  const showCustomerPo = useCustomerPoNotice();
  const gates = useProcurementGates();

  const flow = useDocumentFlow('do', header?.id ?? null);
  const soNodes = useMemo(() => flowNodesOf(flow.data, 'so'), [flow.data]);
  const siNodes = useMemo(() => flowNodesOf(flow.data, 'si'), [flow.data]);
  const poNodes = useMemo(() => flowNodesOf(flow.data, 'po'), [flow.data]);
  const grnNodes = useMemo(() => flowNodesOf(flow.data, 'grn'), [flow.data]);
  const piNodes = useMemo(() => flowNodesOf(flow.data, 'pi'), [flow.data]);

  const nodes: ChainNode[] = useMemo(
    () => (header ? buildDoChainNodes(header, soNodes, siNodes, poNodes, grnNodes, piNodes, gates) : []),
    [header, soNodes, siNodes, poNodes, grnNodes, piNodes, gates],
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
        if (siNodes.length === 1) {
          navigate(`/scm/sales-invoices/${siNodes[0]!.id}`);
          return true;
        }
        openChoice({
          title: 'Billed on more than one invoice',
          intro: 'This delivery was invoiced across several Sales Invoices. Pick one to open it.',
          docs: siNodes.map((d) => ({ id: d.id, label: d.label, sub: d.status, to: `/scm/sales-invoices/${d.id}` })),
        });
        return false;
      }
      if (n.type === 'GRN' && grnNodes.length > 0) {
        if (!gates.canOpenGrn) {
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
        openChoice({
          title: 'Received on more than one GRN',
          intro: "This order's goods arrived across several Goods Received notes. Pick one to open it.",
          docs: grnNodes.map((g) => ({ id: g.id, label: g.label, sub: g.status, to: `/scm/grns/${g.id}` })),
        });
        return false;
      }
      if (n.type === 'Purchase Order' && poNodes.length > 0) {
        if (!gates.canOpenPo) {
          void notify({
            title: 'Purchase Orders are not open to you',
            body:
              `This delivery's goods were bought on ${poNodes.map((p) => p.label).join(', ')}. ` +
              `Opening a PO needs Procurement access — ask an admin if you need it.`,
          });
          return false;
        }
        if (poNodes.length === 1) {
          navigate(`/scm/purchase-orders/${poNodes[0]!.id}`);
          return true;
        }
        openChoice({
          title: 'Bought on more than one purchase order',
          intro: 'This delivery is purchased across several Purchase Orders. Pick one to open it.',
          docs: poNodes.map((p) => ({ id: p.id, label: p.label, sub: p.status, to: `/scm/purchase-orders/${p.id}` })),
        });
        return false;
      }
      if (n.type === 'Purchase Invoice' && piNodes.length > 0) {
        if (!gates.canOpenPi) {
          void notify({
            title: 'Purchase Invoices are not open to you',
            body:
              `The supplier billed these goods on ${piNodes.map((p) => p.label).join(', ')}. ` +
              `Opening a PI needs Procurement access — ask an admin if you need it.`,
          });
          return false;
        }
        if (piNodes.length === 1) {
          navigate(`/scm/purchase-invoices/${piNodes[0]!.id}`);
          return true;
        }
        openChoice({
          title: 'Billed on more than one supplier invoice',
          intro: 'The supplier billed these goods across several Purchase Invoices. Pick one to open it.',
          docs: piNodes.map((p) => ({ id: p.id, label: p.label, sub: p.status, to: `/scm/purchase-invoices/${p.id}` })),
        });
        return false;
      }
      if (n.type === 'Customer PO' && n.state === 'done') {
        showCustomerPo(n.doc);
      }
      return false;
    },
    [navigate, notify, openChoice, showCustomerPo, header?.so_doc_no, header?.do_number, soNodes, siNodes, poNodes, grnNodes, piNodes, gates],
  );

  const pairing = useMemo<{ kind: PairingKind } | null>(
    () => (poNodes.length > 0 ? { kind: 'provenance' } : null),
    [poNodes],
  );

  return { nodes, onNodeClick, pairing, choice, openChoice, closeChoice, pickChoice };
}

// ── Sales Invoice chain — Customer PO ▶ Sales Order ▶ Delivery Order ▶
//    Payments ▶ Sales Invoice (current). The 5-node shape's downstream slot is
//    the AR payments the live graph carries off this invoice (the hand-built
//    chain dropped them for a dead "no GRN" tile). ────────────────────────────
export type SiRelationshipHeader = CustomerRefHeader & {
  id: string;
  invoice_number: string;
  so_doc_no?: string | null;
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
  const poRef = customerRefOf(header);
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
} & DocChoiceApi {
  const navigate = useNavigate();
  const notify = useNotify();
  const { choice, openChoice, closeChoice, pickChoice } = useDocChoice();
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
        if (doNodes.length === 1) {
          navigate(`/scm/delivery-orders/${doNodes[0]!.id}`);
          return true;
        }
        openChoice({
          title: 'Shipped on more than one DO',
          intro: 'This invoice covers several Delivery Orders. Pick one to open it.',
          docs: doNodes.map((d) => ({ id: d.id, label: d.label, sub: d.status, to: `/scm/delivery-orders/${d.id}` })),
        });
        return false;
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
    [navigate, notify, openChoice, showCustomerPo, header?.so_doc_no, header?.invoice_number, soNodes, doNodes, paymentNodes],
  );

  return { nodes, onNodeClick, choice, openChoice, closeChoice, pickChoice };
}

// ── Delivery Return chain — Customer PO ▶ Sales Order ▶ Delivery Order ▶
//    Sales Invoice ▶ Delivery Return (current). The return branches off the DO;
//    the SO + SI nodes are now the real family documents, not "Upstream …". ────
export type DrRelationshipHeader = CustomerRefHeader & {
  id: string;
  return_number: string;
  do_doc_no?: string | null;
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
  const poRef = customerRefOf(header);
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
} & DocChoiceApi {
  const navigate = useNavigate();
  const notify = useNotify();
  const { choice, openChoice, closeChoice, pickChoice } = useDocChoice();
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
        openChoice({
          title: 'Returns against more than one sales order',
          intro: 'This return covers several Sales Orders. Pick one to open it.',
          docs: soNodes.map((so) => ({
            id: so.id, label: so.label, sub: so.status,
            to: `/scm/sales-orders/${encodeURIComponent(so.id)}`,
          })),
        });
        return false;
      }
      if (n.type === 'Delivery Order' && doNodes.length > 0) {
        if (doNodes.length === 1) {
          navigate(`/scm/delivery-orders/${doNodes[0]!.id}`);
          return true;
        }
        openChoice({
          title: 'Returned against more than one DO',
          intro: 'This return covers several Delivery Orders. Pick one to open it.',
          docs: doNodes.map((d) => ({ id: d.id, label: d.label, sub: d.status, to: `/scm/delivery-orders/${d.id}` })),
        });
        return false;
      }
      if (n.type === 'Sales Invoice' && siNodes.length > 0) {
        if (siNodes.length === 1) {
          navigate(`/scm/sales-invoices/${siNodes[0]!.id}`);
          return true;
        }
        openChoice({
          title: 'Billed on more than one invoice',
          intro: 'The order behind this return was invoiced across several Sales Invoices. Pick one to open it.',
          docs: siNodes.map((d) => ({ id: d.id, label: d.label, sub: d.status, to: `/scm/sales-invoices/${d.id}` })),
        });
        return false;
      }
      if (n.type === 'Customer PO' && n.state === 'done') {
        showCustomerPo(n.doc);
      }
      return false;
    },
    [navigate, notify, openChoice, showCustomerPo, header?.return_number, soNodes, doNodes, siNodes],
  );

  return { nodes, onNodeClick, choice, openChoice, closeChoice, pickChoice };
}
