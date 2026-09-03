/**
 * Lead Time Portal — per-priority stage targets.
 *
 * Sub-tab on /assr?view=settings&tab=lead_time. The legacy Normal/Peak
 * profile editor was retired now that mig 082's priority-driven lead
 * time is live. The backend profile lookup remains as a safety
 * fallback (any unset priority×stage cell falls through to the
 * currently-active profile), but the seed populates every cell, so
 * the fallback never fires in practice.
 *
 * Read access: service_cases.read. Write access: service_cases.manage.
 */
import { useState } from "react";

import { api } from "../api/client";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useAuth } from "../auth/AuthContext";
import { Button } from "../components/Button";
import { ListSkeleton } from "../components/Skeleton";

// ── Stage display order — mirrors backend mig 074. `short` is used by
// the matrix column headers so the priorities × stages grid stays
// readable without horizontal scroll on standard screens.

const STAGE_ORDER: { value: string; label: string; short: string }[] = [
  { value: "pending_review",           label: "Review",                    short: "Review" },
  { value: "under_verification",       label: "Verification",              short: "Verify" },
  { value: "pending_solution",         label: "Solution",                  short: "Solution" },
  { value: "pending_supplier_pickup",  label: "Pickup / Return",           short: "Pickup" },
  { value: "pending_item_ready",       label: "Pending Item Ready",        short: "Ready" },
  { value: "pending_delivery_service", label: "Delivery / Service",        short: "Delivery" },
];

export function ServiceLeadTimePortal() {
  const { can } = useAuth();
  const toast = useToast();
  const canManage = can("service_cases.manage");

  return (
    <div className="space-y-6">
      <PriorityTargetsSection canManage={canManage} toast={toast} />
    </div>
  );
}

// ── Per-priority stage targets (mig 082) ────────────────────────────
//
// Renders a priorities × stages grid. Each cell is editable inline —
// blur or Enter commits. Empty cells fall back to the active Lead Time
// profile at case-transition time; the grid shows them as blank with a
// soft outline.

type PriorityRow = { id: number; slug: string; name: string; sort_order: number };
type PriorityTarget = { id: number; priority_id: number; stage: string; target_days: number };

function PriorityTargetsSection({
  canManage,
  toast,
}: {
  canManage: boolean;
  toast: ReturnType<typeof useToast>;
}) {
  const data = useQuery<{
    priorities: PriorityRow[];
    stages: string[];
    targets: PriorityTarget[];
  }>("/api/assr/portal/priority-targets", () => api.get("/api/assr/portal/priority-targets"));

  if (data.loading) {
    return (
      <section className="rounded-lg border border-border bg-surface p-4">
        <ListSkeleton rows={4} />
      </section>
    );
  }
  if (data.error) {
    return (
      <section className="rounded-lg border border-err/40 bg-err/5 p-4 text-[12px] text-err">
        <div className="mb-2">Failed to load priority targets: {data.error}</div>
        <Button variant="ghost" onClick={() => data.reload()}>
          Retry
        </Button>
      </section>
    );
  }

  const priorities = data.data?.priorities ?? [];
  const targets = data.data?.targets ?? [];
  const cellMap = new Map<string, number>();
  for (const t of targets) cellMap.set(`${t.priority_id}|${t.stage}`, t.target_days);

  return (
    <section className="rounded-lg border border-border bg-surface">
      <header className="border-b border-border px-4 py-3">
        <h2 className="font-display text-[15px] font-bold leading-tight tracking-tight text-ink">
          Lead Time — By Priority
        </h2>
        <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
          Per-priority stage targets in days. The priority a case is created with
          drives its per-stage SLA snapshot. Edit a cell to flex how aggressive
          that priority is — changes affect new cases and future stages of
          in-flight cases. Leave a cell blank to fall back to the system default.
        </p>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b-2 border-border bg-surface-dim text-[10px] font-bold uppercase tracking-brand text-ink">
              <th className="sticky left-0 z-10 bg-bg px-4 py-2 text-left font-semibold">
                Priority
              </th>
              {STAGE_ORDER.map((s) => (
                <th
                  key={s.value}
                  className="px-3 py-2 text-right font-semibold whitespace-nowrap"
                >
                  {s.label}
                </th>
              ))}
              <th className="px-3 py-2 text-right font-semibold whitespace-nowrap">
                E2E (d)
              </th>
            </tr>
          </thead>
          <tbody>
            {priorities.map((p) => {
              const total = STAGE_ORDER.reduce(
                (sum, s) => sum + (cellMap.get(`${p.id}|${s.value}`) ?? 0),
                0
              );
              return (
                <tr key={p.id} className="border-t border-border">
                  <td className="sticky left-0 z-10 bg-surface px-4 py-2 font-semibold text-ink whitespace-nowrap">
                    {p.name}
                    {/* Slug hidden (Houzs 2026-06-24) — owner: the gray machine
                        code under the name is unnecessary clutter. */}
                  </td>
                  {STAGE_ORDER.map((s) => {
                    const cellVal = cellMap.get(`${p.id}|${s.value}`);
                    return (
                      <td key={s.value} className="px-2 py-1 text-right">
                        <PriorityCell
                          priorityId={p.id}
                          stage={s.value}
                          value={cellVal}
                          canManage={canManage}
                          onSaved={() => data.reload()}
                          toast={toast}
                        />
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-right font-mono font-semibold text-ink whitespace-nowrap">
                    {total.toFixed(1)}
                  </td>
                </tr>
              );
            })}
            {priorities.length === 0 && (
              <tr>
                <td
                  colSpan={STAGE_ORDER.length + 2}
                  className="px-4 py-6 text-center text-[11px] text-ink-muted"
                >
                  No active priorities. Add some via Service Maintenance → General → Priorities.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PriorityCell({
  priorityId,
  stage,
  value,
  canManage,
  onSaved,
  toast,
}: {
  priorityId: number;
  stage: string;
  value: number | undefined;
  canManage: boolean;
  onSaved: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [draft, setDraft] = useState<string>(value == null ? "" : String(value));
  const [saving, setSaving] = useState(false);

  async function commit() {
    const original = value == null ? "" : String(value);
    if (draft === original) return;
    const n = Number(draft);
    if (!Number.isFinite(n) || n < 0) {
      toast.error("Must be a non-negative number");
      setDraft(original);
      return;
    }
    setSaving(true);
    try {
      await api.patch("/api/assr/portal/priority-targets", {
        priority_id: priorityId,
        stage,
        target_days: n,
      });
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
      setDraft(original);
    } finally {
      setSaving(false);
    }
  }

  if (!canManage) {
    return <span className="font-mono text-ink">{value == null ? "—" : value.toFixed(1)}</span>;
  }

  return (
    <input
      type="number"
      step="0.5"
      min="0"
      value={draft}
      placeholder="—"
      disabled={saving}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value == null ? "" : String(value));
          (e.target as HTMLInputElement).blur();
        }
      }}
      className="h-7 w-16 rounded border border-border bg-surface px-1.5 text-right font-mono text-[12px] text-ink outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 disabled:opacity-50"
    />
  );
}
