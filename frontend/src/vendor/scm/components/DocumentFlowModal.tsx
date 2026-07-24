// DocumentFlowModal — the SAP-Business-One-style "Relationship Map" popup.
//
// Given an anchor document it asks the backend for the whole family graph and
// lays it out in fixed stage-columns (no graph library): the sales chain runs
// along the top band (SO ▶ DO ▶ Invoice ▶ AR Payment) and the purchase chain
// along the bottom (SO ▶ PO ▶ GRN ▶ Purchase Invoice), with the Sales Order
// shared at the left. Connector lines are coloured by transfer kind. Clicking
// any node jumps to that document's detail page.

import { useNavigate } from 'react-router';
import {
  useDocumentFlow,
  type FlowNode,
  type FlowNodeType,
  type FlowEdgeKind,
} from '../lib/flow-queries';
import { statusLabel, humaniseStatusKey, simplifiedAmendmentPill, STATUS_TONES, type StatusDocType } from '../lib/status-pill';

type Props = { type: FlowNodeType; id: string; open: boolean; onClose: () => void };

/* Every node on the relationship map printed its RAW db status, so the operator
   read `PARTIALLY_RECEIVED` / `IN_PRODUCTION` / `PARTIALLY_PAID` (owner
   2026-07-16: 白話文). Route the 8 node types that HAVE a canonical map through
   statusLabel; the consignment / payment types have none, so they fall back to
   the same humaniser resolveStatusPill uses. Never the raw key.
   NB: a plain statusLabel(n.type, ...) does not typecheck AND would throw —
   FlowNodeType is wider than StatusDocType. */
const FLOW_STATUS_DOC_TYPE: Partial<Record<FlowNodeType, StatusDocType>> = {
  so: 'so', do: 'do', si: 'si', po: 'po', grn: 'grn', pi: 'pi', dr: 'dr', pr: 'pr',
};
const flowStatusLabel = (n: FlowNode): string => {
  const docType = FLOW_STATUS_DOC_TYPE[n.type];
  return docType ? statusLabel(docType, n.status) : humaniseStatusKey(n.status);
};

const NODE_W = 196;
const NODE_H = 86;
const COL_GAP = 84;
const ROW_GAP = 20;
const BAND_GAP = 80;
const PAD = 28;

const TYPE_META: Record<
  FlowNodeType,
  { col: number; band: 'top' | 'bottom' | 'mid'; title: string; route: ((id: string) => string) | null; bg: string; accent: string }
> = {
  so:      { col: 0, band: 'mid',    title: 'Sales Order',      route: (id) => `/mfg-sales-orders/${id}`,   bg: '#eef2ff', accent: '#4f46e5' },
  do:      { col: 1, band: 'top',    title: 'Delivery Order',   route: (id) => `/mfg-delivery-orders/${id}`, bg: '#ecfeff', accent: '#0891b2' },
  si:      { col: 2, band: 'top',    title: 'Invoice',          route: (id) => `/sales-invoices/${id}`,      bg: '#fff7ed', accent: '#ea580c' },
  payment: { col: 3, band: 'top',    title: 'AR Payment',       route: null,                                  bg: '#f0fdf4', accent: '#16a34a' },
  po:      { col: 1, band: 'bottom', title: 'Purchase Order',   route: (id) => `/scm/purchase-orders/${id}`, bg: '#faf5ff', accent: '#9333ea' },
  grn:     { col: 2, band: 'bottom', title: 'Goods Receive',    route: (id) => `/grns/${id}`,                bg: '#f0f9ff', accent: '#0284c7' },
  pi:      { col: 3, band: 'bottom', title: 'Purchase Invoice', route: (id) => `/purchase-invoices/${id}`,   bg: '#fefce8', accent: '#ca8a04' },
  // Returns reverse goods. A Delivery Return hangs off its DO (sales/top band),
  // a Purchase Return off its GRN (purchase/bottom band). Both sit one column
  // right of their parent and share a warm red accent to read as "sent back".
  dr:      { col: 2, band: 'top',    title: 'Delivery Return',  route: (id) => `/delivery-returns/${id}`,    bg: '#fef2f2', accent: '#b91c1c' },
  pr:      { col: 3, band: 'bottom', title: 'Purchase Return',  route: (id) => `/purchase-returns/${id}`,    bg: '#fef2f2', accent: '#b91c1c' },
  // Consignment family — its own self-contained map (sales OR purchase chain,
  // never both at once). cso/pco are the roots (mid), notes/receipts and their
  // returns fan out to the right exactly like the SO→DO→DR / PO→GRN→PR layout.
  cso:     { col: 0, band: 'mid',    title: 'Consignment Order',  route: (id) => `/consignment/${id}`,                  bg: '#eef2ff', accent: '#4f46e5' },
  cdo:     { col: 1, band: 'top',    title: 'Consignment Note',   route: (id) => `/consignment-note/${id}`,             bg: '#ecfeff', accent: '#0891b2' },
  cdr:     { col: 2, band: 'top',    title: 'Consignment Return', route: (id) => `/consignment-return/${id}`,           bg: '#fef2f2', accent: '#b91c1c' },
  pco:     { col: 0, band: 'mid',    title: 'PC Order',           route: (id) => `/purchase-consignment/${id}`,         bg: '#faf5ff', accent: '#9333ea' },
  pcr:     { col: 1, band: 'bottom', title: 'PC Receive',         route: (id) => `/purchase-consignment-receive/${id}`, bg: '#f0f9ff', accent: '#0284c7' },
  pcrn:    { col: 2, band: 'bottom', title: 'PC Return',          route: (id) => `/purchase-consignment-return/${id}`,  bg: '#fef2f2', accent: '#b91c1c' },
};

const EDGE_COLOR: Record<FlowEdgeKind, string> = {
  full: '#2563eb',
  partial: '#dc2626',
  value: '#ea580c',
  payment: '#16a34a',
};
const LEGEND: Array<{ kind: FlowEdgeKind; label: string }> = [
  { kind: 'full', label: 'Full Transfer' },
  { kind: 'partial', label: 'Partial Transfer' },
  { kind: 'value', label: 'Value Transfer' },
  { kind: 'payment', label: 'Payment' },
];

const colX = (col: number) => PAD + col * (NODE_W + COL_GAP);

export function DocumentFlowModal({ type, id, open, onClose }: Props) {
  const navigate = useNavigate();
  const { data, isLoading, isError } = useDocumentFlow(open ? type : null, open ? id : null);

  if (!open) return null;

  const nodes = data?.nodes ?? [];
  const edges = data?.edges ?? [];
  // PO amendments (mig 0192) branch off the Purchase Order — rendered as a
  // clickable chip row below the map, the same idiom #1229 used for SO
  // amendments on the SO map. Each opens /scm/po-amendments/:id.
  const poAmendments = data?.poAmendments ?? [];

  const goPoAmendment = (amendmentId: string) => {
    onClose();
    navigate(`/scm/po-amendments/${amendmentId}`);
  };

  // ── Layout: assign every node an (x, y) ─────────────────────────────────
  const pos = new Map<string, { x: number; y: number }>();
  const byColBand = (band: 'top' | 'bottom') => {
    const cols = new Map<number, FlowNode[]>();
    for (const n of nodes) {
      const m = TYPE_META[n.type];
      if (m.band !== band) continue;
      const list = cols.get(m.col) ?? [];
      list.push(n);
      cols.set(m.col, list);
    }
    for (const list of cols.values()) list.sort((a, b) => (a.label ?? '').localeCompare(b.label ?? ''));
    return cols;
  };
  const topCols = byColBand('top');
  const bottomCols = byColBand('bottom');
  const topMax = Math.max(0, ...[...topCols.values()].map((l) => l.length));
  const bottomMax = Math.max(0, ...[...bottomCols.values()].map((l) => l.length));

  const topBandH = topMax > 0 ? topMax * (NODE_H + ROW_GAP) - ROW_GAP : 0;
  const bottomTop = PAD + topBandH + (topMax > 0 && bottomMax > 0 ? BAND_GAP : 0);
  const bottomBandH = bottomMax > 0 ? bottomMax * (NODE_H + ROW_GAP) - ROW_GAP : 0;
  const bandsBottom = bottomMax > 0 ? bottomTop + bottomBandH : PAD + topBandH;

  // The SO column is vertically centred across both bands. The canvas must fit
  // whichever is taller — the bands OR the SO block — otherwise a document with
  // no downstream rows (a lone SO node) gets clipped at the bottom.
  // The mid column holds the chain root — an SO, or a consignment root
  // (cso / pco), all of which use band 'mid'.
  const soNodes = nodes.filter((n) => TYPE_META[n.type].band === 'mid').sort((a, b) => (a.label ?? '').localeCompare(b.label ?? ''));
  const soBlockH = soNodes.length > 0 ? soNodes.length * (NODE_H + ROW_GAP) - ROW_GAP : 0;
  const contentBottom = Math.max(bandsBottom, PAD + soBlockH);

  for (const [col, list] of topCols) list.forEach((n, i) => pos.set(n.key, { x: colX(col), y: PAD + i * (NODE_H + ROW_GAP) }));
  for (const [col, list] of bottomCols) list.forEach((n, i) => pos.set(n.key, { x: colX(col), y: bottomTop + i * (NODE_H + ROW_GAP) }));
  const soStart = PAD + Math.max(0, (contentBottom - PAD - soBlockH) / 2);
  soNodes.forEach((n, i) => pos.set(n.key, { x: colX(0), y: soStart + i * (NODE_H + ROW_GAP) }));

  const width = colX(3) + NODE_W + PAD;
  const height = contentBottom + PAD;

  const go = (n: FlowNode) => {
    const route = TYPE_META[n.type].route;
    if (!route) return;
    onClose();
    navigate(route(n.id));
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '48px 20px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'white', borderRadius: 10, boxShadow: '0 24px 64px rgba(0,0,0,0.3)',
          width: '100%', maxWidth: 1160, maxHeight: 'calc(100vh - 96px)', display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 22px', borderBottom: '1px solid var(--c-line)' }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--c-burnt)' }}>
              Relationship Map
            </div>
            <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--c-ink)' }}>
              {TYPE_META[type].title} {id}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 0, cursor: 'pointer', fontSize: 22, color: 'var(--fg-muted)', lineHeight: 1 }} aria-label="Close">×</button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 22, background: 'var(--c-cream)', display: 'flex', minHeight: 460 }}>
          {isLoading && <div style={{ color: 'var(--fg-muted)', padding: 40, textAlign: 'center' }}>Loading map…</div>}
          {isError && <div style={{ color: '#9f1239', padding: 40, textAlign: 'center' }}>Could not load the relationship map.</div>}
          {!isLoading && !isError && (
            <div style={{ position: 'relative', width, height, margin: 'auto' }}>
              <svg width={width} height={height} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                <defs>
                  {Object.entries(EDGE_COLOR).map(([k, color]) => (
                    <marker key={k} id={`arrow-${k}`} markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
                      <path d="M0,0 L7,3 L0,6 Z" fill={color} />
                    </marker>
                  ))}
                </defs>
                {edges.map((e, i) => {
                  const p = pos.get(e.from); const ch = pos.get(e.to);
                  if (!p || !ch) return null;
                  const x1 = p.x + NODE_W, y1 = p.y + NODE_H / 2;
                  const x2 = ch.x, y2 = ch.y + NODE_H / 2;
                  const mx = (x1 + x2) / 2;
                  return (
                    <path
                      key={i}
                      d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2 - 2} ${y2}`}
                      fill="none" stroke={EDGE_COLOR[e.kind]} strokeWidth={2}
                      markerEnd={`url(#arrow-${e.kind})`}
                    />
                  );
                })}
              </svg>
              {nodes.map((n) => {
                const p = pos.get(n.key); if (!p) return null;
                const m = TYPE_META[n.type];
                const clickable = !!m.route;
                const cancelled = (n.status ?? '').toUpperCase() === 'CANCELLED';
                return (
                  <div
                    key={n.key}
                    onClick={() => go(n)}
                    title={clickable ? 'Open document' : undefined}
                    style={{
                      position: 'absolute', left: p.x, top: p.y, width: NODE_W, height: NODE_H,
                      boxSizing: 'border-box', borderRadius: 8, padding: '10px 12px',
                      background: n.isAnchor ? '#fff7d6' : m.bg,
                      border: n.isAnchor ? '2px solid #d4a017' : '1px solid var(--c-line)',
                      cursor: clickable ? 'pointer' : 'default',
                      display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2,
                      opacity: cancelled ? 0.55 : 1,
                      boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
                    }}
                  >
                    <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: m.accent }}>{m.title}</div>
                    <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--c-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: cancelled ? 'line-through' : 'none' }}>{n.label}</div>
                    {n.status && <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{flowStatusLabel(n)}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {!isLoading && !isError && poAmendments.length > 0 && (
          <div style={{ padding: '12px 22px', borderTop: '1px solid var(--c-line)' }}>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--c-burnt)', marginBottom: 8 }}>
              Amendments off the Purchase Order
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {poAmendments.map((a) => {
                const { label, tone } = simplifiedAmendmentPill(a.status);
                const { bg, fg } = STATUS_TONES[tone];
                return (
                  <button
                    key={a.id}
                    onClick={() => goPoAmendment(a.id)}
                    title="Open PO amendment"
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                      border: '1px solid var(--c-line)', borderRadius: 8, padding: '6px 10px',
                      background: 'white', fontFamily: 'inherit',
                    }}
                  >
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--c-ink)' }}>
                      {a.amendmentNo != null && String(a.amendmentNo).trim() !== '' ? String(a.amendmentNo) : `Amendment ${a.poNumber}`}
                    </span>
                    <span style={{ fontSize: 10.5, fontWeight: 600, borderRadius: 999, padding: '2px 8px', background: bg, color: fg }}>
                      {label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 18, alignItems: 'center', padding: '12px 22px', borderTop: '1px solid var(--c-line)', flexWrap: 'wrap' }}>
          {LEGEND.map((l) => (
            <span key={l.kind} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--c-ink)' }}>
              <span style={{ width: 22, height: 0, borderTop: `3px solid ${EDGE_COLOR[l.kind]}` }} />
              {l.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
