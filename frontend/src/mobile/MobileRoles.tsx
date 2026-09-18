import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { api } from "../api/client";
import type { PermissionDef, Role } from "../types";
import { buildModules, diffGrants, isLockedRole } from "../lib/rolesPermissionModel";

/**
 * Mobile Roles & Permissions — the phone presentation of the desktop
 * `pages/Roles.tsx` editor. One shared logic layer (`lib/rolesPermissionModel`)
 * and the SAME `/api/roles*` endpoints; only the presentation differs: a role
 * LIST, then a per-role detail where each module (resource) is a collapsible
 * card of permission toggles, staged and saved through a sticky action bar.
 * Single-role edit — the desktop's bulk multi-role selection is left off the
 * phone by design.
 */
export function MobileRoles({ onBack }: { onBack: () => void }) {
  const rolesQ = useQuery<{ roles: Role[] }>("/api/roles", () => api.get("/api/roles"));
  const permsQ = useQuery<{ permissions: PermissionDef[] }>("/api/roles/permissions", () =>
    api.get("/api/roles/permissions")
  );
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const roles = rolesQ.data?.roles ?? [];
  const selected = selectedId != null ? roles.find((r) => r.id === selectedId) ?? null : null;

  // A role that vanished under us (deleted elsewhere) drops back to the list.
  useEffect(() => {
    if (selectedId != null && roles.length > 0 && !roles.some((r) => r.id === selectedId)) {
      setSelectedId(null);
    }
  }, [selectedId, roles]);

  if (selected) {
    return (
      <RoleDetail
        role={selected}
        permissions={permsQ.data?.permissions ?? []}
        onBack={() => setSelectedId(null)}
        onSaved={() => rolesQ.reload()}
      />
    );
  }
  return (
    <RoleList
      roles={roles}
      permissions={permsQ.data?.permissions ?? []}
      loading={rolesQ.loading || permsQ.loading}
      onBack={onBack}
      onOpen={setSelectedId}
    />
  );
}

const HDR_BACK: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  background: "none",
  border: "none",
  color: "var(--teal)",
  fontFamily: "inherit",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  padding: 0,
};
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

// ── List view ────────────────────────────────────────────────
function RoleList({
  roles,
  permissions,
  loading,
  onBack,
  onOpen,
}: {
  roles: Role[];
  permissions: PermissionDef[];
  loading: boolean;
  onBack: () => void;
  onOpen: (id: number) => void;
}) {
  const [query, setQuery] = useState("");
  const keyLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of permissions) m.set(p.key, p.label);
    return m;
  }, [permissions]);

  const q = query.trim().toLowerCase();
  const filtered = roles.filter((r) => {
    if (!q) return true;
    if ((r.name + " " + (r.description ?? "")).toLowerCase().includes(q)) return true;
    return r.permissions.some(
      (k) => k.toLowerCase().includes(q) || (keyLabel.get(k) ?? "").toLowerCase().includes(q)
    );
  });
  const groups = [
    { key: "System", rows: filtered.filter((r) => r.is_system) },
    { key: "Custom", rows: filtered.filter((r) => !r.is_system) },
  ].filter((g) => g.rows.length > 0);

  return (
    <div className="hz-m" style={{ position: "fixed", inset: 0, background: "var(--app-bg)", display: "flex", flexDirection: "column" }}>
      <header className="hdr">
        <button onClick={onBack} style={HDR_BACK}>‹ Back</button>
        <div style={{ fontSize: 19, fontWeight: 800, color: "var(--ink)", marginTop: 6 }}>Roles & Permissions</div>
        <div style={{ fontSize: 12, color: "var(--mut)", marginTop: 2 }}>
          Tap a role to view or edit its grants.
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search roles or permission keys"
          style={{
            marginTop: 12,
            width: "100%",
            height: 40,
            border: "1px solid var(--line-card)",
            background: "var(--bg)",
            borderRadius: "var(--r-input)",
            padding: "0 12px",
            fontSize: 13.5,
            fontFamily: "inherit",
            color: "var(--ink)",
            outline: "none",
          }}
        />
      </header>

      <div className="scroll" style={{ padding: "12px 14px 32px" }}>
        {loading && <div style={{ color: "var(--mut)", fontSize: 13, padding: 20, textAlign: "center" }}>Loading…</div>}
        {!loading && groups.length === 0 && (
          <div style={{ color: "var(--mut)", fontSize: 13, padding: 24, textAlign: "center" }}>No roles match.</div>
        )}
        {groups.map((g) => (
          <div key={g.key} style={{ marginBottom: 18 }}>
            <div className="ey" style={{ color: "var(--gold)", padding: "0 2px 8px" }}>{g.key}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {g.rows.map((r) => (
                <button
                  key={r.id}
                  className="card"
                  onClick={() => onOpen(r.id)}
                  style={{ textAlign: "left", cursor: "pointer", fontFamily: "inherit", padding: "13px 14px", border: "1px solid var(--line-card)" }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 14.5, fontWeight: 700, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.name}
                    </span>
                    {r.is_system && (
                      <span style={{ flex: "none", fontSize: 9, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--gold)", background: "#f3ece0", borderRadius: 999, padding: "2px 6px" }}>
                        System
                      </span>
                    )}
                    <span style={{ flex: "none", color: "var(--mut2)", fontSize: 18 }}>›</span>
                  </div>
                  {r.description && (
                    <div style={{ fontSize: 12, color: "var(--ink2)", marginTop: 3 }}>{r.description}</div>
                  )}
                  <div className="tnum" style={{ fontSize: 11.5, color: "var(--mut)", marginTop: 6 }}>
                    {r.member_count} member{r.member_count === 1 ? "" : "s"} ·{" "}
                    {r.permissions.includes("*")
                      ? "All permissions"
                      : `${r.permissions.length} permission${r.permissions.length === 1 ? "" : "s"}`}
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Detail view ──────────────────────────────────────────────
function RoleDetail({
  role,
  permissions,
  onBack,
  onSaved,
}: {
  role: Role;
  permissions: PermissionDef[];
  onBack: () => void;
  onSaved: () => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const canManage = can("roles.manage");
  const locked = isLockedRole(role);
  const readOnly = !canManage || locked;

  const modules = useMemo(() => buildModules(permissions), [permissions]);
  const defByKey = useMemo(() => {
    const m = new Map<string, PermissionDef>();
    for (const p of permissions) m.set(p.key, p);
    return m;
  }, [permissions]);

  const baseline = useMemo(() => new Set(role.permissions), [role.permissions]);
  const [staged, setStaged] = useState<Set<string>>(() => new Set(role.permissions));
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  // Re-seed when the selected role changes (id is stable across data reloads, so
  // a save+reload does not clobber the edits we just persisted).
  useEffect(() => {
    setStaged(new Set(role.permissions));
    setOpen({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role.id]);

  const dirty = useMemo(
    () => diffGrants({ [role.id]: staged }, { [role.id]: baseline }),
    [staged, baseline, role.id]
  );

  function toggle(key: string) {
    if (readOnly) return;
    setStaged((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function setModule(keys: string[], on: boolean) {
    if (readOnly) return;
    setStaged((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  }

  async function save() {
    if (dirty.total === 0) return;
    setBusy(true);
    try {
      await api.patch(`/api/roles/${role.id}`, { permissions: Array.from(staged) });
      toast.success("Permissions saved.");
      onSaved();
    } catch (e) {
      toast.error((e instanceof Error && e.message) || "Save failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="hz-m" style={{ position: "fixed", inset: 0, background: "var(--app-bg)", display: "flex", flexDirection: "column" }}>
      <header className="hdr">
        <button onClick={onBack} style={HDR_BACK}>‹ Roles</button>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
          <span style={{ fontSize: 19, fontWeight: 800, color: "var(--ink)" }}>{role.name}</span>
          {role.is_system && (
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--gold)", background: "#f3ece0", borderRadius: 999, padding: "2px 6px" }}>
              System
            </span>
          )}
        </div>
        {role.description && (
          <div style={{ fontSize: 12, color: "var(--mut)", marginTop: 3 }}>{role.description}</div>
        )}
      </header>

      <div className="scroll" style={{ padding: "12px 14px", paddingBottom: dirty.total > 0 ? 96 : 32 }}>
        {(role.unknown_permissions?.length ?? 0) > 0 && (
          <div className="card" style={{ padding: 12, marginBottom: 10, border: "1px solid var(--amber)", background: "var(--amber-bg)" }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--amber)" }}>
              {role.unknown_permissions!.length} stored key
              {role.unknown_permissions!.length === 1 ? "" : "s"} this build does not recognise
            </div>
            <div style={{ fontSize: 11.5, color: "var(--ink2)", marginTop: 4, lineHeight: 1.4 }}>
              They grant nothing. Clear them from the desktop editor.
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {role.unknown_permissions!.map((k) => (
                <span
                  key={k}
                  style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--ink2)", background: "#fff", border: "1px solid var(--line)", borderRadius: 999, padding: "2px 8px" }}
                >
                  {k}
                </span>
              ))}
            </div>
          </div>
        )}
        {locked ? (
          <div className="card" style={{ padding: 18, textAlign: "center", border: "1px solid var(--line-card)" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--ink)" }}>All permissions</div>
            <div style={{ fontSize: 12.5, color: "var(--mut)", marginTop: 6, lineHeight: 1.5 }}>
              System roles hold every grant in every module and cannot be edited.
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {modules.map((mod) => {
              const on = mod.keys.filter((k) => staged.has(k)).length;
              const total = mod.keys.length;
              const isOpen = !!open[mod.id];
              const full = total > 0 && on === total;
              return (
                <div key={mod.id} className="card" style={{ overflow: "hidden", border: "1px solid var(--line-card)" }}>
                  <button
                    onClick={() => setOpen((p) => ({ ...p, [mod.id]: !p[mod.id] }))}
                    style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "13px 14px", background: "none", border: "none", fontFamily: "inherit", textAlign: "left", cursor: "pointer" }}
                  >
                    <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 700, color: "var(--ink)" }}>{mod.label}</span>
                    <span
                      className="tnum"
                      style={{
                        flex: "none",
                        fontSize: 10.5,
                        fontWeight: 700,
                        borderRadius: 999,
                        padding: "2px 7px",
                        color: on === 0 ? "var(--mut)" : full ? "var(--green)" : "var(--gold)",
                        background: on === 0 ? "var(--bg)" : full ? "var(--green-bg)" : "#f3ece0",
                      }}
                    >
                      {on === 0 ? "—" : `${on}/${total}`}
                    </span>
                    <span style={{ flex: "none", color: "var(--mut2)", fontSize: 13, transform: isOpen ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 120ms" }}>▾</span>
                  </button>
                  {isOpen && (
                    <div style={{ borderTop: "1px solid var(--line2)" }}>
                      {mod.keys.map((key) => {
                        const def = defByKey.get(key);
                        const checked = staged.has(key);
                        return (
                          <label
                            key={key}
                            style={{ display: "flex", gap: 11, alignItems: "flex-start", padding: "11px 14px", borderTop: "1px solid var(--line2)", cursor: readOnly ? "default" : "pointer" }}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={readOnly}
                              onChange={() => toggle(key)}
                              style={{ width: 20, height: 20, marginTop: 1, flex: "none", accentColor: "var(--brand)" }}
                            />
                            <span style={{ minWidth: 0, flex: 1 }}>
                              <span style={{ display: "block", fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>
                                {def?.label ?? key}
                              </span>
                              {def?.description && (
                                <span style={{ display: "block", fontSize: 11.5, color: "var(--mut)", marginTop: 2, lineHeight: 1.4 }}>
                                  {def.description}
                                </span>
                              )}
                              <span style={{ display: "block", fontFamily: MONO, fontSize: 10.5, color: "var(--mut2)", marginTop: 3 }}>
                                {key}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                      {!readOnly && (
                        <div style={{ display: "flex", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--line2)" }}>
                          <button onClick={() => setModule(mod.keys, true)} style={miniBtn}>Grant all</button>
                          <button onClick={() => setModule(mod.keys, false)} style={miniBtn}>Clear all</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {dirty.total > 0 && !readOnly && (
        <div className="actbar" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={() => setStaged(new Set(role.permissions))}
            style={{ flex: "none", height: 48, padding: "0 16px", border: "1px solid var(--line-card)", background: "#fff", borderRadius: "var(--r-btn)", fontFamily: "inherit", fontSize: 14, fontWeight: 700, color: "var(--ink2)", cursor: "pointer" }}
          >
            Discard
          </button>
          <button className="btn" disabled={busy} onClick={save} style={{ flex: 1, width: "auto" }}>
            {busy ? "Saving…" : `Save ${dirty.total} change${dirty.total === 1 ? "" : "s"}`}
          </button>
        </div>
      )}
    </div>
  );
}

const miniBtn: React.CSSProperties = {
  flex: 1,
  height: 34,
  border: "1px solid var(--line-card)",
  background: "var(--bg)",
  borderRadius: 9,
  fontFamily: "inherit",
  fontSize: 12.5,
  fontWeight: 600,
  color: "var(--ink2)",
  cursor: "pointer",
};
