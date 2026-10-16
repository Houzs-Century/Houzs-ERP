// The Logistic and Procurement Overviews on a phone (owner, 2026-10-17). Both
// pages are already laid out for a narrow screen — tiles two-up, charts sized
// by their container, tables scrolling inside their panel — so the phone shows
// the same page under the mobile header rather than a second copy of it.
import { lazy, Suspense } from "react";

const LogisticOverview = lazy(() => import("../pages/scm-v2/LogisticOverview").then((m) => ({ default: m.LogisticOverview })));
const ProcurementOverview = lazy(() => import("../pages/scm-v2/ProcurementOverview").then((m) => ({ default: m.ProcurementOverview })));

export type OverviewKind = "logistic" | "procurement";

const META: Record<OverviewKind, { eyebrow: string; title: string }> = {
  logistic: { eyebrow: "Logistics", title: "Logistic Overview" },
  procurement: { eyebrow: "Procurement", title: "Procurement Overview" },
};

export function MobileOverview({ kind, onBack }: { kind: OverviewKind; onBack: () => void }) {
  const meta = META[kind];
  return (
    <div className="hz-m" style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <div>
            <button onClick={onBack} className="back" style={{ marginBottom: 4 }}>
              <span className="chev">‹</span> Back
            </button>
            <div className="eyebrow">{meta.eyebrow}</div>
            <div className="scr-title">{meta.title}</div>
          </div>
        </div>
      </header>
      <div className="scroll hz-scroll" style={{ padding: 12, paddingBottom: 40 }}>
        <Suspense fallback={<div style={{ padding: 24, textAlign: "center", fontSize: 12 }}>Loading…</div>}>
          {kind === "logistic" ? <LogisticOverview embedded /> : <ProcurementOverview embedded />}
        </Suspense>
      </div>
    </div>
  );
}
