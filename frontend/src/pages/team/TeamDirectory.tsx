import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronRight, LogIn, Pencil, RefreshCw } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { api, tokenStore } from "../../api/client";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { allSettledBounded } from "../../lib/allSettledBounded";
import { relativeTime, cn } from "../../lib/utils";
import { fmtDate } from "../../vendor/shared/format";
import { formatPhone } from "../../vendor/shared/phone";
import { DataTable, type Column } from "../../components/DataTable";
import { FilterPills } from "../../components/FilterPills";
import { StatStrip } from "../../components/DetailLayout";
import { Badge } from "../../components/Badge";
import { Avatar } from "../../components/Avatar";
import { Button, IconButton, SearchInput } from "../../components/Button";
import { Panel, PanelSection } from "../../components/Panel";
import { SearchableSelect } from "../../vendor/scm/components/SearchableSelect";
import type { TeamMember, Department, Position, Role } from "../../types";
import {
  buildDeptNodes,
  attentionCounts,
  statusBadgeProps,
  divisionOf,
  empCode,
  Eyebrow,
  FIELD_SELECT_CLS,
} from "./teamShared";
import { TeamMemberProfile } from "./TeamMemberProfile";
import { TeamInviteModal } from "./TeamInviteModal";

/* Directory — the redesigned Team home (design handoff screen 01).
 * Department tree pinned left, dense member table right, dark bulk-action
 * bar when rows are checked. Replaces the flat Members list as the primary
 * "find a person / manage a roster" screen; the classic Members tab stays
 * URL-reachable at /team?tab=members during the transition. */

type RailSelection =
  | { kind: "all" }
  | { kind: "dept"; id: number; division: string | null }
  | { kind: "nodept" }
  | { kind: "attention"; key: "pending" | "never" | "disabled" };

type StatusPill = "all" | "active" | "invited" | "disabled";

const railRow =
  "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors duration-fast";

export function TeamDirectory({
  inviteOpen,
  onCloseInvite,
  salesDirScoped = false,
}: {
  inviteOpen: boolean;
  onCloseInvite: () => void;
  salesDirScoped?: boolean;
}) {
  const { user: me, can } = useAuth();
  const toast = useToast();
  const dialog = useDialog();
  const canManage = can("users.manage");
  const [params, setParams] = useSearchParams();

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
  const positions = useQuery<{ positions: Position[] }>(
    "/api/positions",
    () => api.get("/api/positions"),
    [],
    freshList,
  );
  const roles = useQuery<{ roles: Role[] }>(
    "/api/roles",
    () => api.get("/api/roles"),
    [],
    freshList,
  );
  const companiesQ = useQuery<{
    companies: Array<{ id: number; code: string; name: string }>;
    activeCompanyCode?: string;
  }>("/api/companies", () => api.get("/api/companies"), [], freshList);

  const users = useMemo(() => members.data?.users ?? [], [members.data]);
  const departments = depts.data?.departments ?? [];
  const companyName =
    companiesQ.data?.companies.find(
      (c) => c.code === companiesQ.data?.activeCompanyCode,
    )?.name ??
    companiesQ.data?.companies[0]?.name ??
    "Houzs";

  const { nodes: deptNodes, noDept } = useMemo(
    () => buildDeptNodes(users, departments),
    [users, departments],
  );
  const attention = useMemo(() => attentionCounts(users), [users]);

  // Rail selection — ?dept=<id> deep-links a department (Departments cards
  // navigate here with it).
  const [selection, setSelection] = useState<RailSelection>(() => {
    const deep = parseInt(params.get("dept") ?? "", 10);
    return Number.isFinite(deep) && deep > 0
      ? { kind: "dept", id: deep, division: null }
      : { kind: "all" };
  });
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // Departments that can expand (have at least one team) — drives the rail's
  // one-click Expand all / Collapse all toggle.
  const expandableDeptIds = useMemo(
    () => deptNodes.filter((n) => n.divisions.length > 0).map((n) => n.dept.id),
    [deptNodes],
  );
  const allExpanded =
    expandableDeptIds.length > 0 &&
    expandableDeptIds.every((id) => expanded.has(id));
  const [statusPill, setStatusPill] = useState<StatusPill>("all");
  const [searchQ, setSearchQ] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [profileId, setProfileId] = useState<number | null>(null);
  const [bulkField, setBulkField] = useState<
    "dept" | "team" | "manager" | "position" | null
  >(null);
  const [bulkValue, setBulkValue] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);

  // Keep the ?dept= param in sync so a selected department is shareable.
  useEffect(() => {
    const next = new URLSearchParams(params);
    if (selection.kind === "dept") next.set("dept", String(selection.id));
    else next.delete("dept");
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);

  function selectDept(id: number, division: string | null = null) {
    setSelection({ kind: "dept", id, division });
    setSelectedIds(new Set());
  }

  // Members in the current rail scope (before the status pill + search).
  const scoped = useMemo(() => {
    switch (selection.kind) {
      case "all":
        return users;
      case "nodept":
        return users.filter((u) => u.department_id == null);
      case "dept": {
        const inDept = users.filter((u) => u.department_id === selection.id);
        return selection.division == null
          ? inDept
          : inDept.filter((u) => divisionOf(u) === selection.division);
      }
      case "attention":
        if (selection.key === "pending") return users.filter((u) => u.status === "invited");
        if (selection.key === "disabled") return users.filter((u) => u.status === "disabled");
        return users.filter((u) => u.status === "active" && !u.last_login_at);
    }
  }, [users, selection]);

  const rows = useMemo(() => {
    let list = scoped;
    if (statusPill !== "all") list = list.filter((u) => u.status === statusPill);
    const q = searchQ.trim().toLowerCase();
    if (q) {
      list = list.filter((u) =>
        [u.name, u.email, u.phone, u.position_name, divisionOf(u)]
          .some((v) => (v ?? "").toLowerCase().includes(q)),
      );
    }
    return list;
  }, [scoped, statusPill, searchQ]);

  const scopedCounts = useMemo(() => {
    const active = scoped.filter((u) => u.status === "active").length;
    const invited = scoped.filter((u) => u.status === "invited").length;
    const disabled = scoped.filter((u) => u.status === "disabled").length;
    return { active, invited, disabled };
  }, [scoped]);

  const activeNode =
    selection.kind === "dept"
      ? deptNodes.find((n) => n.dept.id === selection.id) ?? null
      : null;

  const headerTitle =
    selection.kind === "all"
      ? "All members"
      : selection.kind === "nodept"
        ? "No department"
        : selection.kind === "attention"
          ? selection.key === "pending"
            ? "Pending invites"
            : selection.key === "never"
              ? "Never logged in"
              : "Disabled accounts"
          : selection.division ?? activeNode?.dept.name ?? "Department";

  const headerEyebrow = (
    selection.kind === "dept" && selection.division && activeNode
      ? `${companyName} · ${activeNode.dept.name}`
      : companyName
  ).toUpperCase();

  // ── Impersonation (same probe + flow as the classic Members tab) ──
  const [canImpersonate, setCanImpersonate] = useState(false);
  useEffect(() => {
    if (!canManage) return;
    let alive = true;
    api
      .get<{ enabled: boolean }>("/api/users/impersonation-enabled")
      .then((r) => alive && setCanImpersonate(!!r.enabled))
      .catch(() => {
        // Probe unreachable or refused — fail closed: the Login-as button
        // stays hidden, which is the designed answer for "not enabled".
        if (alive) setCanImpersonate(false);
      });
    return () => {
      alive = false;
    };
  }, [canManage]);

  async function loginAs(u: TeamMember) {
    if (
      !(await dialog.confirm(
        `Log in as ${u.name || u.email}?\n\nYour current session will be replaced — to come back, log out and sign in with your own account again.`,
      ))
    )
      return;
    try {
      const res = await api.post<{ token: string }>(`/api/users/${u.id}/impersonate`, {});
      tokenStore.set(res.token, true);
      window.location.assign("/");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not log in as this member");
    }
  }

  async function resendInvite(u: TeamMember) {
    try {
      await api.post(`/api/users/${u.id}/resend-invite`, {});
      toast.success(`Invite re-sent to ${u.email}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not resend the invite");
    }
  }

  // ── Bulk actions ──
  const selectedMembers = useMemo(
    () => users.filter((u) => selectedIds.has(String(u.id))),
    [users, selectedIds],
  );

  async function bulkPatch(patch: Record<string, unknown>, label: string) {
    setBulkBusy(true);
    const results = await allSettledBounded(
      selectedMembers.map((u) => () => api.patch(`/api/users/${u.id}`, patch)),
    );
    setBulkBusy(false);
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed) toast.error(`${label}: ${failed} of ${results.length} failed`);
    else toast.success(`${label} applied to ${results.length} member${results.length === 1 ? "" : "s"}`);
    setSelectedIds(new Set());
    setBulkField(null);
    setBulkValue("");
    members.reload();
  }

  async function bulkStatus(status: "active" | "disabled") {
    const verb = status === "active" ? "Enable" : "Disable";
    if (
      !(await dialog.confirm({
        message: `${verb} ${selectedMembers.length} member${selectedMembers.length === 1 ? "" : "s"}?`,
        tone: status === "disabled" ? "danger" : undefined,
      }))
    )
      return;
    await bulkPatch({ status }, verb);
  }

  async function bulkResend() {
    const pending = selectedMembers.filter((u) => u.status === "invited");
    if (pending.length === 0) {
      toast.error("None of the selected members has a pending invite.");
      return;
    }
    setBulkBusy(true);
    const results = await allSettledBounded(
      pending.map((u) => () => api.post(`/api/users/${u.id}/resend-invite`, {})),
    );
    setBulkBusy(false);
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed) toast.error(`Resend: ${failed} of ${results.length} failed`);
    else toast.success(`Invites re-sent to ${results.length} member${results.length === 1 ? "" : "s"}`);
    setSelectedIds(new Set());
  }

  // Company names for the optional Company column. Empty grant set fail-opens
  // to every company (companyContext semantics) — shown as "All companies".
  function companyNamesOf(u: TeamMember): string {
    const list = companiesQ.data?.companies ?? [];
    if (!u.company_ids || u.company_ids.length === 0) return "All companies";
    return (
      list
        .filter((c) => u.company_ids!.includes(c.id))
        .map((c) => c.name)
        .join(" + ") || "—"
    );
  }

  // ── Table columns ──
  const columns: Column<TeamMember>[] = useMemo(
    () => [
      {
        key: "member",
        label: "Member",
        width: "230px",
        render: (u) => (
          <div className="flex min-w-0 items-center gap-2.5">
            <Avatar
              userId={u.id}
              hasImage={u.profile_pic_r2_key}
              name={u.name ?? u.email}
              size={28}
            />
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold text-ink">
                {u.name || "—"}
              </div>
              <div className="truncate font-mono text-[10.5px] text-ink-muted">
                {u.email}
              </div>
            </div>
          </div>
        ),
        getValue: (u) => `${u.name ?? ""} ${u.email}`,
        sortValue: (u) => (u.name ?? u.email).toLowerCase(),
      },
      {
        key: "team",
        label: "Team",
        width: "120px",
        render: (u) => (
          <span className="text-[12px] text-ink-secondary">{divisionOf(u) ?? "—"}</span>
        ),
        getValue: (u) => divisionOf(u) ?? "",
        sortValue: (u) => divisionOf(u) ?? "~",
      },
      {
        key: "title",
        label: "Title",
        width: "120px",
        render: (u) => (
          <span className="text-[12px] text-ink-secondary">{u.position_name ?? "—"}</span>
        ),
        getValue: (u) => u.position_name ?? "",
        sortValue: (u) => u.position_name ?? "~",
      },
      /* ── Employee basics — off by default, available from the Columns panel ── */
      {
        key: "emp_id",
        label: "Employee ID",
        width: "90px",
        defaultHidden: true,
        render: (u) => (
          <span className="font-mono text-[11px] text-ink-muted">{empCode(u.id)}</span>
        ),
        getValue: (u) => empCode(u.id),
      },
      {
        key: "email",
        label: "Email",
        width: "180px",
        defaultHidden: true,
        render: (u) => (
          <span className="truncate font-mono text-[11px] text-ink-secondary">{u.email}</span>
        ),
        getValue: (u) => u.email,
      },
      {
        key: "phone",
        label: "Phone",
        width: "120px",
        defaultHidden: true,
        render: (u) => (
          <span className="font-mono text-[11px] text-ink-secondary">
            {u.phone ? formatPhone(u.phone) : "—"}
          </span>
        ),
        getValue: (u) => u.phone ?? "",
      },
      {
        key: "joined",
        label: "Joined",
        width: "90px",
        defaultHidden: true,
        render: (u) => (
          <span className="font-money text-[11px] text-ink-secondary">
            {u.joined_at ? fmtDate(u.joined_at) : "—"}
          </span>
        ),
        getValue: (u) => u.joined_at ?? "",
        sortValue: (u) => u.joined_at ?? "",
      },
      {
        key: "email_alias",
        label: "Mail alias",
        width: "160px",
        defaultHidden: true,
        render: (u) => (
          <span className="truncate font-mono text-[11px] text-ink-secondary">
            {u.email_alias ?? "—"}
          </span>
        ),
        getValue: (u) => u.email_alias ?? "",
      },
      {
        key: "company",
        label: "Company",
        width: "130px",
        defaultHidden: true,
        render: (u) => (
          <span className="truncate text-[12px] text-ink-secondary">
            {companyNamesOf(u)}
          </span>
        ),
        getValue: (u) => companyNamesOf(u),
      },
      {
        key: "reports_to",
        label: "Reports to",
        width: "120px",
        render: (u) => (
          <span className="text-[12px] text-ink-secondary">{u.manager_name ?? "—"}</span>
        ),
        getValue: (u) => u.manager_name ?? "",
      },
      {
        key: "role",
        label: "Role",
        width: "100px",
        defaultHidden: true,
        render: (u) => (
          <span className="text-[12px] text-ink-secondary">{u.role_name}</span>
        ),
        getValue: (u) => u.role_name,
      },
      {
        key: "last_login",
        label: "Last login",
        width: "90px",
        render: (u) => (
          <span className="font-mono text-[11px] text-ink-muted">
            {u.last_login_at ? relativeTime(u.last_login_at) : "never"}
          </span>
        ),
        getValue: (u) => u.last_login_at ?? "never",
        sortValue: (u) => u.last_login_at ?? "",
      },
      {
        key: "status",
        label: "Status",
        width: "90px",
        render: (u) => {
          const s = statusBadgeProps(u.status);
          return <Badge tone={s.tone}>{s.label}</Badge>;
        },
        getValue: (u) => statusBadgeProps(u.status).label,
      },
      {
        key: "actions",
        label: "",
        width: "96px",
        disableSort: true,
        disableFilter: true,
        render: (u) => (
          <div
            className="flex justify-end gap-1"
            onClick={(e) => e.stopPropagation()}
          >
            {u.status === "invited" && canManage && (
              <IconButton
                icon={<RefreshCw size={13} />}
                variant="ghost"
                size="xs"
                aria-label="Resend invite"
                title="Resend invite"
                onClick={() => resendInvite(u)}
              />
            )}
            {canImpersonate &&
              u.status === "active" &&
              canManage &&
              u.id !== me?.id && (
                <IconButton
                  icon={<LogIn size={13} />}
                  variant="ghost"
                  size="xs"
                  aria-label={`Log in as ${u.name ?? u.email}`}
                  title="Log in as"
                  onClick={() => loginAs(u)}
                />
              )}
            <IconButton
              icon={<Pencil size={13} />}
              variant="ghost"
              size="xs"
              aria-label="Open profile"
              title="Open profile"
              onClick={() => setProfileId(u.id)}
            />
          </div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canManage, canImpersonate, me?.id, companiesQ.data],
  );

  const pillOptions = [
    { value: "all" as const, label: "All", count: scoped.length },
    { value: "active" as const, label: "Active", count: scopedCounts.active },
    { value: "invited" as const, label: "Pending", count: scopedCounts.invited },
    { value: "disabled" as const, label: "Disabled", count: scopedCounts.disabled },
  ];

  const profileMember = profileId != null ? users.find((u) => u.id === profileId) ?? null : null;

  return (
    <div className="flex items-start gap-4">
      {/* ── Left rail: search + department tree + needs-attention ── */}
      <aside className="sticky top-4 hidden w-[280px] flex-none flex-col self-start overflow-hidden rounded-lg border border-border bg-surface-2 shadow-stone md:flex xl:w-[320px]">
        <div className="border-b border-border-subtle p-3">
          <SearchInput
            value={searchQ}
            onChange={setSearchQ}
            placeholder="Search name / email / phone"
          />
        </div>
        <div className="max-h-[calc(100vh-220px)] flex-1 overflow-y-auto p-2">
          <div className="flex items-center justify-between px-2 pb-2 pt-1">
            <Eyebrow>Organization</Eyebrow>
            {expandableDeptIds.length > 0 && (
              <button
                className="text-[11px] text-primary hover:underline"
                onClick={() =>
                  setExpanded(allExpanded ? new Set() : new Set(expandableDeptIds))
                }
              >
                {allExpanded ? "Collapse all" : "Expand all"}
              </button>
            )}
          </div>
          <button
            className={cn(
              railRow,
              selection.kind === "all"
                ? "bg-surface font-semibold text-ink shadow-stone"
                : "text-ink-secondary hover:bg-surface-dim",
            )}
            onClick={() => {
              setSelection({ kind: "all" });
              setSelectedIds(new Set());
            }}
          >
            <span className="truncate">{companyName}</span>
            <span className="font-money text-[11.5px] text-ink-muted">
              {users.filter((u) => u.status !== "disabled").length}
            </span>
          </button>
          <div className="mt-1 flex flex-col gap-0.5 pl-3">
            {deptNodes.map((n) => {
              const isOpen = expanded.has(n.dept.id);
              const isSelected =
                selection.kind === "dept" &&
                selection.id === n.dept.id &&
                selection.division == null;
              return (
                <div key={n.dept.id}>
                  <div
                    className={cn(
                      railRow,
                      "gap-1 py-1.5",
                      isSelected
                        ? "bg-primary-soft font-medium text-primary-ink"
                        : "text-ink-secondary hover:bg-surface-dim",
                    )}
                  >
                    <button
                      className="-ml-1 grid h-4 w-4 flex-none place-items-center rounded text-ink-muted hover:text-ink"
                      aria-label={isOpen ? "Collapse" : "Expand"}
                      onClick={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          next.has(n.dept.id) ? next.delete(n.dept.id) : next.add(n.dept.id);
                          return next;
                        })
                      }
                    >
                      {n.divisions.length > 0 ? (
                        isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />
                      ) : (
                        <span className="h-1 w-1 rounded-full bg-border-strong" />
                      )}
                    </button>
                    <button
                      className="flex min-w-0 flex-1 items-center justify-between text-left"
                      onClick={() => selectDept(n.dept.id)}
                    >
                      <span className="truncate">{n.dept.name}</span>
                      <span className={cn("font-money text-[11.5px]", isSelected ? "" : "text-ink-muted")}>
                        {n.counts.visible}
                      </span>
                    </button>
                  </div>
                  {isOpen && n.divisions.length > 0 && (
                    <div className="flex flex-col gap-0.5 pl-6 text-[12px]">
                      {n.divisions.map((d) => {
                        const divSelected =
                          selection.kind === "dept" &&
                          selection.id === n.dept.id &&
                          selection.division === d.name;
                        return (
                          <button
                            key={d.name}
                            className={cn(
                              "flex items-center justify-between rounded-md px-2 py-1 text-left",
                              divSelected
                                ? "bg-primary-soft font-medium text-primary-ink"
                                : "text-ink-secondary hover:bg-surface-dim",
                            )}
                            onClick={() => selectDept(n.dept.id, d.name)}
                          >
                            <span className="truncate">{d.name}</span>
                            <span className="font-money text-[11px] text-ink-muted">
                              {d.counts.visible}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
            {noDept.visible > 0 && (
              <button
                className={cn(
                  railRow,
                  selection.kind === "nodept"
                    ? "bg-primary-soft font-medium text-primary-ink"
                    : "text-err hover:bg-surface-dim",
                )}
                onClick={() => {
                  setSelection({ kind: "nodept" });
                  setSelectedIds(new Set());
                }}
              >
                <span>No department</span>
                <span className="font-money text-[11.5px]">{noDept.visible}</span>
              </button>
            )}
          </div>

          <Eyebrow className="mt-4 px-2 pb-2">Needs attention</Eyebrow>
          <div className="flex flex-col gap-0.5">
            {(
              [
                ["pending", "Pending invites", attention.pending, "warning"],
                ["never", "Never logged in", attention.neverLoggedIn, "neutral"],
                ["disabled", "Disabled", attention.disabled, "error"],
              ] as const
            ).map(([key, label, count, tone]) => (
              <button
                key={key}
                className={cn(
                  railRow,
                  selection.kind === "attention" && selection.key === key
                    ? "bg-primary-soft font-medium text-primary-ink"
                    : "text-ink-secondary hover:bg-surface-dim",
                )}
                onClick={() => {
                  setSelection({ kind: "attention", key });
                  setStatusPill("all");
                  setSelectedIds(new Set());
                }}
              >
                <span>{label}</span>
                <Badge tone={tone}>{count}</Badge>
              </button>
            ))}
          </div>
        </div>
      </aside>

      {/* ── Right pane: scope header + filters + table + bulk bar ── */}
      <section className="min-w-0 flex-1">
        <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
          <div className="flex flex-wrap items-end justify-between gap-3 px-5 pb-3 pt-4">
            <div className="min-w-0">
              <Eyebrow tone="accent">{headerEyebrow}</Eyebrow>
              <div className="mt-1 flex flex-wrap items-baseline gap-3">
                <h2 className="m-0 font-serif text-[22px] font-semibold text-ink">
                  {headerTitle}
                </h2>
                <span className="text-[12.5px] text-ink-secondary">
                  {activeNode?.lead && selection.kind === "dept" && !selection.division
                    ? `Lead ${activeNode.lead.name ?? activeNode.lead.email} · ${scoped.length} people`
                    : `${scoped.length} ${scoped.length === 1 ? "person" : "people"}`}
                </span>
              </div>
            </div>
            <div className="w-[300px] max-w-full">
              <StatStrip
                items={[
                  { label: "Active", value: scopedCounts.active },
                  {
                    label: "Pending",
                    value: scopedCounts.invited,
                    tone: scopedCounts.invited > 0 ? "warn" : "default",
                  },
                  {
                    label: "Disabled",
                    value: scopedCounts.disabled,
                    tone: scopedCounts.disabled > 0 ? "err" : "default",
                  },
                ]}
              />
            </div>
          </div>
          <div className="border-t border-border-subtle bg-surface-2 px-5 py-2">
            <FilterPills<StatusPill>
              value={statusPill}
              onChange={setStatusPill}
              options={pillOptions}
            />
          </div>
        </div>

        <div className="mt-3">
          <DataTable<TeamMember>
            tableId="team-directory"
            columns={columns}
            rows={members.loading ? null : rows}
            loading={members.loading}
            error={members.error ? "Couldn't load members." : undefined}
            emptyLabel={
              searchQ || statusPill !== "all"
                ? "No members match the current filters."
                : "No members in this scope yet."
            }
            getRowKey={(u) => String(u.id)}
            onRowClick={(u) => setProfileId(u.id)}
            getRowClassName={(u) =>
              selectedIds.has(String(u.id)) ? "bg-primary-soft" : ""
            }
            exportName="team-directory"
            selection={
              canManage
                ? {
                    selectedIds,
                    onToggle: (id) =>
                      setSelectedIds((prev) => {
                        const next = new Set(prev);
                        next.has(id) ? next.delete(id) : next.add(id);
                        return next;
                      }),
                    onToggleAll: (keys, allSelected) =>
                      setSelectedIds((prev) => {
                        const next = new Set(prev);
                        if (allSelected) for (const k of keys) next.delete(k);
                        else for (const k of keys) next.add(k);
                        return next;
                      }),
                  }
                : undefined
            }
          />
        </div>

        {selectedIds.size > 0 && canManage && (
          <div className="sticky bottom-4 z-10 mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-strong bg-ink px-5 py-2.5 shadow-slab">
            <span className="text-[12.5px] font-semibold text-white">
              {selectedIds.size} selected
            </span>
            <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
              {(
                [
                  ["dept", "Change dept"],
                  ["team", "Change team"],
                  ["manager", "Change manager"],
                  ["position", "Change position"],
                ] as const
              ).map(([field, label]) => (
                <button
                  key={field}
                  className="rounded-md bg-white/10 px-2.5 py-1 text-white transition-colors hover:bg-white/20"
                  onClick={() => {
                    setBulkField(field);
                    setBulkValue("");
                  }}
                >
                  {label}
                </button>
              ))}
              <button
                className="rounded-md bg-white/10 px-2.5 py-1 text-white transition-colors hover:bg-white/20"
                onClick={bulkResend}
                disabled={bulkBusy}
              >
                Resend invite
              </button>
              <button
                className="rounded-md bg-white/10 px-2.5 py-1 text-white transition-colors hover:bg-white/20"
                onClick={() => bulkStatus("active")}
                disabled={bulkBusy}
              >
                Enable
              </button>
              <button
                className="rounded-md bg-white/10 px-2.5 py-1 text-white transition-colors hover:bg-white/20"
                onClick={() => bulkStatus("disabled")}
                disabled={bulkBusy}
              >
                Disable
              </button>
              <button
                className="rounded-md px-2.5 py-1 text-white/70 transition-colors hover:text-white"
                onClick={() => setSelectedIds(new Set())}
              >
                Clear
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Bulk "change field" picker */}
      <Panel
        open={bulkField != null}
        onClose={() => setBulkField(null)}
        title={
          bulkField === "dept"
            ? "Change department"
            : bulkField === "team"
              ? "Change team"
              : bulkField === "manager"
                ? "Change manager"
                : "Change position"
        }
        subtitle={`Applies to ${selectedIds.size} selected member${selectedIds.size === 1 ? "" : "s"}`}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setBulkField(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={bulkBusy || (bulkField !== "team" && bulkValue === "")}
              onClick={() => {
                if (bulkField === "team") {
                  void bulkPatch(
                    { division: bulkValue.trim() || null },
                    bulkValue.trim() ? "Team change" : "Team cleared",
                  );
                  return;
                }
                const id = bulkValue === "none" ? null : Number(bulkValue);
                if (bulkField === "dept")
                  void bulkPatch({ department_id: id }, "Department change");
                else if (bulkField === "manager")
                  void bulkPatch({ manager_id: id }, "Manager change");
                else void bulkPatch({ position_id: id }, "Position change");
              }}
            >
              Apply
            </Button>
          </div>
        }
      >
        <PanelSection title="New value">
          {bulkField === "dept" && (
            <SearchableSelect
              className={FIELD_SELECT_CLS}
              value={bulkValue}
              onChange={setBulkValue}
              options={[
                { value: "none", label: "No department" },
                ...departments.map((d) => ({ value: String(d.id), label: d.name })),
              ]}
              placeholder="Choose a department…"
            />
          )}
          {bulkField === "team" && (
            <>
              <input
                list="bulk-team-suggestions"
                value={bulkValue}
                onChange={(e) => setBulkValue(e.target.value)}
                placeholder="Type a team — leave empty to clear"
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-primary"
              />
              <datalist id="bulk-team-suggestions">
                {[...new Set(users.map((m) => divisionOf(m)).filter(Boolean) as string[])]
                  .sort()
                  .map((d) => (
                    <option key={d} value={d} />
                  ))}
              </datalist>
              <p className="mb-0 mt-2 text-[11.5px] text-ink-muted">
                Teams are free-text groupings within a department — pick an existing
                one or type a new name.
              </p>
            </>
          )}
          {bulkField === "manager" && (
            <SearchableSelect
              className={FIELD_SELECT_CLS}
              value={bulkValue}
              onChange={setBulkValue}
              options={[
                { value: "none", label: "No manager (top level)" },
                /* Bulk change can't exclude each row's own downline the way the
                   single-member picker does — the server-side cycle guard
                   rejects any loop, so offer everyone and let it referee. */
                ...users
                  .filter((m) => m.status === "active" && !selectedIds.has(String(m.id)))
                  .map((m) => ({
                    value: String(m.id),
                    label: m.department_name
                      ? `${m.name || m.email} · ${m.department_name}`
                      : m.name || m.email,
                  }))
                  .sort((a, b) => a.label.localeCompare(b.label)),
              ]}
              placeholder="Choose a manager…"
            />
          )}
          {bulkField === "position" && (
            <SearchableSelect
              className={FIELD_SELECT_CLS}
              value={bulkValue}
              onChange={setBulkValue}
              options={[
                { value: "none", label: "No position" },
                ...(positions.data?.positions ?? []).map((p) => ({
                  value: String(p.id),
                  label: p.department_name ? `${p.name} — ${p.department_name}` : p.name,
                })),
              ]}
              placeholder="Choose a position…"
            />
          )}
        </PanelSection>
      </Panel>

      {profileMember && (
        <TeamMemberProfile
          member={profileMember}
          members={users}
          departments={departments}
          positions={positions.data?.positions ?? []}
          roles={roles.data?.roles ?? []}
          companies={companiesQ.data?.companies ?? []}
          canManage={canManage && !salesDirScoped}
          canImpersonate={canImpersonate}
          onLoginAs={loginAs}
          onClose={() => setProfileId(null)}
          onChanged={() => members.reload()}
        />
      )}

      <TeamInviteModal
        open={inviteOpen}
        onClose={onCloseInvite}
        departments={departments}
        positions={positions.data?.positions ?? []}
        roles={roles.data?.roles ?? []}
        members={users}
        companies={companiesQ.data?.companies ?? []}
        salesDirScoped={salesDirScoped}
        presetDeptId={selection.kind === "dept" ? selection.id : null}
        onInvited={() => members.reload()}
      />
    </div>
  );
}
