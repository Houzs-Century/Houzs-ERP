// MobileRelationshipMap — the PHONE surface of the living Relationship Map
// (desktop: vendor DocumentFlowModal + scm-v2 DocumentRelationshipMapModal,
// PR #1676). One product, two presentations: instead of the desktop's SVG
// stage-column canvas, the phone renders the SAME graph as a stacked chain
// list — sales chain and procurement chain as stage-ordered card groups with
// solid connectors, and the SO ▸ PO hop as explicit pairing rows carrying the
// three identities (solid = executed chain, muted "Bought for" = provenance,
// dashed + "~" = floating live MRP pairing).
//
// ZERO added backend load (owner constraint "它可能会 API 爆炸", same rule the
// desktop feature shipped under): it reads the SAME useDocumentFlow query the
// desktop modal reads (staleTime 30s) and, for purchase anchors, the SAME
// usePoSoCoverage query key the mobile document detail ALREADY fetched for its
// Assigned-SO chips — so the coverage read is a react-query cache hit, the
// floating overlay is assembled client-side by the pinned buildFloatingOverlay,
// and no polling, no new endpoint, no extra call class exists. An SO anchor
// deliberately fetches NO coverage: coverage is purchase-doc-keyed, and an
// SO-keyed read would be new backend load (same deliberate gap as the desktop
// SO map — the SO detail already shows the same engine's answer per line).
//
// Chip dress mirrors ./source-chips.tsx (solidChip / mutedChip / floatingChip)
// — keep the two in lockstep.

import { useMemo } from "react";
import {
  useDocumentFlow,
  usePoSoCoverage,
  type FlowNodeType,
} from "../vendor/scm/lib/flow-queries";
import { statusLabel, humaniseStatusKey, type StatusDocType } from "../vendor/scm/lib/status-pill";
import {
  buildMobileMapModel,
  CHAIN_LEGEND,
  FLOATING_LEGEND,
  FLOATING_TITLE,
  PROVENANCE_LEGEND,
  PROVENANCE_TITLE,
  type FlowNav,
  type MobileMapCard,
} from "./relationship-map-model";
import "./mobile.css";

/* Raw db statuses read as 白話文 — same routing as the desktop modal's
   flowStatusLabel (statusLabel for the 8 canonical types, humanised fallback
   for payment/consignment). */
const STATUS_DOC_TYPE: Partial<Record<FlowNodeType, StatusDocType>> = {
  so: "so", do: "do", si: "si", po: "po", grn: "grn", pi: "pi", dr: "dr", pr: "pr",
};
const cardStatus = (c: MobileMapCard): string => {
  const docType = STATUS_DOC_TYPE[c.type];
  return docType ? statusLabel(docType, c.status) : humaniseStatusKey(c.status);
};

/* Chip dress — lockstep with ./source-chips.tsx. */
const chipBase: React.CSSProperties = {
  fontFamily: "monospace", fontSize: 11, fontWeight: 700, color: "#0c3f39",
  background: "#eef3f1", border: "1px solid #d7e2de", borderRadius: 5, padding: "1px 6px",
};
const mutedChip: React.CSSProperties = {
  ...chipBase, color: "#5c6357", background: "#f4f6f3", border: "1px solid #d9ded4",
};
const floatingChip: React.CSSProperties = {
  ...mutedChip, background: "transparent", border: "1px dashed #b6c6c0",
};

const eyebrowStyle: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: ".13em", textTransform: "uppercase",
  color: "#a16a2e", margin: "2px 2px 8px",
};

/* One document card. Tappable only when a mobile screen exists AND the shell
   says this position may open it (nav.can — the same fail-closed gate the menu
   rows use); everything else renders inert, matching "off, not hide". */
function MapCard({ card, nav, onClose }: { card: MobileMapCard; nav?: FlowNav; onClose: () => void }) {
  const target = card.nav && nav && nav.can(card.nav) ? card.nav : null;
  const open = target ? () => { onClose(); nav!.open(target); } : undefined;
  return (
    <div
      onClick={open}
      role={open ? "button" : undefined}
      title={card.floating ? FLOATING_TITLE : open ? "Open document" : undefined}
      style={{
        background: card.isAnchor ? "#fff7d6" : "#fff",
        border: card.isAnchor ? "2px solid #d4a017" : card.floating ? "1.5px dashed #b6c6c0" : "1px solid #e3e6e0",
        borderRadius: 12, padding: "9px 12px",
        opacity: card.cancelled ? 0.55 : 1,
        cursor: open ? "pointer" : "default",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: ".3px", textTransform: "uppercase", color: "#9aa093" }}>
          {card.title}{card.isAnchor ? " · this document" : ""}
        </span>
        {card.status && (
          <span style={{ fontSize: 10, fontWeight: 700, color: "#5c6357", flex: "none" }}>{cardStatus(card)}</span>
        )}
      </div>
      <div
        className="money"
        style={{
          fontSize: 13, fontWeight: 800, color: "#11140f", marginTop: 2,
          textDecoration: card.cancelled ? "line-through" : "none", wordBreak: "break-all",
        }}
      >
        {card.label}{card.floating ? " ~" : ""}
        {open && <span style={{ color: "#16695f", fontWeight: 600, marginLeft: 6 }}>{"›"}</span>}
      </div>
      {card.fromLabels.length > 0 && (
        <div className="money" style={{ fontSize: 10, color: "#9aa093", marginTop: 2 }}>
          From {card.fromLabels.join(", ")}{card.partial ? " · partial" : ""}
        </div>
      )}
    </div>
  );
}

/* The solid vertical connector between consecutive stages — every vertical hop
   is an execution FK (anchored history); the only non-chain hop, SO ▸ PO, is
   the pairing section instead. */
function ChainConnector() {
  return (
    <div aria-hidden title={CHAIN_LEGEND} style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 24, marginLeft: 14 }}>
      <div style={{ width: 2, height: 12, background: "#b3b8ac" }} />
      <div style={{ color: "#b3b8ac", fontSize: 9, lineHeight: 1, marginTop: -1 }}>{"▼"}</div>
    </div>
  );
}

function ChainSection({ title, groups, nav, onClose }: {
  title: string; groups: MobileMapCard[][]; nav?: FlowNav; onClose: () => void;
}) {
  if (groups.length === 0) return null;
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={eyebrowStyle}>{title}</div>
      {groups.map((group, gi) => (
        <div key={group[0]?.key ?? gi}>
          {gi > 0 && <ChainConnector />}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {group.map((c) => <MapCard key={c.key} card={c} nav={nav} onClose={onClose} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

export function MobileRelationshipMap({ type, id, label, onClose, nav }: {
  type: FlowNodeType;
  /** document-flow anchor id: the SO doc_no for `so`, the uuid for the rest. */
  id: string;
  /** Header title — the anchor's document number. Falls back to the id. */
  label?: string;
  onClose: () => void;
  /** Screen navigation, provided by MobileApp. Absent → every node is inert. */
  nav?: FlowNav;
}) {
  const flowQ = useDocumentFlow(type, id);
  /* Coverage ONLY for purchase anchors, on the SAME query key the document
     detail already fetched — cache hit, zero added load (see file header). */
  const covType = type === "po" || type === "grn" || type === "pi" ? type : null;
  const covQ = usePoSoCoverage(covType, covType ? id : null);
  const model = useMemo(
    () => buildMobileMapModel(flowQ.data, covQ.data),
    [flowQ.data, covQ.data],
  );
  const amendments = flowQ.data?.amendments ?? [];
  const poAmendments = flowQ.data?.poAmendments ?? [];

  return (
    <div className="hz-m" style={{ position: "fixed", inset: 0, zIndex: 80, display: "flex", flexDirection: "column", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button className="back" onClick={onClose}><span className="chev">{"‹"}</span> Back</button>
        </div>
        <div className="eyebrow" style={{ marginTop: 7 }}>Relationship Map</div>
        <div className="scr-title money">{label || id}</div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 14, paddingBottom: 40 }}>
        {flowQ.isLoading && (
          <div style={{ fontSize: 11.5, color: "#9aa093", textAlign: "center", padding: "26px 0" }}>Loading map{"…"}</div>
        )}
        {!!flowQ.isError && !flowQ.isLoading && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, background: "var(--red-bg, #f8eaea)", border: "1px solid #e6cccc", borderRadius: 12, padding: "11px 13px" }}>
            <span style={{ fontSize: 12, color: "var(--red, #b23a3a)", fontWeight: 600 }}>Couldn't load the relationship map</span>
            <button onClick={() => flowQ.refetch()} style={{ border: "none", background: "transparent", color: "var(--red, #b23a3a)", fontFamily: "inherit", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Retry</button>
          </div>
        )}
        {!flowQ.isLoading && !flowQ.isError && !model.hasContent && (
          <div style={{ fontSize: 11.5, color: "#9aa093", textAlign: "center", padding: "26px 0" }}>No linked documents.</div>
        )}

        {!flowQ.isLoading && !flowQ.isError && model.hasContent && (
          <>
            <ChainSection title="Sales chain" groups={model.sales} nav={nav} onClose={onClose} />

            {model.pairings.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={eyebrowStyle}>Sales ▸ Procurement pairing</div>
                <div style={{ background: "#fff", border: "1px solid #e3e6e0", borderRadius: 12, padding: "4px 12px" }}>
                  {model.pairings.map((p) => {
                    const floating = p.identity === "floating";
                    const title = floating ? FLOATING_TITLE : PROVENANCE_TITLE;
                    const soOpen = p.soNav && nav && nav.can(p.soNav)
                      ? () => { onClose(); nav.open(p.soNav!); }
                      : undefined;
                    return (
                      <div key={`${p.identity}-${p.soDocNo}-${p.poLabel}`} style={{ padding: "8px 0", borderBottom: "1px solid #f0f2ee" }}>
                        <div className={floating ? "animate-pulse" : undefined} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                          <span
                            onClick={soOpen}
                            role={soOpen ? "button" : undefined}
                            title={title}
                            style={{ ...(floating ? floatingChip : mutedChip), cursor: soOpen ? "pointer" : "default" }}
                          >
                            {p.soDocNo}{floating ? " ~" : ""}
                          </span>
                          <span style={{ color: "#b3b8ac", fontSize: 10 }}>{"▸"}</span>
                          <span style={floating ? floatingChip : mutedChip} title={title}>{p.poLabel}</span>
                        </div>
                        {/* No hover on a phone — the identity wording the desktop
                            carries as a tooltip renders as a visible caption. */}
                        <div style={{ fontSize: 10, color: "#9aa093", marginTop: 3, lineHeight: 1.4 }}>{title}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <ChainSection title="Procurement chain" groups={model.purchase} nav={nav} onClose={onClose} />

            {(amendments.length > 0 || poAmendments.length > 0) && (
              <div style={{ marginBottom: 16 }}>
                <div style={eyebrowStyle}>Amendments</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {/* Display-only on the phone (the amendment job cards are
                      desktop pages / their own list screens). */}
                  {amendments.map((a) => (
                    <span key={`soa-${a.id}`} style={mutedChip}>
                      {String(a.amendmentNo ?? "").trim() || `Amendment ${a.soDocNo}`}
                      {a.status ? ` · ${humaniseStatusKey(a.status)}` : ""}
                    </span>
                  ))}
                  {poAmendments.map((a) => (
                    <span key={`poa-${a.id}`} style={mutedChip}>
                      {String(a.amendmentNo ?? "").trim() || `Amendment ${a.poNumber}`}
                      {a.status ? ` · ${humaniseStatusKey(a.status)}` : ""}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 5, padding: "2px 2px 0" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 10.5, color: "#5c6357" }}>
                <span style={{ width: 18, height: 0, borderTop: "3px solid #b3b8ac", flex: "none" }} />
                {CHAIN_LEGEND}
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 10.5, color: "#5c6357" }}>
                <span style={{ width: 18, height: 0, borderTop: "3px solid #d9ded4", flex: "none" }} />
                {PROVENANCE_LEGEND}
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 10.5, color: "#5c6357" }}>
                <span style={{ width: 18, height: 0, borderTop: "3px dashed #b6c6c0", flex: "none" }} />
                {FLOATING_LEGEND}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
