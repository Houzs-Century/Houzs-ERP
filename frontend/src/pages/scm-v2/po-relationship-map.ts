// po-relationship-map — the ONE builder for the Purchase Order's 5-node
// Relationship Map, the purchase-side sibling of so-relationship-map.ts /
// sales-doc-relationship-map.ts. Every node is read from the LIVE
// `/document-flow` graph (the same company-scoped source every other map
// uses), never a hand-built literal chain. Chain, from the PO's perspective
// (owner 2026-07-27 — "PO 页要有 relation map"):
//   Sales Order ▶ Purchase Order (current) ▶ GRN, then billing follows
//   receipt: Purchase Invoice ▶ Purchase Return.
//
// ANCHORED traversal, not the family-wide slots the sales maps use: the graph
// resolves the whole document family off the root SO(s), which can hold
// SIBLING POs (one SO covered by several buys) — and a sibling's GRN must not
// paint THIS PO's GRN node done while its own receipt progress sits at 0. So
// the GRN / PI / PR nodes are walked along the graph's edges from this PO's
// anchor key (po:{id} ▶ grn ▶ pi/pr), which are the real FKs
// (grns.purchase_order_id, purchase_invoices.grn_id, purchase_returns.grn_id).
//
// The Sales Order node is the anchor resolution itself (rootSos ARE this PO's
// source SOs — resolved through purchase_order_items.so_item_id). A PO raised
// before the MRP-linked flow (2026-07-09) carries no so_item_id, so the graph
// resolves no root — for those the node falls back to the SO doc numbers the
// PO's own "From SOs: …" note records, which is the authoritative raise-time
// record, not a guess (same ruling as document-flow's note-linked PO nodes).

import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useDocumentFlow, usePoSoCoverage, floatingSoDocNos, type FlowNode, type FlowEdge } from '../../vendor/scm/lib/flow-queries';
import type { ChainNode, AmendmentChip, PairingKind } from '../../components/scm-v2/DocumentRelationshipMapModal';
import { useDocChoice, type DocChoiceApi } from './doc-choice';

export type PoRelationshipHeader = {
  id: string;
  po_number: string;
  notes?: string | null;
};

/* The SO doc numbers a PO's "From SOs: …" note records. Frontend twin of the
   backend's parseFromSosNote (document-flow.ts) — the note FORMAT's one home is
   the writer `From SOs: ${docNos.join(', ')}` in mfg-purchase-orders.ts; both
   parsers match that label (case-insensitive, optional plural) and split on
   commas. Returns [] for a plain free-text note. */
export const parsePoNoteSos = (note: string | null | undefined): string[] => {
  if (!note) return [];
  const m = /^\s*From SOs?:\s*(.+)$/im.exec(String(note).trim());
  if (!m) return [];
  return [...new Set(m[1]!.split(',').map((s) => s.trim()).filter(Boolean))];
};

const docCell = (labels: string[], plural: string, emptyDoc: string) =>
  labels.length === 0
    ? emptyDoc
    : labels.length === 1
      ? labels[0]!
      : `${labels.length} ${plural}`;

/** Pure node builder for the PO chain (exported for unit tests). `soLabels`
 *  merges the graph's root-SO nodes with the note fallback (the hook does the
 *  merge); grn/pi/pr are the edge-walked nodes off THIS PO's anchor.
 *  `floatingSos` ("soft until DO, hard from DO") are the SO doc numbers the
 *  live MRP allocation currently pairs this PO with (coverage source 'mrp') —
 *  shown, never stored: the slot floats (dashed, "~") when nothing stored
 *  backs it, and a stored raise-link always paints the slot solid. */
export function buildPoChainNodes(
  header: PoRelationshipHeader,
  soLabels: string[],
  grnNodes: FlowNode[],
  piNodes: FlowNode[],
  prNodes: FlowNode[],
  gates: { canOpenSo: boolean; canOpenGrn: boolean; canOpenPi: boolean; canOpenPr: boolean },
  floatingSos: string[] = [],
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
  // A floating SO that is ALSO stored (another SKU's raise-link) shows once.
  const floatOnly = floatingSos.filter((d) => !soLabels.includes(d));
  const allSo = [...soLabels, ...floatOnly];
  const purelyFloating = soLabels.length === 0 && floatOnly.length > 0;
  return [
    {
      type: 'Sales Order',
      doc: docCell(allSo, 'sales orders', 'Not linked'),
      meta:
        allSo.length === 0
          ? 'Stock buy — no source SO'
          : !gates.canOpenSo
            ? 'Sales document'
            : purelyFloating
              ? allSo.length === 1
                ? 'Live MRP pairing — tap'
                : 'Live MRP pairings — tap'
              : allSo.length === 1
                ? 'Tap to open'
                : 'Tap to list',
      // Only a STORED link paints the slot done/green; a floating pairing is
      // a live fact, not a record — it renders dashed via `float`.
      state: soLabels.length > 0 ? 'done' : 'pending',
      actionable: allSo.length > 0,
      float: purelyFloating,
    },
    {
      type: 'Purchase Order',
      doc: header.po_number,
      meta: 'This document',
      state: 'current',
    },
    {
      type: 'GRN',
      doc: docCell(grnNodes.map((n) => n.label), 'GRNs', 'Not created'),
      meta: gateMeta(grnNodes, gates.canOpenGrn, 'On supplier delivery', 'Procurement document'),
      state: grnNodes.length > 0 ? 'done' : 'pending',
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

export function usePoRelationshipMap(header: PoRelationshipHeader | null): {
  nodes: ChainNode[];
  onNodeClick: (n: ChainNode) => boolean;
  amendments: AmendmentChip[];
  onAmendmentClick: (a: AmendmentChip) => boolean;
  /* How this PO's SO hop is paired — 'floating' when any live MRP pairing
     exists, 'provenance' when only stored raise-links do, null when neither.
     The modal restyles the SO↔PO connector from it. */
  pairing: { kind: PairingKind } | null;
} & DocChoiceApi {
  const navigate = useNavigate();
  const notify = useNotify();
  /* Several documents in one slot open a chooser whose every row clicks through
     (2026-08-03) — naming them and pointing at a list the doc no cannot be
     searched in left the operator copying numbers by hand. */
  const { choice, openChoice, closeChoice, pickChoice } = useDocChoice();
  const { can, pageAccess } = useAuth();

  const poId = header?.id ?? null;
  const flow = useDocumentFlow('po', poId);

  /* FLOATING pre-DO pairing ("soft until DO, hard from DO") — the SO doc
     numbers the live MRP allocation currently assigns this PO to, read from
     the SAME usePoSoCoverage query key the PO list drill-down and every other
     coverage reader use. Common path = react-query cache hit; cold path = the
     one normal coverage fetch. NEVER a new endpoint, never a computeMrp call
     added to document-flow (owner constraint: zero new backend load). */
  const cov = usePoSoCoverage('po', poId);
  const floatingSos = useMemo(() => floatingSoDocNos(cov.data), [cov.data]);

  /* Edge-walk off this PO's anchor (see header comment): its own GRNs, then
     the invoices / returns those GRNs carry. */
  const { soNodes, grnNodes, piNodes, prNodes } = useMemo(() => {
    const nodes: FlowNode[] = flow.data?.nodes ?? [];
    const edges: FlowEdge[] = flow.data?.edges ?? [];
    const anchorKey = poId ? `po:${poId}` : '';
    const grnKeys = new Set(
      edges.filter((e) => e.from === anchorKey && e.to.startsWith('grn:')).map((e) => e.to),
    );
    const fromGrn = (type: FlowNode['type']) =>
      nodes.filter((n) => n.type === type && edges.some((e) => grnKeys.has(e.from) && e.to === n.key));
    return {
      soNodes: nodes.filter((n) => n.type === 'so'),
      grnNodes: nodes.filter((n) => grnKeys.has(n.key)),
      piNodes: fromGrn('pi'),
      prNodes: fromGrn('pr'),
    };
  }, [flow.data, poId]);

  /* Note fallback fires only when the flow has LOADED and resolved no root SO
     (pre-MRP PO) — a linked PO never shows note tokens over real nodes. */
  const flowLoaded = !flow.isLoading && flow.data != null;
  const noteSos = useMemo(
    () => (flowLoaded && soNodes.length === 0 ? parsePoNoteSos(header?.notes) : []),
    [flowLoaded, soNodes.length, header?.notes],
  );
  const soLabels = useMemo(
    () => (soNodes.length > 0 ? soNodes.map((n) => n.label) : noteSos),
    [soNodes, noteSos],
  );
  // Floating SOs no stored link already names (a stored raise-link always
  // paints the slot solid; the pairing HOP can still float — see `pairing`).
  const floatOnlySos = useMemo(
    () => floatingSos.filter((d) => !soLabels.includes(d)),
    [floatingSos, soLabels],
  );
  const pairing = useMemo<{ kind: PairingKind } | null>(
    () =>
      floatingSos.length > 0
        ? { kind: 'floating' }
        : soLabels.length > 0
          ? { kind: 'provenance' }
          : null,
    [floatingSos, soLabels],
  );

  /* Amendments branch off this PO — BOTH kinds (owner 2026-07-27, "这个应该有
     amendment SO 怎么没有?"):
       · SO amendments off this PO's source SO — a pending SO revision is the
         reason this PO must be re-approved, so it belongs on the PO map; the
         graph already returns them (document-flow resolves them for the root
         SO regardless of anchor type). Chip → /scm/amendments/:id.
       · direct PO amendments on this PO (poAmendments spans sibling POs, so
         keep this PO's own). Chip → /scm/po-amendments/:id.
     The kind is carried in an id PREFIX ("so:" / "po:") so the one click
     handler routes to the right job card; both detail routes are gated on
     areas this PO page's viewer already holds. */
  const amendments: AmendmentChip[] = useMemo(() => {
    const so = (flow.data?.amendments ?? []).map((a) => ({
      id: `so:${a.id}`,
      label: `SO Amendment ${a.amendmentNo}`,
      status: a.status,
    }));
    const po = (flow.data?.poAmendments ?? [])
      .filter((a) => a.poId === poId)
      .map((a) => ({
        id: `po:${a.id}`,
        label: `PO Amendment ${a.amendmentNo}`,
        status: a.status,
      }));
    return [...so, ...po];
  }, [flow.data, poId]);
  const onAmendmentClick = useCallback(
    (a: AmendmentChip): boolean => {
      const [kind, ...rest] = a.id.split(":");
      const realId = rest.join(":");
      navigate(kind === "so" ? `/scm/amendments/${realId}` : `/scm/po-amendments/${realId}`);
      return true;
    },
    [navigate],
  );

  /* Route-gate mirrors (same OR-shape as ScmGuard): the SO detail route mounts
     on scm.sales.orders, GRN / PI / PR on their procurement areas — never hand
     the operator a node that navigates straight into <Forbidden>. */
  const canOpenSo = can('scm.access') || pageAccess('scm.sales.orders') !== 'none';
  const canOpenGrn = can('scm.access') || pageAccess('scm.procurement.grn') !== 'none';
  const canOpenPi = can('scm.access') || pageAccess('scm.procurement.pi') !== 'none';
  const canOpenPr = can('scm.access') || pageAccess('scm.procurement.pr') !== 'none';

  const nodes: ChainNode[] = useMemo(
    () =>
      header
        ? buildPoChainNodes(header, soLabels, grnNodes, piNodes, prNodes, {
            canOpenSo,
            canOpenGrn,
            canOpenPi,
            canOpenPr,
          }, floatingSos)
        : [],
    [header, soLabels, grnNodes, piNodes, prNodes, canOpenSo, canOpenGrn, canOpenPi, canOpenPr, floatingSos],
  );

  const onNodeClick = useCallback(
    (n: ChainNode): boolean => {
      if (n.type === 'Sales Order' && (soLabels.length > 0 || floatOnlySos.length > 0)) {
        if (!canOpenSo) {
          void notify({
            title: 'Sales Orders are not open to you',
            body:
              (soLabels.length > 0
                ? `This PO was raised from ${soLabels.join(', ')}. `
                : `MRP currently pairs this PO with ${floatOnlySos.join(', ')} — a live pairing, not a stored link. `) +
              `Opening a Sales Order needs sales access — ask an admin if you need it.`,
          });
          return false;
        }
        /* Stored rows first (graph so-nodes navigate by doc_no — their id;
           note tokens are the doc numbers verbatim), then the floating
           pairings, each row saying what it is — live, never a stored link. */
        const storedRows = soNodes.length > 0
          ? soNodes.map((so) => ({ id: so.id, label: so.label, sub: so.status as string | null }))
          : noteSos.map((doc) => ({ id: doc, label: doc, sub: null as string | null }));
        const floatRows = floatOnlySos.map((doc) => ({
          id: doc, label: `${doc} ~`, sub: 'Live MRP pairing — may change' as string | null,
        }));
        const rows = [...storedRows, ...floatRows];
        if (rows.length === 1) {
          navigate(`/scm/sales-orders/${encodeURIComponent(rows[0]!.id)}`);
          return true;
        }
        /* Several SOs, one slot. The SO list searches its own refs, not a PO
           number, so "go find them" landed nowhere — each SO is a row that opens
           it. Graph so-nodes and note tokens are both doc numbers, so both route
           the same way. */
        openChoice({
          title: floatRows.length === 0
            ? 'Raised from more than one sales order'
            : 'Paired with more than one sales order',
          intro: floatRows.length === 0
            ? 'This PO covers several Sales Orders. Pick one to open it.'
            : 'Plain rows are stored raise-links; "~" rows are the live MRP pairing and may change on the next view. Pick one to open it.',
          docs: rows.map((d) => ({ ...d, to: `/scm/sales-orders/${encodeURIComponent(d.id)}` })),
        });
        return false;
      }
      if (n.type === 'GRN' && grnNodes.length > 0) {
        if (!canOpenGrn) {
          void notify({
            title: 'Goods Received is not open to you',
            body:
              `This PO's goods were received on ${grnNodes.map((g) => g.label).join(', ')}. ` +
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
          intro: "This PO's goods arrived across several Goods Received notes. Pick one to open it.",
          docs: grnNodes.map((g) => ({ id: g.id, label: g.label, sub: g.status, to: `/scm/grns/${g.id}` })),
        });
        return false;
      }
      if (n.type === 'Purchase Invoice' && piNodes.length > 0) {
        if (!canOpenPi) {
          void notify({
            title: 'Purchase Invoices are not open to you',
            body:
              `The supplier billed this PO on ${piNodes.map((p) => p.label).join(', ')}. ` +
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
          intro: 'The supplier billed this PO across several Purchase Invoices. Pick one to open it.',
          docs: piNodes.map((p) => ({ id: p.id, label: p.label, sub: p.status, to: `/scm/purchase-invoices/${p.id}` })),
        });
        return false;
      }
      if (n.type === 'Purchase Return' && prNodes.length > 0) {
        if (!canOpenPr) {
          void notify({
            title: 'Purchase Returns are not open to you',
            body:
              `Goods from this PO were returned on ${prNodes.map((p) => p.label).join(', ')}. ` +
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
          intro: 'Goods from this PO went back on several Purchase Returns. Pick one to open it.',
          docs: prNodes.map((p) => ({ id: p.id, label: p.label, sub: p.status, to: `/scm/purchase-returns/${p.id}` })),
        });
        return false;
      }
      return false;
    },
    [navigate, notify, openChoice, soLabels, floatOnlySos, soNodes, noteSos, grnNodes, piNodes, prNodes, canOpenSo, canOpenGrn, canOpenPi, canOpenPr],
  );

  return { nodes, onNodeClick, amendments, onAmendmentClick, pairing, choice, openChoice, closeChoice, pickChoice };
}
