// grn-relationship-map — the ONE builder for the Goods Received (GRN)
// Relationship Map, the receipt-side sibling of po-relationship-map.ts /
// sales-doc-relationship-map.ts. Every node is read from the LIVE
// `/document-flow` graph (the same company-scoped source every other map uses),
// never a hand-built literal chain. Chain, from the GRN's perspective (owner
// 2026-09-18 — the GRN was the one procurement document with no relationship
// map, so staff could not see what it converted to/from):
//   Sales Order ▶ Purchase Order ▶ GRN (current), then billing follows receipt:
//   Purchase Invoice ▶ Purchase Return.
//
// ANCHORED traversal, exactly like the PO map: the graph resolves the whole
// document family off the root SO(s), which can hold SIBLING purchase documents
// (an SO covered by several POs, a PO received on several GRNs). A sibling GRN's
// invoice must not paint THIS GRN's PI node done, so the PO / PI / PR nodes are
// walked along the graph's edges from this GRN's anchor key
// (po ▶ grn:{id} ▶ pi/pr), which are the real FKs (grns.purchase_order_id,
// purchase_invoices.grn_id, purchase_returns.grn_id). The Sales Order node is
// the family's root SO(s) — resolved through the parent PO, so the chain reads
// SO ▶ PO ▶ GRN ▶ PI/PR, the same span the PO map shows. A GRN has no
// amendments, so this hook carries no amendments row (unlike the PO map).

import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useDocumentFlow, type FlowNode, type FlowEdge } from '../../vendor/scm/lib/flow-queries';
import type { ChainNode, PairingKind } from '../../components/scm-v2/DocumentRelationshipMapModal';
import { useDocChoice, type DocChoiceApi } from './doc-choice';

export type GrnRelationshipHeader = {
  id: string;
  grn_number: string;
};

const docCell = (labels: string[], plural: string, emptyDoc: string) =>
  labels.length === 0
    ? emptyDoc
    : labels.length === 1
      ? labels[0]!
      : `${labels.length} ${plural}`;

/** Pure node builder for the GRN chain (exported for unit tests). `soLabels`
 *  are the family root SOs; po/pi/pr are the edge-walked nodes off THIS GRN's
 *  anchor (its parent PO, and the invoices / returns it became). Order matches
 *  the 5-node canvas: SO ▶ PO ▶ GRN (current) on the top row, PI / PR branching
 *  down from the GRN. */
export function buildGrnChainNodes(
  header: GrnRelationshipHeader,
  soLabels: string[],
  poNodes: FlowNode[],
  piNodes: FlowNode[],
  prNodes: FlowNode[],
  gates: { canOpenSo: boolean; canOpenPo: boolean; canOpenPi: boolean; canOpenPr: boolean },
): ChainNode[] {
  const gateMeta = (
    nodes: FlowNode[],
    canOpen: boolean,
    emptyMeta: string,
    gatedMeta: string,
  ): string =>
    nodes.length === 0
      ? emptyMeta
      : !canOpen
        ? gatedMeta
        : nodes.length === 1
          ? 'Tap to open'
          : 'Tap to list';
  return [
    {
      type: 'Sales Order',
      doc: docCell(soLabels, 'sales orders', 'Not linked'),
      meta:
        soLabels.length === 0
          ? 'Stock buy — no source SO'
          : !gates.canOpenSo
            ? 'Sales document'
            : soLabels.length === 1
              ? 'Tap to open'
              : 'Tap to list',
      state: soLabels.length > 0 ? 'done' : 'pending',
      actionable: soLabels.length > 0,
    },
    {
      type: 'Purchase Order',
      doc: docCell(poNodes.map((n) => n.label), 'purchase orders', 'Not linked'),
      meta: gateMeta(poNodes, gates.canOpenPo, 'No source PO', 'Procurement document'),
      state: poNodes.length > 0 ? 'done' : 'pending',
    },
    {
      type: 'GRN',
      doc: header.grn_number,
      meta: 'This document',
      state: 'current',
    },
    {
      type: 'Purchase Invoice',
      doc: docCell(piNodes.map((n) => n.label), 'invoices', 'Not created'),
      meta: gateMeta(piNodes, gates.canOpenPi, 'On supplier billing', 'Procurement document'),
      state: piNodes.length > 0 ? 'done' : 'pending',
    },
    {
      type: 'Purchase Return',
      doc: docCell(prNodes.map((n) => n.label), 'returns', 'None'),
      meta: gateMeta(prNodes, gates.canOpenPr, 'If goods are sent back', 'Procurement document'),
      state: prNodes.length > 0 ? 'done' : 'pending',
    },
  ];
}

export function useGrnRelationshipMap(header: GrnRelationshipHeader | null): {
  nodes: ChainNode[];
  onNodeClick: (n: ChainNode) => boolean;
  /* The SO ▶ PO hop is PROVENANCE — "bought for", muted, never an execution
     binding (same rule as the PO / DO maps). No floating hop: this map is keyed
     by a receipt, not a purchase doc, so there is no live MRP pairing to show. */
  pairing: { kind: PairingKind } | null;
} & DocChoiceApi {
  const navigate = useNavigate();
  const notify = useNotify();
  /* Several documents in one slot open a chooser whose every row clicks through
     (2026-08-03) — naming them and pointing at a list the doc no cannot be
     searched in left the operator copying numbers by hand. */
  const { choice, openChoice, closeChoice, pickChoice } = useDocChoice();
  const { can, pageAccess } = useAuth();

  const grnId = header?.id ?? null;
  const flow = useDocumentFlow('grn', grnId);

  /* Edge-walk off this GRN's anchor (see header comment): its parent PO, then
     the invoices / returns it became. The family root SOs are read whole (the
     graph descends from THIS GRN's PO's root SOs, so every so node in it is a
     source of this GRN). */
  const { soNodes, poNodes, piNodes, prNodes } = useMemo(() => {
    const nodes: FlowNode[] = flow.data?.nodes ?? [];
    const edges: FlowEdge[] = flow.data?.edges ?? [];
    const anchorKey = grnId ? `grn:${grnId}` : '';
    const parentPoKeys = new Set(
      edges.filter((e) => e.to === anchorKey && e.from.startsWith('po:')).map((e) => e.from),
    );
    const fromGrn = (type: FlowNode['type']) =>
      nodes.filter((n) => n.type === type && edges.some((e) => e.from === anchorKey && e.to === n.key));
    return {
      soNodes: nodes.filter((n) => n.type === 'so'),
      poNodes: nodes.filter((n) => parentPoKeys.has(n.key)),
      piNodes: fromGrn('pi'),
      prNodes: fromGrn('pr'),
    };
  }, [flow.data, grnId]);

  const soLabels = useMemo(() => soNodes.map((n) => n.label), [soNodes]);

  /* Route-gate mirrors (same OR-shape as ScmGuard): the SO detail route mounts
     on scm.sales.orders, PO / PI / PR on their procurement areas — never hand
     the operator a node that navigates straight into <Forbidden>. */
  const canOpenSo = can('scm.access') || pageAccess('scm.sales.orders') !== 'none';
  const canOpenPo = can('scm.access') || pageAccess('scm.procurement.po') !== 'none';
  const canOpenPi = can('scm.access') || pageAccess('scm.procurement.pi') !== 'none';
  const canOpenPr = can('scm.access') || pageAccess('scm.procurement.pr') !== 'none';

  const nodes: ChainNode[] = useMemo(
    () =>
      header
        ? buildGrnChainNodes(header, soLabels, poNodes, piNodes, prNodes, {
            canOpenSo,
            canOpenPo,
            canOpenPi,
            canOpenPr,
          })
        : [],
    [header, soLabels, poNodes, piNodes, prNodes, canOpenSo, canOpenPo, canOpenPi, canOpenPr],
  );

  const onNodeClick = useCallback(
    (n: ChainNode): boolean => {
      if (n.type === 'Sales Order' && soNodes.length > 0) {
        if (!canOpenSo) {
          void notify({
            title: 'Sales Orders are not open to you',
            body:
              `This receipt's goods were bought for ${soNodes.map((s) => s.label).join(', ')}. ` +
              `Opening a Sales Order needs sales access — ask an admin if you need it.`,
          });
          return false;
        }
        if (soNodes.length === 1) {
          navigate(`/scm/sales-orders/${encodeURIComponent(soNodes[0]!.id)}`);
          return true;
        }
        openChoice({
          title: 'Bought for more than one sales order',
          intro: 'The goods on this receipt were bought for several Sales Orders. Pick one to open it.',
          docs: soNodes.map((s) => ({
            id: s.id, label: s.label, sub: s.status,
            to: `/scm/sales-orders/${encodeURIComponent(s.id)}`,
          })),
        });
        return false;
      }
      if (n.type === 'Purchase Order' && poNodes.length > 0) {
        if (!canOpenPo) {
          void notify({
            title: 'Purchase Orders are not open to you',
            body:
              `This receipt was raised from ${poNodes.map((p) => p.label).join(', ')}. ` +
              `Opening a PO needs Procurement access — ask an admin if you need it.`,
          });
          return false;
        }
        if (poNodes.length === 1) {
          navigate(`/scm/purchase-orders/${poNodes[0]!.id}`);
          return true;
        }
        openChoice({
          title: 'Received against more than one purchase order',
          intro: 'This receipt covers several Purchase Orders. Pick one to open it.',
          docs: poNodes.map((p) => ({ id: p.id, label: p.label, sub: p.status, to: `/scm/purchase-orders/${p.id}` })),
        });
        return false;
      }
      if (n.type === 'Purchase Invoice' && piNodes.length > 0) {
        if (!canOpenPi) {
          void notify({
            title: 'Purchase Invoices are not open to you',
            body:
              `The supplier billed this receipt on ${piNodes.map((p) => p.label).join(', ')}. ` +
              `Opening a PI needs Procurement access — ask an admin if you need it.`,
          });
          return false;
        }
        if (piNodes.length === 1) {
          navigate(`/scm/purchase-invoices/${piNodes[0]!.id}`);
          return true;
        }
        openChoice({
          title: 'Billed on more than one invoice',
          intro: 'This receipt was billed across several Purchase Invoices. Pick one to open it.',
          docs: piNodes.map((p) => ({ id: p.id, label: p.label, sub: p.status, to: `/scm/purchase-invoices/${p.id}` })),
        });
        return false;
      }
      if (n.type === 'Purchase Return' && prNodes.length > 0) {
        if (!canOpenPr) {
          void notify({
            title: 'Purchase Returns are not open to you',
            body:
              `Goods from this receipt were returned on ${prNodes.map((p) => p.label).join(', ')}. ` +
              `Opening a return needs Procurement access — ask an admin if you need it.`,
          });
          return false;
        }
        if (prNodes.length === 1) {
          navigate(`/scm/purchase-returns/${prNodes[0]!.id}`);
          return true;
        }
        openChoice({
          title: 'Returned on more than one document',
          intro: 'Goods from this receipt went back on several Purchase Returns. Pick one to open it.',
          docs: prNodes.map((p) => ({ id: p.id, label: p.label, sub: p.status, to: `/scm/purchase-returns/${p.id}` })),
        });
        return false;
      }
      return false;
    },
    [navigate, notify, openChoice, soNodes, poNodes, piNodes, prNodes, canOpenSo, canOpenPo, canOpenPi, canOpenPr],
  );

  const pairing = useMemo<{ kind: PairingKind } | null>(
    () => (soLabels.length > 0 ? { kind: 'provenance' } : null),
    [soLabels],
  );

  return { nodes, onNodeClick, pairing, choice, openChoice, closeChoice, pickChoice };
}
