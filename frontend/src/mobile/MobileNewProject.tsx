import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { composeDefaultProjectName } from "../lib/projectName";
import { DateField } from "../vendor/scm/components/DateField";
import "./mobile.css";

type NotifyFn = (o: { title: string; body?: string; tone?: "info" | "error" }) => Promise<void>;

/**
 * New Project on mobile — the create sheet lifted out of MobilePMS so that
 * already-huge screen file stops growing (repo file-size ratchet).
 */
// ── Create ──
// New Project on mobile (owner 2026-07-31: "owner and ummu can create").
// Creation is NOT a general projects.write right — the backend restricts it to
// BD staff, the Owner position and weisiang (routes/projects.ts canCreateEvent,
// 403 otherwise) and the shared auth/salesAccess.canCreateEvent mirrors that
// rule, so the button uses the SAME predicate as the desktop page rather than
// a second hand-rolled list of people.
//
// Mirrors the desktop New Project panel field for field: the name is DERIVED
// (never typed) from state/brand/organizer/venue, the state comes from the
// picked venue (project_venues is the source of truth), and the backend needs
// brand + venue + state to generate the project code.
export function NewProjectSheet({
  onClose, onCreated, notify,
}: {
  onClose: () => void;
  onCreated: (id: number) => void;
  notify: NotifyFn;
}) {
  const [eventTypeId, setEventTypeId] = useState("");
  const [brand, setBrand] = useState("");
  const [venueName, setVenueName] = useState("");
  const [organizer, setOrganizer] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [saving, setSaving] = useState(false);

  const eventTypesQ = useQuery({
    queryKey: ["pms-event-types"],
    queryFn: () => api.get<{ data: { id: number; name: string; slug: string }[] }>("/api/projects/event-types"),
    staleTime: 5 * 60_000,
  });
  const brandsQ = useQuery({
    queryKey: ["pms-brands"],
    queryFn: () => api.get<{ data: string[] }>("/api/projects/brands"),
    staleTime: 5 * 60_000,
  });
  const venuesQ = useQuery({
    queryKey: ["pms-venues"],
    queryFn: () => api.get<{ data: { id: number; name: string; state: string | null }[] }>("/api/projects/venues"),
    staleTime: 5 * 60_000,
  });
  const organizersQ = useQuery({
    queryKey: ["pms-organizers"],
    queryFn: () => api.get<{ data: { id: number; name: string }[] }>("/api/projects/organizers"),
    staleTime: 5 * 60_000,
  });

  const eventTypes = eventTypesQ.data?.data ?? [];
  const venues = venuesQ.data?.data ?? [];
  const eventTypeSlug = eventTypes.find((t) => String(t.id) === eventTypeId)?.slug ?? null;
  const isSolo = (eventTypeSlug ?? "").toLowerCase() === "solo";
  // State is NOT typed — it rides on the chosen venue, same as desktop.
  const stateName = venues.find((v) => v.name === venueName)?.state ?? "";
  const derivedName = composeDefaultProjectName({
    state: stateName, brand, organizer, venue: venueName, event_type_slug: eventTypeSlug,
  });
  const dateInvalid = !!(startDate && endDate && endDate < startDate);

  const submit = async () => {
    // Same guards as the desktop panel, so the failure is explained here
    // instead of coming back as a 400 from the code generator.
    if (!brand) { await notify({ title: "Brand is required", body: "Pick the brand this event runs under.", tone: "error" }); return; }
    if (!venueName.trim()) { await notify({ title: "Venue is required", body: "Pick the venue — the event name and code are built from it.", tone: "error" }); return; }
    if (!stateName.trim()) { await notify({ title: "This venue has no state", body: "Open Project Maintenance → Venues on a PC and set the venue's state first.", tone: "error" }); return; }
    if (!derivedName.trim()) { await notify({ title: "Name can't be derived", body: "Pick a venue and brand so the event name can be composed.", tone: "error" }); return; }
    if (dateInvalid) { await notify({ title: "Check the dates", body: "End date must be on or after the start date.", tone: "error" }); return; }
    setSaving(true);
    try {
      const res = await api.post<{ id: number; code: string }>("/api/projects", {
        name: derivedName.trim(),
        event_type_id: eventTypeId ? parseInt(eventTypeId, 10) : undefined,
        brand: brand || undefined,
        start_date: startDate || undefined,
        end_date: endDate || undefined,
        venue: venueName.trim() || undefined,
        state: stateName.trim() || undefined,
        organizer: isSolo ? undefined : (organizer || undefined),
      });
      onCreated(res.id);
    } catch (e) {
      await notify({ title: "Couldn't create the event", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  const fieldStyle: React.CSSProperties = {
    width: "100%", fontSize: 13, padding: "9px 10px", borderRadius: 9,
    border: "1px solid var(--line)", background: "#fff", color: "var(--ink)", fontFamily: "inherit",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 9.5, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase",
    color: "#767b6e", marginBottom: 4, display: "block",
  };

  return (
    <div className="sheet-bd" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <div className="sheet-head">
          <div>
            <div className="ey" style={{ color: "var(--brand)" }}>Projects</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "var(--ink)" }}>New event</div>
          </div>
          <button className="sheet-x" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <div className="sheet-scroll" style={{ gap: 11, display: "flex", flexDirection: "column" }}>
          <div>
            <label style={labelStyle}>Event type</label>
            <select style={fieldStyle} value={eventTypeId} onChange={(e) => setEventTypeId(e.target.value)}>
              <option value="">— select —</option>
              {eventTypes.map((t) => <option key={t.id} value={String(t.id)}>{t.name}</option>)}
            </select>
            <div style={{ fontSize: 10.5, color: "#9aa093", marginTop: 3 }}>Loads that type's default checklist.</div>
          </div>
          <div>
            <label style={labelStyle}>Brand *</label>
            <select style={fieldStyle} value={brand} onChange={(e) => setBrand(e.target.value)}>
              <option value="">— select —</option>
              {(brandsQ.data?.data ?? []).map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Venue *</label>
            <select style={fieldStyle} value={venueName} onChange={(e) => setVenueName(e.target.value)}>
              <option value="">— select —</option>
              {venues.map((v) => <option key={v.id} value={v.name}>{v.name}</option>)}
            </select>
            <div style={{ fontSize: 10.5, color: stateName ? "#2f8a5b" : "#9aa093", marginTop: 3 }}>
              {venueName ? (stateName ? `State: ${stateName}` : "This venue has no state set — add it on a PC first.") : "The state and event code come from the venue."}
            </div>
          </div>
          {!isSolo && (
            <div>
              <label style={labelStyle}>Organizer</label>
              <select style={fieldStyle} value={organizer} onChange={(e) => setOrganizer(e.target.value)}>
                <option value="">— select —</option>
                {(organizersQ.data?.data ?? []).map((o) => <option key={o.id} value={o.name}>{o.name}</option>)}
              </select>
            </div>
          )}
          {/* DateField, not a native <input type="date">: the native control
              renders in the viewer's OS locale, which is exactly what the
              repo's one-date-format rule exists to prevent. It keeps the value
              canonical ISO and displays dd/mm/yyyy. */}
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
          {/* The name is composed, never typed — show what will be saved. */}
          <div style={{ border: "1px dashed #d6d9d2", borderRadius: 10, padding: "9px 11px", background: "#faf9f5" }}>
            <div style={labelStyle}>Event name</div>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: derivedName ? "var(--ink)" : "#9aa093", lineHeight: 1.35 }}>
              {derivedName || "Pick brand + venue to compose the name"}
            </div>
          </div>
        </div>
        <div className="sheet-foot">
          <button className="tinybtn" style={{ flex: 1 }} onClick={onClose} disabled={saving}>Cancel</button>
          <button
            className="tinybtn"
            style={{ flex: 2, background: "var(--brand)", borderColor: "var(--brand)", color: "#fff", fontWeight: 700 }}
            disabled={saving}
            onClick={() => void submit()}
          >
            {saving ? "Creating…" : "Create event"}
          </button>
        </div>
      </div>
    </div>
  );
}

