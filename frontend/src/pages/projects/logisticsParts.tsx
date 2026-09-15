import { useState, useEffect } from "react";
import { formatDateTime } from "../../lib/utils";
import { DateField } from "../../vendor/scm/components/DateField";

// ── Datetime field (inline commit on blur) ───────────────────
// InlineEdit supports only text/date/number; this is the logistics analog, and
// NOT the shared DateTimeField also imported here — they differ in CONTRACT.

export function LogisticsDateTimeField({
  label,
  value,
  onSave,
  readOnly = false,
}: {
  label: string;
  value: string | null | undefined;
  onSave: (next: string | null) => Promise<void> | void;
  /** View-only for Sales (owner 2026-07): disable inputs, no commit. */
  readOnly?: boolean;
}) {
  // Split into a separate date + time input — the native datetime-local
  // control is too wide for the Logistics 2-col grid (browser locale +
  // AM/PM stretches it on Windows). Two narrow controls side-by-side
  // pack tighter and the unambiguous DD/MM/YYYY HH:mm caption sits
  // below for confirmation.
  const initial = toLocalInput(value);
  const [datePart, setDatePart] = useState(initial.slice(0, 10));
  const [timePart, setTimePart] = useState(initial.slice(11, 16));
  useEffect(() => {
    const v = toLocalInput(value);
    setDatePart(v.slice(0, 10));
    setTimePart(v.slice(11, 16));
  }, [value]);

  const draft = datePart && timePart ? `${datePart}T${timePart}` : datePart;

  async function commit() {
    // Treat "date only" as midnight-local so the user can still tap a
    // date and hit save; without this, half-filled inputs would never
    // persist.
    const normalized =
      datePart && !timePart
        ? `${datePart}T00:00`
        : datePart && timePart
          ? `${datePart}T${timePart}`
          : null;
    if ((normalized ?? "") === (toLocalInput(value) || "")) return;
    await onSave(normalized);
  }

  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
        {label}
      </div>
      <div className="flex gap-1.5">
        <DateField
          fullWidth
          value={datePart}
          disabled={readOnly}
          onChange={(iso) => setDatePart(iso)}
          onBlur={readOnly ? undefined : commit}
          className="flex-1 min-w-0 rounded-md border border-border bg-surface px-2 py-1.5 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:bg-bg/40 disabled:opacity-70"
        />
        <input
          type="time"
          value={timePart}
          disabled={readOnly}
          onChange={(e) => setTimePart(e.target.value)}
          onBlur={readOnly ? undefined : commit}
          className="w-[88px] rounded-md border border-border bg-surface px-2 py-1.5 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:bg-bg/40 disabled:opacity-70"
        />
      </div>
      <div className="mt-1 font-mono text-[10px] text-ink-muted">
        {formatDateTime(draft)}
      </div>
    </div>
  );
}

// datetime-local inputs expect "YYYY-MM-DDTHH:mm" (no seconds, no Z).
// Our backend stores ISO strings like "2025-08-25T23:00:00.000Z" OR
// "2025-08-25T23:00". Strip to the first 16 chars after normalization.
function toLocalInput(v: string | null | undefined): string {
  if (!v) return "";
  // Drop any trailing "Z" or ms — we treat stored values as already
  // local-ish since the user enters them in local time.
  return v.slice(0, 16);
}

// Grab trip (owner 2026-07-23): instead of a manual name/phone/plate, a Grab
// trip is two staff helpers riding together, picked from the full helper list.
export function GrabHelperBox({
  helpers,
  onAdd,
}: {
  helpers: CrewMember[];
  onAdd: (o: { helper1: string; helper2: string }) => void;
}) {
  const [h, setH] = useState({ helper1: "", helper2: "" });
  const HelperSelect = ({ which, label }: { which: "helper1" | "helper2"; label: string }) => (
    <select
      value={h[which]}
      onChange={(e) => setH({ ...h, [which]: e.target.value })}
      className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-[12px]"
    >
      <option value="">{label}…</option>
      {helpers.map((o) => (
        <option key={o.id} value={o.name}>{o.name}</option>
      ))}
    </select>
  );
  return (
    <div className="space-y-2 rounded-md border border-dashed border-border bg-bg/40 p-2">
      <HelperSelect which="helper1" label="Helper 1" />
      <HelperSelect which="helper2" label="Helper 2" />
      <button
        onClick={() => {
          if (!h.helper1 && !h.helper2) return;
          onAdd(h);
          setH({ helper1: "", helper2: "" });
        }}
        className="rounded-md bg-synced/90 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-synced"
      >
        + Add
      </button>
    </div>
  );
}

// Driver / helper profile surfaced when one is picked in the Logistics
// Schedule. Fields come straight from /api/fleet/staff (set up in the
// Driver App or Logistics > Fleet > Driver). Pay rates and IC are
// intentionally omitted — they don't belong in the project view, and the
// endpoint no longer serves them to this page's wide Sales-view gate.
export type CrewMember = {
  id: number;
  name: string;
  phone: string | null;
  user_type: string | null;
  role_name: string | null;
};
