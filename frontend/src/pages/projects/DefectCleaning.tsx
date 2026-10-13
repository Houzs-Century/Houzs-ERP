// The Sabah/Sarawak defect CLEANING stage (owner 2026-10-12/13). A defect item
// in Sabah or Sarawak carries one extra mark: the owner/BD presses "Cleaning
// done" once the on-site cleaning service is finished (one button only — the
// cleaning happens during setup, so a separate "in progress" state is double
// work). Everyone sees the resulting "Cleaned" chip; only BD/owner can set it.
// Still-dirty items are escalated to the purchaser through the existing per-photo
// Replace flow — this component only marks the cleaning complete.
//
// Kept out of Projects.tsx (near its file-size ceiling): the state gate, the
// permission gate and the toggle live here, so the host adds one <DefectCleaning>.
import { useState } from "react";
import { Sparkles, Check } from "lucide-react";
import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { canCreateEvent } from "../../auth/salesAccess";
import type { ChecklistItem } from "./types";

// Mirror of backend services/projectGates.isEastMalaysiaState — the two states
// whose defect items carry the cleaning stage. Canonical Title-Case (mig 0175).
export function isEastMalaysiaState(state: string | null | undefined): boolean {
  const s = (state ?? "").trim().toLowerCase();
  return s === "sabah" || s === "sarawak";
}

/** True when this item should show the cleaning stage at all. */
export function showsDefectCleaning(item: ChecklistItem, projectState: string | null | undefined): boolean {
  return isEastMalaysiaState(projectState) && /^defect (list|item)/i.test((item.title || "").trim());
}

export function DefectCleaning({
  item,
  projectId,
  projectState,
  onChanged,
  className,
}: {
  item: ChecklistItem;
  projectId: number;
  projectState: string | null | undefined;
  onChanged: () => void;
  /** The host's shared action-button class, so the toggle matches Attach/N/A. */
  className?: string;
}) {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  if (!showsDefectCleaning(item, projectState)) return null;

  const done = item.cleaning_status === "done";
  const mayEdit = canCreateEvent(user); // BD / owner / weisiang only (owner 2026-10-13)

  // Read-only viewers (reviewer, purchaser, sales) see the chip, never a button,
  // so everyone can tell a Sabah/Sarawak defect has been cleaned.
  if (!mayEdit) {
    return done ? (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700"
        title="Cleaning service finished (Sabah/Sarawak)"
      >
        <Check size={11} /> Cleaned
      </span>
    ) : null;
  }

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.post(`/api/projects/${projectId}/checklist/${item.id}/defect-cleaning`, {
        status: done ? "none" : "done",
      });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy}
      className={
        className ??
        "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold disabled:opacity-50 " +
          (done
            ? "border-emerald-400 bg-emerald-50 text-emerald-700"
            : "border-border bg-surface text-ink-muted hover:border-accent/40 hover:text-accent")
      }
      title={done ? "Cleaned — tap to undo" : "Mark the cleaning service done (Sabah/Sarawak)"}
    >
      {done ? <Check size={12} /> : <Sparkles size={12} />}
      {done ? "Cleaned" : "Cleaning done"}
    </button>
  );
}
