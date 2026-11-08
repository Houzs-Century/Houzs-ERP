// Take a gap off Books not complete when the event truly has none, or put it back
// (owner 2026-11-05). Show removed keeps every removal one click from undoing.
import { useState } from "react";
import { api } from "../../api/client";

export type BooksGap = "rental" | "report" | "size";

export function BooksGapButton({ projectId, gap, waived, onSaved }: { projectId: number; gap: BooksGap; waived: boolean; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const press = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      await api.post(`/api/project-sales-bills/${projectId}/books-gap`, { gap, waived: !waived });
      setDone(true);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save.");
    } finally { setBusy(false); }
  };

  return (
    <span className="inline-flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      {err && <span className="text-[11.5px] text-err">{err}</span>}
      {done
        ? <span className="text-[11.5px] text-ink-muted">Saved, updating…</span>
        : <button type="button" disabled={busy} className="text-[11.5px] font-semibold text-primary hover:underline" onClick={() => void press()}>{busy ? "Saving…" : waived ? "Put back" : "Remove"}</button>}
    </span>
  );
}
