// so-relationship-map — the ONE builder for the Sales Order's 7-node
// Relationship Map and for what each node does when it is clicked. Two chains,
// both rooted at the Sales Order (owner 2026-07-23, verbatim):
//   sales    : Customer PO → Sales Order → Delivery Order → Sales Invoice
//   purchase : Sales Order → Purchase Order → GRN → Purchase Invoice
//
// Pre-MRP SOs (< 2026-07-09) carry no linked PO. For those the PO node falls
// back to ADVISORY candidates matched by item code (owner 2026-07-23) — shown as
// "Not linked", tap to list them. Read-only: never presented as, nor written as,
// a real link.
//
// Why it exists: the chain + its click handling were written twice — once in
// SalesOrderDetailV2 (the read-only page) and once in SalesOrderDetail (the
// ?edit=1 editor) — and immediately drifted. #600 taught the V2 copy to resolve
// the real downstream DO / SI and navigate to them; the editor copy was left with
// a hard-coded "Not created" chain and `onNodeClick={(n) => void n}`, so on the
// page the owner actually sits on while amending an order, EVERY node was dead
// and the DO / SI nodes lied about not existing. Both pages now call this hook,
// so there is one chain and one set of destinations (owner rule: one logic
// layer, never per-surface).
//
// Owner 2026-07-16: "每個點了都要有反應可以看到文件的" — a node that paints as
// Linked must answer when it is clicked. Nodes with a real document navigate to
// it; the ones that cannot (see below) say why in-app instead of doing nothing.

import { customerRefOf } from '../../lib/customer-ref';
import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useDocumentFlow, useCandidatePos, type FlowNode } from '../../vendor/scm/lib/flow-queries';
import type { ChainNode, AmendmentChip, PairingKind } from '../../components/scm-v2/DocumentRelationshipMapModal';
import { useDocChoice, type DocChoiceApi } from './doc-choice';

/** The header columns the chain reads. Loose on purpose — the two SO detail
 *  pages carry their own (differently-typed) SoHeader. */
export type SoRelationshipHeader = {
  doc_no: string;
  po_doc_no?: string | null;
  customer_so_no?: string | null;
  ref?: string | null;
};

/* What a "Customer PO" IS on a Houzs SO — read this before wiring it to a file.
   It is a REFERENCE STRING and nothing else. PR #140 (commander 2026-05-26,
   "customer PO 不需要") dropped the whole Customer PO card — PO No / PO ID / PO
   Date / PO image — so no Houzs surface writes po_doc_no or customer_po*; the
   columns survive only because the SCM schema was vendored from 2990. The value
   this node shows is therefore almost always `customer_so_no`, the customer's own
   ERP reference typed into the Customer card ("Customer SO Ref"). The one image
   column that exists, customer_po_image_b64, is never written by any Houzs code
   path — SELECTed and audit-mapped, never inserted.
   The files an SO does own — slip_image_key (the handwritten ORDER SLIP) and
   receipt_image_key (the PAYMENT RECEIPT) — are OUR documents from the scan flow,
   not the customer's PO, and the detail page already shows them in their own
   sections. Pointing this node at them would mislabel our slip as their PO.
   So: no file exists, and the honest response is to say so rather than sit dead. */
export function useCustomerPoNotice() {
  const notify = useNotify();
  return useCallback(
    (poRef: string) => {
      void notify({
        title: `Customer PO ${poRef}`.trim(),
        body:
          `${poRef} is the customer's own reference for this order. It is their ` +
          `document, not ours, so there is no file here to open.`,
      });
    },
    [notify],
  );
}

const flowNodesOf = (data: { nodes: FlowNode[] } | undefined, type: FlowNode['type']) =>
  (data?.nodes ?? []).filter((n) => n.type === type);

/** Builds the SO chain and returns the click handler both SO detail pages pass
 *  straight to <DocumentRelationshipMapModal>. `onNodeClick` returns TRUE when the
 *  click navigated away, so the caller knows to close the map — an in-app notice
 *  must render OVER the map instead of dismissing it. */
export function useSoRelationshipMap(salesOrder: SoRelationshipHeader | null): {
  nodes: ChainNode[];
  onNodeClick: (n: ChainNode) => boolean;
  amendments: AmendmentChip[];
  onAmendmentClick: (a: AmendmentChip) => boolean;
  /* The SO ↓ PO hop is PROVENANCE when the graph carries stored raise-links —
     muted, "bought for", never an execution binding ("soft until DO, hard
     from DO"). The SO map shows no FLOATING hop: usePoSoCoverage is keyed by
     purchase doc, so the live pairing renders on the purchase-side maps and
     on this page's per-line Stock/coverage column (same one engine) — adding
     it here would need a new SO-keyed backend read (owner: zero new load). */
  pairing: { kind: PairingKind } | null;
} & DocChoiceApi {
  const navigate = useNavigate();
  const notify = useNotify();
  /* A slot standing for SEVERAL documents opens a chooser whose every row
     clicks through (2026-08-03). It used to raise a notice that only NAMED the
     doc numbers — and pointed at lists that cannot search by this SO's doc no,
     so the operator was copying numbers by hand. */
  const { choice, openChoice, closeChoice, pickChoice } = useDocChoice();
  const showCustomerPo = useCustomerPoNotice();
  const { can, pageAccess } = useAuth();

  const docNo = salesOrder?.doc_no ?? null;
  // Downstream docs generated from this SO. Company-scoped server-side.
  const flow = useDocumentFlow('so', docNo);
  const doNodes = useMemo(() => flowNodesOf(flow.data, 'do'), [flow.data]);
  const siNodes = useMemo(() => flowNodesOf(flow.data, 'si'), [flow.data]);
  const grnNodes = useMemo(() => flowNodesOf(flow.data, 'grn'), [flow.data]);
  // The PURCHASE leg — owner 2026-07-23: "sales order-> purchase order ->
  // good receipt note(GRN) -> purchase invoice". document-flow has always
  // returned these nodes (purchase_order_items.so_item_id → grns →
  // purchase_invoices); the chain just never showed them.
  const poNodes = useMemo(() => flowNodesOf(flow.data, 'po'), [flow.data]);
  const piNodes = useMemo(() => flowNodesOf(flow.data, 'pi'), [flow.data]);

  /* Amendments (SO revision requests) hang off this SO. document-flow returns
     them as a read-only side list; the map branches them off the Sales Order,
     each chip clicking through to its job card. The amendment detail route is
     gated exactly like the SO (scm.sales.orders + allowSales), so no extra
     access check is needed here. */
  const amendments: AmendmentChip[] = useMemo(
    () =>
      (flow.data?.amendments ?? []).map((a) => ({
        id: a.id,
        label: `Amendment ${a.amendmentNo}`,
        status: a.status,
      })),
    [flow.data],
  );
  const onAmendmentClick = useCallback(
    (a: AmendmentChip): boolean => {
      navigate(`/scm/amendments/${a.id}`);
      return true;
    },
    [navigate],
  );

  /* Pre-MRP SOs (2026-07-09) have no linked PO leg. When the flow has loaded
     and returned no PO node, ask the backend for ADVISORY candidates matched by
     item code — read-only, never a stored link (owner 2026-07-23 chose this over
     auto-linking because a pre-MRP PO was a shared stock buy and the true SO⇄PO
     attribution can't be safely inferred). Gated so a linked SO never fires the
     request. */
  const flowLoaded = !flow.isLoading && flow.data != null;
  const candQ = useCandidatePos(flowLoaded && poNodes.length === 0 ? docNo : null);
  const candidatePos = useMemo(() => candQ.data?.candidates ?? [], [candQ.data]);

  /* GRN sits behind the procurement guard — App.tsx mounts /scm/grns/:id as
     <ScmGuard area="scm.procurement.grn"> with NO allowSales — so mirror that
     route gate here rather than handing a salesperson a node that navigates
     straight into <Forbidden>. Same OR-shape as the Guard itself. */
  const canOpenGrn = can('scm.access') || pageAccess('scm.procurement.grn') !== 'none';
  // Same gate shape for the PO / PI nodes (/scm/purchase-orders/:id and
  // /scm/purchase-invoices/:id guard on their own areas, no allowSales).
  const canOpenPo = can('scm.access') || pageAccess('scm.procurement.po') !== 'none';
  const canOpenPi = can('scm.access') || pageAccess('scm.procurement.pi') !== 'none';

  const poRef = customerRefOf(salesOrder);

  const nodes: ChainNode[] = useMemo(() => {
    if (!salesOrder) return [];
    return [
      {
        type: 'Customer PO',
        doc: poRef || 'Not linked',
        // Reference only — no file exists (see useCustomerPoNotice above).
        meta: poRef ? "Customer's own doc" : '—',
        state: poRef ? 'done' : 'pending',
      },
      {
        type: 'Sales Order',
        doc: salesOrder.doc_no,
        meta: 'This document',
        state: 'current',
      },
      {
        type: 'Delivery Order',
        doc:
          doNodes.length === 0
            ? 'Not created'
            : doNodes.length === 1
              ? doNodes[0]!.label
              : `${doNodes.length} delivery orders`,
        meta:
          doNodes.length === 0
            ? 'After confirmation'
            : doNodes.length === 1
              ? 'Tap to open'
              : 'Tap to view all',
        state: doNodes.length > 0 ? 'done' : 'pending',
      },
      /* Node 3 closes the SALES row — the owner's first chain, verbatim
         (2026-07-23): Sales Order → Delivery Order → Sales Invoice. */
      {
        type: 'Sales Invoice',
        doc:
          siNodes.length === 0
            ? 'Not created'
            : siNodes.length === 1
              ? siNodes[0]!.label
              : `${siNodes.length} invoices`,
        meta:
          siNodes.length === 0
            ? 'On completion'
            : siNodes.length === 1
              ? 'Tap to open'
              : 'Tap to view all',
        state: siNodes.length > 0 ? 'done' : 'pending',
      },
      /* Nodes 4-6 = the PURCHASE row, the owner's second chain: Sales Order →
         Purchase Order → GRN → Purchase Invoice. It hangs off the SO because
         that is where the supplier order is raised from. */
      {
        type: 'Purchase Order',
        doc:
          poNodes.length === 1
            ? poNodes[0]!.label
            : poNodes.length > 1
              ? `${poNodes.length} purchase orders`
              : candidatePos.length > 0
                ? 'Not linked'
                : 'Not created',
        meta:
          poNodes.length > 0
            ? !canOpenPo
              ? 'Procurement document'
              : poNodes.length === 1
                ? 'Tap to open'
                : 'Tap to list'
            : candidatePos.length > 0
              // Advisory only — the link was never recorded (see hook).
              ? `${candidatePos.length} candidate${candidatePos.length > 1 ? 's' : ''} — tap`
              : 'On supplier order',
        // Candidates are a GUESS, not a link, so the node stays 'pending' (grey)
        // — only a real PO node paints it done.
        state: poNodes.length > 0 ? 'done' : 'pending',
        // A grey candidate node is still tappable (it lists the advisory POs).
        // Without this the modal renders it disabled and "N candidates — tap"
        // does nothing.
        actionable: poNodes.length > 0 || candidatePos.length > 0,
      },
      {
        type: 'GRN',
        doc:
          grnNodes.length === 0
            ? 'Not created'
            : grnNodes.length === 1
              ? grnNodes[0]!.label
              : `${grnNodes.length} GRNs`,
        meta:
          grnNodes.length === 0
            ? 'On supplier delivery'
            : !canOpenGrn
              ? 'Procurement document'
              : grnNodes.length === 1
                ? 'Tap to open'
                : 'Tap to list',
        state: grnNodes.length > 0 ? 'done' : 'pending',
      },
      {
        type: 'Purchase Invoice',
        doc:
          piNodes.length === 0
            ? 'Not created'
            : piNodes.length === 1
              ? piNodes[0]!.label
              : `${piNodes.length} invoices`,
        meta:
          piNodes.length === 0
            ? 'On supplier billing'
            : !canOpenPi
              ? 'Procurement document'
              : piNodes.length === 1
                ? 'Tap to open'
                : 'Tap to list',
        state: piNodes.length > 0 ? 'done' : 'pending',
      },
    ];
  }, [salesOrder, poRef, doNodes, siNodes, grnNodes, poNodes, piNodes, candidatePos, canOpenGrn, canOpenPo, canOpenPi]);

  const onNodeClick = useCallback(
    (n: ChainNode): boolean => {
      // One match → its detail page; several → the list filtered by this SO's
      // doc no (the chain has a single slot per doc type, so a split
      // delivery/invoice lands on the filtered list).
      if (n.type === 'Delivery Order' && doNodes.length > 0) {
        if (doNodes.length === 1) {
          navigate(`/scm/delivery-orders/${doNodes[0]!.id}`);
          return true;
        }
        openChoice({
          title: 'Delivered on more than one DO',
          intro: 'This order shipped across several Delivery Orders. Pick one to open it.',
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
          intro: 'This order was invoiced across several Sales Invoices. Pick one to open it.',
          docs: siNodes.map((d) => ({ id: d.id, label: d.label, sub: d.status, to: `/scm/sales-invoices/${d.id}` })),
        });
        return false;
      }
      if (n.type === 'Purchase Order' && poNodes.length > 0) {
        if (!canOpenPo) {
          void notify({
            title: 'Purchase Orders are not open to you',
            body:
              `This order is purchased on ${poNodes.map((p) => p.label).join(', ')}. ` +
              `Opening a PO needs Procurement access — ask an admin if you need it.`,
          });
          return false;
        }
        if (poNodes.length === 1) {
          navigate(`/scm/purchase-orders/${poNodes[0]!.id}`);
          return true;
        }
        /* Several POs, one slot. Naming them was never enough — the PO list
           searches its OWN refs (supplier / PO no) and knows nothing about an SO
           doc no, so "go look them up" landed on an empty list. Each PO is a row
           that opens it. */
        openChoice({
          title: 'Purchased on more than one PO',
          intro: 'This order is purchased across several Purchase Orders. Pick one to open it.',
          docs: poNodes.map((p) => ({ id: p.id, label: p.label, sub: p.status, to: `/scm/purchase-orders/${p.id}` })),
        });
        return false;
      }
      /* No linked PO, but advisory candidates exist (pre-MRP SO). List them for
         manual reconciliation — each one opens, but the wording keeps saying
         what they are: a GUESS by item code, never presented as the link, since
         which PO (if any) actually covers this SO was never recorded. */
      if (n.type === 'Purchase Order' && candidatePos.length > 0) {
        openChoice({
          title: 'No purchase order linked to this sale',
          intro:
            'This sale predates linked purchasing, so its PO was never recorded against it. '
            + 'By item code, these live purchase orders MIGHT cover it — a GUESS, not a link. '
            + 'Open one to verify before relying on it.',
          docs: candidatePos.map((p) => ({
            id: p.id, label: p.poNumber, sub: p.status, to: `/scm/purchase-orders/${p.id}`,
          })),
        });
        return false;
      }
      if (n.type === 'Purchase Invoice' && piNodes.length > 0) {
        if (!canOpenPi) {
          void notify({
            title: 'Purchase Invoices are not open to you',
            body:
              `The supplier billed this order on ${piNodes.map((p) => p.label).join(', ')}. ` +
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
          intro: 'The supplier billed this order across several Purchase Invoices. Pick one to open it.',
          docs: piNodes.map((p) => ({ id: p.id, label: p.label, sub: p.status, to: `/scm/purchase-invoices/${p.id}` })),
        });
        return false;
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
        /* Several GRNs and one slot to show them in. The GRN list searches its
           OWN refs (supplier / PO / GRN no) and knows nothing about an SO doc no,
           so ?q=<SO no> lands on an empty list — each GRN is a row that opens
           it directly instead. */
        openChoice({
          title: 'Received on more than one GRN',
          intro: "This order's goods arrived across several Goods Received notes. Pick one to open it.",
          docs: grnNodes.map((g) => ({ id: g.id, label: g.label, sub: g.status, to: `/scm/grns/${g.id}` })),
        });
        return false;
      }
      if (n.type === 'Customer PO' && n.state === 'done') {
        showCustomerPo(n.doc);
      }
      return false;
    },
    [navigate, notify, openChoice, showCustomerPo, salesOrder?.doc_no, doNodes, siNodes, grnNodes, poNodes, piNodes, candidatePos, canOpenGrn, canOpenPo, canOpenPi],
  );

  const pairing = useMemo<{ kind: PairingKind } | null>(
    () => (poNodes.length > 0 ? { kind: 'provenance' } : null),
    [poNodes],
  );

  return { nodes, onNodeClick, amendments, onAmendmentClick, pairing, choice, openChoice, closeChoice, pickChoice };
}
