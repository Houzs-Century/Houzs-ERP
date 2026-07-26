// ----------------------------------------------------------------------------
// Schedule Reconcile (Roadshow PMS Agent — Job A). Upload an organizer's latest
// schedule photo; it's OCR'd (Claude vision) and diffed against that organizer's
// projects. Each row is MATCH / DATE_CHANGED / NEW / MISSING. For a moved event
// you apply the new dates to the project in one click; MISSING (a live project
// the schedule dropped) is flagged as a possible postpone/cancel for you to check.
// ----------------------------------------------------------------------------

import { useState } from "react";
import { api } from "../api/client";

type Project = { id: number; code: string; name: string; venue: string; startDate: string | null; endDate: string | null; stage: string };
type Row = {
  venue: string;
  scheduleStart: string | null;
  scheduleEnd: string | null;
  scheduleStatus: string | null;
  status: "MATCH" | "DATE_CHANGED" | "NEW" | "MISSING";
  project: Project | null;
};
type ScanResult = { organizer: string; projectCount: number; rows: Row[] };

const STATUS_STYLE: Record<Row["status"], { label: string; color: string }> = {
  DATE_CHANGED: { label: "Date changed", color: "#b45309" },
  MISSING: { label: "Not in schedule", color: "#b91c1c" },
  NEW: { label: "New event", color: "#1d4ed8" },
  MATCH: { label: "Unchanged", color: "#15803d" },
};
const ORDER: Row["status"][] = ["DATE_CHANGED", "MISSING", "NEW", "MATCH"];
const dash = (s: string | null) => s || "—";

export function ScheduleReconcile() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [applied, setApplied] = useState<Record<number, "ok" | "err">>({});
  const [applying, setApplying] = useState<Record<number, boolean>>({});

  async function onFile(file: File) {
    setError(""); setResult(null); setApplied({}); setBusy(true);
    try {
      const res = await api.uploadFile<ScanResult>("/projects/schedule-reconcile/scan", file, "file");
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the schedule.");
    } finally { setBusy(false); }
  }

  async function applyDates(row: Row) {
    if (!row.project) return;
    const id = row.project.id;
    setApplying((s) => ({ ...s, [id]: true }));
    try {
      await api.patch(`/projects/${id}`, { start_date: row.scheduleStart, end_date: row.scheduleEnd });
      setApplied((s) => ({ ...s, [id]: "ok" }));
    } catch {
      setApplied((s) => ({ ...s, [id]: "err" }));
    } finally { setApplying((s) => ({ ...s, [id]: false })); }
  }

  const rowsByStatus = (st: Row["status"]) => (result?.rows ?? []).filter((r) => r.status === st);

  return (
    <div style={{ padding: 20, maxWidth: 960 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Schedule Reconcile</h1>
      <p style={{ fontSize: 13, color: "var(--fg-muted,#666)", marginBottom: 16 }}>
        Upload an organizer's latest schedule photo. It is read automatically and compared to that
        organizer's projects — moved dates, new venues, and events dropped from the schedule
        (possible postpone/cancel) are flagged. Apply a new date to a project in one click.
      </p>

      <label style={{ display: "inline-flex", alignItems: "center", gap: 10, padding: "10px 14px", border: "1px solid var(--border,#ccc)", borderRadius: 8, cursor: "pointer", background: "var(--bg-subtle,#f7f7f7)" }}>
        <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>{busy ? "Reading schedule…" : "Choose schedule photo"}</span>
      </label>
      {error && <p style={{ color: "var(--c-error,#c00)", fontSize: 13, marginTop: 10 }}>{error}</p>}

      {result && (
        <>
          <p style={{ fontSize: 13, margin: "16px 0 8px" }}>
            Organizer: <strong>{result.organizer || "—"}</strong> · matched against{" "}
            <strong>{result.projectCount}</strong> of its projects.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {ORDER.flatMap((st) => rowsByStatus(st)).map((r, i) => {
              const cfg = STATUS_STYLE[r.status];
              const id = r.project?.id;
              const ap = id != null ? applied[id] : undefined;
              return (
                <div key={i} style={{ border: "1px solid var(--border,#ddd)", borderRadius: 10, padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <div>
                    <span style={{ fontSize: 11, fontWeight: 700, color: cfg.color, textTransform: "uppercase" }}>{cfg.label}</span>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{r.venue}</div>
                    <div style={{ fontSize: 12, color: "var(--fg-muted,#666)" }}>
                      {r.status === "MISSING" ? (
                        <>project {r.project?.code} · {dash(r.project?.startDate ?? null)}–{dash(r.project?.endDate ?? null)} · not on the latest schedule</>
                      ) : r.status === "NEW" ? (
                        <>schedule {dash(r.scheduleStart)}–{dash(r.scheduleEnd)} · no matching project yet</>
                      ) : (
                        <>
                          schedule {dash(r.scheduleStart)}–{dash(r.scheduleEnd)}
                          {r.project && <> · project {r.project.code} currently {dash(r.project.startDate)}–{dash(r.project.endDate)}</>}
                        </>
                      )}
                    </div>
                  </div>
                  <div style={{ fontSize: 12 }}>
                    {r.status === "DATE_CHANGED" && id != null && (
                      ap === "ok" ? <span style={{ color: "#15803d" }}>Dates applied</span> :
                      ap === "err" ? <span style={{ color: "#c00" }}>Apply failed</span> :
                      <button onClick={() => applyDates(r)} disabled={applying[id]}
                        style={{ padding: "6px 12px", borderRadius: 8, border: "none", background: "var(--c-primary,#146c43)", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                        {applying[id] ? "Applying…" : "Apply new dates"}
                      </button>
                    )}
                    {r.status === "MISSING" && <span style={{ color: "var(--fg-muted,#999)" }}>Check: postponed or cancelled?</span>}
                    {r.status === "NEW" && <span style={{ color: "var(--fg-muted,#999)" }}>Create the project</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export default ScheduleReconcile;
