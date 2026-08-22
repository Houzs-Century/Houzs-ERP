import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Pencil } from "lucide-react";
import { api } from "../../api/client";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { useAuth } from "../../auth/AuthContext";
import { cn } from "../../lib/utils";
import { Avatar } from "../../components/Avatar";
import { Badge } from "../../components/Badge";
import { Button, IconButton } from "../../components/Button";
import { Panel, PanelSection } from "../../components/Panel";
import { ListSkeleton } from "../../components/Skeleton";
import type { TeamMember, Department } from "../../types";
import { buildDeptNodes, type DeptNode } from "./teamShared";

/* Departments — design handoff screen 05. Card grid for a company-wide
 * headcount scan; a department with no lead surfaces as a red card. Clicking
 * a card opens that department's roster in the Directory (same right-pane
 * table, scoped). The "lead" is DERIVED from reporting lines (see
 * deriveDeptLead) — the schema has no lead column yet. */

const DEPT_PALETTE = [
  "64748b", "3b82f6", "06b6d4", "10b981",
  "f59e0b", "f97316", "ec4899", "8b5cf6",
];

export function TeamDepartmentsV2({
  creating,
  onCloseCreate,
}: {
  creating: boolean;
  onCloseCreate: () => void;
}) {
  const { can } = useAuth();
  const canManage = can("users.manage");
  const toast = useToast();
  const dialog = useDialog();
  const [, setParams] = useSearchParams();

  const members = useQuery<{ users: TeamMember[] }>("/api/users", () =>
    api.get("/api/users"),
  );
  const depts = useQuery<{ departments: Department[] }>(
    "/api/departments",
    () => api.get("/api/departments"),
    [],
    { staleTime: 60_000 },
  );

  const users = useMemo(() => members.data?.users ?? [], [members.data]);
  const departments = depts.data?.departments ?? [];
  const { nodes } = useMemo(() => buildDeptNodes(users, departments), [users, departments]);

  const [editing, setEditing] = useState<Department | null>(null);
  const [creatingLocal, setCreatingLocal] = useState(false);
  const editorOpen = creating || creatingLocal || editing != null;

  const totals = useMemo(() => {
    const teams = nodes.reduce((acc, n) => acc + n.divisions.length, 0);
    const active = users.filter((u) => u.status === "active").length;
    const visible = users.filter((u) => u.status !== "disabled").length;
    return { teams, active, visible };
  }, [nodes, users]);

  function openRoster(deptId: number) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("tab", "directory");
        next.set("dept", String(deptId));
        return next;
      },
      { replace: false },
    );
  }

  if (members.loading || depts.loading) return <ListSkeleton rows={4} />;
  if (members.error || depts.error)
    return <div className="text-[12px] text-err">Couldn't load departments.</div>;

  return (
    <div>
      <p className="mb-4 mt-0 text-[13px] text-ink-secondary">
        {nodes.length} department{nodes.length === 1 ? "" : "s"} · {totals.teams} team
        {totals.teams === 1 ? "" : "s"} · {totals.active} active
        {totals.visible > totals.active ? ` / ${totals.visible} incl. pending` : ""}
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {nodes.map((n) => (
          <DeptCard
            key={n.dept.id}
            node={n}
            users={users}
            canManage={canManage}
            onOpen={() => openRoster(n.dept.id)}
            onEdit={() => setEditing(n.dept)}
          />
        ))}
        {canManage && (
          <button
            className="rounded-lg border border-dashed border-border-strong bg-surface-2 p-4 text-left transition-colors hover:border-primary"
            onClick={() => setCreatingLocal(true)}
          >
            <div className="text-[13.5px] font-semibold text-ink-secondary">+ New Department</div>
            <div className="mt-1 text-[11px] text-ink-muted">
              Groups the directory tree, org chart and mailbox assignment
            </div>
          </button>
        )}
      </div>

      <p className="mb-0 mt-4 text-[11.5px] text-ink-muted">
        Click a card to open its roster in the Directory. The lead shown is derived from
        reporting lines (the member most others in the department report to).
      </p>

      {editorOpen && (
        <DeptEditor
          dept={editing}
          onClose={() => {
            setEditing(null);
            setCreatingLocal(false);
            onCloseCreate();
          }}
          onSaved={() => {
            depts.reload();
            members.reload();
          }}
        />
      )}
    </div>
  );
}

function DeptCard({
  node,
  users,
  canManage,
  onOpen,
  onEdit,
}: {
  node: DeptNode;
  users: TeamMember[];
  canManage: boolean;
  onOpen: () => void;
  onEdit: () => void;
}) {
  const { dept, counts, divisions, lead } = node;
  const noLead = lead == null && counts.visible > 0;
  const preview = users
    .filter((u) => u.department_id === dept.id && u.status === "active")
    .slice(0, 3);
  const overflow = Math.max(0, counts.visible - preview.length);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      className={cn(
        "group cursor-pointer rounded-lg border p-4 text-left transition-all duration-fast hover:-translate-y-px hover:shadow-slab",
        noLead
          ? "border-err bg-err-bg"
          : "border-border bg-surface shadow-stone hover:border-primary",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            "flex min-w-0 items-center gap-2 text-[13.5px] font-semibold",
            noLead ? "text-err" : "text-ink",
          )}
        >
          <span
            className="h-2.5 w-2.5 flex-none rounded-full"
            style={{ backgroundColor: `#${dept.color}` }}
          />
          <span className="truncate">{dept.name}</span>
        </span>
        <span className={cn("font-money text-[13px]", noLead ? "text-err" : "text-ink")}>
          {counts.active}
          {counts.visible > counts.active && (
            <span className={cn("text-[11px]", noLead ? "text-err" : "text-ink-muted")}>
              /{counts.visible}
            </span>
          )}
        </span>
      </div>

      {noLead ? (
        <div className="mt-1.5 text-[11.5px] text-err">No lead</div>
      ) : lead ? (
        <div className="mt-1.5 flex items-center gap-1.5">
          <Avatar
            userId={lead.id}
            hasImage={lead.profile_pic_r2_key}
            name={lead.name ?? lead.email}
            size={20}
          />
          <span className="truncate text-[11.5px] text-ink-secondary">
            {lead.name || lead.email}
            {divisions.length > 0 &&
              ` · ${divisions.length} team${divisions.length === 1 ? "" : "s"}`}
          </span>
        </div>
      ) : (
        <div className="mt-1.5 text-[11.5px] text-ink-muted">Empty department</div>
      )}

      <div className="mt-3 flex items-center gap-1">
        {preview.map((u) => (
          <Avatar
            key={u.id}
            userId={u.id}
            hasImage={u.profile_pic_r2_key}
            name={u.name ?? u.email}
            size={24}
          />
        ))}
        {overflow > 0 && (
          <span className={cn("ml-1 font-mono text-[10.5px]", noLead ? "text-err" : "text-ink-muted")}>
            +{overflow}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {counts.invited > 0 && (
            <Badge tone="warning">{counts.invited} pending</Badge>
          )}
          {canManage && (
            <span onClick={(e) => e.stopPropagation()}>
              <IconButton
                icon={<Pencil size={12} />}
                variant="ghost"
                size="xs"
                aria-label={`Edit ${dept.name}`}
                className="opacity-0 transition-opacity group-hover:opacity-100"
                onClick={onEdit}
              />
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

function DeptEditor({
  dept,
  onClose,
  onSaved,
}: {
  dept: Department | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const dialog = useDialog();
  const [name, setName] = useState(dept?.name ?? "");
  const [description, setDescription] = useState(dept?.description ?? "");
  const [color, setColor] = useState(dept?.color ?? DEPT_PALETTE[0]);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const body = { name: name.trim(), description: description.trim() || null, color };
      if (dept) await api.patch(`/api/departments/${dept.id}`, body);
      else await api.post("/api/departments", body);
      toast.success(dept ? "Department updated" : "Department created");
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the department");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!dept) return;
    const warn =
      dept.member_count > 0
        ? `Delete ${dept.name}? Its ${dept.member_count} member${dept.member_count === 1 ? "" : "s"} will be left with no department.`
        : `Delete ${dept.name}?`;
    if (!(await dialog.confirm({ message: warn, tone: "danger", confirmLabel: "Delete" })))
      return;
    setBusy(true);
    try {
      await api.del(`/api/departments/${dept.id}`);
      toast.success("Department deleted");
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete the department");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      open
      onClose={onClose}
      title={dept ? `Edit ${dept.name}` : "New Department"}
      footer={
        <div className="flex items-center justify-between gap-2">
          {dept ? (
            <Button variant="danger" onClick={remove} disabled={busy}>
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} disabled={busy || !name.trim()}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      }
    >
      <PanelSection title="Details">
        <div className="flex flex-col gap-3">
          <div>
            <div className="text-[11.5px] text-ink-muted">Name</div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Operation Department"
              className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-primary"
            />
          </div>
          <div>
            <div className="text-[11.5px] text-ink-muted">Description</div>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional one-liner"
              className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-primary"
            />
          </div>
          <div>
            <div className="text-[11.5px] text-ink-muted">Colour</div>
            {/* Inline swatches, not the ColorPicker popover — the popover was
               clipped by the Panel's scroll body when this is the last field
               (owner report 2026-08-21, "colour 卡片卡住了"). */}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {DEPT_PALETTE.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  title={`#${hex}`}
                  aria-label={`Colour #${hex}`}
                  onClick={() => setColor(hex)}
                  style={{ backgroundColor: `#${hex}` }}
                  className={cn(
                    "h-6 w-6 rounded-md border-2 transition-all",
                    color === hex
                      ? "scale-110 border-ink"
                      : "border-border hover:border-ink/40",
                  )}
                />
              ))}
              <span className="mx-1 h-5 w-px bg-border" />
              <input
                type="color"
                value={`#${color}`}
                onChange={(e) => {
                  const clean = e.target.value.replace(/^#/, "").toLowerCase();
                  if (/^[0-9a-f]{6}$/.test(clean)) setColor(clean);
                }}
                aria-label="Custom colour"
                className="h-6 w-9 cursor-pointer rounded-md border border-border bg-surface"
              />
              <span className="font-mono text-[10.5px] uppercase text-ink-muted">
                #{color}
              </span>
            </div>
          </div>
        </div>
      </PanelSection>
    </Panel>
  );
}
