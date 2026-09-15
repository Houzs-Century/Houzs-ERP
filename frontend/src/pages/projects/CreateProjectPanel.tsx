import { useState } from "react";
import { Button } from "../../components/Button";
import { Panel, PanelSection } from "../../components/Panel";
import { useToast } from "../../hooks/useToast";
import { api } from "../../api/client";
import { cn } from "../../lib/utils";
import { DateField } from "../../vendor/scm/components/DateField";
import type { EventType } from "./types";
import { composeDefaultProjectName } from "./projectHelpers";
import { OrganizerPicker, VenuePicker } from "./ProjectPickers";

/* Canonical Malaysian states — aligned to `scm.my_localities` after mig 0172
   (owner 2026-07-22). PMS used to store an UPPERCASE short list (`JOHOR` /
   `KL` / `PENANG`) while SCM stored the Title Case full names (`Johor` /
   `Kuala Lumpur` / `Pulau Pinang`); a shared Sales-by-state report split the
   same physical state into two buckets. This list IS the SCM one — new rows
   land canonical, existing UPPERCASE rows are back-filled by the migration. */
const PROJECT_STATES = [
  "Johor",
  "Kedah",
  "Kelantan",
  "Kuala Lumpur",
  "Labuan",
  "Melaka",
  "Negeri Sembilan",
  "Pahang",
  "Perak",
  "Perlis",
  "Pulau Pinang",
  "Putrajaya",
  "Sabah",
  "Sarawak",
  "Selangor",
  "Terengganu",
] as const;

// ── Create Panel ─────────────────────────────────────────────

export function CreateProjectPanel({
  onClose,
  onCreated,
  toast,
  brands,
  eventTypes,
}: {
  onClose: () => void;
  onCreated: (id: number) => void;
  toast: ReturnType<typeof useToast>;
  brands: string[];
  eventTypes: EventType[];
}) {
  // Owner 2026-08-19: the Ownership/PIC section is REMOVED from creation
  // (supersedes the 2026-07-18/07-21 back-and-forth on who may assign at
  // create). The creator does not know the PIC — only the Sales Director
  // does, and they assign it AFTER creation on the detail page (which also
  // surfaces the "Set Sales PIC" duty in their My Pending while it is
  // empty). Projects are therefore always created unassigned; row scope
  // falls back to created_by via COALESCE(p.pic_id, p.created_by).
  const [eventTypeId, setEventTypeId] = useState<string>("");
  const [brand, setBrand] = useState<string>("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [venue, setVenue] = useState("");
  // State is derived from the picked venue (project_venues stores it).
  // Not user-editable — the venue is the single source of truth.
  const [stateName, setStateName] = useState("");
  const [organizer, setOrganizer] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const eventTypeSlug =
    eventTypes.find((t) => String(t.id) === eventTypeId)?.slug ?? null;

  // Name is fully derived — user can't override.
  const derivedName = composeDefaultProjectName({
    state: stateName,
    brand,
    organizer,
    venue,
    event_type_slug: eventTypeSlug,
  });

  const dateInvalid = !!(startDate && endDate && endDate < startDate);

  // The backend derives the project code from state/venue/brand and
  // throws when any are missing. Validate all three client-side so the
  // user gets a clear inline message instead of a server round-trip.
  async function submit() {
    if (!brand) {
      toast.error("Brand is required");
      return;
    }
    if (!venue.trim()) {
      toast.error("Venue is required");
      return;
    }
    if (!stateName.trim()) {
      toast.error("This venue has no state set. Open Project Maintenance → Venues and add one.");
      return;
    }
    if (!derivedName.trim()) {
      toast.error("Pick a venue so a name can be derived");
      return;
    }
    if (dateInvalid) {
      toast.error("End date must be on or after start date");
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.post<{ id: number; code: string }>("/api/projects", {
        name: derivedName.trim(),
        event_type_id: eventTypeId ? parseInt(eventTypeId, 10) : undefined,
        brand: brand || undefined,
        start_date: startDate || undefined,
        end_date: endDate || undefined,
        venue: venue.trim(),
        state: stateName.trim() || undefined,
        organizer: organizer.trim() || undefined,
      });
      toast.success(`Created ${res.code}`);
      onCreated(res.id);
    } catch (e) {
      toast.error((e as { message?: string } | null)?.message || "Failed to create");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Panel
      open
      onClose={onClose}
      title="New Project"
      subtitle="Picking an event type pre-loads the default checklist"
      width={480}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-border bg-surface px-3 py-2 text-[12px] text-ink-secondary"
          >
            Cancel
          </button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={
              submitting ||
              !brand ||
              !venue.trim() ||
              !stateName.trim() ||
              !derivedName.trim() ||
              dateInvalid
            }
          >
            {submitting ? "Creating…" : "Create Project"}
          </Button>
        </div>
      }
    >
      <PanelSection title="Basics">
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Project Name
          </div>
          <div className="w-full rounded-md border border-dashed border-border bg-bg px-3 py-2 text-[13px] text-ink-secondary">
            {derivedName || (
              <span className="text-ink-muted">
                Pick brand, organizer and venue to derive…
              </span>
            )}
          </div>
          <div className="mt-1 text-[10px] text-ink-muted">
            Auto-derived: <span className="font-mono">{"{state} [{brand}] {organizer | SOLO} @ {venue}"}</span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              Event Type
            </div>
            <select
              value={eventTypeId}
              onChange={(e) => setEventTypeId(e.target.value)}
              className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            >
              <option value="">— none —</option>
              {eventTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              Brand<span className="ml-1 text-err">*</span>
            </div>
            <select
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            >
              <option value="">— pick a brand —</option>
              {brands.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            {brands.length === 0 && (
              <div className="mt-1 text-[10px] text-warning-text">
                No brands configured yet. Add one under Project Maintenance → Brands.
              </div>
            )}
          </div>
        </div>
      </PanelSection>

      <PanelSection title="Dates">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              Start
            </div>
            <DateField
              fullWidth
              value={startDate}
              onChange={(iso) => setStartDate(iso)}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
            />
          </div>
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              End
            </div>
            <DateField
              fullWidth
              value={endDate}
              min={startDate || undefined}
              onChange={(iso) => setEndDate(iso)}
              className={cn(
                "w-full rounded-md border bg-surface px-3 py-2 text-[13px]",
                dateInvalid ? "border-err" : "border-border"
              )}
            />
          </div>
        </div>
        {dateInvalid && (
          <div className="text-[11px] text-err">
            End date must be on or after the start date.
          </div>
        )}
      </PanelSection>

      <PanelSection title="Venue">
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Venue<span className="ml-1 text-err">*</span>
          </div>
          <VenuePicker
            value={venue || null}
            onChange={(v) => {
              setVenue(v ?? "");
              if (!v) setStateName("");
            }}
            onStateHint={(s) => setStateName(s ?? "")}
          />
        </div>
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            State<span className="ml-1 text-err">*</span>
          </div>
          <select
            value={stateName}
            onChange={(e) => setStateName(e.target.value)}
            className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          >
            <option value="">— pick a state —</option>
            {stateName && !(PROJECT_STATES as readonly string[]).includes(stateName) && (
              <option value={stateName}>{stateName}</option>
            )}
            {PROJECT_STATES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <div className="mt-1 text-[10px] text-ink-muted">
            Auto-fills from the venue's record. Override here if the venue
            doesn't have one set yet — fix it later in Project Maintenance → Venues.
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Organizer
          </div>
          <OrganizerPicker
            value={organizer}
            onChange={(v) => setOrganizer(v ?? "")}
          />
        </div>
      </PanelSection>

      {/* Ownership/PIC section removed at creation (owner 2026-08-19) — the
          Sales Director assigns the PIC on the detail page after creation. */}
    </Panel>
  );
}
