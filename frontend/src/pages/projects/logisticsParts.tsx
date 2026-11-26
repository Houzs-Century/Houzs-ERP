import { useState, useEffect } from "react";
import { formatDateTime } from "../../lib/utils";
import { DateField } from "../../vendor/scm/components/DateField";


export function LogisticsDateTimeField({
  label,
  value,
  onSave,
  readOnly = false,
}: {
  label: string;
  value: string | null | undefined;
  onSave: (next: string | null) => Promise<void> | void;
  readOnly?: boolean;
}) {
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

function toLocalInput(v: string | null | undefined): string {
  if (!v) return "";
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

export type CrewMember = {
  id: number | string;
  name: string;
  phone: string | null;
  user_type: string | null;
  role_name: string | null;
};
