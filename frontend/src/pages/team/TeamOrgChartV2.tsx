import { useMemo, useState, type DragEvent } from "react";
import { ChevronsDownUp, ChevronsUpDown, Pencil, Printer } from "lucide-react";
import { api } from "../../api/client";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { useAuth } from "../../auth/AuthContext";
import { cn } from "../../lib/utils";
import { Avatar } from "../../components/Avatar";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { ListSkeleton } from "../../components/Skeleton";
import { PrintPreviewModal, usePrintPreview } from "../../components/scm-v2/PrintPreviewModal";
import type { TeamMember, Department, Position, Role } from "../../types";
import { buildDeptNodes, inCompany, statusBadgeProps } from "./teamShared";
import { TeamMemberProfile } from "./TeamMemberProfile";

/* Org Chart — design handoff screen 04. Companies as lanes: Owner card on
 * top, departments as dark collapsible pills, an expanded department lays
 * its people out by team (users.division) in columns, grouped by position.
 * Cards drag between team columns / onto department pills to reassign.
 *
 * Stripe rule (from the handoff): the 4px pill stripe is bg-primary ONLY for
 * an expanded department, bg-err for a department with a real structural flag
 * (no derived lead), and neutral bg-border-strong otherwise — never one
 * colour per department. */

type CompanyOpt = { id: number; code: string; name: string };

const GENERAL = " general"; // sentinel column for members with no division

/* Owner rule (2026-08-21, matching the handoff spec): outsourced/contractor
 * people never appear on the org chart — it represents direct organizational
 * structure only. They stay in the Directory roster. Keyed off the member's
 * team/position naming, e.g. division "Outsource Transporter". */
function isOutsourced(u: TeamMember): boolean {
  const hay = `${u.division ?? ""} ${u.position_name ?? ""}`.toLowerCase();
  return hay.includes("outsource");
}

export function TeamOrgChartV2() {
  const { can } = useAuth();
  const canManage = can("users.manage");
  const toast = useToast();

  const members = useQuery<{ users: TeamMember[] }>("/api/users", () =>
    api.get("/api/users"),
  );
  const freshList = { staleTime: 60_000 };
  const depts = useQuery<{ departments: Department[] }>(
    "/api/departments",
    () => api.get("/api/departments"),
    [],
    freshList,
  );
  const positionsQ = useQuery<{ positions: Position[] }>(
    "/api/positions",
    () => api.get("/api/positions"),
    [],
    freshList,
  );
  const rolesQ = useQuery<{ roles: Role[] }>(
    "/api/roles",
    () => api.get("/api/roles"),
    [],
    freshList,
  );
  const companiesQ = useQuery<{ companies: CompanyOpt[] }>(
    "/api/companies",
    () => api.get("/api/companies"),
    [],
    freshList,
  );

  const users = useMemo(() => members.data?.users ?? [], [members.data]);
  const departments = depts.data?.departments ?? [];
  const companies: CompanyOpt[] =
    companiesQ.data?.companies.length
      ? companiesQ.data.companies
      : [{ id: 1, code: "HOUZS", name: "Houzs Century" }];

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState(1);
  const [profileId, setProfileId] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  const lanes = useMemo(
    () =>
      companies.map((company) => {
        const laneUsers = users.filter(
          (u) =>
            u.status !== "disabled" &&
            inCompany(u, company.id) &&
            !isOutsourced(u),
        );
        const { nodes, noDept } = buildDeptNodes(laneUsers, departments);
        return {
          company,
          laneUsers,
          nodes: nodes.filter((n) => n.counts.visible > 0),
          noDept,
          owner: laneUsers.find((u) => u.role_name === "Owner") ?? null,
        };
      }),
    [companies, users, departments],
  );

  const allKeys = useMemo(
    () =>
      lanes.flatMap((lane) =>
        lane.nodes.map((n) => `${lane.company.id}:${n.dept.id}`),
      ),
    [lanes],
  );

  const print = usePrintPreview(() => {
    setExpanded(new Set(allKeys));
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        document
          .querySelectorAll<HTMLElement>(".org-print-scale")
          .forEach((el) =>
            el.style.setProperty(
              "--print-zoom",
              String(Math.min(1, 1000 / (el.scrollWidth || 1))),
            ),
          );
        window.print();
      }),
    );
  });

  async function moveMember(
    memberId: number,
    deptId: number | null,
    division: string | null,
  ) {
    const m = users.find((u) => u.id === memberId);
    if (!m) return;
    const nextDivision = division === GENERAL ? null : division;
    if (m.department_id === deptId && (m.division ?? null) === nextDivision) return;
    try {
      await api.patch(`/api/users/${memberId}`, {
        department_id: deptId,
        division: nextDivision,
      });
      toast.success(`${m.name || m.email} moved`);
      members.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not move the member");
    }
  }

  function dropProps(key: string, onDrop: (memberId: number) => void) {
    if (!canManage) return {};
    return {
      onDragOver: (e: DragEvent) => {
        e.preventDefault();
        setDragOver(key);
      },
      onDragLeave: () => setDragOver((k) => (k === key ? null : k)),
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        setDragOver(null);
        const id = parseInt(e.dataTransfer.getData("text/member-id"), 10);
        if (Number.isFinite(id)) onDrop(id);
      },
    };
  }

  if (members.loading || depts.loading) return <ListSkeleton rows={4} />;
  if (members.error || depts.error)
    return <div className="text-[12px] text-err">Couldn't load the org chart.</div>;

  const profileMember =
    profileId != null ? users.find((u) => u.id === profileId) ?? null : null;

  return (
    <div>
      {/* ── Toolbar ── */}
      <div className="mb-4 flex items-center justify-end gap-2">
        <Button
          variant="secondary"
          icon={
            expanded.size >= allKeys.length ? (
              <ChevronsDownUp size={14} />
            ) : (
              <ChevronsUpDown size={14} />
            )
          }
          onClick={() =>
            setExpanded(
              expanded.size >= allKeys.length ? new Set() : new Set(allKeys),
            )
          }
        >
          {expanded.size >= allKeys.length ? "Collapse all" : "Expand all"}
        </Button>
        <Button variant="secondary" icon={<Printer size={14} />} onClick={print.openPreview}>
          Export
        </Button>
        <PrintPreviewModal
          open={print.open}
          onClose={print.close}
          docTitle="Org Chart"
          docNo="Team"
          rows={[
            { label: "Prints", value: "Every department, fully expanded" },
            { label: "Fit", value: "Each company lane is scaled to one landscape page" },
          ]}
          onPrint={print.handlers.onPrint}
        />
        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.1).toFixed(2)))}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface text-[15px] leading-none text-ink-secondary hover:text-ink"
          aria-label="Zoom out"
        >
          −
        </button>
        <button
          type="button"
          onClick={() => setZoom(1)}
          className="inline-flex h-7 min-w-[3.25rem] items-center justify-center rounded-md border border-border bg-surface font-money text-[11.5px] text-ink"
          title="Reset zoom"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(1.6, +(z + 0.1).toFixed(2)))}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface text-[15px] leading-none text-ink-secondary hover:text-ink"
          aria-label="Zoom in"
        >
          +
        </button>
      </div>

      <div className="org-print-area" style={{ zoom }}>
        {lanes.map((lane) => {
          const laneTotal = lane.laneUsers.length;
          return (
            <div key={lane.company.id} className="org-print-scale pb-8">
              {/* Lane header */}
              <div className="flex items-center gap-3">
                <span className="font-mono text-[11px] uppercase tracking-wider text-ink">
                  {lane.company.name}
                </span>
                <Badge tone="neutral">{laneTotal}</Badge>
                <div className="h-px flex-1 bg-border" />
              </div>

              {/* Owner card */}
              {lane.owner && (
                <>
                  <div className="mt-4 flex justify-center">
                    <div className="flex flex-col items-center">
                      <div
                        className="overflow-hidden rounded-lg border border-border-strong bg-surface shadow-slab"
                        style={{ width: 196 }}
                      >
                        <div className="bg-ink py-1.5 text-center font-mono text-[10px] uppercase tracking-wider text-white">
                          Owner
                        </div>
                        <div className="m-2 flex items-center gap-2.5 rounded-md border border-border-subtle px-3 py-2.5">
                          <Avatar
                            userId={lane.owner.id}
                            hasImage={lane.owner.profile_pic_r2_key}
                            name={lane.owner.name ?? lane.owner.email}
                            size={36}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[12.5px] font-semibold leading-tight text-ink">
                              {lane.owner.name || lane.owner.email}
                            </div>
                            <div className="text-[11px] text-ink-secondary">Owner</div>
                          </div>
                          <button
                            className="text-[11px] text-ink-muted hover:text-ink"
                            aria-label="Open profile"
                            onClick={() => setProfileId(lane.owner!.id)}
                          >
                            <Pencil size={11} />
                          </button>
                        </div>
                      </div>
                      <div className="h-[18px] w-px bg-border" />
                    </div>
                  </div>
                  <div className="px-10">
                    <div className="h-px w-full bg-border" />
                  </div>
                </>
              )}

              {/* Department pills */}
              <div className={cn("flex flex-wrap items-start justify-center gap-x-3", !lane.owner && "mt-4")}>
                {lane.nodes.map((n) => {
                  const key = `${lane.company.id}:${n.dept.id}`;
                  const isOpen = expanded.has(key);
                  const noLead = n.lead == null && n.counts.visible > 0;
                  return (
                    <div key={key} className="flex flex-col items-center">
                      <div className="h-4 w-px bg-border" />
                      <button
                        className={cn(
                          "flex items-stretch overflow-hidden rounded-md bg-ink shadow-stone transition-shadow",
                          dragOver === key && "ring-2 ring-primary",
                        )}
                        onClick={() =>
                          setExpanded((prev) => {
                            const next = new Set(prev);
                            next.has(key) ? next.delete(key) : next.add(key);
                            return next;
                          })
                        }
                        {...dropProps(key, (memberId) => moveMember(memberId, n.dept.id, null))}
                      >
                        <span
                          className={cn(
                            "w-1 flex-none",
                            isOpen ? "bg-primary" : noLead ? "bg-err" : "bg-border-strong",
                          )}
                        />
                        <span className="flex h-8 items-center gap-2 px-3">
                          <span className="text-[10px] text-white">{isOpen ? "▾" : "›"}</span>
                          <span className="font-mono text-[10.5px] uppercase tracking-wider text-white">
                            {n.dept.name}
                          </span>
                          <span className="font-money text-[10.5px] text-white/55">
                            {n.counts.visible}
                          </span>
                        </span>
                      </button>
                    </div>
                  );
                })}
                {lane.noDept.visible > 0 && (
                  <div className="flex flex-col items-center">
                    <div className="h-4 w-px bg-border" />
                    <div className="flex items-stretch overflow-hidden rounded-md bg-ink shadow-stone">
                      <span className="w-1 flex-none bg-err" />
                      <span className="flex h-8 items-center gap-2 px-3">
                        <span className="font-mono text-[10.5px] uppercase tracking-wider text-white">
                          No department
                        </span>
                        <span className="font-money text-[10.5px] text-white/55">
                          {lane.noDept.visible}
                        </span>
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* Expanded department panels */}
              {lane.nodes
                .filter((n) => expanded.has(`${lane.company.id}:${n.dept.id}`))
                .map((n) => {
                  const columns = new Map<string, TeamMember[]>();
                  const deptUsers = lane.laneUsers.filter(
                    (u) => u.department_id === n.dept.id,
                  );
                  for (const u of deptUsers) {
                    const col = (u.division ?? "").trim() || GENERAL;
                    const list = columns.get(col) ?? [];
                    list.push(u);
                    columns.set(col, list);
                  }
                  const colNames = [...columns.keys()].sort((a, b) => {
                    if (a === GENERAL) return 1;
                    if (b === GENERAL) return -1;
                    return (columns.get(b)!.length - columns.get(a)!.length) || a.localeCompare(b);
                  });
                  return (
                    <div
                      key={`panel-${lane.company.id}-${n.dept.id}`}
                      className="mt-4 overflow-hidden rounded-lg border border-border-strong bg-surface shadow-slab"
                    >
                      <div className="flex items-center justify-between bg-ink px-4 py-2">
                        <span className="font-mono text-[10.5px] uppercase tracking-wider text-white">
                          ▾ {n.dept.name}
                        </span>
                        <span className="font-money text-[11px] text-white/55">
                          {n.counts.visible}
                        </span>
                      </div>
                      <div
                        className="grid gap-4 bg-surface-dim p-4"
                        style={{
                          gridTemplateColumns: `repeat(${Math.min(Math.max(colNames.length, 1), 6)}, minmax(0, 1fr))`,
                        }}
                      >
                        {colNames.map((col) => {
                          const colUsers = columns.get(col)!;
                          const groups = new Map<string, TeamMember[]>();
                          for (const u of colUsers) {
                            const g = u.position_name ?? "No position";
                            const list = groups.get(g) ?? [];
                            list.push(u);
                            groups.set(g, list);
                          }
                          const dropKey = `${lane.company.id}:${n.dept.id}:${col}`;
                          return (
                            <div
                              key={col}
                              className={cn(
                                "flex min-w-0 flex-col gap-2.5 rounded-md p-1 transition-colors",
                                dragOver === dropKey && "bg-primary-soft",
                              )}
                              {...dropProps(dropKey, (memberId) =>
                                moveMember(memberId, n.dept.id, col),
                              )}
                            >
                              <div className="flex items-baseline gap-1.5">
                                <span className="truncate font-mono text-[10px] uppercase tracking-wider text-ink">
                                  {col === GENERAL ? "General" : col}
                                </span>
                                <span className="font-money text-[10.5px] text-ink-muted">
                                  {colUsers.length}
                                </span>
                              </div>
                              {[...groups.entries()].map(([g, gUsers]) => (
                                <div key={g} className="flex flex-col gap-1.5">
                                  <div className="truncate font-mono text-[9.5px] uppercase tracking-wider text-ink-muted">
                                    {g}
                                  </div>
                                  {gUsers.map((u) => (
                                    <div
                                      key={u.id}
                                      draggable={canManage}
                                      onDragStart={(e) =>
                                        e.dataTransfer.setData("text/member-id", String(u.id))
                                      }
                                      className={cn(
                                        "flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-2 shadow-stone",
                                        canManage && "cursor-grab active:cursor-grabbing",
                                      )}
                                    >
                                      <Avatar
                                        userId={u.id}
                                        hasImage={u.profile_pic_r2_key}
                                        name={u.name ?? u.email}
                                        size={28}
                                      />
                                      <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-1.5">
                                          <span className="truncate text-[11.5px] font-semibold uppercase leading-tight text-ink">
                                            {u.name || u.email}
                                          </span>
                                          {u.status === "invited" && (
                                            <Badge tone={statusBadgeProps("invited").tone}>
                                              Invited
                                            </Badge>
                                          )}
                                        </div>
                                        <div className="truncate text-[10.5px] text-ink-muted">
                                          {u.position_name ?? "—"}
                                        </div>
                                      </div>
                                      <button
                                        className="flex-none text-[10px] text-ink-muted hover:text-ink"
                                        aria-label={`Edit ${u.name ?? u.email}`}
                                        onClick={() => setProfileId(u.id)}
                                      >
                                        <Pencil size={11} />
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
            </div>
          );
        })}

        <p className="mb-0 mt-2 text-[11.5px] text-ink-muted print:hidden">
          {canManage
            ? "Tip: drag a card into another team column to move it, or onto a department pill to change department. Use the pencil on a card to edit reporting or grouping. Outsourced teams stay off this chart."
            : "Reporting lines and grouping are managed by admins. Outsourced teams stay off this chart."}
        </p>
      </div>

      {profileMember && (
        <TeamMemberProfile
          member={profileMember}
          members={users}
          departments={departments}
          positions={positionsQ.data?.positions ?? []}
          roles={rolesQ.data?.roles ?? []}
          companies={companies}
          canManage={canManage}
          canImpersonate={false}
          onLoginAs={() => {}}
          onClose={() => setProfileId(null)}
          onChanged={() => members.reload()}
        />
      )}
    </div>
  );
}
