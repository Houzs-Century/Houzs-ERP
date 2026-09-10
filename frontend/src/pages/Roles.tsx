import { useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  Check,
  Minus,
  Shield,
  AlertTriangle,
  Copy,
  Share2,
  ClipboardPaste,
  Settings2,
  Trash2,
  ChevronDown,
  Users,
} from "lucide-react";
import { Button } from "../components/Button";
import { SearchInput } from "../components/Button";
import { Badge } from "../components/Badge";
import { Avatar } from "../components/Avatar";
import { EmptyState } from "../components/EmptyState";
import { FilterPills } from "../components/FilterPills";
import { RowActionsMenu, type MenuItem } from "../components/RowActionsMenu";
import { Skeleton } from "../components/Skeleton";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { useAuth } from "../auth/AuthContext";
import { api } from "../api/client";
import { cn } from "../lib/utils";
import type { PermissionDef, Role, TeamMember } from "../types";
import {
  buildModules,
  activeIds as computeActiveIds,
  setPerm,
  setPerms,
  cellState,
  moduleCounts,
  diffGrants,
  isLockedRole,
  VERBS,
  VERB_LABEL,
  type GrantMap,
  type Verb,
} from "../lib/rolesPermissionModel";
import { RoleSettingsDrawer } from "./roles/RoleSettingsDrawer";
import { NewRoleModal, RolePickerModal, type NewRoleDraft } from "./roles/RolesModals";

type GroupFilter = "all" | "system" | "custom";

function cloneGrants(g: GrantMap): GrantMap {
  const out: GrantMap = {};
  for (const [k, v] of Object.entries(g)) out[Number(k)] = new Set(v);
  return out;
}

/**
 * Roles & Permissions — master/detail workspace. Left: searchable, grouped role
 * list with bulk checkboxes. Right: the selected role's grants as a
 * resource x verb matrix (adapted from the flat permission catalogue), edited in
 * a staged model with a Save/Discard bar. Embedded in the Team page shell, which
 * owns the tab strip + PageHeader and passes `creating` for the New Role modal.
 */
export function RolesTab({
  creating,
  onCloseCreate,
}: {
  creating: boolean;
  onCloseCreate: () => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const dialog = useDialog();
  const canManage = can("roles.manage");

  const rolesQ = useQuery<{ roles: Role[] }>("/api/roles", () => api.get("/api/roles"));
  const permsQ = useQuery<{ permissions: PermissionDef[] }>(
    "/api/roles/permissions",
    () => api.get("/api/roles/permissions")
  );
  // Members for the avatar cluster. Needs users.read; degrade to counts on 403.
  const usersQ = useQuery<{ users: TeamMember[] }>("/api/users", () =>
    api.get<{ users: TeamMember[] }>("/api/users").catch(() => ({ users: [] as TeamMember[] }))
  );

  const roleList = rolesQ.data?.roles ?? [];
  const perms = permsQ.data?.permissions ?? [];

  const modules = useMemo(() => buildModules(perms), [perms]);
  const keyLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of perms) m.set(p.key, p.label);
    return m;
  }, [perms]);
  const allKeys = useMemo(() => perms.filter((p) => p.key !== "*").map((p) => p.key), [perms]);
  const readKeys = useMemo(
    () => perms.filter((p) => p.verb === "read").map((p) => p.key),
    [perms]
  );
  const roleById = useMemo(() => {
    const m = new Map<number, Role>();
    for (const r of roleList) m.set(r.id, r);
    return m;
  }, [roleList]);
  const lockedIds = useMemo(
    () => new Set(roleList.filter(isLockedRole).map((r) => r.id)),
    [roleList]
  );

  const [selected, setSelected] = useState<number | null>(null);
  const [checked, setChecked] = useState<number[]>([]);
  const [moduleId, setModuleId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [groupFilter, setGroupFilter] = useState<GroupFilter>("all");
  const [closedGroups, setClosedGroups] = useState<Record<string, boolean>>({});
  const [membersOpen, setMembersOpen] = useState(false);
  const [bannerOpen, setBannerOpen] = useState(false);
  const [grants, setGrants] = useState<GrantMap>({});
  const [baseline, setBaseline] = useState<GrantMap>({});
  const [saving, setSaving] = useState(false);
  const [picker, setPicker] = useState<"apply" | "copy" | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [creatingBusy, setCreatingBusy] = useState(false);
  const pendingSelect = useRef<number | null>(null);

  // (Re)seed the staged + baseline grants from the server whenever the role
  // list (re)loads — first load, and after every save/create/delete reload().
  useEffect(() => {
    const data = rolesQ.data;
    if (!data) return;
    const g: GrantMap = {};
    for (const r of data.roles) g[r.id] = new Set(r.permissions);
    setGrants(g);
    setBaseline(cloneGrants(g));
    setSelected((prev) => {
      const want = pendingSelect.current;
      if (want != null && data.roles.some((r) => r.id === want)) return want;
      if (prev != null && data.roles.some((r) => r.id === prev)) return prev;
      const sys = data.roles.find((r) => r.is_system);
      return sys?.id ?? data.roles[0]?.id ?? null;
    });
    pendingSelect.current = null;
    setChecked([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rolesQ.data]);

  useEffect(() => {
    if (modules.length === 0) return;
    setModuleId((prev) => (prev && modules.some((m) => m.id === prev) ? prev : modules[0].id));
  }, [modules]);

  const isBulk = checked.length >= 2;
  const ids = computeActiveIds(selected, checked, lockedIds);
  const current = selected != null ? roleById.get(selected) ?? null : null;
  const isSystemView = isBulk ? ids.length === 0 : current ? isLockedRole(current) : false;
  const mod = modules.find((m) => m.id === moduleId) ?? modules[0] ?? null;

  const diff = useMemo(() => diffGrants(grants, baseline), [grants, baseline]);
  const dirty = diff.total > 0;

  // ── left-rail filtering ────────────────────────────────────
  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    return roleList.filter((r) => {
      if (groupFilter === "system" && !r.is_system) return false;
      if (groupFilter === "custom" && r.is_system) return false;
      if (!q) return true;
      if ((r.name + " " + (r.description ?? "")).toLowerCase().includes(q)) return true;
      if (
        r.permissions.some(
          (k) => k.toLowerCase().includes(q) || (keyLabel.get(k) ?? "").toLowerCase().includes(q)
        )
      )
        return true;
      // Searching an unrecognised stored key (e.g. planner.run) surfaces the
      // roles that still carry it — the whole point of showing them.
      return (r.unknown_permissions ?? []).some((k) => k.toLowerCase().includes(q));
    });
  }, [roleList, groupFilter, q, keyLabel]);

  const groups = useMemo(() => {
    const sys = filtered.filter((r) => r.is_system);
    const custom = filtered.filter((r) => !r.is_system);
    return [
      { key: "System", roles: sys },
      { key: "Custom roles", roles: custom },
    ].filter((g) => g.roles.length > 0);
  }, [filtered]);

  const members = useMemo(() => {
    if (isBulk || selected == null) return [];
    return (usersQ.data?.users ?? []).filter((u) => u.role_id === selected);
  }, [usersQ.data, selected, isBulk]);

  // ── handlers ───────────────────────────────────────────────
  function selectRole(id: number) {
    setSelected(id);
    setChecked([]);
    setMembersOpen(false);
  }
  function toggleCheck(id: number) {
    if (!canManage) return;
    setChecked((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  }
  function toggleGroup(key: string) {
    setClosedGroups((p) => ({ ...p, [key]: !p[key] }));
  }

  function guardEditable(): boolean {
    if (!canManage) return false;
    if (isSystemView) {
      toast.info("System roles cannot be edited. Duplicate one to get an editable copy.");
      return false;
    }
    return true;
  }

  function toggleCell(key: string | undefined) {
    if (!key || !guardEditable()) return;
    const st = cellState(key, ids, grants);
    setGrants((g) => setPerm(g, ids, key, st !== "on", lockedIds));
  }
  function toggleColumn(verb: Verb) {
    if (!mod || !guardEditable()) return;
    const keys = mod.rows.map((r) => r.keyByVerb[verb]).filter((k): k is string => !!k);
    if (keys.length === 0) return;
    const allOn = keys.every((k) => cellState(k, ids, grants) === "on");
    setGrants((g) => setPerms(g, ids, keys, !allOn, lockedIds));
  }
  function setModuleAll(on: boolean) {
    if (!mod || !guardEditable()) return;
    setGrants((g) => setPerms(g, ids, mod.keys, on, lockedIds));
  }

  function discard() {
    setGrants(cloneGrants(baseline));
    toast.info("Changes discarded.");
  }
  async function save() {
    const changed = diff.roleIds;
    if (changed.length === 0) return;
    setSaving(true);
    try {
      await Promise.all(
        changed.map((id) =>
          api.patch(`/api/roles/${id}`, { permissions: Array.from(grants[id] ?? []) })
        )
      );
      toast.success("Permissions saved.");
      rolesQ.reload();
    } catch (e: any) {
      toast.error(e?.message || "Save failed. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  // Re-save the role's VALID staged grants; the backend PATCH filters through
  // isValidPermission, so this drops every unrecognised stored key at once
  // (per-key clear isn't possible — the API strips them all on any write).
  async function clearDropped(r: Role) {
    try {
      await api.patch(`/api/roles/${r.id}`, {
        permissions: Array.from(grants[r.id] ?? new Set(r.permissions)),
      });
      toast.success("Cleared the unrecognised keys.");
      rolesQ.reload();
    } catch (e: any) {
      toast.error(e?.message || "Could not clear the keys.");
    }
  }

  async function deleteRole(r: Role) {
    if (r.is_system) {
      toast.error("System roles cannot be deleted.");
      return;
    }
    const ok = await dialog.confirm({
      title: `Delete “${r.name}”?`,
      message:
        r.member_count > 0
          ? `${r.member_count} member${r.member_count === 1 ? "" : "s"} still hold this role. Reassign them first — this can't be undone.`
          : "This can't be undone.",
      danger: true,
      confirmLabel: "Delete role",
    });
    if (!ok) return;
    try {
      await api.del(`/api/roles/${r.id}`);
      toast.success(`Deleted ${r.name}`);
      if (selected === r.id) setSelected(null);
      rolesQ.reload();
    } catch (e: any) {
      toast.error(e?.message || "Delete failed.");
    }
  }

  async function createRole(draft: NewRoleDraft) {
    const name = draft.name.trim();
    if (!name) {
      toast.error("Give the role a name first.");
      return;
    }
    let permissions: string[] = [];
    if (draft.startFrom === "readonly") permissions = readKeys.slice();
    else if (draft.startFrom.startsWith("role:")) {
      const srcId = Number(draft.startFrom.slice(5));
      const src = roleById.get(srcId);
      permissions = src ? src.permissions.filter((k) => k !== "*") : [];
    }
    setCreatingBusy(true);
    try {
      const res = await api.post<{ id: number }>("/api/roles", {
        name,
        description: draft.description.trim() || null,
        permissions,
      });
      pendingSelect.current = res?.id ?? null;
      toast.success("Role created — set its grants below.");
      onCloseCreate();
      rolesQ.reload();
    } catch (e: any) {
      toast.error(e?.message || "Could not create the role.");
    } finally {
      setCreatingBusy(false);
    }
  }

  async function duplicateRole(r: Role) {
    const permissions = r.permissions.includes("*")
      ? allKeys.slice() // "duplicate as editable": expand the wildcard to real keys
      : Array.from(grants[r.id] ?? new Set(r.permissions));
    // Find a free name — the backend rejects duplicates with 409.
    const taken = new Set(roleList.map((x) => x.name.toLowerCase()));
    let name = `${r.name} copy`;
    let n = 2;
    while (taken.has(name.toLowerCase())) name = `${r.name} copy ${n++}`;
    try {
      const res = await api.post<{ id: number }>("/api/roles", {
        name,
        description: r.description,
        permissions,
        scope_to_pic: r.scope_to_pic,
      });
      pendingSelect.current = res?.id ?? null;
      toast.success(`Duplicated as “${name}”.`);
      rolesQ.reload();
    } catch (e: any) {
      toast.error(e?.message || "Could not duplicate the role.");
    }
  }

  async function applyTo(targetIds: number[]) {
    if (selected == null) return;
    const source = Array.from(grants[selected] ?? []);
    setPickerBusy(true);
    try {
      await Promise.all(
        targetIds.map((id) => api.patch(`/api/roles/${id}`, { permissions: source }))
      );
      toast.success(
        `Applied to ${targetIds.length} role${targetIds.length === 1 ? "" : "s"}.`
      );
      setPicker(null);
      rolesQ.reload();
    } catch (e: any) {
      toast.error(e?.message || "Could not apply permissions.");
    } finally {
      setPickerBusy(false);
    }
  }

  function copyFrom(sourceIds: number[]) {
    const srcId = sourceIds[0];
    if (srcId == null) return;
    const srcPerms = new Set(baseline[srcId] ?? new Set(roleById.get(srcId)?.permissions ?? []));
    setGrants((g) => {
      const next = { ...g };
      for (const id of ids) if (!lockedIds.has(id)) next[id] = new Set(srcPerms);
      return next;
    });
    setPicker(null);
    toast.info(
      `Copied grants from ${roleById.get(srcId)?.name ?? "role"} — review and save.`
    );
  }

  // ── derived display ────────────────────────────────────────
  const systemChecked = isBulk ? checked.filter((id) => lockedIds.has(id)) : [];
  const detailTitle = isBulk
    ? ids.length === 1
      ? "1 editable role selected"
      : `${ids.length} roles selected`
    : current?.name ?? "—";
  const detailSub = isBulk
    ? checked.map((id) => roleById.get(id)?.name ?? "").filter(Boolean).join(", ") +
      (systemChecked.length
        ? " — system roles are read-only and unaffected by bulk edits."
        : "")
    : current?.description ?? "";

  const dirtyLabel = (() => {
    const c = `${diff.total} unsaved change${diff.total === 1 ? "" : "s"}`;
    if (diff.roleIds.length === 1) {
      return `${c} on ${roleById.get(diff.roleIds[0])?.name ?? "1 role"}`;
    }
    return `${c} across ${diff.roleIds.length} roles`;
  })();

  const menuItems: MenuItem[] = current
    ? [
        { icon: Copy, label: "Duplicate role", onClick: () => duplicateRole(current) },
        {
          icon: Share2,
          label: "Apply these permissions to…",
          onClick: () => setPicker("apply"),
        },
        {
          icon: ClipboardPaste,
          label: "Copy permissions from another role…",
          onClick: () => setPicker("copy"),
        },
        { icon: Settings2, label: "Role settings…", onClick: () => setSettingsOpen(true) },
        ...(!current.is_system
          ? [
              {
                icon: Trash2,
                label: "Delete role",
                danger: true,
                onClick: () => deleteRole(current),
              } as MenuItem,
            ]
          : []),
      ]
    : [];

  const loading = rolesQ.loading || permsQ.loading;

  return (
    <div className={cn("relative", dirty && "pb-20")}>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(280px,320px)_minmax(0,1fr)] lg:items-start">
        {/* ── Left rail ─────────────────────────────────────── */}
        <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-stone lg:sticky lg:top-4">
          <div className="border-b border-border-subtle p-2.5">
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="Search roles or permission keys"
              widthClassName="w-full"
              leadingIcon={<Search size={14} />}
              inputClassName="h-9 w-full rounded-md border-border bg-surface-2 pl-[30px] pr-2.5 text-[12.5px] focus:bg-surface"
              aria-label="Search roles"
            />
            <div className="mt-2">
              <FilterPills<GroupFilter>
                value={groupFilter}
                onChange={setGroupFilter}
                options={[
                  { value: "all", label: "All roles", count: roleList.length },
                  {
                    value: "system",
                    label: "System",
                    count: roleList.filter((r) => r.is_system).length,
                  },
                  {
                    value: "custom",
                    label: "Custom",
                    count: roleList.filter((r) => !r.is_system).length,
                  },
                ]}
              />
            </div>
          </div>

          <div className="flex items-center justify-between border-b border-border-subtle bg-surface-2 px-3 py-1.5 text-[11px] text-ink-muted">
            <span>
              {filtered.length} of {roleList.length} roles
              {checked.length > 0 && ` · ${checked.length} selected`}
            </span>
            <button
              onClick={() => setChecked([])}
              className={cn(
                "text-[11px] text-primary underline",
                checked.length === 0 && "invisible"
              )}
            >
              Clear selection
            </button>
          </div>

          <div className="max-h-[calc(100vh-360px)] min-h-[240px] overflow-y-auto">
            {loading && (
              <div className="space-y-2 p-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-11 w-full rounded-md" />
                ))}
              </div>
            )}
            {!loading &&
              groups.map((g) => {
                const open = !closedGroups[g.key];
                return (
                  <div key={g.key}>
                    <button
                      onClick={() => toggleGroup(g.key)}
                      className="flex w-full items-center gap-1.5 border-t border-border-subtle bg-surface px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-ink-muted hover:bg-surface-2"
                    >
                      <ChevronDown
                        size={12}
                        className={cn(
                          "text-border-strong transition-transform duration-[120ms]",
                          !open && "-rotate-90"
                        )}
                      />
                      <span className="flex-1">{g.key}</span>
                      <span className="tabular-nums">{g.roles.length}</span>
                    </button>
                    {open &&
                      g.roles.map((r) => (
                        <RoleRow
                          key={r.id}
                          role={r}
                          selected={!isBulk && r.id === selected}
                          checked={checked.includes(r.id)}
                          canManage={canManage}
                          permCount={
                            r.permissions.includes("*") ? "All permissions" : `${r.permissions.length} permissions`
                          }
                          onSelect={() => selectRole(r.id)}
                          onCheck={() => toggleCheck(r.id)}
                          onDelete={() => deleteRole(r)}
                        />
                      ))}
                  </div>
                );
              })}
            {!loading && groups.length === 0 && (
              <div className="px-3 py-10">
                <EmptyState compact message="No roles match" description="Try a different search or filter." />
              </div>
            )}
          </div>
        </div>

        {/* ── Right panel ───────────────────────────────────── */}
        <div className="min-h-[560px] overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
          {loading || !current ? (
            <div className="p-6">
              <Skeleton className="h-6 w-52 rounded" />
              <Skeleton className="mt-4 h-40 w-full rounded-lg" />
            </div>
          ) : (
            <>
              {/* header */}
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border-subtle px-4 py-3.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[17px] font-bold tracking-tight text-ink">
                      {detailTitle}
                    </span>
                    {!isBulk && current.is_system && (
                      <Badge tone="accent" size="sm">
                        System
                      </Badge>
                    )}
                    {isBulk && (
                      <Badge tone="success" size="sm">
                        Bulk edit
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1 max-w-[620px] text-[12.5px] text-ink-muted [text-wrap:pretty]">
                    {detailSub}
                  </div>
                </div>
                {!isBulk && (
                  <div className="ml-auto flex flex-none items-center gap-2.5">
                    <button
                      onClick={() => setMembersOpen((v) => !v)}
                      className="flex items-center gap-2 rounded-full border border-border bg-surface py-1 pl-1.5 pr-3 hover:bg-surface-dim"
                    >
                      <span className="flex items-center">
                        {members.slice(0, 3).map((m, i) => (
                          <span
                            key={m.id}
                            className={cn("rounded-full ring-2 ring-surface", i > 0 && "-ml-2")}
                            style={{ zIndex: 9 - i }}
                          >
                            <Avatar userId={m.id} name={m.name} size={24} />
                          </span>
                        ))}
                        {members.length === 0 && (
                          <span className="grid h-6 w-6 place-items-center rounded-full bg-surface-2 text-ink-muted">
                            <Users size={13} />
                          </span>
                        )}
                      </span>
                      <span className="text-[11.5px] text-ink-secondary">
                        {current.member_count} member{current.member_count === 1 ? "" : "s"}
                      </span>
                    </button>
                    {canManage && (
                      <RowActionsMenu items={menuItems} size={32} title="Role actions" />
                    )}
                  </div>
                )}
              </div>

              {/* members disclosure */}
              {membersOpen && !isBulk && (
                <div className="flex flex-wrap gap-1.5 border-b border-border-subtle bg-surface-dim px-4 py-2.5">
                  {members.length === 0 ? (
                    <span className="text-[11.5px] text-ink-muted">
                      {current.member_count === 0
                        ? "No members hold this role yet."
                        : `${current.member_count} member${current.member_count === 1 ? "" : "s"} — names need the team-directory permission.`}
                    </span>
                  ) : (
                    members.map((m) => (
                      <span
                        key={m.id}
                        className="flex items-center gap-1.5 rounded-full border border-border bg-surface py-0.5 pl-1 pr-2.5 text-[11.5px] text-ink-secondary"
                      >
                        <Avatar userId={m.id} name={m.name} size={20} />
                        {m.name || m.email}
                      </span>
                    ))
                  )}
                </div>
              )}

              {/* unrecognised-keys banner — stored keys this build no longer knows
                  (served by GET /api/roles as unknown_permissions, #2554) */}
              {!isBulk && current && (current.unknown_permissions?.length ?? 0) > 0 && (
                <div className="border-b border-border-subtle bg-warning-bg">
                  <button
                    onClick={() => setBannerOpen((v) => !v)}
                    className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[12px] text-warning-text"
                  >
                    <AlertTriangle size={13} className="flex-none" />
                    <span className="flex-1 font-semibold">
                      {current.unknown_permissions!.length} stored key
                      {current.unknown_permissions!.length === 1 ? "" : "s"} this build does not recognise — they grant nothing
                    </span>
                    <ChevronDown
                      size={14}
                      className={cn("flex-none transition-transform duration-[120ms]", !bannerOpen && "-rotate-90")}
                    />
                  </button>
                  {bannerOpen && (
                    <div className="px-4 pb-3">
                      <p className="mb-2 text-[11.5px] text-warning-text">
                        These keys are stored on the role but this build no longer recognises them, so they grant nothing. Clear them to keep the role tidy.
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {current.unknown_permissions!.map((k) => (
                          <span
                            key={k}
                            className="rounded-full border border-border-subtle bg-surface px-2 py-0.5 font-mono text-[11px] tabular-nums text-ink-secondary"
                          >
                            {k}
                          </span>
                        ))}
                      </div>
                      {canManage && (
                        <button
                          onClick={() => clearDropped(current)}
                          className="mt-2.5 rounded-md border border-border bg-surface px-2.5 py-1 text-[12px] font-semibold text-ink-secondary hover:border-err hover:text-err"
                        >
                          Clear {current.unknown_permissions!.length} dropped key
                          {current.unknown_permissions!.length === 1 ? "" : "s"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* body: system empty-state OR the matrix */}
              {isSystemView ? (
                <div className="p-11">
                  <EmptyState
                    icon={<Shield size={22} />}
                    message="All permissions"
                    description="System roles hold every grant in every module and cannot be edited. Duplicate this role if you need an editable copy."
                    cta={
                      canManage && current
                        ? { label: "Duplicate as editable role", onClick: () => duplicateRole(current) }
                        : undefined
                    }
                  />
                </div>
              ) : mod ? (
                <>
                  {/* module strip */}
                  <div className="flex flex-wrap gap-1.5 border-b border-border-subtle bg-surface-2 px-3.5 py-2.5">
                    {modules.map((m) => {
                      const active = m.id === mod.id;
                      const { on, total } = moduleCounts(m, ids, grants);
                      const full = total > 0 && on === total;
                      return (
                        <button
                          key={m.id}
                          onClick={() => setModuleId(m.id)}
                          className={cn(
                            "flex h-[27px] items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-[12px] transition-colors",
                            active
                              ? "border-primary bg-primary font-semibold text-white"
                              : "border-border-subtle bg-surface text-ink-secondary hover:bg-surface-dim"
                          )}
                        >
                          <span>{m.label}</span>
                          <span
                            className={cn(
                              "rounded-full px-1.5 py-px text-[9.5px] tabular-nums",
                              active
                                ? "bg-white/20 text-white"
                                : full
                                  ? "bg-synced-bg text-synced"
                                  : on === 0
                                    ? "bg-surface-2 text-ink-muted"
                                    : "bg-accent-soft text-accent"
                            )}
                          >
                            {on === 0 ? "—" : `${on}/${total}`}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {/* module header */}
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-4 py-2.5">
                    <div className="min-w-0">
                      <div className="text-[13.5px] font-semibold text-ink">{mod.label}</div>
                      <div className="mt-0.5 text-[11px] tabular-nums text-ink-muted">
                        {(() => {
                          const { on, total } = moduleCounts(mod, ids, grants);
                          return `${on} of ${total} grants${
                            isBulk ? ` across ${ids.length} role${ids.length === 1 ? "" : "s"}` : ""
                          }`;
                        })()}
                      </div>
                    </div>
                    {canManage && (
                      <div className="flex gap-1.5">
                        <Button variant="secondary" onClick={() => setModuleAll(true)} className="h-[30px] px-2.5 text-[12px]">
                          Grant all
                        </Button>
                        <Button variant="ghost" onClick={() => setModuleAll(false)} className="h-[30px] px-2.5 text-[12px]">
                          Clear all
                        </Button>
                      </div>
                    )}
                  </div>

                  {/* matrix */}
                  <div className="overflow-x-auto">
                    <div className="min-w-[520px]">
                      <div className="grid h-[34px] grid-cols-[minmax(200px,1fr)_repeat(5,58px)] items-center border-b border-border-subtle bg-surface px-4">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                          Resource
                        </div>
                        {VERBS.map((v) => (
                          <button
                            key={v}
                            onClick={() => toggleColumn(v)}
                            title="Toggle whole column"
                            className="text-center text-[10px] font-semibold uppercase tracking-wider text-ink-muted hover:text-primary"
                          >
                            {VERB_LABEL[v]}
                          </button>
                        ))}
                      </div>

                      {mod.rows.map((row) => (
                        <div
                          key={row.stem}
                          className="grid grid-cols-[minmax(200px,1fr)_repeat(5,58px)] items-center border-b border-border-subtle bg-surface px-4 py-2.5 hover:bg-surface-dim"
                        >
                          <div className="min-w-0 pr-3">
                            <div className="text-[13px] font-medium text-ink">{row.label}</div>
                            <div className="mt-0.5 truncate font-mono text-[11px] text-ink-muted">
                              {row.sub}
                            </div>
                          </div>
                          {VERBS.map((v) => {
                            const key = row.keyByVerb[v];
                            const st = cellState(key, ids, grants);
                            return (
                              <div key={v} className="flex justify-center">
                                <MatrixCell state={st} readOnly={!canManage} onClick={() => toggleCell(key)} />
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              ) : null}
            </>
          )}
        </div>
      </div>

      {/* ── save bar ────────────────────────────────────────── */}
      {dirty && canManage && (
        <div className="fixed inset-x-0 bottom-0 z-40 flex flex-wrap items-center justify-between gap-4 border-t border-border bg-ink px-6 py-2.5 text-white shadow-slab">
          <div className="flex items-center gap-2.5 text-[12.5px]">
            <span className="h-[7px] w-[7px] flex-none rounded-full bg-accent" />
            <span>{dirtyLabel}</span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={discard}
              className="rounded-md border border-white/25 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-white/10"
            >
              Discard
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="rounded-md border border-primary bg-primary px-3.5 py-1.5 text-[13px] font-semibold text-white hover:bg-primary-ink disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      )}

      {/* ── modals ──────────────────────────────────────────── */}
      <NewRoleModal
        open={creating}
        roles={roleList}
        busy={creatingBusy}
        onClose={onCloseCreate}
        onCreate={createRole}
      />
      <RolePickerModal
        open={picker !== null}
        mode={picker}
        currentName={current?.name ?? ""}
        busy={pickerBusy}
        roles={roleList.filter((r) =>
          picker === "apply"
            ? r.id !== selected
            : r.id !== selected && !r.is_system && !r.permissions.includes("*")
        )}
        onClose={() => setPicker(null)}
        onConfirm={picker === "apply" ? applyTo : copyFrom}
      />
      {settingsOpen && current && (
        <RoleSettingsDrawer
          open={settingsOpen}
          role={current}
          canManage={canManage}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            setSettingsOpen(false);
            rolesQ.reload();
          }}
        />
      )}
    </div>
  );
}

// ── left-rail role row ───────────────────────────────────────
function RoleRow({
  role,
  selected,
  checked,
  canManage,
  permCount,
  onSelect,
  onCheck,
  onDelete,
}: {
  role: Role;
  selected: boolean;
  checked: boolean;
  canManage: boolean;
  permCount: string;
  onSelect: () => void;
  onCheck: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={cn(
        "relative flex items-start gap-2.5 border-t border-border-subtle px-3 py-2.5",
        selected ? "bg-primary-soft" : checked ? "bg-surface-dim" : "bg-surface"
      )}
    >
      {selected && (
        <span className="pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-primary" />
      )}
      {canManage && (
        <button
          onClick={onCheck}
          aria-label={checked ? "Uncheck role" : "Check role for bulk edit"}
          className={cn(
            "mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded border",
            checked
              ? "border-primary bg-primary text-white"
              : "border-border-strong bg-surface text-transparent"
          )}
        >
          <Check size={10} />
        </button>
      )}
      <button onClick={onSelect} className="min-w-0 flex-1 text-left">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "truncate text-[13px]",
              selected ? "font-bold text-primary-ink" : "font-medium text-ink"
            )}
          >
            {role.name}
          </span>
          {role.is_system && (
            <Badge tone="accent" size="xs">
              System
            </Badge>
          )}
          {(role.unknown_permissions?.length ?? 0) > 0 && (
            <span
              className="flex-none leading-none"
              title={`${role.unknown_permissions!.length} stored key${role.unknown_permissions!.length === 1 ? "" : "s"} this build does not recognise: ${role.unknown_permissions!.join(", ")}`}
            >
              <AlertTriangle size={11} className="text-warning-text" />
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-ink-muted">
          {role.member_count} member{role.member_count === 1 ? "" : "s"} · {permCount}
        </div>
      </button>
      {canManage && !role.is_system && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label="Delete role"
          className={cn(
            "flex h-5 w-5 flex-none items-center justify-center rounded",
            selected ? "text-ink-muted" : "text-border-strong",
            "hover:bg-err-bg hover:text-err"
          )}
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
}

// ── one matrix cell ──────────────────────────────────────────
function MatrixCell({
  state,
  readOnly,
  onClick,
}: {
  state: "on" | "off" | "partial" | "na";
  readOnly: boolean;
  onClick: () => void;
}) {
  if (state === "na") {
    return (
      <span
        title="Not applicable to this resource"
        className="flex h-[26px] w-[30px] items-center justify-center rounded-md border border-dashed border-border-subtle text-[11px] text-border-strong"
      >
        ·
      </span>
    );
  }
  const base =
    "flex h-[26px] w-[30px] items-center justify-center rounded-md border transition-colors duration-[90ms]";
  if (state === "on") {
    return (
      <button
        onClick={onClick}
        disabled={readOnly}
        title="Granted"
        className={cn(base, "border-primary bg-primary text-white", !readOnly && "cursor-pointer")}
      >
        <Check size={13} />
      </button>
    );
  }
  if (state === "partial") {
    return (
      <button
        onClick={onClick}
        disabled={readOnly}
        title="Mixed across selected roles"
        className={cn(base, "border-accent bg-accent-soft text-accent", !readOnly && "cursor-pointer")}
      >
        <Minus size={12} />
      </button>
    );
  }
  return (
    <button
      onClick={onClick}
      disabled={readOnly}
      title="Not granted"
      className={cn(
        base,
        "border-border bg-surface text-transparent",
        !readOnly && "cursor-pointer hover:border-primary"
      )}
    >
      <Check size={13} />
    </button>
  );
}
