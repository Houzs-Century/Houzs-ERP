import { useEffect, useMemo, useRef, useState } from "react";
import { GripVertical, ChevronUp, ChevronDown, Plus, Pencil, Trash2, ShieldCheck, Eye, EyeOff, Upload, Image as ImageIcon } from "lucide-react";
import { useReorderable } from "../hooks/useReorderable";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { RowActionsMenu } from "../components/RowActionsMenu";
import { useQuery } from "../hooks/useQuery";
import { useAuth } from "../auth/AuthContext";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { Skeleton } from "../components/Skeleton";
import { api } from "../api/client";
import { cn } from "../lib/utils";
import { clearBrandLogoCache } from "../lib/branding";
import {
  useLocalities,
  distinctCountries,
  citiesInState,
} from "../vendor/scm/lib/localities-queries";
import { StatePicker } from "../vendor/scm/components/StatePicker";

// ── Projects tab ─────────────────────────────────────────────
// Lookup management for the project module: organizers, venues, and
// the default checklist that's cloned into every new project (per
// event type).

interface OrganizerRow {
  id: number;
  name: string;
  notes: string | null;
  active: number;
}
interface ContractorRow {
  id: number;
  name: string;
  notes: string | null;
  active: number;
}
interface VenueRow {
  id: number;
  name: string;
  state: string | null;
  /* Mig 0178 — optional so pre-mig responses still parse.
     Mig 0182 — city (optional same reason). */
  country?: string | null;
  postcode?: string | null;
  city?: string | null;
  /* Mig 0222 — physical venue size, free text (e.g. "12,000 sqft" or "Hall 3").
     Optional so pre-mig responses still parse. */
  size?: string | null;
  notes: string | null;
  active: number;
}
interface EventTypeRow {
  id: number;
  slug: string;
  name: string;
  default_template_id: number | null;
  sort_order: number;
  active?: number;
}
interface ChecklistTemplate {
  id: number;
  name: string;
  description: string | null;
  item_count: number;
  used_by: string | null;
}
interface ChecklistTemplateItem {
  id: number;
  seq: number;
  title: string;
  description: string | null;
  required_perm: string | null;
  /** mig 085 — display-only owner tag (DRIVER / SALES PIC / BD / PURCHASER). */
  role_label: string | null;
  /** mig 086 — when 1, every project instantiated from this template
   *  surfaces this row in the Driver App's Documents card. */
  crew_visible: number;
  due_offset_days: number | null;
  section_id: number | null;
  requires_review: number; // 0 | 1 — admin-driven flag (mig 050)
}

interface ChecklistTemplateSection {
  id: number;
  name: string;
  sort_order: number;
  /** mig 085 — "list" (default) or "documents" (column-headed layout). */
  display_mode?: "list" | "documents";
}

export function ProjectMaintenanceView() {
  const { user } = useAuth();
  // Cost Rates is finance data (per-brand transport / merchandise / commission
  // rate card) — the /api/projects/cost-rates endpoint is denyFinance-guarded
  // server-side (#345). HARD-GATE it on the DIRECTOR-level finance-viewer flag:
  // a non-finance-viewer with projects.maintenance access must NOT mount the
  // section AND must NOT fire the fetch (which would 403). Fail-open when the
  // flag is absent — the backend still enforces.
  const canProjectFinance = !!user?.project_finance_viewer;
  return (
    <div>
      <PageHeader
        eyebrow="Operations · Projects"
        title="Project Maintenance"
        description="All the picker lists that drive the new-project form: brands, event types, organizers, venues, plus the default checklist that clones into every new project."
      />
      {/* Picker lists are short — pack them two-up on wide screens to
          kill the vertical whitespace. Tasklist templates stay
          full-width because their item rows already pack columns
          internally. */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <BrandManager />
        <EventTypeManager />
        <OrganizerManager />
        <ContractorManager />
        <VenueManager />
      </div>
      {canProjectFinance && (
        <div className="mt-6">
          <CostRateManager enabled={canProjectFinance} />
        </div>
      )}
      <div className="mt-6">
        <ChecklistManager />
      </div>
    </div>
  );
}

// Picker lists collapse to this many rows by default; users hit the
// expand button to see the rest. Keeps the 2-up grid balanced when one
// list is much longer than the others.
const PICKER_PREVIEW_ROWS = 5;

// ── Collapsible section shell ────────────────────────────────
// Each manager below wraps its body in this. The header (title +
// count + rotating chevron) toggles the body open/closed. Default:
// the first section (Brands) is open; the rest start collapsed so
// the page isn't a single long scroll (owner: "Venues (59)" was
// always fully expanded). Count shows even when collapsed so admins
// can see list sizes at a glance.
function CollapsibleSection({
  title,
  description,
  count,
  defaultOpen = false,
  children,
}: {
  title: string;
  description: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-md border border-border bg-surface shadow-stone">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-6 py-4 text-left"
      >
        <h2 className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-accent">
          {title}
        </h2>
        {count != null && (
          <span className="rounded-full bg-bg px-2 py-0.5 font-mono text-[10px] font-semibold text-ink-muted">
            {count}
          </span>
        )}
        <ChevronDown
          size={16}
          className={cn(
            "ml-auto text-ink-muted transition-transform",
            open && "rotate-180"
          )}
        />
      </button>
      {open && (
        <div className="px-6 pb-6">
          <p className="mb-4 text-[12px] text-ink-secondary">{description}</p>
          {children}
        </div>
      )}
    </section>
  );
}

function ExpandToggle({
  total,
  expanded,
  onToggle,
}: {
  total: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (total <= PICKER_PREVIEW_ROWS) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-accent hover:underline"
    >
      {expanded
        ? "Collapse"
        : `Show all (${total - PICKER_PREVIEW_ROWS} more)`}
    </button>
  );
}

function OrganizerManager() {
  const toast = useToast();
  const dialog = useDialog();
  const q = useQuery<{ data: OrganizerRow[] }>("/api/projects/organizers",
    () => api.get("/api/projects/organizers")
  );
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [expanded, setExpanded] = useState(false);

  async function add() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setAdding(true);
    try {
      await api.post("/api/projects/organizers", { name: trimmed });
      setName("");
      q.reload();
      toast.success(`Added ${trimmed}`);
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    } finally {
      setAdding(false);
    }
  }

  async function remove(o: OrganizerRow) {
    if (
      !(await dialog.confirm({
        title: "Remove organizer",
        message: `Remove organizer "${o.name}"? Existing projects keep the value.`,
        danger: true,
        confirmLabel: "Remove",
      }))
    )
      return;
    try {
      await api.del(`/api/projects/organizers/${o.id}`);
      toast.success("Organizer removed");
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  return (
    <CollapsibleSection
      title="Organizers"
      count={q.data?.data?.length}
      description="Picker values for the project Organizer field. Soft delete — existing project rows still display whatever name they were saved with."
    >
      <div className="mb-3 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="Add organizer name…"
          className="h-9 flex-1 rounded-md border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
        />
        <Button variant="primary" onClick={add} disabled={adding || !name.trim()}>
          Add
        </Button>
      </div>

      <ul className="divide-y divide-border-subtle rounded-md border border-border bg-bg/40">
        {q.loading && (
          <>
            {Array.from({ length: 3 }).map((_, i) => (
              <li key={i} className="px-3 py-2">
                <Skeleton className="h-4 w-2/3" />
              </li>
            ))}
          </>
        )}
        {q.data?.data?.length === 0 && (
          <li className="px-3 py-3 text-[11.5px] text-ink-muted">No organizers yet.</li>
        )}
        {(expanded
          ? q.data?.data ?? []
          : (q.data?.data ?? []).slice(0, PICKER_PREVIEW_ROWS)
        ).map((o) => (
          <li
            key={o.id}
            className="flex items-center justify-between gap-3 px-3 py-2"
          >
            <span className="flex-1 text-[13px] font-medium text-ink">{o.name}</span>
            <RowActionsMenu
              items={[
                {
                  type: "action",
                  icon: Trash2,
                  label: "Remove",
                  danger: true,
                  onClick: () => remove(o),
                },
              ]}
            />
          </li>
        ))}
      </ul>
      <ExpandToggle
        total={q.data?.data?.length ?? 0}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
      />
    </CollapsibleSection>
  );
}

function ContractorManager() {
  const toast = useToast();
  const dialog = useDialog();
  const q = useQuery<{ data: ContractorRow[] }>("/api/projects/contractors",
    () => api.get("/api/projects/contractors")
  );
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [expanded, setExpanded] = useState(false);

  async function add() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setAdding(true);
    try {
      await api.post("/api/projects/contractors", { name: trimmed });
      setName("");
      q.reload();
      toast.success(`Added ${trimmed}`);
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    } finally {
      setAdding(false);
    }
  }

  async function remove(o: ContractorRow) {
    if (
      !(await dialog.confirm({
        title: "Remove contractor",
        message: `Remove contractor "${o.name}"? Existing projects keep the value.`,
        danger: true,
        confirmLabel: "Remove",
      }))
    )
      return;
    try {
      await api.del(`/api/projects/contractors/${o.id}`);
      toast.success("Contractor removed");
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  return (
    <CollapsibleSection
      title="Contractors"
      count={q.data?.data?.length}
      description="Picker values for the project Contractor field (booth setup/dismantle). Soft delete — existing project rows still display whatever name they were saved with."
    >
      <div className="mb-3 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="Add contractor name…"
          className="h-9 flex-1 rounded-md border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
        />
        <Button variant="primary" onClick={add} disabled={adding || !name.trim()}>
          Add
        </Button>
      </div>

      <ul className="divide-y divide-border-subtle rounded-md border border-border bg-bg/40">
        {q.loading && (
          <>
            {Array.from({ length: 3 }).map((_, i) => (
              <li key={i} className="px-3 py-2">
                <Skeleton className="h-4 w-2/3" />
              </li>
            ))}
          </>
        )}
        {q.data?.data?.length === 0 && (
          <li className="px-3 py-3 text-[11.5px] text-ink-muted">No contractors yet.</li>
        )}
        {(expanded
          ? q.data?.data ?? []
          : (q.data?.data ?? []).slice(0, PICKER_PREVIEW_ROWS)
        ).map((o) => (
          <li
            key={o.id}
            className="flex items-center justify-between gap-3 px-3 py-2"
          >
            <span className="flex-1 text-[13px] font-medium text-ink">{o.name}</span>
            <RowActionsMenu
              items={[
                {
                  type: "action",
                  icon: Trash2,
                  label: "Remove",
                  danger: true,
                  onClick: () => remove(o),
                },
              ]}
            />
          </li>
        ))}
      </ul>
      <ExpandToggle
        total={q.data?.data?.length ?? 0}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
      />
    </CollapsibleSection>
  );
}

/* MY_STATES was the hard-coded fallback list read by VenueManager. Removed
   2026-07-23 — VenueManager now uses <StatePicker> exclusively, which reads
   from scm.my_localities. Any future state that needs to appear here (e.g.
   the CN + SG rows seeded by mig 0181) is added via the Localities
   Maintenance UI, not a code constant. */

function VenueManager() {
  const toast = useToast();
  const dialog = useDialog();
  const q = useQuery<{ data: VenueRow[] }>("/api/projects/venues", () => api.get("/api/projects/venues"));
  const [name, setName] = useState("");
  const [stateField, setStateField] = useState("");
  /* Mig 0178 — Country + Postcode on venue. Country back-derives from state
     via scm.my_localities when the operator picks State first (owner:
     "只需要填写 State 就会自动带出国家"). Postcode optional per owner.
     Mig 0182 — City added (same maintenance-only dropdown pattern). */
  const [countryField, setCountryField] = useState("");
  const [cityField, setCityField] = useState("");
  const [postcodeField, setPostcodeField] = useState("");
  /* Mig 0222 — free-text physical venue size (owner enters sqft or a hall label). */
  const [sizeField, setSizeField] = useState("");
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const localities = useLocalities();
  const localityRows = localities.data ?? [];
  const knownCountries = useMemo(() => distinctCountries(localityRows), [localityRows]);
  const cityOptions = useMemo(
    () => (stateField ? citiesInState(localityRows, stateField) : []),
    [localityRows, stateField],
  );

  async function add() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setAdding(true);
    try {
      await api.post("/api/projects/venues", {
        name: trimmed,
        state: stateField.trim() || null,
        country: countryField.trim() || null,
        city: cityField.trim() || null,
        postcode: postcodeField.trim() || null,
        size: sizeField.trim() || null,
      });
      setName("");
      setStateField("");
      setCountryField("");
      setCityField("");
      setPostcodeField("");
      setSizeField("");
      q.reload();
      toast.success(`Added ${trimmed}`);
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    } finally {
      setAdding(false);
    }
  }

  async function patch(id: number, body: Record<string, any>) {
    try {
      await api.patch(`/api/projects/venues/${id}`, body);
      toast.success("Venue saved");
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  async function remove(v: VenueRow) {
    if (
      !(await dialog.confirm({
        title: "Remove venue",
        message: `Remove venue "${v.name}"? Existing projects keep the value.`,
        danger: true,
        confirmLabel: "Remove",
      }))
    )
      return;
    try {
      await api.del(`/api/projects/venues/${v.id}`);
      toast.success("Venue removed");
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  return (
    <CollapsibleSection
      title="Venues"
      count={q.data?.data?.length}
      description="Picker values for the project Venue field. Optionally tag each venue with a state — picking it on a new project will pre-fill the state."
    >
      {/* Owner spec (task #102, 2026-07-24):
          - StatePicker lists every seeded state grouped by country (MY first),
            with type-to-search — no hard-coded MY_STATES, no "Others" toggle.
          - No `(legacy)` / free-text fallback — a value not in my_localities
            must be added via the Localities Maintenance UI first.
          - Country auto-fills from State via StatePicker's derivedCountry
            callback. City + Postcode are optional and scoped to the picked
            state. */}
      {/* grid-cols use minmax(0,1fr) on the name track and min-w-0 on every input
          so each field shrinks to its own fixed track instead of forcing its
          ~20ch intrinsic min-width. That intrinsic min-width was the postcode
          overflow the owner reported: a bare <input> in a fixed 110px grid cell
          keeps min-width:auto, refuses to shrink below its content box, and
          spills past the cell. min-w-0 lets it size to the track. */}
      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_170px_130px_120px_110px_110px_auto]">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="Venue name…"
          className="h-9 min-w-0 rounded-md border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
        />
        <StatePicker
          value={stateField}
          onChange={(next, derivedCountry) => {
            setStateField(next);
            if (derivedCountry && derivedCountry !== countryField) setCountryField(derivedCountry);
            setCityField("");
          }}
        />
        <select
          value={countryField}
          onChange={(e) => setCountryField(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          disabled={knownCountries.length === 0}
          className="h-9 min-w-0 rounded-md border border-border bg-surface px-2 text-[12.5px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
        >
          <option value="">
            {knownCountries.length === 0 ? "no countries" : "— country —"}
          </option>
          {knownCountries.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select
          value={cityField}
          onChange={(e) => setCityField(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          disabled={!stateField || cityOptions.length === 0}
          className="h-9 min-w-0 rounded-md border border-border bg-surface px-2 text-[12.5px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
        >
          <option value="">
            {!stateField ? "pick state first" : cityOptions.length === 0 ? "no cities" : "— city —"}
          </option>
          {cityOptions.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <input
          value={postcodeField}
          onChange={(e) => setPostcodeField(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          inputMode="numeric"
          placeholder="postcode"
          className="h-9 min-w-0 rounded-md border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
        />
        <input
          value={sizeField}
          onChange={(e) => setSizeField(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="size"
          className="h-9 min-w-0 rounded-md border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
        />
        <Button variant="primary" onClick={add} disabled={adding || !name.trim()}>
          Add
        </Button>
      </div>

      <ul className="divide-y divide-border-subtle rounded-md border border-border bg-bg/40">
        {q.loading && (
          <>
            {Array.from({ length: 3 }).map((_, i) => (
              <li key={i} className="px-3 py-2">
                <Skeleton className="h-4 w-2/3" />
              </li>
            ))}
          </>
        )}
        {q.data?.data?.length === 0 && (
          <li className="px-3 py-3 text-[11.5px] text-ink-muted">No venues yet.</li>
        )}
        {(expanded
          ? q.data?.data ?? []
          : (q.data?.data ?? []).slice(0, PICKER_PREVIEW_ROWS)
        ).map((v) => (
          <li
            key={v.id}
            className="flex items-center justify-between gap-3 px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-ink">{v.name}</div>
              {/* Redundant gray state under the name removed (Houzs 2026-06-24)
                  — the state <select> to the right already shows it; owner
                  flagged the double-render as clutter. */}
            </div>
            {/* Inline state re-pick — same maintenance-only source
                (my_localities) as the Add form's StatePicker. No `(legacy)`
                fallback: a value not in the seeded set shows blank, forcing
                the operator to pick a legit state or add it via the
                Localities Maintenance UI first. */}
            <div className="w-56">
              <StatePicker
                value={v.state || ""}
                onChange={(next) => {
                  if (next !== (v.state || "")) {
                    patch(v.id, { state: next || null });
                  }
                }}
              />
            </div>
            {/* Inline size edit (mig 0222). Free text, committed on blur — not on
                every keystroke — so the operator can type "12,000 sqft" without a
                PATCH per character. key includes the saved value so a reload after
                save re-seeds defaultValue. */}
            <input
              key={`size-${v.id}-${v.size ?? ""}`}
              defaultValue={v.size ?? ""}
              onBlur={(e) => {
                const next = e.target.value.trim();
                if (next !== (v.size ?? "")) patch(v.id, { size: next || null });
              }}
              placeholder="size"
              className="h-8 w-28 min-w-0 rounded-md border border-border bg-surface px-2 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
            />
            <RowActionsMenu
              items={[
                {
                  type: "action",
                  icon: Trash2,
                  label: "Remove",
                  danger: true,
                  onClick: () => remove(v),
                },
              ]}
            />
          </li>
        ))}
      </ul>
      <ExpandToggle
        total={q.data?.data?.length ?? 0}
        expanded={expanded}
        onToggle={() => setExpanded((s) => !s)}
      />
    </CollapsibleSection>
  );
}

function ChecklistManager() {
  const toast = useToast();
  const eventTypesQ = useQuery<{ data: EventTypeRow[] }>("/api/projects/event-types",
    () => api.get("/api/projects/event-types")
  );
  const templatesQ = useQuery<{ data: ChecklistTemplate[] }>("/api/projects/checklist-templates",
    () => api.get("/api/projects/checklist-templates")
  );
  const [activeTemplate, setActiveTemplate] = useState<number | null>(null);

  const templates = templatesQ.data?.data ?? [];
  const eventTypes = eventTypesQ.data?.data ?? [];
  const currentTemplateId = activeTemplate ?? templates[0]?.id ?? null;

  async function setDefaultTemplate(eventTypeId: number, templateId: number | null) {
    try {
      await api.put(
        `/api/projects/event-types/${eventTypeId}/default-template`,
        { template_id: templateId }
      );
      toast.success("Default template updated");
      eventTypesQ.reload();
      templatesQ.reload();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  return (
    <CollapsibleSection
      title="Default Checklist"
      count={templates.length}
      description="Items in the chosen template are cloned into every new project of that event type. Editing here does not affect projects already created."
    >
      <div className="mb-4 rounded-md border border-border bg-bg/40 p-3">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Default template per event type
        </div>
        {eventTypesQ.loading ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {eventTypes.map((et) => (
              <label
                key={et.id}
                className="flex items-center justify-between gap-2 rounded border border-border bg-surface px-3 py-2"
              >
                <span className="text-[12px] font-semibold text-ink">{et.name}</span>
                <select
                  value={et.default_template_id ?? ""}
                  onChange={(e) =>
                    setDefaultTemplate(
                      et.id,
                      e.target.value ? parseInt(e.target.value, 10) : null
                    )
                  }
                  className="h-7 rounded-md border border-border bg-surface px-2 text-[11px] outline-none focus:border-primary"
                >
                  <option value="">— None —</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Editing
        </span>
        <select
          value={currentTemplateId ?? ""}
          onChange={(e) => setActiveTemplate(parseInt(e.target.value, 10) || null)}
          className="h-8 rounded-md border border-border bg-surface px-2 text-[12px] outline-none focus:border-primary"
        >
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} · {t.item_count} items
            </option>
          ))}
        </select>
        {currentTemplateId &&
          templates.find((t) => t.id === currentTemplateId)?.used_by && (
            <span className="text-[10.5px] text-ink-muted">
              Used by:{" "}
              {templates.find((t) => t.id === currentTemplateId)?.used_by}
            </span>
          )}
      </div>

      {currentTemplateId && (
        <ChecklistItemsEditor templateId={currentTemplateId} />
      )}
    </CollapsibleSection>
  );
}

// RowActionsMenu and ColorPicker live in ../components for reuse.

function ChecklistItemsEditor({ templateId }: { templateId: number }) {
  const toast = useToast();
  const dialog = useDialog();
  const q = useQuery<{
    data: ChecklistTemplateItem[];
    sections: ChecklistTemplateSection[];
  }>("/api/projects/checklist-templates/:/items",
    () => api.get(`/api/projects/checklist-templates/${templateId}/items`),
    [templateId]
  );
  // Per-section quick-add. Tracks which section's "Add task" form is
  // open + the title being typed.
  const [addInSectionId, setAddInSectionId] = useState<number | null | "_none">(null);
  const [newTitle, setNewTitle] = useState("");
  const [newOffset, setNewOffset] = useState("");
  const [adding, setAdding] = useState(false);
  // Tracks which section a drag is currently hovering over so we can
  // tint the drop zone. Null = not dragging into any section.
  const [dragOverSectionKey, setDragOverSectionKey] = useState<string | null>(null);

  // Section management state
  const [newSectionName, setNewSectionName] = useState("");
  const [editingSectionId, setEditingSectionId] = useState<number | null>(null);
  const [editingSectionName, setEditingSectionName] = useState("");
  const [addingSection, setAddingSection] = useState(false);

  const sections = q.data?.sections ?? [];

  async function addSection() {
    const n = newSectionName.trim();
    if (!n) return;
    setAddingSection(true);
    try {
      await api.post(`/api/projects/checklist-templates/${templateId}/sections`, {
        name: n,
      });
      setNewSectionName("");
      q.reload();
      toast.success("Section added");
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    } finally {
      setAddingSection(false);
    }
  }

  async function renameSection(id: number) {
    const n = editingSectionName.trim();
    if (!n) return;
    try {
      await api.patch(`/api/projects/checklist-templates/sections/${id}`, {
        name: n,
      });
      setEditingSectionId(null);
      setEditingSectionName("");
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  async function deleteSection(id: number, name: string) {
    if (
      !(await dialog.confirm({
        title: "Delete section",
        message: `Delete section "${name}"? Template items in it will move to Uncategorised.`,
        danger: true,
        confirmLabel: "Delete",
      }))
    )
      return;
    try {
      await api.del(`/api/projects/checklist-templates/sections/${id}`);
      toast.success("Section removed");
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  // Reorder a section by one slot. The order here propagates to every
  // project cloned from this template, which drives the stage-chip
  // progress bar at the top of the project detail page.
  async function moveSection(sectionId: number, delta: -1 | 1) {
    const idx = sections.findIndex((s) => s.id === sectionId);
    if (idx < 0) return;
    const target = idx + delta;
    if (target < 0 || target >= sections.length) return;
    const next = sections.slice();
    [next[idx], next[target]] = [next[target], next[idx]];
    try {
      await api.put(
        `/api/projects/checklist-templates/${templateId}/sections/reorder`,
        { ids: next.map((s) => s.id) }
      );
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed to reorder");
    }
  }

  // Local order overrides server data while a reorder is in flight, so
  // the UI feels instant. Reset whenever the server payload changes.
  const [localOrder, setLocalOrder] = useState<ChecklistTemplateItem[] | null>(
    null
  );
  const [dragId, setDragId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);

  useEffect(() => {
    if (q.data?.data) setLocalOrder(q.data.data);
  }, [q.data?.data]);

  const items = localOrder ?? q.data?.data ?? [];

  async function addItem(targetSectionId: number | null) {
    const t = newTitle.trim();
    if (!t) return;
    setAdding(true);
    try {
      await api.post(`/api/projects/checklist-templates/${templateId}/items`, {
        title: t,
        due_offset_days: newOffset ? parseInt(newOffset, 10) : null,
        section_id: targetSectionId,
      });
      setNewTitle("");
      setNewOffset("");
      // Keep the form open in the same section so admins can batch-add
      // multiple tasks per stage without re-clicking.
      q.reload();
      toast.success("Item added");
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    } finally {
      setAdding(false);
    }
  }

  async function patchItem(itemId: number, body: Record<string, any>) {
    try {
      await api.patch(`/api/projects/checklist-templates/items/${itemId}`, body);
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  async function removeItem(item: ChecklistTemplateItem) {
    if (
      !(await dialog.confirm({
        title: "Delete item",
        message: `Delete checklist item "${item.title}"?`,
        danger: true,
        confirmLabel: "Delete",
      }))
    )
      return;
    try {
      await api.del(`/api/projects/checklist-templates/items/${item.id}`);
      toast.success("Item removed");
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  // Push the proposed order to the server. The local state has already
  // been updated; on failure we reload to bring the server's truth back.
  async function persistOrder(next: ChecklistTemplateItem[]) {
    try {
      await api.put(
        `/api/projects/checklist-templates/${templateId}/items/reorder`,
        { ids: next.map((i) => i.id) }
      );
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed to reorder");
      q.reload();
    }
  }

  function moveBy(idx: number, delta: -1 | 1) {
    const target = idx + delta;
    if (target < 0 || target >= items.length) return;
    const next = items.slice();
    [next[idx], next[target]] = [next[target], next[idx]];
    setLocalOrder(next);
    persistOrder(next);
  }

  function onDragStart(e: React.DragEvent, id: number) {
    e.dataTransfer.setData("text/plain", String(id));
    e.dataTransfer.effectAllowed = "move";
    setDragId(id);
  }
  function onDragOver(e: React.DragEvent, overId: number) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverId !== overId) setDragOverId(overId);
  }
  function onDragLeaveRow(overId: number) {
    if (dragOverId === overId) setDragOverId(null);
  }
  function onDrop(e: React.DragEvent, targetId: number) {
    e.preventDefault();
    setDragOverId(null);
    setDragOverSectionKey(null);
    const sourceId = parseInt(e.dataTransfer.getData("text/plain"), 10);
    setDragId(null);
    if (!sourceId || sourceId === targetId) return;
    const sourceIdx = items.findIndex((i) => i.id === sourceId);
    const targetIdx = items.findIndex((i) => i.id === targetId);
    if (sourceIdx < 0 || targetIdx < 0) return;
    const source = items[sourceIdx];
    const target = items[targetIdx];
    const next = items.slice();
    const [moved] = next.splice(sourceIdx, 1);
    // Cross-section drop: inherit the target row's section before
    // splicing in, so the persisted order + section_id agree.
    const movedNew = { ...moved, section_id: target.section_id };
    const targetIdxAdj =
      sourceIdx < targetIdx ? targetIdx - 1 : targetIdx;
    next.splice(targetIdxAdj, 0, movedNew);
    setLocalOrder(next);
    if (source.section_id !== target.section_id) {
      // Patch the item's section_id first, then persist the new order.
      // Sequential awaits since reorder relies on the section move
      // already being durable.
      (async () => {
        try {
          await api.patch(`/api/projects/checklist-templates/items/${source.id}`, {
            section_id: target.section_id,
          });
          await persistOrder(next);
        } catch (e: any) {
          toast.error(e?.message || "Failed to move");
          q.reload();
        }
      })();
    } else {
      persistOrder(next);
    }
  }

  // Drop on a section block (header or empty area). Moves the dragged
  // item into this section and parks it at the end of that section's
  // existing items. Avoids the row-on-row collision when a section is
  // empty or the user wants to append rather than insert before a row.
  async function onDropOnSection(
    e: React.DragEvent,
    sectionId: number | null
  ) {
    e.preventDefault();
    setDragOverSectionKey(null);
    const sourceId = parseInt(e.dataTransfer.getData("text/plain"), 10);
    setDragId(null);
    if (!sourceId) return;
    const sourceIdx = items.findIndex((i) => i.id === sourceId);
    if (sourceIdx < 0) return;
    const source = items[sourceIdx];
    if ((source.section_id ?? null) === sectionId) {
      // Already in this section — nothing to do at the section level.
      return;
    }
    // Move the row to just after the last item in the target section
    // (or to the end if that section is empty).
    const next = items.slice();
    const [moved] = next.splice(sourceIdx, 1);
    moved.section_id = sectionId;
    let insertAt = next.length;
    for (let i = next.length - 1; i >= 0; i--) {
      if ((next[i].section_id ?? null) === sectionId) {
        insertAt = i + 1;
        break;
      }
    }
    next.splice(insertAt, 0, moved);
    setLocalOrder(next);
    try {
      await api.patch(`/api/projects/checklist-templates/items/${source.id}`, {
        section_id: sectionId,
      });
      await persistOrder(next);
    } catch (err: any) {
      toast.error(err?.message || "Failed to move");
      q.reload();
    }
  }

  function onDragOverSection(e: React.DragEvent, key: string) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverSectionKey !== key) setDragOverSectionKey(key);
  }

  return (
    <div>
      {/* Sections (mig 050) — define stages that group template items.
          Project-level sections are cloned from these on project create. */}
      <div className="mb-3 rounded-md border border-border bg-bg/40 p-2">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Sections (stages)
          </span>
          <span className="font-mono text-[9.5px] text-ink-muted/70">
            {sections.length} defined
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {sections.map((s, idx) =>
            editingSectionId === s.id ? (
              <span
                key={s.id}
                className="inline-flex items-center gap-1 rounded-full border border-accent bg-accent-soft px-1 py-0.5"
              >
                <input
                  value={editingSectionName}
                  onChange={(e) => setEditingSectionName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") renameSection(s.id);
                    if (e.key === "Escape") setEditingSectionId(null);
                  }}
                  autoFocus
                  className="h-5 w-32 rounded bg-surface px-1.5 text-[11px] outline-none"
                />
                <button
                  onClick={() => renameSection(s.id)}
                  className="rounded bg-accent px-1 py-0.5 font-mono text-[8.5px] font-semibold uppercase text-white"
                >
                  Save
                </button>
              </span>
            ) : (
              <span
                key={s.id}
                className="group inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-ink-secondary"
              >
                {/* Reorder arrows — order here propagates to every
                    project cloned from this template, driving the
                    stage progress bar's left-to-right order. */}
                <button
                  onClick={() => moveSection(s.id, -1)}
                  disabled={idx === 0}
                  className="opacity-50 hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-20"
                  title="Move left"
                >
                  <ChevronUp size={10} className="-rotate-90" />
                </button>
                <button
                  onClick={() => moveSection(s.id, 1)}
                  disabled={idx === sections.length - 1}
                  className="opacity-50 hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-20"
                  title="Move right"
                >
                  <ChevronDown size={10} className="-rotate-90" />
                </button>
                <span>{s.name}</span>
                <button
                  onClick={() => {
                    setEditingSectionId(s.id);
                    setEditingSectionName(s.name);
                  }}
                  className="opacity-50 hover:opacity-100"
                  title="Rename"
                >
                  <Pencil size={10} />
                </button>
                <button
                  onClick={() => deleteSection(s.id, s.name)}
                  className="opacity-50 hover:text-err hover:opacity-100"
                  title="Delete"
                >
                  <Trash2 size={10} />
                </button>
              </span>
            )
          )}
          <input
            value={newSectionName}
            onChange={(e) => setNewSectionName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addSection()}
            placeholder="New section…"
            className="h-7 w-44 rounded-md border border-dashed border-border bg-surface px-2 text-[11.5px] outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
          />
          <button
            onClick={addSection}
            disabled={addingSection || !newSectionName.trim()}
            className="rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-secondary hover:border-accent/40 hover:text-accent disabled:opacity-50"
          >
            <Plus size={10} className="inline-block mr-0.5" />
            Add
          </button>
        </div>
        {sections.length === 0 && (
          <p className="mt-1 text-[10px] text-ink-muted">
            No sections yet. Without sections, all template items land in
            "Uncategorised" on each project.
          </p>
        )}
      </div>

      {q.loading && items.length === 0 && (
        <div className="rounded-md border border-border bg-bg/40 px-3 py-3 text-[11.5px] text-ink-muted">
          Loading…
        </div>
      )}

      {/* Section-keyed blocks. Each block is a drop zone — drop a row
          onto it to move the row into that section. Reordering within
          a section uses the row-on-row drop (cross-section drop also
          works that way; the row inherits the target's section). */}
      {!q.loading &&
        (() => {
          const blocks: Array<{
            key: string;
            sectionId: number | null;
            name: string;
            items: ChecklistTemplateItem[];
          }> = [];
          for (const s of sections) {
            blocks.push({
              key: `s-${s.id}`,
              sectionId: s.id,
              name: s.name,
              items: items.filter((it) => it.section_id === s.id),
            });
          }
          const uncat = items.filter((it) => it.section_id == null);
          if (uncat.length > 0 || sections.length === 0) {
            blocks.push({
              key: "s-none",
              sectionId: null,
              name: "Uncategorised",
              items: uncat,
            });
          }
          return (
            <div className="space-y-2">
              {blocks.map((block) => {
                const isDropTarget =
                  dragOverSectionKey === block.key && dragId != null;
                const addOpenHere =
                  addInSectionId ===
                  (block.sectionId == null ? "_none" : block.sectionId);
                return (
                  <div
                    key={block.key}
                    onDragOver={(e) => onDragOverSection(e, block.key)}
                    onDragLeave={() => {
                      if (dragOverSectionKey === block.key)
                        setDragOverSectionKey(null);
                    }}
                    onDrop={(e) => onDropOnSection(e, block.sectionId)}
                    className={cn(
                      "rounded-md border bg-bg/40 transition-colors",
                      isDropTarget
                        ? "border-accent bg-accent-soft/30"
                        : "border-border"
                    )}
                  >
                    {/* Block header */}
                    <div className="flex items-center gap-2 border-b border-border-subtle bg-bg/60 px-3 py-1.5">
                      <span className="flex-1 text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">
                        {block.name}
                      </span>
                      <span className="font-mono text-[10px] text-ink-muted">
                        {block.items.length}
                      </span>
                      <button
                        onClick={() =>
                          setAddInSectionId(
                            addOpenHere
                              ? null
                              : block.sectionId == null
                              ? "_none"
                              : block.sectionId
                          )
                        }
                        className="rounded p-0.5 text-ink-muted hover:bg-surface-dim hover:text-accent"
                        title="Add task to this section"
                      >
                        <Plus size={12} />
                      </button>
                    </div>

                    {/* Block rows */}
                    <ul className="divide-y divide-border-subtle">
                      {block.items.length === 0 && !addOpenHere && (
                        <li className="px-3 py-3 text-[10.5px] italic text-ink-muted">
                          Drop a task here, or click <Plus size={10} className="inline" /> above to add one.
                        </li>
                      )}
                      {block.items.map((item) => {
                        const idx = items.findIndex((i) => i.id === item.id);
                        const blockIdx = block.items.findIndex(
                          (i) => i.id === item.id
                        );
                        const isDragging = dragId === item.id;
                        const isRowDropTarget =
                          dragOverId === item.id && dragId !== item.id;
                        return (
                          <li
                            key={item.id}
                            draggable
                            onDragStart={(e) => onDragStart(e, item.id)}
                            onDragOver={(e) => {
                              e.stopPropagation();
                              onDragOver(e, item.id);
                            }}
                            onDragLeave={() => onDragLeaveRow(item.id)}
                            onDrop={(e) => {
                              e.stopPropagation();
                              onDrop(e, item.id);
                            }}
                            onDragEnd={() => {
                              setDragId(null);
                              setDragOverId(null);
                              setDragOverSectionKey(null);
                            }}
                            className={cn(
                              "grid grid-cols-1 gap-2 px-3 py-2 transition-colors sm:grid-cols-[auto_minmax(0,1fr)_110px_96px_auto] sm:items-center",
                              isDragging && "opacity-40",
                              isRowDropTarget && "bg-accent-soft/40"
                            )}
                          >
                            {/* Drag handle + arrow controls */}
                            <div className="flex items-center gap-0.5 text-ink-muted">
                              <span
                                className="cursor-grab rounded p-1 hover:bg-bg/70 active:cursor-grabbing"
                                title="Drag to reorder or move between sections"
                                aria-label="Drag handle"
                              >
                                <GripVertical size={14} />
                              </span>
                              <button
                                type="button"
                                onClick={() => moveBy(idx, -1)}
                                disabled={blockIdx === 0}
                                title="Move up"
                                aria-label="Move up"
                                className="rounded p-1 hover:bg-bg/70 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
                              >
                                <ChevronUp size={14} />
                              </button>
                              <button
                                type="button"
                                onClick={() => moveBy(idx, 1)}
                                disabled={blockIdx === block.items.length - 1}
                                title="Move down"
                                aria-label="Move down"
                                className="rounded p-1 hover:bg-bg/70 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
                              >
                                <ChevronDown size={14} />
                              </button>
                              <span className="ml-1 font-mono text-[10px] text-ink-muted/70">
                                {blockIdx + 1}
                              </span>
                            </div>
                            <input
                              defaultValue={item.title}
                              key={`title-${item.id}-${item.title}`}
                              onBlur={(e) => {
                                if (e.target.value !== item.title)
                                  patchItem(item.id, { title: e.target.value });
                              }}
                              className="h-7 rounded-md border border-border bg-surface px-2 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
                            />
                            <input
                              defaultValue={item.role_label ?? ""}
                              key={`role-${item.id}-${item.role_label ?? ""}`}
                              onBlur={(e) => {
                                const v = e.target.value.trim().toUpperCase() || null;
                                if (v !== (item.role_label ?? null))
                                  patchItem(item.id, { role_label: v });
                              }}
                              placeholder="Role"
                              title="Display-only owner tag (e.g. DRIVER, SALES PIC, BD, PURCHASER)"
                              className="h-7 w-full rounded-md border border-border bg-surface px-2 text-[11px] uppercase tracking-wider outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
                            />
                            <input
                              defaultValue={item.due_offset_days ?? ""}
                              key={`offset-${item.id}-${item.due_offset_days ?? ""}`}
                              onBlur={(e) => {
                                const n = e.target.value
                                  ? parseInt(e.target.value, 10)
                                  : null;
                                if (n !== item.due_offset_days)
                                  patchItem(item.id, { due_offset_days: n });
                              }}
                              type="number"
                              placeholder="±d"
                              title="Days from project start_date (negative = before)"
                              className="h-7 w-full rounded-md border border-border bg-surface px-2 text-[11px] tabular-nums outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
                            />
                            {/* State strip — visible chips for the
                                review-required and crew-visible flags
                                (otherwise hidden inside the kebab menu
                                and easy to miss across 19 rows). The
                                same kebab still shows the toggles for
                                editing. */}
                            <div className="flex items-center justify-end gap-1.5">
                              {!!item.requires_review && (
                                <span
                                  className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-800"
                                  title="Review required before this task can be marked done"
                                >
                                  <ShieldCheck size={9} /> Review
                                </span>
                              )}
                              {!!item.crew_visible && (
                                <span
                                  className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-accent"
                                  title="Visible to crew (drivers + helpers) in the Driver App"
                                >
                                  <Eye size={9} /> Crew
                                </span>
                              )}
                              <RowActionsMenu
                                indicator={!!item.requires_review || !!item.crew_visible}
                                items={[
                                {
                                  type: "toggle",
                                  icon: ShieldCheck,
                                  label: "Need review",
                                  active: !!item.requires_review,
                                  onClick: () =>
                                    patchItem(item.id, {
                                      requires_review: !item.requires_review,
                                    }),
                                },
                                {
                                  type: "toggle",
                                  icon: Eye,
                                  label: "Crew can view",
                                  active: !!item.crew_visible,
                                  onClick: () =>
                                    patchItem(item.id, {
                                      crew_visible: !item.crew_visible,
                                    }),
                                },
                                {
                                  type: "action",
                                  icon: Trash2,
                                  label: "Delete",
                                  danger: true,
                                  onClick: () => removeItem(item),
                                },
                              ]}
                              />
                            </div>
                          </li>
                        );
                      })}
                      {/* Inline quick-add inside the section */}
                      {addOpenHere && (
                        <li className="grid grid-cols-1 gap-2 bg-bg/30 px-3 py-2 sm:grid-cols-[1fr_140px_auto_auto] sm:items-center">
                          <input
                            value={newTitle}
                            onChange={(e) => setNewTitle(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") addItem(block.sectionId);
                              if (e.key === "Escape") {
                                setAddInSectionId(null);
                                setNewTitle("");
                                setNewOffset("");
                              }
                            }}
                            placeholder="New task title…"
                            autoFocus
                            className="h-8 rounded-md border border-accent/40 bg-surface px-2 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
                          />
                          <input
                            value={newOffset}
                            onChange={(e) => setNewOffset(e.target.value)}
                            onKeyDown={(e) =>
                              e.key === "Enter" && addItem(block.sectionId)
                            }
                            placeholder="Days from start"
                            title="Days from project start_date (negative = before)"
                            type="number"
                            className="h-8 rounded-md border border-border bg-surface px-2 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
                          />
                          <Button
                            variant="primary"
                            onClick={() => addItem(block.sectionId)}
                            disabled={adding || !newTitle.trim()}
                          >
                            Add
                          </Button>
                          <button
                            onClick={() => {
                              setAddInSectionId(null);
                              setNewTitle("");
                              setNewOffset("");
                            }}
                            className="rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted"
                          >
                            Cancel
                          </button>
                        </li>
                      )}
                    </ul>
                  </div>
                );
              })}
            </div>
          );
        })()}

      <p className="mt-2 text-[10.5px] text-ink-muted">
        Drag a row's handle to reorder within a section, or drop it on a
        different section's block to move it. The "Mgmt review" toggle
        flags tasks that need approval before they can be ticked done on
        a project.
      </p>
    </div>
  );
}

// ── Brand manager ────────────────────────────────────────────
// Brands live in project_brands (migration 044). The calendar now
// tints by project status (mig 088), so brand colour is unused;
// the column still exists in the DB for backward compatibility.

interface BrandRow {
  id: number;
  name: string;
  color: string;
  sort_order: number;
  active: number;
  /** R2 key of the brand's letterhead logo (migration-pg 0069); null/'' =
   *  none. The pg driver camelCases result columns, so consumers dual-read
   *  logo_r2_key ?? logoR2Key. */
  logo_r2_key?: string | null;
  logoR2Key?: string | null;
}

/** Dual-read the brand logo key (camelCase ?? snake_case — #1 recurring bug). */
const brandLogoKey = (b: BrandRow): string =>
  (b.logo_r2_key ?? b.logoR2Key ?? "").trim();

// ── Per-row brand logo cell ─────────────────────────────────
// Thumb + Upload/Replace/Remove, cloning the Settings → Branding company
// logo uploader (api.postBinary raw-binary upload + fetchBlobUrl preview,
// because the serve endpoint needs the bearer so <img src> can't hit it
// directly + in-app dialog.confirm for Remove). The uploaded logo prints
// on SCM Sales Order PDFs when the SO resolves to this brand.
function BrandLogoCell({
  brand,
  onChanged,
}: {
  brand: BrandRow;
  onChanged: () => void;
}) {
  const toast = useToast();
  const dialog = useDialog();
  const inputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = brandLogoKey(brand);

  // Load / refresh the thumb whenever the stored key changes. Keys carry a
  // Date.now() stamp, so passing the key as a query param busts stale caches.
  useEffect(() => {
    if (!key) {
      setUrl(null);
      return;
    }
    let obj: string | null = null;
    let cancelled = false;
    api
      .fetchBlobUrl(`/api/projects/brands/${brand.id}/logo?k=${encodeURIComponent(key)}`)
      .then((u) => {
        if (cancelled) {
          URL.revokeObjectURL(u);
        } else {
          obj = u;
          setUrl(u);
        }
      })
      .catch(() => setUrl(null));
    return () => {
      cancelled = true;
      if (obj) URL.revokeObjectURL(obj);
    };
  }, [brand.id, key]);

  async function upload(file: File | null) {
    if (!file) return;
    if (!["image/png", "image/jpeg"].includes(file.type)) {
      toast.error("Logo must be a PNG or JPG image");
      return;
    }
    if (file.size > 1024 * 1024) {
      toast.error("Logo must be under 1 MB");
      return;
    }
    setBusy(true);
    try {
      await api.postBinary(`/api/projects/brands/${brand.id}/logo`, file, file.type);
      clearBrandLogoCache(); // next SO PDF re-reads the new image
      toast.success(`${brand.name} logo uploaded`);
      onChanged();
    } catch (e: any) {
      toast.error(e?.message || "Failed to upload logo");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const ok = await dialog.confirm({
      title: "Remove brand logo?",
      message: `Sales Order PDFs for "${brand.name}" go back to the company letterhead.`,
      confirmLabel: "Remove",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.del(`/api/projects/brands/${brand.id}/logo`);
      clearBrandLogoCache();
      toast.success("Logo removed");
      onChanged();
    } catch (e: any) {
      toast.error(e?.message || "Failed to remove logo");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {url ? (
        <img
          src={url}
          alt={`${brand.name} logo`}
          className="h-8 max-w-[80px] shrink-0 rounded-sm object-contain"
        />
      ) : (
        <div
          className="grid h-8 w-10 shrink-0 place-items-center rounded-sm border border-dashed border-border text-ink-muted"
          title="No logo — SO PDFs use the company letterhead"
        >
          <ImageIcon size={13} />
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={(e) => {
          void upload(e.target.files?.[0] ?? null);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        title={key ? "Replace logo (PNG/JPG, up to 1 MB)" : "Upload logo (PNG/JPG, up to 1 MB)"}
        className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[10.5px] font-medium text-ink-secondary hover:bg-bg/70 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Upload size={11} />
        {busy ? "Working…" : key ? "Replace" : "Upload"}
      </button>
      {key && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void remove()}
          title="Remove logo"
          className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[10.5px] font-medium text-ink-secondary hover:bg-bg/70 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Trash2 size={11} />
          Remove
        </button>
      )}
    </div>
  );
}

function BrandManager() {
  const toast = useToast();
  const dialog = useDialog();
  const q = useQuery<{ data: BrandRow[] }>("/api/projects/brands?full=1&include_inactive=1", () =>
    api.get("/api/projects/brands?full=1&include_inactive=1")
  );
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Drag + arrow ordering replaces the old sort_order number input.
  const reorder = useReorderable(q.data?.data ?? [], async (ids) => {
    try {
      await api.put("/api/projects/brands/reorder", { ids });
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed to reorder");
      q.reload();
    }
  });

  async function add() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setAdding(true);
    try {
      await api.post("/api/projects/brands", {
        name: trimmed,
        sort_order: (q.data?.data?.length ?? 0) * 10,
      });
      setName("");
      q.reload();
      toast.success(`Added ${trimmed}`);
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    } finally {
      setAdding(false);
    }
  }

  async function patch(
    b: BrandRow,
    body: Partial<Omit<BrandRow, "active">> & { active?: boolean }
  ) {
    try {
      await api.patch(`/api/projects/brands/${b.id}`, body);
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  // Owner 2026-07-23: real delete. The old "Hide from picker" only marked
  // active=0 and left the row in the list — after the branding seed left
  // duplicates (Happi.S vs Happi.S Mattress, 2990s vs 2990s Mattress) the
  // owner needed to actually remove them. project_brands.id is not FK'd
  // (projects.brand is free text), so a hard delete is safe; ?hard=1 tells
  // the backend to DELETE rather than deactivate.
  async function removePermanently(b: BrandRow) {
    if (
      !(await dialog.confirm({
        title: "Permanently delete brand",
        message:
          `Delete "${b.name}" from this list? This cannot be undone. ` +
          `Existing projects that reference "${b.name}" keep the text.`,
        danger: true,
        confirmLabel: "Delete permanently",
      }))
    )
      return;
    try {
      await api.del(`/api/projects/brands/${b.id}?hard=1`);
      toast.success("Brand deleted");
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  return (
    <CollapsibleSection
      title="Brands"
      count={q.data?.data?.length}
      defaultOpen
      description="Shown in the project Brand dropdown. Renames cascade to existing projects so historical data stays in sync."
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="New brand name…"
          className="h-9 min-w-[200px] flex-1 rounded-md border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
        />
        <Button variant="primary" onClick={add} disabled={adding || !name.trim()}>
          Add
        </Button>
      </div>

      <ul className="divide-y divide-border-subtle rounded-md border border-border bg-bg/40">
        {q.loading && (
          <>
            {Array.from({ length: 3 }).map((_, i) => (
              <li key={i} className="px-3 py-2">
                <Skeleton className="h-4 w-2/3" />
              </li>
            ))}
          </>
        )}
        {q.data?.data?.length === 0 && (
          <li className="px-3 py-3 text-[11.5px] text-ink-muted">
            No brands configured.
          </li>
        )}
        {(expanded
          ? reorder.view
          : reorder.view.slice(0, PICKER_PREVIEW_ROWS)
        ).map((b, idx) => {
          const handlers = reorder.rowHandlers(b.id);
          const isDragging = reorder.isDragging(b.id);
          const isDropTarget = reorder.isDropTarget(b.id);
          return (
          <li
            key={b.id}
            {...handlers}
            className={cn(
              "flex flex-wrap items-center gap-2 px-3 py-2 transition-colors",
              // Owner 2026-07-23: 50% fade made the 3-dots look disabled and
              // nobody could tell a hidden brand could be re-shown. Softer.
              !b.active && "opacity-75",
              isDragging && "opacity-40",
              isDropTarget && "bg-accent-soft/40"
            )}
          >
            {/* Drag + arrow controls — replaces the old sort_order
                number input for visual consistency with the
                checklist editor. */}
            <div className="flex items-center gap-0.5 text-ink-muted">
              <span
                className="cursor-grab rounded p-1 hover:bg-bg/70 active:cursor-grabbing"
                title="Drag to reorder"
                aria-label="Drag handle"
              >
                <GripVertical size={14} />
              </span>
              <button
                type="button"
                onClick={() => reorder.moveBy(idx, -1)}
                disabled={idx === 0}
                title="Move up"
                aria-label="Move up"
                className="rounded p-1 hover:bg-bg/70 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
              >
                <ChevronUp size={14} />
              </button>
              <button
                type="button"
                onClick={() => reorder.moveBy(idx, 1)}
                disabled={idx === reorder.view.length - 1}
                title="Move down"
                aria-label="Move down"
                className="rounded p-1 hover:bg-bg/70 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
              >
                <ChevronDown size={14} />
              </button>
            </div>
            <input
              defaultValue={b.name}
              key={`name-${b.id}-${b.name}`}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== b.name) patch(b, { name: v });
              }}
              className="flex-1 min-w-[140px] h-8 rounded-md border border-transparent bg-transparent px-2 text-[13px] font-medium text-ink hover:border-border focus:border-primary focus:bg-surface focus:ring-1 focus:ring-primary/20 focus:outline-none"
            />
            {/* Brand logo (owner 2026-07) — prints on SCM Sales Order PDFs
                in place of the company letterhead when the SO resolves to
                this brand. */}
            <BrandLogoCell brand={b} onChanged={() => q.reload()} />
            <span
              className={cn(
                "rounded px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider",
                b.active ? "bg-synced/15 text-synced" : "bg-bg text-ink-muted"
              )}
            >
              {b.active ? "Active" : "Hidden"}
            </span>
            <RowActionsMenu
              indicator={!b.active}
              items={[
                {
                  type: "toggle",
                  icon: b.active ? Eye : EyeOff,
                  label: b.active ? "Hide from picker" : "Show in picker",
                  active: !!b.active,
                  onClick: () => patch(b, { active: !b.active }),
                },
                {
                  type: "action",
                  icon: Trash2,
                  label: "Delete permanently",
                  danger: true,
                  onClick: () => removePermanently(b),
                },
              ]}
            />
          </li>
          );
        })}
      </ul>
      <ExpandToggle
        total={q.data?.data?.length ?? 0}
        expanded={expanded}
        onToggle={() => setExpanded((s) => !s)}
      />
    </CollapsibleSection>
  );
}

// ── Event type manager ──────────────────────────────────────
// project_event_types has existed since 021; this UI was missing.

function EventTypeManager() {
  const toast = useToast();
  const dialog = useDialog();
  const q = useQuery<{ data: EventTypeRow[] }>("/api/projects/event-types?include_inactive=1", () =>
    api.get("/api/projects/event-types?include_inactive=1")
  );
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const reorder = useReorderable(q.data?.data ?? [], async (ids) => {
    try {
      await api.put("/api/projects/event-types/reorder", { ids });
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed to reorder");
      q.reload();
    }
  });

  async function add() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setAdding(true);
    try {
      await api.post("/api/projects/event-types", {
        name: trimmed,
        sort_order: (q.data?.data?.length ?? 0) * 10,
      });
      setName("");
      q.reload();
      toast.success(`Added ${trimmed}`);
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    } finally {
      setAdding(false);
    }
  }

  async function patch(t: EventTypeRow, body: any) {
    try {
      await api.patch(`/api/projects/event-types/${t.id}`, body);
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  async function remove(t: EventTypeRow) {
    if (
      !(await dialog.confirm({
        title: "Hide event type",
        message: `Hide "${t.name}" from the picker? Existing projects keep their event type.`,
        danger: true,
        confirmLabel: "Hide",
      }))
    )
      return;
    try {
      await api.del(`/api/projects/event-types/${t.id}`);
      toast.success("Event type hidden");
      q.reload();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  return (
    <CollapsibleSection
      title="Event Types"
      count={q.data?.data?.length}
      description={'Shown in the "Event Type" dropdown when creating a project. Setting a default checklist template on a type auto-seeds the checklist for every new project of that type.'}
    >
      <div className="mb-3 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="New event type name…"
          className="h-9 flex-1 rounded-md border border-border bg-surface px-3 text-[12.5px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
        />
        <Button variant="primary" onClick={add} disabled={adding || !name.trim()}>
          Add
        </Button>
      </div>

      <ul className="divide-y divide-border-subtle rounded-md border border-border bg-bg/40">
        {q.loading && (
          <>
            {Array.from({ length: 3 }).map((_, i) => (
              <li key={i} className="px-3 py-2">
                <Skeleton className="h-4 w-2/3" />
              </li>
            ))}
          </>
        )}
        {q.data?.data?.length === 0 && (
          <li className="px-3 py-3 text-[11.5px] text-ink-muted">
            No event types yet.
          </li>
        )}
        {(expanded
          ? reorder.view
          : reorder.view.slice(0, PICKER_PREVIEW_ROWS)
        ).map((t, idx) => {
          const active = (t as any).active !== 0;
          const handlers = reorder.rowHandlers(t.id);
          const isDragging = reorder.isDragging(t.id);
          const isDropTarget = reorder.isDropTarget(t.id);
          return (
            <li
              key={t.id}
              {...handlers}
              className={cn(
                "flex flex-wrap items-center gap-2 px-3 py-2 transition-colors",
                !active && "opacity-50",
                isDragging && "opacity-40",
                isDropTarget && "bg-accent-soft/40"
              )}
            >
              {/* Drag + arrow controls — replaces the old sort_order
                  number input. */}
              <div className="flex items-center gap-0.5 text-ink-muted">
                <span
                  className="cursor-grab rounded p-1 hover:bg-bg/70 active:cursor-grabbing"
                  title="Drag to reorder"
                  aria-label="Drag handle"
                >
                  <GripVertical size={14} />
                </span>
                <button
                  type="button"
                  onClick={() => reorder.moveBy(idx, -1)}
                  disabled={idx === 0}
                  title="Move up"
                  aria-label="Move up"
                  className="rounded p-1 hover:bg-bg/70 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => reorder.moveBy(idx, 1)}
                  disabled={idx === reorder.view.length - 1}
                  title="Move down"
                  aria-label="Move down"
                  className="rounded p-1 hover:bg-bg/70 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <ChevronDown size={14} />
                </button>
              </div>
              <input
                defaultValue={t.name}
                key={`name-${t.id}-${t.name}`}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== t.name) patch(t, { name: v });
                }}
                className="flex-1 min-w-[160px] h-8 rounded-md border border-transparent bg-transparent px-2 text-[13px] font-medium text-ink hover:border-border focus:border-primary focus:bg-surface focus:ring-1 focus:ring-primary/20 focus:outline-none"
              />
              {/* Slug hidden (Houzs 2026-06-24) — owner: the tiny gray machine
                  code next to each name is unnecessary clutter + misaligned.
                  Slug stays the stable machine value; just no longer shown. */}
              <span
                className={cn(
                  "rounded px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider",
                  active ? "bg-synced/15 text-synced" : "bg-bg text-ink-muted"
                )}
              >
                {active ? "Active" : "Hidden"}
              </span>
              <RowActionsMenu
                indicator={!active}
                items={[
                  {
                    type: "toggle",
                    icon: active ? Eye : EyeOff,
                    label: active ? "Active" : "Hidden",
                    active,
                    onClick: () => patch(t, { active: !active }),
                  },
                  {
                    type: "action",
                    icon: Trash2,
                    label: "Hide from picker",
                    danger: true,
                    onClick: () => remove(t),
                  },
                ]}
              />
            </li>
          );
        })}
      </ul>
      <ExpandToggle
        total={q.data?.data?.length ?? 0}
        expanded={expanded}
        onToggle={() => setExpanded((s) => !s)}
      />
    </CollapsibleSection>
  );
}

// ── Cost rates (mig 063) ─────────────────────────────────────
// Per-brand transport / merchandise / commission rate card. The
// recompute service runs on every finance edit and on every save
// here, so changes are visible across all active projects of the
// brand immediately.

interface CostRateRow {
  brand: string;
  transport_pct: number;
  merchandise_pct: number;
  commission_normal_pct: number;
  commission_boost_pct: number | null;
  boost_min_gp_pct: number | null;
  boost_min_sales: number | null;
  updated_at: string | null;
}

function CostRateManager({ enabled = true }: { enabled?: boolean }) {
  const toast = useToast();
  // `enabled` is the finance-viewer hard gate (see ProjectMaintenanceView). The
  // parent already skips rendering this section when false; the enabled guard
  // is the belt-and-suspenders so the denyFinance-guarded fetch never fires.
  const q = useQuery<{ data: CostRateRow[] }>("/api/projects/cost-rates",
    () => api.get("/api/projects/cost-rates"),
    [],
    { enabled },
  );

  return (
    <CollapsibleSection
      title="Cost Rates"
      count={q.data?.data?.length}
      description="Per-brand transport, merchandise, and commission. Saving a row recomputes auto cost lines for every active project on that brand."
    >
      {q.loading && !q.data ? (
        <Skeleton className="h-32" />
      ) : q.error ? (
        <div className="text-[12px] text-err">{q.error}</div>
      ) : (
        <div className="space-y-2">
          {(q.data?.data ?? []).map((r) => (
            <CostRateRowEditor
              key={r.brand}
              row={r}
              onSaved={() => {
                toast.success(`${r.brand} rates saved`);
                q.reload();
              }}
              onError={(msg) => toast.error(msg)}
            />
          ))}
          {(q.data?.data?.length ?? 0) === 0 && (
            <div className="rounded-md border border-dashed border-border bg-bg/40 px-3 py-2 text-[11.5px] text-ink-muted">
              No active brands. Add one in the Brands picker first.
            </div>
          )}
        </div>
      )}
    </CollapsibleSection>
  );
}

function CostRateRowEditor({
  row,
  onSaved,
  onError,
}: {
  row: CostRateRow;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  // Local edit state per numeric field. Empty string saves as NULL
  // for the optional boost columns; clearing those disables the
  // boost tier for the brand.
  const [transport, setTransport] = useState(String(row.transport_pct ?? ""));
  const [merchandise, setMerchandise] = useState(String(row.merchandise_pct ?? ""));
  const [normal, setNormal] = useState(String(row.commission_normal_pct ?? ""));
  const [boost, setBoost] = useState(
    row.commission_boost_pct == null ? "" : String(row.commission_boost_pct),
  );
  const [minGp, setMinGp] = useState(
    row.boost_min_gp_pct == null ? "" : String(row.boost_min_gp_pct),
  );
  const [minSales, setMinSales] = useState(
    row.boost_min_sales == null ? "" : String(row.boost_min_sales),
  );
  const [saving, setSaving] = useState(false);

  const dirty =
    transport !== String(row.transport_pct ?? "") ||
    merchandise !== String(row.merchandise_pct ?? "") ||
    normal !== String(row.commission_normal_pct ?? "") ||
    boost !== (row.commission_boost_pct == null ? "" : String(row.commission_boost_pct)) ||
    minGp !== (row.boost_min_gp_pct == null ? "" : String(row.boost_min_gp_pct)) ||
    minSales !== (row.boost_min_sales == null ? "" : String(row.boost_min_sales));

  async function save() {
    const numOrNull = (s: string): number | null => {
      const t = s.trim();
      if (!t) return null;
      const n = Number(t);
      if (!Number.isFinite(n) || n < 0) return null;
      return n;
    };
    setSaving(true);
    try {
      await api.put(`/api/projects/cost-rates/${encodeURIComponent(row.brand)}`, {
        transport_pct: numOrNull(transport) ?? 0,
        merchandise_pct: numOrNull(merchandise) ?? 0,
        commission_normal_pct: numOrNull(normal) ?? 0,
        commission_boost_pct: numOrNull(boost),
        boost_min_gp_pct: numOrNull(minGp),
        boost_min_sales: numOrNull(minSales),
      });
      onSaved();
    } catch (e: any) {
      onError(e?.message || "Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-md border border-border bg-bg/30 px-3 py-2">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-display text-[13px] font-extrabold tracking-tight text-ink">
          {row.brand}
        </span>
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="rounded-md bg-accent px-3 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
        >
          {saving ? "Saving…" : dirty ? "Save" : "Saved"}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3 lg:grid-cols-6">
        <RateField label="Transport %" value={transport} onChange={setTransport} />
        <RateField label="Merchandise %" value={merchandise} onChange={setMerchandise} />
        <RateField label="Comm normal %" value={normal} onChange={setNormal} />
        <RateField
          label="Comm boost %"
          value={boost}
          onChange={setBoost}
          optional
        />
        <RateField
          label="Boost ≥ GP %"
          value={minGp}
          onChange={setMinGp}
          optional
        />
        <RateField
          label="Boost ≥ Sales"
          value={minSales}
          onChange={setMinSales}
          optional
          big
        />
      </div>
      {row.commission_boost_pct != null && (
        <p className="mt-1.5 text-[10.5px] text-ink-muted">
          Boost = {row.commission_boost_pct}% applies when{" "}
          {row.boost_min_gp_pct != null
            ? `GP ≥ ${row.boost_min_gp_pct}%`
            : "any GP"}
          {row.boost_min_sales != null
            ? ` AND sales ≥ ${row.boost_min_sales.toLocaleString()}`
            : ""}
          .
        </p>
      )}
    </div>
  );
}

function RateField({
  label,
  value,
  onChange,
  optional,
  big,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  optional?: boolean;
  big?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
        {label}
        {optional && <span className="ml-1 normal-case text-ink-muted/70">(optional)</span>}
      </span>
      <input
        type="number"
        step={big ? "1000" : "0.1"}
        min="0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-border bg-surface px-2 py-1 font-mono text-[12px] outline-none focus:border-primary"
        placeholder={optional ? "—" : "0"}
      />
    </label>
  );
}
