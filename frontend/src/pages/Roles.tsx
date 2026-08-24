import { useEffect, useMemo, useState } from "react";
import { Trash2, Lock, Shield } from "lucide-react";
import { Button } from "../components/Button";
import { Panel, PanelSection } from "../components/Panel";
import { Skeleton } from "../components/Skeleton";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { DORMANT_TAG, DORMANT_TITLE } from "../auth/dormantPages";
import { cn } from "../lib/utils";
import type {
  AccessLevel,
  PageDef,
  Role,
  PermissionDef,
  RolePageAccess,
} from "../types";

/**
 * Roles grid + editor panel, extracted for embedding inside the unified
 * Team page. The parent owns the "New Role" button (in the PageHeader
 * actions) and passes `creating` + `onCloseCreate` down so the editor
 * panel can open/close in response.
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

  const [editing, setEditing] = useState<Role | null>(null);

  const rolesQ = useQuery<{ roles: Role[] }>("/api/roles", () => api.get("/api/roles"));
  const permsQ = useQuery<{ permissions: PermissionDef[] }>("/api/roles/permissions", () =>
    api.get("/api/roles/permissions")
  );

  function reload() {
    rolesQ.reload();
  }

  async function deleteRole(r: Role) {
    if (
      !await dialog.confirm(
        `Delete role "${r.name}"?\n\nThis cannot be undone. Reassign any members holding this role first.`
      )
    )
      return;
    try {
      await api.del(`/api/roles/${r.id}`);
      toast.success(`Deleted ${r.name}`);
      reload();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  const editorOpen = editing !== null || creating;
  function closeEditor() {
    setEditing(null);
    onCloseCreate();
  }

  return (
    <div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {rolesQ.loading && (
          <>
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-32 w-full rounded-lg" />
            ))}
          </>
        )}
        {rolesQ.data?.roles.map((r) => (
          <div
            key={r.id}
            className="group relative overflow-hidden rounded-lg border border-border bg-surface p-5 shadow-stone transition-all duration-200 hover:-translate-y-px hover:shadow-slab"
          >
            <span className="pointer-events-none absolute left-0 top-0 h-px w-full bg-gradient-to-r from-transparent via-accent/40 to-transparent transition-opacity duration-300 group-hover:via-accent" />

            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Shield size={14} className="text-accent" />
                  <h3 className="font-display text-[15px] font-bold leading-tight tracking-tight text-ink">
                    {r.name}
                  </h3>
                  {r.is_system && (
                    <span
                      className="inline-flex items-center gap-1 rounded bg-bg px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-ink-muted"
                      title="System role — cannot be edited or deleted"
                    >
                      <Lock size={9} />
                      System
                    </span>
                  )}
                </div>
                {r.description && (
                  <p className="mt-1 text-[12px] text-ink-secondary">{r.description}</p>
                )}
                <div className="mt-3 flex items-center gap-3 text-[11px] text-ink-muted">
                  <span>
                    <span className="font-mono text-ink">{r.member_count}</span> member
                    {r.member_count === 1 ? "" : "s"}
                  </span>
                  <span>·</span>
                  <span>
                    <span className="font-mono text-ink">
                      {r.permissions.includes("*") ? "All" : r.permissions.length}
                    </span>{" "}
                    permission{r.permissions.length === 1 ? "" : "s"}
                  </span>
                </div>
                {/* A stored key this build does not declare is DROPPED at
                    session hydration and grants nothing. Without this line the
                    role reads as clean and nobody can tell. */}
                {r.unknown_permissions && r.unknown_permissions.length > 0 && (
                  <p
                    className="mt-2 text-[11px] text-warning-text"
                    title={r.unknown_permissions.join(", ")}
                  >
                    {r.unknown_permissions.length} stored key
                    {r.unknown_permissions.length === 1 ? "" : "s"} this build does not
                    recognise, so {r.unknown_permissions.length === 1 ? "it grants" : "they grant"}{" "}
                    nothing: {r.unknown_permissions.join(", ")}
                  </p>
                )}
              </div>
              {canManage && !r.is_system && (
                <button
                  onClick={() => deleteRole(r)}
                  className="rounded p-1.5 text-ink-muted opacity-0 transition-all hover:bg-err/10 hover:text-err group-hover:opacity-100"
                  aria-label="Delete role"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>

            <div className="mt-4 border-t border-border-subtle pt-3">
              <button
                onClick={() => setEditing(r)}
                className="text-[11px] font-semibold uppercase tracking-wider text-accent hover:underline"
              >
                {canManage && !r.is_system ? "Edit permissions →" : "View permissions →"}
              </button>
            </div>
          </div>
        ))}
      </div>

      {editorOpen && (
        <RoleEditorPanel
          open={true}
          onClose={closeEditor}
          role={editing}
          permissions={permsQ.data?.permissions ?? []}
          onSaved={() => {
            closeEditor();
            reload();
          }}
          canManage={canManage}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Role editor panel (create + edit)
// ──────────────────────────────────────────────────────────
function RoleEditorPanel({
  open,
  onClose,
  role,
  permissions,
  onSaved,
  canManage,
}: {
  open: boolean;
  onClose: () => void;
  role: Role | null;
  permissions: PermissionDef[];
  onSaved: () => void;
  canManage: boolean;
}) {
  const toast = useToast();
  const isCreate = role === null;
  const isSystem = !!role?.is_system;
  const readOnly = !canManage || isSystem;

  const [name, setName] = useState(role?.name || "");
  const [description, setDescription] = useState(role?.description || "");
  const [selected, setSelected] = useState<Set<string>>(
    new Set(role?.permissions || [])
  );
  const [scopeToPic, setScopeToPic] = useState<boolean>(!!role?.scope_to_pic);
  const [busy, setBusy] = useState(false);

  // ── Page Access (mig 073) ─────────────────────────────────────
  // Only fetched/edited when we're editing an existing role.
  const pagesQ = useQuery<{ pages: PageDef[] }>("/api/roles/pages", () => api.get("/api/roles/pages"));
  const accessQ = useQuery<{
    role_id: number;
    page_access: Record<string, RolePageAccess>;
  }>("/api/roles/:/page-access",
    () =>
      role?.id
        ? api.get(`/api/roles/${role.id}/page-access`)
        : Promise.resolve({ role_id: 0, page_access: {} }),
    [role?.id]
  );
  const [pageLevels, setPageLevels] = useState<Record<string, AccessLevel>>({});
  const [pageDirty, setPageDirty] = useState<Set<string>>(new Set());

  // Reset local edits whenever the fetched access map changes.
  useEffect(() => {
    if (!accessQ.data) return;
    const initial: Record<string, AccessLevel> = {};
    for (const [k, v] of Object.entries(accessQ.data.page_access)) {
      initial[k] = v.level;
    }
    setPageLevels(initial);
    setPageDirty(new Set());
  }, [accessQ.data]);

  function changeLevel(pageKey: string, level: AccessLevel) {
    if (readOnly) return;
    setPageLevels((prev) => ({ ...prev, [pageKey]: level }));
    setPageDirty((prev) => {
      const next = new Set(prev);
      next.add(pageKey);
      return next;
    });
  }

  const grouped = useMemo(() => {
    const m = new Map<string, PermissionDef[]>();
    for (const p of permissions) {
      if (!m.has(p.resource)) m.set(p.resource, []);
      m.get(p.resource)!.push(p);
    }
    return Array.from(m.entries());
  }, [permissions]);

  function toggle(key: string) {
    if (readOnly) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAll(perms: PermissionDef[]) {
    if (readOnly) return;
    setSelected((prev) => {
      const next = new Set(prev);
      const allOn = perms.every((p) => next.has(p.key));
      if (allOn) {
        for (const p of perms) next.delete(p.key);
      } else {
        for (const p of perms) next.add(p.key);
      }
      return next;
    });
  }

  async function save() {
    if (readOnly) return;
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        permissions: Array.from(selected),
        scope_to_pic: scopeToPic,
      };
      if (isCreate) {
        await api.post("/api/roles", body);
        toast.success(`Created ${body.name}`);
      } else {
        await api.patch(`/api/roles/${role!.id}`, body);
        // Push any page-access edits in the same save click. The
        // backend accepts an empty entries[] as a 400, so guard.
        if (pageDirty.size > 0) {
          const entries = Array.from(pageDirty).map((k) => ({
            page_key: k,
            level: pageLevels[k],
          }));
          await api.patch(`/api/roles/${role!.id}/page-access`, { entries });
        }
        toast.success(`Updated ${body.name}`);
      }
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Save failed");
    } finally {
      setBusy(false);
    }
  }

  const isWildcard = role?.permissions.includes("*");

  return (
    <Panel
      open={open}
      onClose={onClose}
      title={isCreate ? "New Role" : role!.name}
      subtitle={
        isSystem ? "System role · read-only" : isCreate ? "Custom role" : "Custom role"
      }
      width={520}
    >
      <PanelSection title="Identity">
        <div>
          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Name
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={readOnly}
            placeholder="e.g. Operations Lead"
            className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:bg-bg disabled:text-ink-muted"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={readOnly}
            placeholder="What this role is for"
            className="min-h-[60px] w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:bg-bg disabled:text-ink-muted"
          />
        </div>
        <div>
          <label className="flex items-start gap-2 rounded-md border border-border bg-bg/40 p-2.5">
            <input
              type="checkbox"
              checked={scopeToPic}
              disabled={readOnly}
              onChange={(e) => setScopeToPic(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 accent-accent"
            />
            <div className="min-w-0">
              <div className="text-[11.5px] font-semibold text-ink">
                Scope to PIC's projects
              </div>
              <div className="mt-0.5 text-[10.5px] leading-snug text-ink-muted">
                When on, users with this role only see projects where they
                or their manager is the PIC. Finance, logistics, linked
                trips and payment stay hidden. Use this for sales reps
                who should only see their own team's projects.
              </div>
            </div>
          </label>
        </div>
      </PanelSection>

      <PanelSection title="Permissions">
        {isWildcard ? (
          <div className="rounded-md border border-accent/30 bg-accent-soft/40 p-4">
            <div className="flex items-center gap-2 text-[12px] font-semibold text-accent-ink">
              <Shield size={14} />
              Full access
            </div>
            <p className="mt-1 text-[11px] text-ink-secondary">
              This role has the wildcard <code className="font-mono">*</code> permission and
              can access everything in the workspace, including team and role management.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {grouped.map(([resource, perms]) => {
              const allOn = perms.every((p) => selected.has(p.key));
              const someOn = perms.some((p) => selected.has(p.key));
              return (
                <div
                  key={resource}
                  className="rounded-md border border-border bg-surface"
                >
                  <button
                    type="button"
                    onClick={() => toggleAll(perms)}
                    disabled={readOnly}
                    className="flex w-full items-center justify-between border-b border-border-subtle px-3 py-2 text-left transition-colors enabled:hover:bg-surface-dim"
                  >
                    <span className="text-[11px] font-semibold uppercase tracking-brand text-ink">
                      {resource}
                    </span>
                    <span
                      className={cn(
                        "rounded px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-wider",
                        allOn
                          ? "bg-accent-soft text-accent-ink"
                          : someOn
                          ? "bg-warning-bg text-warning-text"
                          : "bg-bg text-ink-muted"
                      )}
                    >
                      {perms.filter((p) => selected.has(p.key)).length}/{perms.length}
                    </span>
                  </button>
                  <div className="divide-y divide-border-subtle">
                    {perms.map((p) => {
                      const on = selected.has(p.key);
                      return (
                        <label
                          key={p.key}
                          className={cn(
                            "flex cursor-pointer items-start gap-3 px-3 py-2.5 transition-colors",
                            !readOnly && "hover:bg-surface-dim",
                            readOnly && "cursor-default"
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={readOnly}
                            onChange={() => toggle(p.key)}
                            className="mt-0.5 h-4 w-4 cursor-pointer accent-accent disabled:cursor-default"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="text-[12px] font-semibold text-ink">{p.label}</div>
                            <div className="mt-0.5 text-[10.5px] text-ink-muted">
                              {p.description}
                            </div>
                            <div className="mt-1 font-mono text-[9.5px] text-ink-muted">
                              {p.key}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </PanelSection>

      {!isCreate && !isWildcard && (
        <PanelSection title="Page access">
          <p className="text-[11px] text-ink-secondary">
            Per-page gate. Pages with sub-tabs (Projects, Team,
            Logistics, ASSR, Orders) can be configured per-tab when
            the parent is set to <strong>Partial</strong> — pick which
            sub-tabs this role can reach. Setting the parent to Full
            or None overrides every sub-tab. Wildcard roles bypass
            this matrix.
          </p>
          {pagesQ.loading || accessQ.loading ? (
            <Skeleton className="h-24 w-full rounded-md" />
          ) : (
            <div className="space-y-2">
              {(pagesQ.data?.pages ?? [])
                .filter((p) => !p.parent)
                .map((parent) => {
                  const parentLevel = pageLevels[parent.key] ?? "none";
                  const children = (pagesQ.data?.pages ?? []).filter(
                    (c) => c.parent === parent.key
                  );
                  // When parent is full or none, children inherit
                  // visually. When parent is partial, each child uses
                  // its own stored value.
                  const childrenLocked =
                    parentLevel === "full" || parentLevel === "none";
                  return (
                    <PageAccessRow
                      key={parent.key}
                      page={parent}
                      level={parentLevel}
                      readOnly={readOnly}
                      dirty={pageDirty.has(parent.key)}
                      onChange={(lvl) => changeLevel(parent.key, lvl)}
                    >
                      {children.length > 0 && (
                        <div className="mt-2 ml-4 space-y-1.5 border-l-2 border-border-subtle pl-3">
                          {children.map((child) => {
                            const effective = childrenLocked
                              ? parentLevel
                              : pageLevels[child.key] ?? "none";
                            return (
                              <PageAccessRow
                                key={child.key}
                                page={child}
                                level={effective}
                                readOnly={readOnly || childrenLocked}
                                dirty={
                                  !childrenLocked && pageDirty.has(child.key)
                                }
                                inherited={
                                  childrenLocked
                                    ? `inherits ${parentLevel} from ${parent.label}`
                                    : null
                                }
                                onChange={(lvl) => changeLevel(child.key, lvl)}
                                dense
                              />
                            );
                          })}
                        </div>
                      )}
                    </PageAccessRow>
                  );
                })}
            </div>
          )}
        </PanelSection>
      )}

      {!readOnly && !isWildcard && (
        <div className="sticky bottom-0 -mx-6 mt-4 flex justify-end gap-2 border-t border-border bg-surface px-6 py-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="brass" onClick={save} disabled={busy}>
            {busy ? "Saving…" : isCreate ? "Create Role" : "Save Changes"}
          </Button>
        </div>
      )}
    </Panel>
  );
}

// ──────────────────────────────────────────────────────────
// PageAccessRow — single page entry in the role editor matrix.
// Used for both parent pages and indented sub-pages.
// ──────────────────────────────────────────────────────────
function PageAccessRow({
  page,
  level,
  readOnly,
  dirty,
  inherited,
  onChange,
  dense,
  children,
}: {
  page: PageDef;
  level: AccessLevel;
  readOnly: boolean;
  dirty: boolean;
  inherited?: string | null;
  onChange: (level: AccessLevel) => void;
  dense?: boolean;
  children?: React.ReactNode;
}) {
  // Nothing in the system reads this key, so the control is disabled rather than
  // removed — the owner wants the row KEPT ("最重要是我要它的 UI"). Identical
  // treatment to Team > Positions (#709), off the identical backend flag: one
  // PAGES catalogue feeds both editors, so these are the same seven keys and a
  // cell that lies there lies here. `dormant` is optional on PageDef, so `===
  // true` keeps "not told" meaning "not dormant" rather than crashing an editor
  // pointed at an endpoint that has not been taught the field.
  const dormant = page.dormant === true;
  return (
    <div
      title={dormant ? DORMANT_TITLE : undefined}
      className={cn(
        "rounded-md border border-border bg-surface",
        dormant && "opacity-60",
        dense ? "p-2" : "p-3"
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              "font-semibold",
              dormant ? "text-ink-muted" : "text-ink",
              dense ? "text-[11.5px]" : "text-[12px]"
            )}
          >
            {page.label}
          </div>
          <div className={cn("mt-0.5 font-mono text-ink-muted", dense ? "text-[9px]" : "text-[9.5px]")}>
            {page.key}
          </div>
        </div>
        {dormant && (
          <span
            title={DORMANT_TITLE}
            className="shrink-0 rounded-full bg-surface-dim px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-ink-muted"
          >
            {DORMANT_TAG}
          </span>
        )}
        {dirty && (
          <span className="rounded bg-warning-bg px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-warning-text">
            unsaved
          </span>
        )}
        {inherited && (
          <span className="rounded bg-bg px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-ink-muted">
            {inherited}
          </span>
        )}
      </div>
      {/* Level radios. Disabled for a dormant page: the level still SHOWS (it
          is the real stored value and must keep reading true — greying must not
          change what anyone resolves to), it just cannot be changed into a
          promise the system will not keep. `readOnly` still wins on its own —
          a system role stays locked whether the key is wired or not. */}
      <div className="mt-2 flex flex-wrap gap-3">
        {(["none", "partial", "full"] as const).map((opt) => {
          if (opt === "partial" && !page.supportsPartial) return null;
          return (
            <label
              key={opt}
              title={dormant ? DORMANT_TITLE : undefined}
              className={cn(
                "flex items-center gap-1.5 text-[11px]",
                dormant
                  ? "cursor-not-allowed text-ink-muted"
                  : readOnly
                    ? "cursor-default opacity-70"
                    : "cursor-pointer"
              )}
            >
              <input
                type="radio"
                name={`pa-${page.key}`}
                value={opt}
                checked={level === opt}
                disabled={readOnly || dormant}
                onChange={() => onChange(opt)}
                className="h-3.5 w-3.5 accent-accent"
              />
              <span className="capitalize">{opt}</span>
            </label>
          );
        })}
      </div>
      {page.supportsPartial && !inherited && (
        <p className="mt-1.5 text-[10.5px] text-ink-muted">
          Partial: {page.partialMeaning}
        </p>
      )}
      {children}
    </div>
  );
}
