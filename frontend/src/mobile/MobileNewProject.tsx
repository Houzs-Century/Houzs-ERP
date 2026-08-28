import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import "./mobile.css";

/* ---------------------------------------------------------------------------
 * MobileNewProject — the phone twin of the desktop CreateProjectPanel
 * (`pages/Projects.tsx`). Added 2026-08-28: mobile could change a project's
 * status and archive one, but had no way to CREATE one, so a BD standing at a
 * venue had to find a laptop.
 *
 * It is NOT built on MobileModuleForm, deliberately. That renderer is a flat
 * config→field map, and this form has two derivations it cannot express:
 *   • STATE is not typed — it comes from the picked venue (`project_venues`
 *     stores it), which is the single source of truth the desktop uses too.
 *   • NAME is not typed either — it is composed from state/brand/organizer/
 *     venue, and the backend derives the project CODE from the same parts.
 * Bending the shared renderer around those two rules would put project-only
 * behaviour into the form that also draws Suppliers, Drivers and Fleet.
 *
 * The gate is the caller's: `canCreateEvent` (BD / owner / weisiang, owner
 * 2026-07-24) — the same rule the desktop FAB uses and the same one
 * `POST /api/projects` enforces server-side, so the button and the route
 * cannot disagree.
 * ------------------------------------------------------------------------- */

type EventType = { id: number; name: string; slug?: string | null };
type Venue = { id: number; name: string; state?: string | null };

/** `{state} [{brand}] {organizer | SOLO} @ {venue}` — the desktop composer
 *  (`pages/Projects.tsx composeDefaultProjectName`), which MobileCalendar also
 *  carries its own copy of. Kept identical so a project created on a phone is
 *  named exactly as one created on a laptop; a SOLO event forces the organizer
 *  slot regardless of what was picked. */
export function composeProjectName(p: {
  state?: string | null;
  brand?: string | null;
  organizer?: string | null;
  venue?: string | null;
  eventTypeSlug?: string | null;
}): string {
  const state = (p.state || "").trim();
  const brand = (p.brand || "").trim();
  const organizer = (p.organizer || "").trim();
  const venue = (p.venue || "").trim();
  const isSolo = (p.eventTypeSlug || "").toLowerCase() === "solo";
  const orgSlot = isSolo ? "SOLO" : organizer || "SOLO";
  const head: string[] = [];
  if (state) head.push(state.toUpperCase());
  if (brand) head.push(`[${brand}]`);
  head.push(orgSlot);
  const left = head.join(" ");
  return venue ? `${left} @ ${venue}` : left;
}

export function MobileNewProject({
  onBack,
  onCreated,
}: {
  onBack: () => void;
  /** Fires with the new project's id so the caller can open its detail. */
  onCreated: (id: number) => void;
}) {
  const brands = useQuery({
    queryKey: ["pms-brands"],
    queryFn: () => api.get<{ data: string[] }>("/api/projects/brands"),
  });
  const eventTypes = useQuery({
    queryKey: ["pms-event-types"],
    queryFn: () => api.get<{ data: EventType[] }>("/api/projects/event-types"),
  });
  const venues = useQuery({
    queryKey: ["pms-venues"],
    queryFn: () => api.get<{ data: Venue[] }>("/api/projects/venues"),
  });

  const [eventTypeId, setEventTypeId] = useState("");
  const [brand, setBrand] = useState("");
  const [venueId, setVenueId] = useState("");
  const [organizer, setOrganizer] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const venueList = venues.data?.data ?? [];
  const venue = useMemo(
    () => venueList.find((v) => String(v.id) === venueId) ?? null,
    [venueList, venueId]
  );
  /* State rides the venue, exactly as on desktop — it is displayed but never
     typed, because `project_venues.state` is what the code derivation reads. */
  const stateName = (venue?.state || "").trim();
  const eventTypeSlug =
    (eventTypes.data?.data ?? []).find((t) => String(t.id) === eventTypeId)?.slug ?? null;

  const derivedName = composeProjectName({
    state: stateName,
    brand,
    organizer,
    venue: venue?.name,
    eventTypeSlug,
  });

  const dateInvalid = !!(startDate && endDate && endDate < startDate);
  /* Mirrors the three fields `deriveProjectCode` throws on (state / venue /
     brand) plus the route's own `name` check, so a missing one is named here
     instead of coming back as a 400 after a round trip. */
  const blocker =
    !brand
      ? "Pick a brand."
      : !venue
        ? "Pick a venue."
        : !stateName
          ? "This venue has no state set. Open Project Maintenance → Venues on desktop and add one."
          : !derivedName.trim()
            ? "Pick a venue so a name can be derived."
            : dateInvalid
              ? "End date must be on or after the start date."
              : null;

  async function submit() {
    if (blocker) {
      setError(blocker);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.post<{ id: number; code: string }>("/api/projects", {
        name: derivedName.trim(),
        event_type_id: eventTypeId ? parseInt(eventTypeId, 10) : undefined,
        brand: brand || undefined,
        start_date: startDate || undefined,
        end_date: endDate || undefined,
        venue: (venue?.name ?? "").trim(),
        state: stateName || undefined,
        organizer: organizer.trim() || undefined,
      });
      onCreated(res.id);
    } catch (e) {
      /* Surfaced inline, never swallowed: the create route answers with a real
         sentence for every 400 it raises (missing code part, bad date order,
         and the 403 for a non-BD caller), and that sentence is the whole value
         of the failure. */
      setError(e instanceof Error ? e.message : "Could not create the project.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="hz-m"
      style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}
    >
      <header className="hdr">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span
            onClick={onBack}
            role="button"
            style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 12.5, fontWeight: 600, color: "#16695f", cursor: "pointer" }}
          >
            <span style={{ fontSize: 17, lineHeight: 1 }}>{"‹"}</span> Projects
          </span>
          <span
            onClick={onBack}
            role="button"
            style={{ fontSize: 13, fontWeight: 600, color: "#767b6e", cursor: "pointer" }}
          >
            Cancel
          </span>
        </div>
        <div className="ey" style={{ color: "#a16a2e", marginTop: 6 }}>PMS</div>
        <div style={{ fontSize: 19, fontWeight: 800, color: "#11140f", marginTop: 2 }}>New Project</div>
      </header>

      <div className="scroll" style={{ padding: 12, paddingBottom: 24 }}>
        <div className="so-card">
          <div className="so-hd">
            <h2 className="so-ti">Event</h2>
          </div>
          <div className="so-bd">
            <label className="fld">
              <span className="fld-l">Event type</span>
              <select className="fld-i" value={eventTypeId} onChange={(e) => setEventTypeId(e.target.value)}>
                <option value="">Select…</option>
                {(eventTypes.data?.data ?? []).map((t) => (
                  <option key={t.id} value={String(t.id)}>{t.name}</option>
                ))}
              </select>
              <span className="so-sub" style={{ marginTop: 2 }}>Pre-loads that type's default checklist.</span>
            </label>

            <label className="fld">
              <span className="fld-l">Brand *</span>
              <select className="fld-i" value={brand} onChange={(e) => setBrand(e.target.value)}>
                <option value="">Select…</option>
                {(brands.data?.data ?? []).map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </label>

            <label className="fld">
              <span className="fld-l">Venue *</span>
              <select className="fld-i" value={venueId} onChange={(e) => setVenueId(e.target.value)}>
                <option value="">Select…</option>
                {venueList.map((v) => (
                  <option key={v.id} value={String(v.id)}>{v.name}</option>
                ))}
              </select>
              <span className="so-sub" style={{ marginTop: 2 }}>
                {venue
                  ? stateName
                    ? `State: ${stateName}`
                    : "This venue has no state — the project code cannot be built without one."
                  : "State comes from the venue."}
              </span>
            </label>

            <label className="fld">
              <span className="fld-l">Organizer</span>
              <input
                className="fld-i"
                value={organizer}
                onChange={(e) => setOrganizer(e.target.value)}
                placeholder="Leave blank for SOLO"
              />
            </label>
          </div>
        </div>

        <div className="so-card" style={{ marginTop: 12 }}>
          <div className="so-hd">
            <h2 className="so-ti">Dates</h2>
          </div>
          <div className="so-bd">
            <label className="fld">
              <span className="fld-l">Start date</span>
              <input className="fld-i" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </label>
            <label className="fld">
              <span className="fld-l">End date</span>
              <input className="fld-i" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </label>
          </div>
        </div>

        <div className="so-card" style={{ marginTop: 12 }}>
          <div className="so-hd">
            <h2 className="so-ti">Name</h2>
          </div>
          <div className="so-bd">
            {/* Read-only on purpose — the desktop panel does not let the name be
                overridden either, because the project CODE is derived from the
                same parts and a hand-typed name would drift from it. */}
            <div
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: derivedName.trim() ? "#11140f" : "#9aa093",
                lineHeight: 1.4,
                wordBreak: "break-word",
              }}
            >
              {derivedName.trim() || "Pick brand and venue to derive the name…"}
            </div>
            <span className="so-sub" style={{ marginTop: 4, display: "block" }}>
              Auto-derived: {"{state} [{brand}] {organizer | SOLO} @ {venue}"}
            </span>
          </div>
        </div>

        {/* The blocker is shown BEFORE the tap, not after — the Create button is
            left enabled so the reason is readable rather than being a grey
            button with no explanation. */}
        {(error || blocker) && (
          <div style={{ marginTop: 8, fontSize: 12, color: error ? "#b23a3a" : "#767b6e", textAlign: "center", padding: "0 4px" }}>
            {error ?? blocker}
          </div>
        )}
      </div>

      <footer className="actbar">
        <button
          className="btn"
          disabled={submitting || !!blocker}
          onClick={() => void submit()}
          style={{ opacity: submitting || blocker ? 0.6 : 1 }}
        >
          {submitting ? "Creating…" : "Create Project"}
        </button>
      </footer>
    </div>
  );
}
