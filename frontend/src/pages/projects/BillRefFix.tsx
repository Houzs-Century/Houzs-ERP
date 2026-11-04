// Change a bill's reference on the event's sales report, so the Sales Order matches
// (owner 2026-11-04). The chat message is the record, so that is what changes.
import { useState } from "react";
import { api } from "../../api/client";

export function BillRefFix({ projectId, from, onSaved }: { projectId: number; from: string; onSaved: () => void }) {
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    const to = (value ?? "").trim();
    if (!to || to === from) { setValue(null); return; }
    setBusy(true); setErr(null);
    try {
      await api.post(`/api/project-sales-bills/${projectId}/rename-ref`, { from, to });
      setValue(null);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not change the reference.");
    } finally { setBusy(false); }
  };

  if (value === null) {
    return <button type="button" className="ml-2 text-[11.5px] text-primary hover:underline" onClick={(e) => { e.stopPropagation(); setValue(from); }}>Edit</button>;
  }
  return (
    <span className="inline-flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value.toUpperCase())}
        onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setValue(null); }}
        aria-label={`New reference for ${from}`}
        className="h-7 w-28 rounded border border-border bg-surface px-1.5 font-mono text-[12px] text-ink focus:border-primary focus:outline-none"
      />
      <button type="button" disabled={busy} className="text-[11.5px] font-semibold text-primary hover:underline" onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
      <button type="button" className="text-[11.5px] text-ink-muted hover:underline" onClick={() => { setValue(null); setErr(null); }}>Cancel</button>
      {err && <span className="text-[11.5px] text-err">{err}</span>}
    </span>
  );
}
