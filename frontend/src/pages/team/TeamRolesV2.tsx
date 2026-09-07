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

/* Roles & Permissions — design handoff screen 06, on the REAL access model,
 * editable (owner 2026-08-22, extended the same day to 全部 SCM 模块).
 *
 * Two axes, one screen:
 *   Actions — operational capabilities (load / dispatch / revert / invoice),
 *     rows in position_capabilities; enforcement ships with the warehouse
 *     line.
 *   SCM areas (Sales / Procurement / Consignment / Transportation /
 *     Warehouse / Finance) — page-access LEVELS per position. The code-defined
 *     position policy is the BASELINE; a cell edited here stores an override
 *     (position_page_overrides) that composes over it at session hydration
 *     and is enforced by the existing scmAreaGuard on the next request.
 *
 * Cell click cycles none → view → edit → full → inherit (clears back to the
 * policy baseline). Overridden cells carry a marker; god positions (Owner /
 * Super Admin) always pass and stay locked. */

type CapabilityDef = {
  key: string;
  label: string;
  group: string;
  description: string;
};

type MatrixPayload = {
  capabilities: CapabilityDef[];
  grants: Array<{ position_id: number; capability: string }>;
  scm_keys: string[];
  overrides: Array<{ position_id: number; page_key: string; level: string }>;
  baselines: Partial<Record<string, Partial<Record<string, string>>>>;
};

const GOD_SLUGS = new Set(["super_admin", "owner"]);

const LEVEL_CYCLE = ["none", "view", "edit", "full"] as const;
const LEVEL_CODE: Record<string, string> = {
  none: "—",
  partial: "P",
  view: "V",
  edit: "E",
  full: "F",
};

/** Leaf-segment display labels; anything absent title-cases the segment. */
const LEAF_LABELS: Record<string, string> = {
  po: "PO",
  grn: "GRN",
  pi: "PI",
  pr: "PR",
  mrp: "MRP",
  po_orders: "PO orders",
  po_receives: "PO receives",
  po_returns: "PO returns",
  stock_take: "Stock take",
};

function leafLabel(key: string): string {
  const seg = key.split(".").pop() ?? key;
  if (LEAF_LABELS[seg]) return LEAF_LABELS[seg];
  return seg.charAt(0).toUpperCase() + seg.slice(1).replace(/_/g, " ");
}

function areaOf(key: string): string {
  return key.split(".")[1] ?? "";
}

function areaLabel(area: string): string {
  return area.charAt(0).toUpperCase() + area.slice(1);
}

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
  const scmKeys = matrixQ.data?.scm_keys ?? [];
  const baselines = matrixQ.data?.baselines ?? {};

  const areas = useMemo(
    () => [...new Set(scmKeys.map(areaOf))],
    [scmKeys],
  );
  // "roles" is the ROLE editor (Roles.tsx: role list + permission checkboxes
  // + New Role) embedded as the first section — owner 2026-09-07 ("Roles &
  // Permissions 里加个 Roles 分区"): the strip lost its Roles tab in the
  // redesign and the only way to a role's permission checkboxes was the
  // URL ?tab=roles, which nobody finds. The other sections are the
  // POSITION matrix as before.
  type Tab = "roles" | "actions" | (string & {});
  const [tab, setTab] = useState<Tab>("roles");
  const [creatingRole, setCreatingRole] = useState(false);
  const isRoles = tab === "roles";

  // Drafts — seeded from the server, edited optimistically; a failed PUT
  // rolls the row back to the last server truth.
  const [capDraft, setCapDraft] = useState<Map<number, Set<string>>>(new Map());
  const [ovrDraft, setOvrDraft] = useState<Map<number, Partial<Record<string, string>>>>(new Map());
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
    const ovr = new Map<number, Partial<Record<string, string>>>();
    for (const o of matrixQ.data.overrides) {
      const rec = ovr.get(o.position_id) ?? {};
      rec[o.page_key] = o.level;
      ovr.set(o.position_id, rec);
    }
    setOvrDraft(ovr);
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

  async function cycleOverride(position: Position, key: string) {
    if (!canEdit || savingId != null) return;
    const posBaselines = baselines[String(position.id)];
    const baseline = posBaselines?.[key] ?? "none";
    const current: Partial<Record<string, string>> = { ...(ovrDraft.get(position.id) ?? {}) };
    const now = current[key];
    // inherit → none → view → edit → full → inherit …, skipping the step that
    // would merely restate the baseline (a no-op override is clutter).
    let next: string | undefined;
    if (now == null) next = LEVEL_CYCLE[0];
    else {
      const at = LEVEL_CYCLE.indexOf(now as (typeof LEVEL_CYCLE)[number]);
      next = at >= 0 && at < LEVEL_CYCLE.length - 1 ? LEVEL_CYCLE[at + 1] : undefined;
    }
    if (next === baseline) {
      const at = LEVEL_CYCLE.indexOf(next as (typeof LEVEL_CYCLE)[number]);
      next = at < LEVEL_CYCLE.length - 1 ? LEVEL_CYCLE[at + 1] : undefined;
    }
    if (next == null) delete current[key];
    else current[key] = next;

    const previous = ovrDraft.get(position.id) ?? {};
    setOvrDraft((prev) => new Map(prev).set(position.id, current));
    setSavingId(position.id);
    try {
      await api.put(`/api/position-capabilities/${position.id}/pages`, {
        overrides: current,
      });
    } catch (e) {
      setOvrDraft((prev) => new Map(prev).set(position.id, previous));
      toast.error(e instanceof Error ? e.message : "Could not save the change");
    } finally {
      setSavingId(null);
    }
  }

  // The Roles section has its own loading state (RolesTab); only the matrix
  // sections wait for the position + capability queries.
  if (!isRoles && (positionsQ.loading || matrixQ.loading)) return <ListSkeleton rows={5} />;
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

  const isActions = tab === "actions";
  const tabKeys = isActions ? [] : scmKeys.filter((k) => areaOf(k) === tab);
  const columnCount = isActions ? capabilities.length : tabKeys.length;
  const gridTemplate = `200px 56px repeat(${Math.max(columnCount, 1)}, minmax(76px, 1fr))`;

  let lastDept: string | null | undefined;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <SegmentedTabs<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: "roles", label: "Roles" },
            { value: "actions", label: "Actions" },
            ...areas.map((a) => ({ value: a, label: areaLabel(a) })),
          ]}
        />
        {isRoles ? (
          canEdit && (
            <Button
              variant="brass"
              icon={<Plus size={14} />}
              onClick={() => setCreatingRole(true)}
            >
              New Role
            </Button>
          )
        ) : !isActions ? (
          <span className="text-[11.5px] text-ink-muted">
            Cells show the effective level — click cycles none / view / edit / full /
            inherit. Marked cells override the position policy.
          </span>
        ) : null}
      </div>

      {isRoles ? (
        <RolesTab creating={creatingRole} onCloseCreate={() => setCreatingRole(false)} />
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
            {isActions
              ? capabilities.map((cap) => (
                  <span
                    key={cap.key}
                    className="font-mono text-[10px] uppercase tracking-wider text-ink-muted"
                    title={cap.description}
                  >
                    {cap.label}
                  </span>
                ))
              : tabKeys.map((key) => (
                  <span
                    key={key}
                    className="font-mono text-[10px] uppercase tracking-wider text-ink-muted"
                    title={key}
                  >
                    {leafLabel(key)}
                  </span>
                ))}
          </div>

          {positions.map((p) => {
            const god = GOD_SLUGS.has(p.slug);
            const highlight = mostPopulous?.id === p.id;
            const grants = capDraft.get(p.id) ?? new Set<string>();
            const overrides = ovrDraft.get(p.id) ?? {};
            const baseline = baselines[String(p.id)] ?? {};
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

                  {isActions
                    ? capabilities.map((cap) => {
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
                      })
                    : tabKeys.map((key) => {
                        const override = overrides[key];
                        const base = baseline[key] ?? "none";
                        const effective = god ? "full" : (override ?? base);
                        const overridden = !god && override != null;
                        return (
                          <button
                            key={key}
                            disabled={god || !canEdit || savingId != null}
                            onClick={() => cycleOverride(p, key)}
                            title={
                              god
                                ? "Always allowed — system owner tier"
                                : overridden
                                  ? `${key}: override ${effective} (policy default ${base}) — click to cycle, cycling past full clears it`
                                  : `${key}: ${effective} from the position policy — click to override`
                            }
                            className={cn(
                              "flex w-max items-center gap-1 rounded px-1.5 py-0.5 text-left text-[12.5px] transition-colors",
                              effective === "none"
                                ? "text-ink-muted"
                                : highlight
                                  ? "font-semibold text-primary-ink"
                                  : "font-semibold text-primary",
                              !god && canEdit && "hover:bg-surface-2",
                              god && "cursor-default",
                            )}
                          >
                            {LEVEL_CODE[effective] ?? effective}
                            {overridden && (
                              <span
                                className="h-1.5 w-1.5 rounded-full bg-accent"
                                aria-label="Overrides the position policy"
                              />
                            )}
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
          SCM cells take effect on the member's next request — the marked overrides
          compose over the position policy and the SCM area guard enforces them.
          Sales-cohort caps and the money-movement rule are code rules that still
          apply on top. The Actions switches govern the delivery-line verbs; their
          enforcement ships with the warehouse loading flow. Owner-tier positions
          always pass and stay locked.
        </p>
      </div>
        </>
      )}
    </div>
  );
}
