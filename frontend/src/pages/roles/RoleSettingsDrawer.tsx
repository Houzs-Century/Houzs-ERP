import { useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { Panel, PanelSection } from "../../components/Panel";
import { Skeleton } from "../../components/Skeleton";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { api } from "../../api/client";
import { DORMANT_TAG, DORMANT_TITLE } from "../../auth/dormantPages";
import { cn } from "../../lib/utils";
import type { AccessLevel, PageDef, Role, RolePageAccess } from "../../types";

/**
 * "Role settings" drawer — the leftovers of the old role editor that the new
 * inline permission matrix does NOT cover: name/description, the PIC scope flag,
 * and the per-page access matrix (what a role can SEE, distinct from the flat
 * permission keys it can DO). Opened from the panel's ... menu so the rebuild
 * doesn't regress those capabilities. Permission GRANTS are edited on the main
 * matrix, not here.
 */
export function RoleSettingsDrawer({
  open,
  role,
  canManage,
  onClose,
  onSaved,
}: {
  open: boolean;
  role: Role;
  canManage: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const isSystem = !!role.is_system;
  const isWildcard = role.permissions.includes("*");
  const readOnly = !canManage || isSystem;

  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description || "");
  const [scopeToPic, setScopeToPic] = useState<boolean>(!!role.scope_to_pic);
  const [busy, setBusy] = useState(false);

  const pagesQ = useQuery<{ pages: PageDef[] }>("/api/roles/pages", () =>
    api.get("/api/roles/pages")
  );
  const accessQ = useQuery<{
    role_id: number;
    page_access: Record<string, RolePageAccess>;
  }>(
    `/api/roles/${role.id}/page-access`,
    () => api.get(`/api/roles/${role.id}/page-access`),
    [role.id]
  );

  const [pageLevels, setPageLevels] = useState<Record<string, AccessLevel>>({});
  const [pageDirty, setPageDirty] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!accessQ.data) return;
    const initial: Record<string, AccessLevel> = {};
    for (const [k, v] of Object.entries(accessQ.data.page_access)) initial[k] = v.level;
    setPageLevels(initial);
    setPageDirty(new Set());
  }, [accessQ.data]);

  function changeLevel(pageKey: string, level: AccessLevel) {
    if (readOnly) return;
    setPageLevels((prev) => ({ ...prev, [pageKey]: level }));
    setPageDirty((prev) => new Set(prev).add(pageKey));
  }

  const identityDirty =
    name.trim() !== role.name ||
    (description.trim() || "") !== (role.description || "") ||
    scopeToPic !== !!role.scope_to_pic;

  async function save() {
    if (readOnly && pageDirty.size === 0) {
      onClose();
      return;
    }
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    setBusy(true);
    try {
      if (!readOnly && identityDirty) {
        await api.patch(`/api/roles/${role.id}`, {
          // Name is locked for system roles; only send what the backend accepts.
          ...(isSystem ? {} : { name: name.trim(), scope_to_pic: scopeToPic }),
          description: description.trim() || null,
        });
      }
      if (pageDirty.size > 0) {
        const entries = Array.from(pageDirty).map((k) => ({
          page_key: k,
          level: pageLevels[k],
        }));
        await api.patch(`/api/roles/${role.id}/page-access`, { entries });
      }
      toast.success(`Updated ${name.trim()}`);
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Save failed");
    } finally {
      setBusy(false);
    }
  }

  const dirty = (!readOnly && identityDirty) || pageDirty.size > 0;

  return (
    <Panel
      open={open}
      onClose={onClose}
      title={role.name}
      subtitle={isSystem ? "System role · settings are read-only" : "Role settings"}
      width={520}
      dirty={dirty}
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
            disabled={!canManage}
            placeholder="What this role is for"
            className="min-h-[60px] w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:bg-bg disabled:text-ink-muted"
          />
        </div>
        {!isSystem && (
          <label className="flex items-start gap-2 rounded-md border border-border bg-bg/40 p-2.5">
            <input
              type="checkbox"
              checked={scopeToPic}
              disabled={readOnly}
              onChange={(e) => setScopeToPic(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 accent-primary"
            />
            <div className="min-w-0">
              <div className="text-[11.5px] font-semibold text-ink">
                Scope to PIC's projects
              </div>
              <div className="mt-0.5 text-[10.5px] leading-snug text-ink-muted">
                Users with this role only see projects where they or their manager
                is the PIC. Finance, logistics, linked trips and payment stay hidden.
              </div>
            </div>
          </label>
        )}
      </PanelSection>

      {!isWildcard && (
        <PanelSection title="Page access">
          <p className="text-[11px] text-ink-secondary">
            Per-page gate (what this role can reach). Pages with sub-tabs can be
            configured per-tab when the parent is set to <strong>Partial</strong>.
            Full or None overrides every sub-tab. Wildcard roles bypass this matrix.
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
                                dirty={!childrenLocked && pageDirty.has(child.key)}
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

      <div className="sticky bottom-0 -mx-6 mt-4 flex justify-end gap-2 border-t border-border bg-surface px-6 py-3">
        <Button variant="ghost" onClick={onClose}>
          {dirty ? "Cancel" : "Close"}
        </Button>
        {(canManage || pageDirty.size > 0) && (
          <Button variant="primary" onClick={save} disabled={busy || !dirty}>
            {busy ? "Saving…" : "Save changes"}
          </Button>
        )}
      </div>
    </Panel>
  );
}

// One page entry in the access matrix — parent or indented child.
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
  // Nothing reads a dormant page key, so the control is disabled but the row is
  // KEPT (owner: "最重要是我要它的 UI") — identical treatment to the old editor.
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
          <div
            className={cn(
              "mt-0.5 font-mono text-ink-muted",
              dense ? "text-[9px]" : "text-[9.5px]"
            )}
          >
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
                className="h-3.5 w-3.5 accent-primary"
              />
              <span className="capitalize">{opt}</span>
            </label>
          );
        })}
      </div>
      {page.supportsPartial && !inherited && (
        <p className="mt-1.5 text-[10.5px] text-ink-muted">Partial: {page.partialMeaning}</p>
      )}
      {children}
    </div>
  );
}
