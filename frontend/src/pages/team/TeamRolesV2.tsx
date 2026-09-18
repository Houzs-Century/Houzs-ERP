import { useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { api } from "../../api/client";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { useAuth } from "../../auth/AuthContext";
import { cn } from "../../lib/utils";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { RolesTab } from "../Roles";
import { EmptyState } from "../../components/EmptyState";
import { ListSkeleton } from "../../components/Skeleton";
import type { Position } from "../../types";
import { Eyebrow, SegmentedTabs } from "./teamShared";
import { TeamTitlesPolicy, type TitlePolicyPayload } from "./TeamTitlesPolicy";

/* Roles & Permissions — three sections, one question each:
 *   Roles   — what a role may DO (the flat permission keys, Roles.tsx).
 *   Titles  — what a Title's members SEE: cohort / profile / money / config /
 *             fleet, one position_policy row per Title (TeamTitlesPolicy).
 *   Actions — the delivery-line verbs a Title may perform (load / dispatch /
 *             revert / invoice), rows in position_capabilities.
 * The per-page SCM override tabs (position_page_overrides) were removed on
 * 2026-09-16: never used in production, and the Titles cohort answers the same
 * question. Owner-tier Titles always pass and stay locked in the matrix. */

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

/** Department display order: Management first, then Sales, then Operation. */
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
  // The per-Title policy rows (Titles tab). Also the one source for "this Title
  // is owner tier" — the matrix locks those rows on, read from the server's
  // answer rather than a slug list kept here.
  const policyQ = useQuery<TitlePolicyPayload>("/api/position-policy", () =>
    api.get("/api/position-policy"),
  );
  const godIds = useMemo(
    () =>
      new Set(
        (policyQ.data?.positions ?? [])
          .filter((p) => p.effective.cohort === "god")
          .map((p) => p.id),
      ),
    [policyQ.data],
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

  // "roles" is the ROLE editor (Roles.tsx: role list + permission checkboxes
  // + New Role) embedded as the first section — owner 2026-09-07 ("Roles &
  // Permissions 里加个 Roles 分区"): the strip lost its Roles tab in the
  // redesign and the only way to a role's permission checkboxes was the
  // URL ?tab=roles, which nobody finds.
  type Tab = "roles" | "titles" | "actions";
  const [tab, setTab] = useState<Tab>("roles");
  const [creatingRole, setCreatingRole] = useState(false);
  const isRoles = tab === "roles";
  const isTitles = tab === "titles";

  // Drafts — seeded from the server, edited optimistically; a failed PUT
  // rolls the row back to the last server truth.
  const [capDraft, setCapDraft] = useState<Map<number, Set<string>>>(new Map());
  const [savingId, setSavingId] = useState<number | null>(null);
  useEffect(() => {
    if (!matrixQ.data) return;
    const caps = new Map<number, Set<string>>();
    for (const g of matrixQ.data.grants) {
      const set = caps.get(g.position_id) ?? new Set<string>();
      set.add(g.capability);
      caps.set(g.position_id, set);
    }
    setCapDraft(caps);
  }, [matrixQ.data]);

  async function toggleCapability(position: Position, key: string) {
    if (!canEdit || savingId != null) return;
    const current = new Set(capDraft.get(position.id) ?? []);
    current.has(key) ? current.delete(key) : current.add(key);
    const previous = capDraft.get(position.id) ?? new Set<string>();
    setCapDraft((prev) => new Map(prev).set(position.id, current));
    setSavingId(position.id);
    try {
      await api.put(`/api/position-capabilities/${position.id}`, {
        capabilities: [...current],
      });
    } catch (e) {
      setCapDraft((prev) => new Map(prev).set(position.id, previous));
      toast.error(e instanceof Error ? e.message : "Could not save the change");
    } finally {
      setSavingId(null);
    }
  }

  // The Roles section has its own loading state (RolesTab); only the matrix
  // sections wait for the position + capability queries.
  if (!isRoles && (positionsQ.loading || matrixQ.loading || policyQ.loading)) return <ListSkeleton rows={5} />;
  if (isTitles && policyQ.error)
    return (
      <EmptyState
        message="The Titles policy isn't served by this backend yet"
        description="This tab needs the position-policy API from the same release — it appears once this branch's backend is deployed."
      />
    );
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

  const gridTemplate = `200px 56px repeat(${Math.max(capabilities.length, 1)}, minmax(76px, 1fr))`;

  let lastDept: string | null | undefined;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <SegmentedTabs<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: "roles", label: "Roles" },
            { value: "titles", label: "Titles" },
            { value: "actions", label: "Actions" },
          ]}
        />
        {isRoles && canEdit && (
          <Button
            variant="brass"
            icon={<Plus size={14} />}
            onClick={() => setCreatingRole(true)}
          >
            New Role
          </Button>
        )}
      </div>

      {isRoles ? (
        <RolesTab creating={creatingRole} onCloseCreate={() => setCreatingRole(false)} />
      ) : isTitles && policyQ.data ? (
        <TeamTitlesPolicy payload={policyQ.data} canEdit={canEdit} onSaved={() => policyQ.reload()} />
      ) : (
        <>
      <div className="overflow-x-auto">
        <div className="min-w-[760px] overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
          {/* Header row */}
          <div
            className="grid items-end gap-2 border-b border-border bg-surface-2 px-5 py-2"
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
            const god = godIds.has(p.id);
            const highlight = mostPopulous?.id === p.id;
            const grants = capDraft.get(p.id) ?? new Set<string>();
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
                    "grid items-center gap-2 border-b border-border-subtle px-5 py-2.5 last:border-b-0",
                    highlight && "bg-primary-soft",
                    savingId === p.id && "opacity-60",
                  )}
                  style={{ gridTemplateColumns: gridTemplate }}
                >
                  <div>
                    <div
                      className={cn(
                        "truncate text-[13px] font-semibold",
                        highlight ? "text-primary-ink" : "text-ink",
                      )}
                    >
                      {p.name}
                    </div>
                    <div
                      className={cn(
                        "truncate font-mono text-[10px] uppercase tracking-wider",
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
                        onClick={() => toggleCapability(p, cap.key)}
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
          The Actions switches govern the delivery-line verbs and take effect on the
          member's next request. Which pages a Title sees is set on the Titles tab;
          sales-cohort caps and the money-movement rule are code rules that still
          apply on top. Owner-tier positions always pass and stay locked.
        </p>
      </div>
        </>
      )}
    </div>
  );
}
