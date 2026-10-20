import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { api } from "../../api/client";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { useAuth } from "../../auth/AuthContext";
import { cn } from "../../lib/utils";
import { Button } from "../../components/Button";
import { Badge } from "../../components/Badge";
import { EmptyState } from "../../components/EmptyState";
import { ListSkeleton } from "../../components/Skeleton";
import type { Role, PermissionDef } from "../../types";
import { isLockedRole } from "../../lib/rolesPermissionModel";
import {
  MATRIX_LEVELS,
  MATRIX_LEVEL_LABEL,
  MATRIX_LEVEL_LABEL_EN,
  buildMatrixModules,
  normalizeStoredLevel,
  applyLevelToPages,
  applyLevelToPerms,
  reconcileScmAccess,
  moduleLevel,
  pageRowsToSend,
  permsDiffer,
  pageLevelsDiffCount,
  type PageLite,
  type MatrixLevel,
  type MatrixModule,
} from "../../lib/roleMatrixModel";

/* The "矩阵" section of Roles & Permissions (RBAC rebuild, Option A — PR2). One
 * control per module — 无/看/改/批 — over what a role may SEE (role_page_access)
 * and, for the modules a level can safely drive, what it may DO. Expand a module
 * to set a single sub-page finer. Page access is written through
 * PATCH /api/roles/:id/page-access; the function keys a level touches ride the
 * existing PATCH /api/roles/:id {permissions}. Approval / money / fine SCM keys
 * are never flipped here (roleMatrixModel.isNeverByLevel) — those stay on the
 * Roles tab with their explicit-grant semantics. */

type PageAccessPayload = {
  pages: PageLite[];
  roles: Array<{ role_id: number; has_rows: boolean; levels: Record<string, string> }>;
};

type PageLevels = Record<string, MatrixLevel>;

function seedPageLevels(pages: PageLite[], stored: Record<string, string> | undefined): PageLevels {
  const out: PageLevels = {};
  for (const p of pages) out[p.key] = normalizeStoredLevel(stored?.[p.key]);
  return out;
}

export function RoleMatrixTab() {
  const { can } = useAuth();
  const toast = useToast();
  const canManage = can("roles.manage");

  const rolesQ = useQuery<{ roles: Role[] }>("/api/roles", () => api.get("/api/roles"));
  const permsQ = useQuery<{ permissions: PermissionDef[] }>("/api/roles/permissions", () =>
    api.get("/api/roles/permissions"),
  );
  const pageQ = useQuery<PageAccessPayload>("/api/roles/page-access", () =>
    api.get("/api/roles/page-access"),
  );

  const roleList = rolesQ.data?.roles ?? [];
  const pages = pageQ.data?.pages ?? [];
  const modules = useMemo(
    () => buildMatrixModules(pages, permsQ.data?.permissions ?? []),
    [pages, permsQ.data],
  );
  const hasRowsById = useMemo(() => {
    const m = new Map<number, boolean>();
    for (const r of pageQ.data?.roles ?? []) m.set(r.role_id, r.has_rows);
    return m;
  }, [pageQ.data]);

  const [selected, setSelected] = useState<number | null>(null);
  // Staged is an OVERLAY — only roles the owner has actually touched. Reads fall
  // back to the baseline, so the matrix is correct from the first render.
  const [pageStaged, setPageStaged] = useState<Map<number, PageLevels>>(new Map());
  const [permStaged, setPermStaged] = useState<Map<number, Set<string>>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  // Baselines are DERIVED from the server data (not seeded via an effect), so
  // they are populated in the very render the modules first appear — there is no
  // window where the matrix shows but the baseline is empty, which previously
  // made an early click register nothing (dirtyIds skipped a role with no base).
  const pageBase = useMemo(() => {
    const m = new Map<number, PageLevels>();
    const pa = pageQ.data;
    if (!pa) return m;
    const levelsByRole = new Map(pa.roles.map((r) => [r.role_id, r.levels]));
    for (const r of rolesQ.data?.roles ?? []) m.set(r.id, seedPageLevels(pa.pages, levelsByRole.get(r.id)));
    return m;
  }, [rolesQ.data, pageQ.data]);
  const permBase = useMemo(() => {
    const m = new Map<number, Set<string>>();
    for (const r of rolesQ.data?.roles ?? []) m.set(r.id, new Set(r.permissions));
    return m;
  }, [rolesQ.data]);

  const pagesFor = (id: number): PageLevels => pageStaged.get(id) ?? pageBase.get(id) ?? {};
  const permsFor = (id: number): Set<string> => permStaged.get(id) ?? permBase.get(id) ?? new Set<string>();

  // Resolve the selected role deterministically: the explicit pick, else the
  // first role. Deriving it (rather than setting it from an effect) means there
  // is no render where the matrix is shown with no role selected — a click in
  // that window would otherwise no-op against a null id.
  const selectedId = selected ?? roleList.at(0)?.id ?? null;
  const role = selectedId != null ? roleList.find((r) => r.id === selectedId) ?? null : null;
  const locked = role ? isLockedRole(role) : false;
  const readOnly = !canManage || locked;

  const dirtyIds = useMemo(() => {
    const out: number[] = [];
    for (const r of roleList) {
      const pb = pageBase.get(r.id) ?? {};
      const mb = permBase.get(r.id) ?? new Set<string>();
      const ps = pageStaged.get(r.id) ?? pb;
      const ms = permStaged.get(r.id) ?? mb;
      if (pageLevelsDiffCount(pages, ps, pb) > 0 || permsDiffer(ms, mb)) out.push(r.id);
    }
    return out;
  }, [roleList, pageStaged, permStaged, pageBase, permBase, pages]);

  function updateRole(
    id: number,
    nextPages: PageLevels,
    nextPerms: Set<string>,
  ) {
    setPageStaged((m) => new Map(m).set(id, nextPages));
    setPermStaged((m) => new Map(m).set(id, nextPerms));
  }

  function setModule(m: MatrixModule, level: MatrixLevel) {
    if (readOnly || selectedId == null) return;
    const nextPages = applyLevelToPages(pagesFor(selectedId), m, level);
    let nextPerms = applyLevelToPerms(permsFor(selectedId), m, level);
    if (m.scmArea) nextPerms = reconcileScmAccess(nextPerms, nextPages);
    updateRole(selectedId, nextPages, nextPerms);
  }

  function setSubPage(pageKey: string, level: MatrixLevel) {
    if (readOnly || selectedId == null) return;
    const nextPages = { ...pagesFor(selectedId), [pageKey]: level };
    let nextPerms = permsFor(selectedId);
    if (pageKey.startsWith("scm.")) nextPerms = reconcileScmAccess(nextPerms, nextPages);
    updateRole(selectedId, nextPages, nextPerms);
  }

  function discard() {
    if (selectedId == null) return;
    setPageStaged((m) => {
      const n = new Map(m);
      n.delete(selectedId);
      return n;
    });
    setPermStaged((m) => {
      const n = new Map(m);
      n.delete(selectedId);
      return n;
    });
    toast.info("Changes discarded.");
  }

  async function save() {
    if (dirtyIds.length === 0) return;
    setSaving(true);
    try {
      for (const id of dirtyIds) {
        const ps = pagesFor(id);
        const pb = pageBase.get(id) ?? {};
        if (pageLevelsDiffCount(pages, ps, pb) > 0) {
          await api.patch(`/api/roles/${id}/page-access`, { entries: pageRowsToSend(pages, ps) });
        }
        const ms = permsFor(id);
        const mb = permBase.get(id) ?? new Set<string>();
        if (permsDiffer(ms, mb)) {
          await api.patch(`/api/roles/${id}`, { permissions: [...ms] });
        }
      }
      toast.success("Page access saved. Members see it on their next request.");
      // Drop the overlay so the reloaded server data becomes the new baseline.
      setPageStaged(new Map());
      setPermStaged(new Map());
      rolesQ.reload();
      pageQ.reload();
    } catch (e) {
      toast.error((e instanceof Error && e.message) || "Save failed. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (rolesQ.loading || permsQ.loading || pageQ.loading) return <ListSkeleton rows={6} />;
  if (pageQ.error || !pageQ.data?.pages)
    return (
      <EmptyState
        message="The page-access API isn't served by this backend yet"
        description="The matrix needs GET /api/roles/page-access from the same release — it appears once this branch's backend is deployed."
      />
    );
  if (rolesQ.error) return <div className="text-[12px] text-err">Couldn't load the roles.</div>;

  const curPages = selectedId != null ? pagesFor(selectedId) : {};
  const curPerms = selectedId != null ? permsFor(selectedId) : new Set<string>();
  const hasRows = selectedId != null ? hasRowsById.get(selectedId) ?? false : false;

  const systemRoles = roleList.filter((r) => r.is_system);
  const customRoles = roleList.filter((r) => !r.is_system);

  return (
    <div className={cn("relative", dirtyIds.length > 0 && "pb-20")}>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[12px] text-ink-secondary">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Role</span>
          <select
            value={selectedId ?? ""}
            onChange={(e) => setSelected(Number(e.target.value))}
            className="h-8 rounded-md border border-border bg-surface px-2 text-[13px] text-ink"
          >
            <optgroup label="System">
              {systemRoles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Custom roles">
              {customRoles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        {role && <Badge tone={role.is_system ? "accent" : "neutral"}>{role.member_count} members</Badge>}
      </div>

      {locked ? (
        <div className="rounded-lg border border-border bg-surface p-4 shadow-stone">
          <div className="text-[13px] font-semibold text-ink">All pages</div>
          <p className="mb-0 mt-1 text-[12.5px] text-ink-secondary">
            System roles (and any role holding the <span className="font-mono">*</span> wildcard) see
            every page and cannot have their access narrowed here. Duplicate one to get an editable copy.
          </p>
        </div>
      ) : (
        <>
          {!hasRows && (
            <div className="mb-3 flex items-start gap-3 rounded-lg border border-warning-text/30 bg-warning-bg p-3">
              <Badge tone="warning">Not configured</Badge>
              <p className="mb-0 text-[12px] leading-relaxed text-ink-secondary">
                This role has no saved page access yet — its members still see pages by the old
                position rule. Set the levels below and save once to make the role the source of truth.
              </p>
            </div>
          )}

          <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
            <div className="grid grid-cols-[1fr_auto] items-center gap-2 border-b border-border bg-surface-2 px-4 py-2">
              <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Module</span>
              <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">无 / 看 / 改 / 批</span>
            </div>

            {modules.map((m) => {
              const lv = moduleLevel(m, curPages, curPerms);
              const open = expanded.has(m.id);
              const expandable = m.pages.length > 1;
              return (
                <div key={m.id} className="border-b border-border-subtle last:border-b-0">
                  <div className="grid grid-cols-[1fr_auto] items-center gap-2 px-4 py-2.5">
                    <button
                      type="button"
                      disabled={!expandable}
                      onClick={() =>
                        setExpanded((s) => {
                          const n = new Set(s);
                          n.has(m.id) ? n.delete(m.id) : n.add(m.id);
                          return n;
                        })
                      }
                      className={cn("flex items-center gap-1.5 text-left", expandable && "hover:text-primary")}
                    >
                      {expandable ? (
                        <ChevronRight
                          size={14}
                          className={cn("flex-none text-ink-muted transition-transform", open && "rotate-90")}
                        />
                      ) : (
                        <span className="w-[14px] flex-none" />
                      )}
                      <span>
                        <span className="text-[13px] font-semibold text-ink">{m.labelZh}</span>
                        <span className="ml-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
                          {m.labelEn}
                        </span>
                      </span>
                    </button>
                    <LevelPicker
                      value={lv}
                      disabled={readOnly}
                      onChange={(next) => setModule(m, next)}
                    />
                  </div>

                  {open && expandable && (
                    <div className="border-t border-border-subtle bg-surface-2/40">
                      {m.pages
                        .filter((p) => p.key !== m.topPageKey)
                        .map((p) => (
                          <div
                            key={p.key}
                            className="grid grid-cols-[1fr_auto] items-center gap-2 px-4 py-2 pl-10"
                          >
                            <span>
                              <span
                                className={cn(
                                  "text-[12.5px]",
                                  p.dormant ? "text-ink-muted line-through" : "text-ink-secondary",
                                )}
                              >
                                {p.label}
                              </span>
                              {p.dormant && (
                                <span className="ml-2 font-mono text-[9px] uppercase tracking-wider text-ink-muted">
                                  dormant · not wired
                                </span>
                              )}
                              <span className="ml-2 font-mono text-[9.5px] text-ink-muted">{p.key}</span>
                            </span>
                            <LevelPicker
                              value={curPages[p.key] ?? "none"}
                              disabled={readOnly || !!p.dormant}
                              onChange={(next) => setSubPage(p.key, next)}
                            />
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-3 flex items-start gap-3 rounded-lg border border-border bg-surface p-3 shadow-stone">
            <Badge tone="accent">How it works</Badge>
            <p className="mb-0 text-[12px] leading-relaxed text-ink-secondary">
              无 hides the page (nav + direct URL). 看 / 改 / 批 open it at that level. A module's level
              also grants its ordinary function keys; cancellation, amendment-approval and money keys
              stay on the Roles tab and are never changed here. Supply Chain areas control page
              visibility and the Supply Chain access switch.
            </p>
          </div>
        </>
      )}

      {dirtyIds.length > 0 && !readOnly && (
        <div className="fixed bottom-0 left-0 right-0 z-20 flex items-center gap-3 border-t border-border bg-surface px-5 py-3 shadow-stone">
          <span className="text-[12.5px] text-ink-secondary">
            Unsaved changes on {dirtyIds.length} role{dirtyIds.length === 1 ? "" : "s"}
          </span>
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={discard} disabled={saving}>
              Discard
            </Button>
            <Button variant="brass" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function LevelPicker({
  value,
  disabled,
  onChange,
}: {
  value: MatrixLevel | "mixed";
  disabled: boolean;
  onChange: (level: MatrixLevel) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {value === "mixed" && (
        <span className="mr-1 font-mono text-[10px] uppercase tracking-wider text-ink-muted">混</span>
      )}
      {MATRIX_LEVELS.map((lv) => {
        const active = value === lv;
        return (
          <button
            key={lv}
            type="button"
            disabled={disabled}
            onClick={() => onChange(lv)}
            title={MATRIX_LEVEL_LABEL_EN[lv]}
            className={cn(
              "h-6 w-7 rounded text-[12.5px] transition-colors",
              active
                ? "bg-primary font-semibold text-white"
                : "text-ink-muted hover:bg-surface-2",
              disabled && "cursor-default opacity-60 hover:bg-transparent",
            )}
          >
            {MATRIX_LEVEL_LABEL[lv]}
          </button>
        );
      })}
    </div>
  );
}
