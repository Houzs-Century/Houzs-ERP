import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { useAuth } from "../../auth/AuthContext";
import { cn } from "../../lib/utils";
import { Badge } from "../../components/Badge";
import { EmptyState } from "../../components/EmptyState";
import { ListSkeleton } from "../../components/Skeleton";
import type { Position } from "../../types";
import { Eyebrow } from "./teamShared";

/* Roles & Permissions — design handoff screen 06, rebuilt on the REAL access
 * model: rows are the positions that drive access (not the retired 5-role
 * idea), columns are the editable operational capabilities stored in
 * position_capabilities (owner 2026-08-22: "要界面可编辑").
 *
 * Page/menu access stays code-defined in the backend position policy — this
 * matrix edits what a position may DO (load / dispatch / revert / invoice),
 * which the delivery-line endpoints enforce. God positions (Owner / Super
 * Admin) always pass via the wildcard, so their rows render locked. */

type CapabilityDef = {
  key: string;
  label: string;
  group: string;
  description: string;
};

type MatrixPayload = {
  capabilities: CapabilityDef[];
  grants: Array<{ position_id: number; capability: string }>;
};

const GOD_SLUGS = new Set(["super_admin", "owner"]);

/** Department display order: Management first, then Sales, then Operation —
 *  the same top-down order the org chart reads in. */
function deptRank(name: string | null): number {
  const n = (name ?? "").toLowerCase();
  if (n.includes("management")) return 0;
  if (n.includes("sales")) return 1;
  if (n.includes("operation")) return 2;
  return 3;
}

export function TeamRolesV2() {
  const { can } = useAuth();
  const canEdit = can("roles.manage");
  const toast = useToast();

  const positionsQ = useQuery<{ positions: Position[] }>(
    "/api/positions",
    () => api.get("/api/positions"),
    [],
    { staleTime: 60_000 },
  );
  const matrixQ = useQuery<MatrixPayload>("/api/position-capabilities", () =>
    api.get("/api/position-capabilities"),
  );

  const positions = useMemo(
    () =>
      [...(positionsQ.data?.positions ?? [])]
        .filter((p) => p.active)
        .sort(
          (a, b) =>
            deptRank(a.department_name) - deptRank(b.department_name) ||
            a.level - b.level ||
            a.name.localeCompare(b.name),
        ),
    [positionsQ.data],
  );
  const capabilities = matrixQ.data?.capabilities ?? [];

  // Draft grant state — seeded from the server, edited optimistically, and a
  // failed PUT rolls the row back to the last server truth.
  const [draft, setDraft] = useState<Map<number, Set<string>>>(new Map());
  const [savingId, setSavingId] = useState<number | null>(null);
  useEffect(() => {
    if (!matrixQ.data) return;
    const next = new Map<number, Set<string>>();
    for (const g of matrixQ.data.grants) {
      const set = next.get(g.position_id) ?? new Set<string>();
      set.add(g.capability);
      next.set(g.position_id, set);
    }
    setDraft(next);
  }, [matrixQ.data]);

  async function toggle(position: Position, key: string) {
    if (!canEdit || savingId != null) return;
    const current = new Set(draft.get(position.id) ?? []);
    current.has(key) ? current.delete(key) : current.add(key);
    const previous = draft.get(position.id) ?? new Set<string>();
    setDraft((prev) => new Map(prev).set(position.id, current));
    setSavingId(position.id);
    try {
      await api.put(`/api/position-capabilities/${position.id}`, {
        capabilities: [...current],
      });
    } catch (e) {
      setDraft((prev) => new Map(prev).set(position.id, previous));
      toast.error(e instanceof Error ? e.message : "Could not save the change");
    } finally {
      setSavingId(null);
    }
  }

  if (positionsQ.loading || matrixQ.loading) return <ListSkeleton rows={5} />;
  if (matrixQ.error)
    return (
      <EmptyState
        message="The capability matrix isn't served by this backend yet"
        description="This screen needs the position-capabilities API from the same release — it appears once this branch's backend is deployed."
      />
    );
  if (positionsQ.error)
    return <div className="text-[12px] text-err">Couldn't load the permission matrix.</div>;

  const mostPopulous = positions.reduce(
    (max, p) => (p.member_count > (max?.member_count ?? -1) ? p : max),
    null as Position | null,
  );
  const gridTemplate = `220px 64px repeat(${capabilities.length}, minmax(96px, 1fr))`;

  let lastDept: string | null | undefined;

  return (
    <div>
      <div className="overflow-x-auto">
        <div className="min-w-[720px] overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
          {/* Header row */}
          <div
            className="grid items-end gap-3 border-b border-border bg-surface-2 px-5 py-2"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
              Position
            </span>
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
              People
            </span>
            {capabilities.map((cap) => (
              <span
                key={cap.key}
                className="font-mono text-[10px] uppercase tracking-wider text-ink-muted"
                title={cap.description}
              >
                {cap.label}
              </span>
            ))}
          </div>

          {positions.map((p) => {
            const grants = draft.get(p.id) ?? new Set<string>();
            const god = GOD_SLUGS.has(p.slug);
            const highlight = mostPopulous?.id === p.id;
            const deptHeader =
              p.department_name !== lastDept ? (p.department_name ?? "No department") : null;
            lastDept = p.department_name;
            return (
              <div key={p.id}>
                {deptHeader && (
                  <div className="border-b border-border-subtle bg-surface-2 px-5 py-1.5">
                    <Eyebrow>{deptHeader}</Eyebrow>
                  </div>
                )}
                <div
                  className={cn(
                    "grid items-center gap-3 border-b border-border-subtle px-5 py-2.5 last:border-b-0",
                    highlight && "bg-primary-soft",
                    savingId === p.id && "opacity-60",
                  )}
                  style={{ gridTemplateColumns: gridTemplate }}
                >
                  <div>
                    <div
                      className={cn(
                        "text-[13px] font-semibold",
                        highlight ? "text-primary-ink" : "text-ink",
                      )}
                    >
                      {p.name}
                    </div>
                    <div
                      className={cn(
                        "font-mono text-[10px] uppercase tracking-wider",
                        highlight ? "text-primary-ink" : "text-ink-muted",
                      )}
                    >
                      {p.slug}
                    </div>
                  </div>
                  <span
                    className={cn(
                      "font-money text-[12.5px]",
                      highlight ? "text-primary-ink" : "text-ink",
                    )}
                  >
                    {p.member_count}
                  </span>
                  {capabilities.map((cap) => {
                    const on = god || grants.has(cap.key);
                    return (
                      <button
                        key={cap.key}
                        disabled={god || !canEdit || savingId != null}
                        onClick={() => toggle(p, cap.key)}
                        title={
                          god
                            ? "Always allowed — system owner tier"
                            : canEdit
                              ? cap.description
                              : "Requires roles.manage to edit"
                        }
                        className={cn(
                          "w-max rounded px-1.5 py-0.5 text-left text-[12.5px] transition-colors",
                          on
                            ? highlight
                              ? "font-semibold text-primary-ink"
                              : "font-semibold text-primary"
                            : "text-ink-muted",
                          !god && canEdit && "hover:bg-surface-2",
                          god && "cursor-default",
                        )}
                      >
                        {on ? "✓" : "—"}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-4 flex items-start gap-3 rounded-lg border border-border bg-surface p-4 shadow-stone">
        <Badge tone="accent">Note</Badge>
        <p className="mb-0 text-[12.5px] leading-relaxed text-ink-secondary">
          These switches govern the delivery-line actions (load / dispatch / revert)
          and invoice issuing; enforcement ships with the warehouse loading flow.
          Menu and page access follow each position's policy and change through a
          code review, not here. Owner-tier positions always pass and stay locked.
        </p>
      </div>
    </div>
  );
}
