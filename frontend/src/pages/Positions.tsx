import { useMemo, useState } from "react";
import { Plus, Pencil, Trash2, ChevronDown, ChevronRight, GripVertical } from "lucide-react";
import { Button } from "../components/Button";
import { Panel, PanelSection } from "../components/Panel";
import { Skeleton } from "../components/Skeleton";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { api } from "../api/client";
import { cn } from "../lib/utils";
import type { Department, Position } from "../types";

/** Embedded in the Team page as the "Titles" tab (a Title is a `positions` row). */
export function PositionsTab() {
  const toast = useToast();
  const dialog = useDialog();
  const positionsQ = useQuery<{ positions: Position[] }>("/api/positions", () => api.get("/api/positions"));
  const deptsQ = useQuery<{ departments: Department[] }>("/api/departments", () => api.get("/api/departments"));
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // null = closed · "new" = create · Position = edit that one
  const [editing, setEditing] = useState<Position | "new" | null>(null);
  // Department groups the admin has collapsed in the left list.
  const [collapsedDepts, setCollapsedDepts] = useState<Set<string>>(new Set());
  const toggleDept = (dept: string) =>
    setCollapsedDepts((prev) => {
      const next = new Set(prev);
      next.has(dept) ? next.delete(dept) : next.add(dept);
      return next;
    });

  const positions = positionsQ.data?.positions ?? [];
  const selected = positions.find((p) => p.id === selectedId) ?? null;

  const deptList = deptsQ.data?.departments ?? [];
  const deptByName = useMemo(() => {
    const m = new Map<string, Department>();
    for (const d of deptList) m.set(d.name, d);
    return m;
  }, [deptList]);

  const byDept = useMemo(() => {
    const m = new Map<string, Position[]>();
    for (const p of positions) {
      const d = p.department_name ?? "No department";
      if (!m.has(d)) m.set(d, []);
      m.get(d)!.push(p);
    }
    // Order the department groups by their saved sort_order (drag-reorderable),
    // then name; positions inside each come back from the API already ordered.
    const ord = (name: string) => deptByName.get(name)?.sort_order ?? 9999;
    return Array.from(m.entries()).sort(
      (a, b) => ord(a[0]) - ord(b[0]) || a[0].localeCompare(b[0]),
    );
  }, [positions, deptByName]);

  // ── Drag-and-drop reordering (Super Admin) ──────────────────
  const [drag, setDrag] = useState<{ kind: "pos" | "dept"; id?: number; dept: string } | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  async function persistPositions(
    updates: { id: number; sort_order: number; department_id?: number | null }[],
  ) {
    try {
      await Promise.all(
        updates.map((u) =>
          api.patch(`/api/positions/${u.id}`, {
            sort_order: u.sort_order,
            ...(u.department_id !== undefined ? { department_id: u.department_id } : {}),
          }),
        ),
      );
    } catch (e: any) {
      toast.error(e?.message || "Reorder failed");
    } finally {
      positionsQ.reload();
    }
  }

  function dropOnPosition(target: Position) {
    const d = drag;
    setDrag(null);
    setDragOverKey(null);
    if (!d || d.kind !== "pos" || d.id == null || d.id === target.id) return;
    const dragged = positions.find((p) => p.id === d.id);
    if (!dragged) return;
    const targetDeptName = target.department_name ?? "No department";
    const list = byDept.find(([name]) => name === targetDeptName)?.[1] ?? [];
    const ids = list.filter((p) => p.id !== dragged.id).map((p) => p.id);
    const at = ids.indexOf(target.id);
    ids.splice(at < 0 ? ids.length : at, 0, dragged.id);
    const targetDeptId = deptByName.get(targetDeptName)?.id ?? dragged.department_id ?? null;
    persistPositions(
      ids.map((id, i) => ({
        id,
        sort_order: (i + 1) * 10,
        ...(id === dragged.id ? { department_id: targetDeptId } : {}),
      })),
    );
  }

  function dropOnDept(targetDeptName: string) {
    const d = drag;
    setDrag(null);
    setDragOverKey(null);
    if (!d) return;
    if (d.kind === "pos" && d.id != null) {
      // Move a position into this department (appended at the end).
      const dragged = positions.find((p) => p.id === d.id);
      if (!dragged || (dragged.department_name ?? "No department") === targetDeptName) return;
      const list = byDept.find(([name]) => name === targetDeptName)?.[1] ?? [];
      const targetDeptId = deptByName.get(targetDeptName)?.id ?? null;
      persistPositions([
        ...list.map((p, i) => ({ id: p.id, sort_order: (i + 1) * 10 })),
        { id: dragged.id, sort_order: (list.length + 1) * 10, department_id: targetDeptId },
      ]);
    } else if (d.kind === "dept" && d.dept !== targetDeptName) {
      const names = byDept.map(([n]) => n).filter((n) => n !== d.dept);
      const at = names.indexOf(targetDeptName);
      names.splice(at < 0 ? names.length : at, 0, d.dept);
      const updates = names
        .map((name, i) => ({ dep: deptByName.get(name), so: (i + 1) * 10 }))
        .filter((x) => x.dep && x.dep.sort_order !== x.so);
      if (updates.length === 0) return;
      Promise.all(
        updates.map((u) => api.patch(`/api/departments/${u.dep!.id}`, { sort_order: u.so })),
      )
        .then(() => {
          deptsQ.reload();
        })
        .catch((e: any) => toast.error(e?.message || "Reorder failed"));
    }
  }

  async function deletePosition(p: Position) {
    if (p.member_count > 0) {
      toast.error(`${p.name} still has ${p.member_count} member(s) — reassign them first.`);
      return;
    }
    if (!(await dialog.confirm(`Delete the title “${p.name}”?`))) return;
    try {
      await api.del(`/api/positions/${p.id}`);
      toast.success("Title deleted");
      if (selectedId === p.id) setSelectedId(null);
      positionsQ.reload();
    } catch (e: any) {
      toast.error(e?.message || "Delete failed (members may still hold it)");
    }
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-brand text-accent">
          {positions.length} title{positions.length === 1 ? "" : "s"}
        </span>
        <div className="flex items-center gap-2">
          <Button variant="brass" icon={<Plus size={14} />} onClick={() => setEditing("new")}>
            New Title
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        {/* Position list — grouped by department, each row editable/deletable */}
        {/* Position list — single column, department-grouped + collapsible */}
        <div className="shrink-0 lg:w-64">
          {positionsQ.loading && <Skeleton className="h-40 w-full" />}
          <div className="space-y-2.5">
          {byDept.map(([dept, list]) => {
            const collapsed = collapsedDepts.has(dept);
            return (
            <div
              key={dept}
              className={cn(
                "break-inside-avoid rounded",
                dragOverKey === `dept:${dept}` && "ring-1 ring-accent ring-offset-1",
              )}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverKey(`dept:${dept}`);
              }}
              onDrop={() => dropOnDept(dept)}
            >
              <div className="mb-1.5 flex w-full items-center gap-1">
                <span
                  draggable
                  onDragStart={() => setDrag({ kind: "dept", dept })}
                  onDragEnd={() => {
                    setDrag(null);
                    setDragOverKey(null);
                  }}
                  title="Drag to reorder department"
                  className="cursor-grab text-ink-muted/60 hover:text-accent active:cursor-grabbing"
                >
                  <GripVertical size={14} />
                </span>
                <button
                  type="button"
                  onClick={() => toggleDept(dept)}
                  className="flex flex-1 items-center gap-1 text-[13px] font-bold uppercase tracking-brand text-ink transition-colors hover:text-accent"
                >
                  {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  <span className="truncate">{dept}</span>
                  <span className="ml-auto rounded bg-surface-dim px-1.5 text-[9px] font-semibold text-ink-muted">
                    {list.length}
                  </span>
                </button>
              </div>
              {!collapsed && (
              <div className="space-y-0.5">
                {list.map((p) => (
                  <div
                    key={p.id}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDragOverKey(`pos:${p.id}`);
                    }}
                    onDrop={(e) => {
                      e.stopPropagation();
                      dropOnPosition(p);
                    }}
                    className={cn(
                      "group flex items-center gap-1 rounded-md border pr-1 transition-colors",
                      selectedId === p.id
                        ? "border-accent bg-accent-soft"
                        : "border-border bg-surface hover:border-accent/50",
                      dragOverKey === `pos:${p.id}` && "ring-1 ring-accent",
                    )}
                  >
                    <span
                      draggable
                      onDragStart={(e) => {
                        e.stopPropagation();
                        setDrag({ kind: "pos", id: p.id, dept });
                      }}
                      onDragEnd={() => {
                        setDrag(null);
                        setDragOverKey(null);
                      }}
                      title="Drag to reorder, or onto a department to move it"
                      className="shrink-0 cursor-grab pl-1 text-ink-muted/40 transition-colors hover:text-accent active:cursor-grabbing"
                    >
                      <GripVertical size={12} />
                    </span>
                    <button
                      onClick={() => setSelectedId(p.id)}
                      className="flex min-w-0 flex-1 items-center justify-between gap-2 py-1.5 pr-2 text-left text-[12px]"
                    >
                      <span
                        className={cn(
                          "truncate",
                          selectedId === p.id ? "font-semibold text-accent-ink" : "text-ink",
                        )}
                      >
                        {p.name}
                      </span>
                      <span className="shrink-0 text-[10px] text-ink-muted">{p.member_count}</span>
                    </button>
                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => setEditing(p)}
                        title="Edit title"
                        aria-label={`Edit ${p.name}`}
                        className="rounded p-1 text-ink-muted transition-colors hover:bg-accent-soft hover:text-accent"
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={() => deletePosition(p)}
                        title="Delete title"
                        aria-label={`Delete ${p.name}`}
                        className="rounded p-1 text-ink-muted transition-colors hover:bg-err/10 hover:text-err"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              )}
            </div>
            );
          })}
          </div>
          {!positionsQ.loading && positions.length === 0 && (
            <div className="rounded-md border border-dashed border-border p-4 text-center text-[11px] text-ink-muted">
              No titles yet — add one to start.
            </div>
          )}
        </div>

        {/* Page-access matrix for the selected position */}
        <div className="min-w-0 flex-1">
          {selected ? (
            <PositionMatrixEditor
              key={selected.id}
              position={selected}
              onEdit={() => setEditing(selected)}
            />
          ) : (
            <div className="rounded-lg border border-border bg-surface p-8 text-center text-[12px] text-ink-muted shadow-stone">
              Select a title to see its details, or{" "}
              <button
                type="button"
                onClick={() => setEditing("new")}
                className="font-semibold text-accent hover:underline"
              >
                add a new one
              </button>
              .
            </div>
          )}
        </div>
      </div>

      {editing && (
        <PositionEditPanel
          position={editing === "new" ? null : editing}
          departments={deptsQ.data?.departments ?? []}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null);
            positionsQ.reload();
            if (id) setSelectedId(id);
          }}
          onDeleted={() => {
            setEditing(null);
            setSelectedId(null);
            positionsQ.reload();
          }}
        />
      )}
    </div>
  );
}

/** Create / edit a single position (name + department). */
function PositionEditPanel({
  position,
  departments,
  onClose,
  onSaved,
  onDeleted,
}: {
  position: Position | null;
  departments: Department[];
  onClose: () => void;
  onSaved: (newId?: number) => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const dialog = useDialog();
  const isNew = !position;
  const [name, setName] = useState(position?.name || "");
  const [deptId, setDeptId] = useState<number | "">(position?.department_id ?? "");
  const [busy, setBusy] = useState(false);

  const inputCls =
    "h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20";
  const labelCls =
    "mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted";

  async function save() {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    setBusy(true);
    try {
      if (isNew) {
        const res = await api.post<{ id?: number }>("/api/positions", {
          name: name.trim(),
          department_id: deptId || undefined,
        });
        toast.success(`Created “${name.trim()}”`);
        onSaved(res?.id);
      } else {
        await api.patch(`/api/positions/${position!.id}`, {
          name: name.trim(),
          department_id: deptId || null,
        });
        toast.success(`Saved “${name.trim()}”`);
        onSaved(position!.id);
      }
    } catch (e: any) {
      toast.error(e?.message || "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function del() {
    if (!position) return;
    if (position.member_count > 0) {
      toast.error(`Still has ${position.member_count} member(s) — reassign them first.`);
      return;
    }
    if (!(await dialog.confirm(`Delete the title “${position.name}”?`))) return;
    setBusy(true);
    try {
      await api.del(`/api/positions/${position.id}`);
      toast.success("Title deleted");
      onDeleted();
    } catch (e: any) {
      toast.error(e?.message || "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      open
      onClose={onClose}
      title={isNew ? "New Title" : position!.name}
      subtitle={isNew ? "Create a title" : "Edit title"}
      width={420}
    >
      <PanelSection title="Details">
        <div>
          <label className={labelCls}>Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Ops Executive"
            className={inputCls}
            autoFocus
          />
        </div>
        <div>
          <label className={labelCls}>Department</label>
          <select
            value={deptId}
            onChange={(e) => setDeptId(e.target.value ? Number(e.target.value) : "")}
            className={inputCls}
          >
            <option value="">— None —</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <div className="mt-1 text-[10px] text-ink-muted">
            Groups the title under a department. A member's title drives which pages they can see.
          </div>
        </div>
      </PanelSection>

      <div className="pb-1">
        <Button variant="brass" className="w-full" onClick={save} disabled={busy}>
          {busy ? "Saving…" : isNew ? "Create Title" : "Save Changes"}
        </Button>
      </div>

      {!isNew && (
        <PanelSection title="Danger">
          <button
            type="button"
            onClick={del}
            disabled={busy}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-err/30 bg-surface px-3 py-2 text-[12px] font-semibold text-err transition-colors hover:bg-err/10 disabled:opacity-50"
          >
            <Trash2 size={13} /> Delete title
            {position!.member_count > 0 ? ` (${position!.member_count} members)` : ""}
          </button>
          {position!.member_count > 0 && (
            <div className="text-[10px] text-ink-muted">
              Reassign its {position!.member_count} member(s) to another title before deleting.
            </div>
          )}
        </PanelSection>
      )}
    </Panel>
  );
}

function PositionMatrixEditor({
  position,
  onEdit,
}: {
  position: Position;
  onEdit: () => void;
}) {
  // Page access for a positioned member is resolved from position defaults in
  // the backend at login (services/positionPolicy.ts) — NOT from a per-page
  // matrix edited here. The old none/view/edit/full grid wrote the
  // position_page_access table, which auth.ts no longer reads for a positioned
  // user, so every "Saved" changed nothing. The grid and its Save were removed
  // so the editor can no longer claim to save an edit that does nothing; the
  // table and its backend route are kept for when per-page editing is reworked.
  // Position details (name / department) stay fully editable via the pencil.
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-stone">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="font-display text-[15px] font-bold leading-tight tracking-tight text-ink">
              {position.name}
            </div>
            <button
              type="button"
              onClick={onEdit}
              title="Edit title name / department"
              className="rounded p-1 text-ink-muted transition-colors hover:bg-accent-soft hover:text-accent"
            >
              <Pencil size={12} />
            </button>
          </div>
          <div className="truncate text-[10px] text-ink-muted">
            {position.department_name ?? "No department"}
          </div>
        </div>
      </div>

      <div className="rounded-md border border-border bg-bg/40 p-4">
        <div className="mb-1.5 text-[10px] font-bold uppercase tracking-brand text-ink-muted">
          Page access
        </div>
        <p className="text-[12px] leading-relaxed text-ink-secondary">
          Members of this title see the pages of its cohort — set on Roles & Permissions,
          under Titles (cohort, profile and duty).
        </p>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-muted">
          Rename this title or move it to another department with the edit button above.
        </p>
      </div>
    </div>
  );
}
