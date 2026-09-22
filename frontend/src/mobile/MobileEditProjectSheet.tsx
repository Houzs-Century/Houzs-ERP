import { useState } from "react";
import { DateField } from "../vendor/scm/components/DateField";
import "./mobile.css";

// ── Edit event details on mobile ──
// Lifted out of MobilePMS.tsx so that already-huge screen file stops growing
// (repo file-size ratchet). It replaced the SEQUENTIAL PROMPT editor that ran
// six window-style prompts back to back — name, booth, venue, organizer, start
// date, end date — where DISMISSING ANY ONE prompt ended the whole flow. In
// practice the operator edited the title, dismissed the next field they did not
// care about, and never reached the date prompts (owner 2026-09-21: "i cant
// edit all details event using mobile pms. only can edit title but date cant").
// Every field is now on screen at once, and the dates use the repo's DateField
// (canonical ISO on the wire, dd/mm/yyyy on screen — never the native control,
// which renders in the viewer's OS locale, the one thing the date rule forbids).
//
// The permission gate and the fields are UNCHANGED from the prompt flow it
// replaced: the caller renders this only for `canWrite && access.canEdit`, and
// only these six columns are offered. The save sends just the CHANGED fields
// through the same project PATCH, so start_date still re-dates the checklist and
// an organizer edit still syncs the composed name, exactly as before.

export type EditableProject = {
  name: string;
  booth_no: string | null;
  venue: string | null;
  organizer?: string | null;
  start_date: string | null;
  end_date: string | null;
};

/** ISO-or-timestamp -> the `YYYY-MM-DD` DateField wants. Stored start/end dates
 *  are dates, but some legacy rows carry a `T00:00` tail; slice it off so the
 *  field shows the day and round-trips it unchanged. */
function dayOnly(v: string | null | undefined): string {
  return (v ?? "").slice(0, 10);
}

export function EditProjectSheet({
  project, busy, onClose, onSave,
}: {
  project: EditableProject;
  busy?: boolean;
  onClose: () => void;
  /** Resolves true when the patch saved, so the sheet can close itself. */
  onSave: (patch: Record<string, unknown>) => Promise<boolean>;
}) {
  const [name, setName] = useState(project.name);
  const [booth, setBooth] = useState(project.booth_no ?? "");
  const [venue, setVenue] = useState(project.venue ?? "");
  const [organizer, setOrganizer] = useState(project.organizer ?? "");
  const [startDate, setStartDate] = useState(dayOnly(project.start_date));
  const [endDate, setEndDate] = useState(dayOnly(project.end_date));
  const [saving, setSaving] = useState(false);

  const nameBlank = !name.trim();
  // Same rule the backend enforces (end_date >= start_date) — caught here so the
  // save button explains it rather than the PATCH coming back 400.
  const dateInvalid = !!(startDate && endDate && endDate < startDate);

  const submit = async () => {
    if (nameBlank || dateInvalid || saving || busy) return;
    // Only changed fields go in the patch. A field cleared to blank sends null;
    // the name can never be blanked (guarded above).
    const patch: Record<string, unknown> = {};
    const put = (key: string, next: string, cur: string | null | undefined) => {
      const t = next.trim();
      if (t !== (cur ?? "")) patch[key] = t || null;
    };
    if (name.trim() !== project.name) patch.name = name.trim();
    put("booth_no", booth, project.booth_no);
    put("venue", venue, project.venue);
    put("organizer", organizer, project.organizer);
    put("start_date", startDate, dayOnly(project.start_date));
    put("end_date", endDate, dayOnly(project.end_date));
    if (Object.keys(patch).length === 0) { onClose(); return; }
    setSaving(true);
    try {
      if (await onSave(patch)) onClose();
    } finally {
      setSaving(false);
    }
  };

  const fieldStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", fontSize: 13, padding: "9px 10px", borderRadius: 9,
    border: "1px solid var(--line)", background: "#fff", color: "var(--ink)", fontFamily: "inherit",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 9.5, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase",
    color: "#767b6e", marginBottom: 4, display: "block",
  };
  const disabled = saving || busy;

  return (
    <div className="sheet-bd" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <div className="sheet-head">
          <div>
            <div className="ey" style={{ color: "var(--brand)" }}>Projects</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "var(--ink)" }}>Edit event</div>
          </div>
          <button className="sheet-x" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <div className="sheet-scroll" style={{ gap: 11, display: "flex", flexDirection: "column" }}>
          <div>
            <label style={labelStyle}>Event name</label>
            <input style={fieldStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="Event name" aria-label="Event name" />
            {nameBlank && <div style={{ fontSize: 11.5, color: "#b23a3a", marginTop: 3 }}>The event name can't be blank.</div>}
          </div>
          <div>
            <label style={labelStyle}>Booth number</label>
            <input style={fieldStyle} value={booth} onChange={(e) => setBooth(e.target.value)} placeholder="e.g. A01-A04" aria-label="Booth number" />
          </div>
          <div>
            <label style={labelStyle}>Venue</label>
            <input style={fieldStyle} value={venue} onChange={(e) => setVenue(e.target.value)} placeholder="Venue" aria-label="Venue" />
          </div>
          <div>
            <label style={labelStyle}>Organizer</label>
            <input style={fieldStyle} value={organizer} onChange={(e) => setOrganizer(e.target.value)} placeholder="Organizer" aria-label="Organizer" />
          </div>
          <div style={{ display: "flex", gap: 9 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Start date</label>
              <DateField value={startDate} onChange={setStartDate} style={fieldStyle} aria-label="Start date" />
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>End date</label>
              <DateField value={endDate} onChange={setEndDate} style={fieldStyle} aria-label="End date" />
            </div>
          </div>
          {dateInvalid && <div style={{ fontSize: 11.5, color: "#b23a3a" }}>End date must be on or after the start date.</div>}
        </div>
        <div className="sheet-foot">
          <button className="tinybtn" style={{ flex: 1 }} onClick={onClose} disabled={disabled}>Cancel</button>
          <button
            className="tinybtn"
            style={{ flex: 2, background: "var(--brand)", borderColor: "var(--brand)", color: "#fff", fontWeight: 700, opacity: nameBlank || dateInvalid ? 0.55 : 1 }}
            disabled={disabled || nameBlank || dateInvalid}
            onClick={() => void submit()}
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default EditProjectSheet;
