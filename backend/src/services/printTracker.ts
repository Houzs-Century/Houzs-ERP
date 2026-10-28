/**
 * Print-friendly Workflow Progress Tracker for ASSR cases.
 *
 * This module emits a static inline SVG stepper that survives PDF
 * rasterisation cleanly: numbered nodes, coloured connectors
 * green/amber/red by the prior stage's health, current stage
 * solid-coloured by elapsed vs target, completed stages green with a
 * check.
 *
 * It used to say it mirrored `frontend/src/components/ServiceProgressTracker.tsx`.
 * That component was DELETED (never rendered anywhere, and its stage copy was
 * unfiltered), so the pointer is gone rather than left dangling. The canonical
 * stage table now lives in `frontend/src/vendor/scm/lib/assr/stages.ts`, and the
 * `STAGES` list below is another copy that applies no internal-resolution filter
 * — an internal-resolution case skips the two supplier-only stages, so this would
 * print 7 nodes where the UI shows 5 (`docs/modules/service-case.md`). Nothing
 * imports this module at present; wire it up only after the filter comes from
 * the shared rule.
 */

export interface StageHistoryRow {
  stage: string;
  entered_at: string;
  exited_at: string | null;
  target_days: number | null;
  status?: string | null;
  skipped?: number | null;
  skip_reason?: string | null;
}

interface StageDef { value: string; short: string }

// Mirrors the canonical 9-stage order from mig 074.
const STAGES: StageDef[] = [
  { value: "pending_review",            short: "Review" },
  { value: "under_verification",        short: "Verify" },
  { value: "pending_solution",          short: "Solution" },
  { value: "pending_supplier_pickup",   short: "Supplier" },
  { value: "pending_item_ready",        short: "Ready" },
  { value: "pending_delivery_service",  short: "Delivery" },
  { value: "completed",                 short: "Done" },
];

// Mirror toneForPct in the React component.
function toneForPct(pct: number): "green" | "amber" | "red" {
  if (pct >= 1.0) return "red";
  if (pct >= 0.5) return "amber";
  return "green";
}

// Tailwind tone → hex for inline SVG. Approximate matches to the
// frontend palette (synced/amber-500/err) so the print echoes the UI.
const HEX = {
  green: "#16a34a",  // synced
  amber: "#d97706",  // amber-700 (darker than 500 for print contrast)
  red:   "#dc2626",  // err
  ink:   "#0f172a",
  muted: "#94a3b8",
  border:"#cbd5e1",
};

function daysBetween(fromIso: string, toIso: string | null): number {
  const a = new Date(fromIso.endsWith("Z") ? fromIso : fromIso + "Z").getTime();
  const b = toIso
    ? new Date(toIso.endsWith("Z") ? toIso : toIso + "Z").getTime()
    : Date.now();
  return (b - a) / (1000 * 60 * 60 * 24);
}

/**
 * Render the tracker as a single inline SVG block. Width-fills its
 * container; height is fixed (~36mm so the node circles read at
 * 9-12pt). Returns an HTML string the variant composers can drop
 * into a `<section>`.
 */
export function renderStageTrackerHtml({
  history,
  currentStage,
}: {
  history: StageHistoryRow[];
  currentStage: string;
}): string {
  // Most-recent entry per stage wins, same as the React component.
  const lastByStage = new Map<string, StageHistoryRow>();
  for (const h of history ?? []) lastByStage.set(h.stage, h);
  const currentIdx = Math.max(
    0,
    STAGES.findIndex((s) => s.value === currentStage),
  );

  // SVG layout constants. viewBox is in arbitrary units; the
  // container scales it via CSS (width: 100%; height: 90px).
  const N = STAGES.length;
  const W = 900;
  const H = 110;
  const PAD = 30;
  const ringR = 18;
  const cy = 40;
  const stepX = (W - PAD * 2) / (N - 1);

  const nodes: string[] = [];
  const connectors: string[] = [];

  STAGES.forEach((s, idx) => {
    const cx = PAD + stepX * idx;
    const h = lastByStage.get(s.value);
    const isPast = idx < currentIdx;
    const isCurrent = idx === currentIdx;
    const isSkipped = !!h?.skipped;

    // Connector to the next node (skip the last one).
    if (idx < N - 1) {
      const nextX = PAD + stepX * (idx + 1);
      let strokeColor = HEX.border;
      let strokeDash = "";
      if (isPast || (isCurrent && !isSkipped)) {
        // Coloured by this stage's tone if we have a target.
        let tone: "green" | "amber" | "red" = "green";
        if (h?.target_days && h?.entered_at) {
          const elapsed = daysBetween(h.entered_at, h.exited_at);
          tone = toneForPct(elapsed / h.target_days);
        }
        strokeColor = HEX[tone];
      }
      if (isSkipped) {
        strokeColor = HEX.muted;
        strokeDash = ' stroke-dasharray="4 4"';
      }
      connectors.push(
        `<line x1="${cx + ringR}" y1="${cy}" x2="${nextX - ringR}" y2="${cy}" stroke="${strokeColor}" stroke-width="2.5"${strokeDash}/>`
      );
    }

    // Node circle.
    let fill = "#fff";
    let stroke = HEX.border;
    let textColor = HEX.muted;
    let label: string = String(idx + 1);
    if (isPast) {
      fill = HEX.green;
      stroke = HEX.green;
      textColor = "#fff";
      label = "✓";
    } else if (isCurrent) {
      let tone: "green" | "amber" | "red" = "green";
      if (h?.target_days && h?.entered_at) {
        const elapsed = daysBetween(h.entered_at, h.exited_at);
        tone = toneForPct(elapsed / h.target_days);
      }
      fill = HEX[tone];
      stroke = HEX[tone];
      textColor = "#fff";
    } else if (isSkipped) {
      stroke = HEX.muted;
      textColor = HEX.muted;
    }

    nodes.push(
      `<g>
        <circle cx="${cx}" cy="${cy}" r="${ringR}" fill="${fill}" stroke="${stroke}" stroke-width="2"${isSkipped ? ' stroke-dasharray="3 3"' : ""}/>
        <text x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="14" font-weight="700" fill="${textColor}" font-family="Roboto, Helvetica, Arial, sans-serif">${label}</text>
        <text x="${cx}" y="${cy + ringR + 18}" text-anchor="middle" font-size="11" fill="${HEX.ink}" font-family="Roboto, Helvetica, Arial, sans-serif">${s.short}</text>
      </g>`
    );
  });

  return `<div class="tracker-wrap">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" width="100%" height="90">
      ${connectors.join("")}
      ${nodes.join("")}
    </svg>
  </div>`;
}

/**
 * CSS for the tracker wrap so the variant composers can include it
 * without duplicating styles. Inlined into the print HTML's `<style>`.
 */
export const STAGE_TRACKER_CSS = `
.tracker-wrap {
  width: 100%;
  margin: 0 0 4mm 0;
  padding: 3mm 0 4mm 0;
  border-top: 0.5pt solid #d0d0d0;
  border-bottom: 0.5pt solid #d0d0d0;
  page-break-inside: avoid;
}
.tracker-wrap svg { display: block; }
`;
