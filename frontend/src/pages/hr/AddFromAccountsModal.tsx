import { useEffect, useMemo, useState } from "react";
import { Search, UserPlus } from "lucide-react";
import { ModalOverlay } from "../../components/scm-v2/DocumentRelationshipMapModal";
import { Button } from "../../components/Button";
import { useToast } from "../../hooks/useToast";
import { Toggle, errText, inputCls } from "../pos-admin/posAdminUi";
import { bulkLinkEmployees, useEmployeeOptions, type ErpAccount } from "./hrApi";

export function AddFromAccountsModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const options = useEmployeeOptions(open);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [isOutsource, setIsOutsource] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setSearch("");
      setPicked(new Set());
      setIsOutsource(false);
    }
  }, [open]);

  const deptName = useMemo(() => new Map((options.data?.departments ?? []).map((d) => [d.id, d.name])), [options.data]);
  const available = useMemo(() => (options.data?.accounts ?? []).filter((a) => a.linkedEmpNo == null), [options.data]);
  const alreadyLinked = (options.data?.accounts ?? []).length - available.length;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return available;
    return available.filter((a) => [a.name, a.email, a.position].some((v) => (v ?? "").toLowerCase().includes(q)));
  }, [available, search]);

  const allFilteredPicked = filtered.length > 0 && filtered.every((a) => picked.has(a.id));
  const toggleOne = (id: number) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleAllFiltered = () =>
    setPicked((p) => {
      const n = new Set(p);
      if (allFilteredPicked) filtered.forEach((a) => n.delete(a.id));
      else filtered.forEach((a) => n.add(a.id));
      return n;
    });

  const groups = useMemo(() => {
    const byDept = new Map<string, ErpAccount[]>();
    for (const a of filtered) {
      const dept = a.department_id != null ? deptName.get(a.department_id) ?? "No department" : "No department";
      const arr = byDept.get(dept);
      if (arr) arr.push(a);
      else byDept.set(dept, [a]);
    }
    return [...byDept.entries()].sort(([x], [y]) => (x === "No department" ? 1 : y === "No department" ? -1 : x.localeCompare(y)));
  }, [filtered, deptName]);

  const toggleGroup = (accts: ErpAccount[], allIn: boolean) =>
    setPicked((p) => {
      const n = new Set(p);
      for (const a of accts) if (allIn) n.delete(a.id);
      else n.add(a.id);
      return n;
    });

  async function confirm() {
    if (picked.size === 0) return;
    setSaving(true);
    try {
      const res = await bulkLinkEmployees([...picked], isOutsource);
      const added = res.created.length;
      const skipped = res.skipped.length;
      if (added > 0) {
        toast.success(skipped > 0 ? `Added ${added}, skipped ${skipped} (already had a record)` : `Added ${added} ${added === 1 ? "employee" : "employees"}`);
        onDone();
        setPicked(new Set());
        options.reload();
      } else {
        toast.error(skipped > 0 ? "Nothing added — those accounts already have an employee record." : "Nothing was added.");
      }
    } catch (e) {
      toast.error(errText(e, "Could not add the employees."));
    } finally {
      setSaving(false);
    }
  }

  const footer = (
    <div className="flex w-full items-center justify-between gap-3">
      <Toggle
        checked={isOutsource}
        onChange={setIsOutsource}
        label="Outsourced (OSC numbers)"
        hint="Numbers these as OSC-### instead of EMP-###."
      />
      <Button variant="primary" icon={<UserPlus size={14} />} disabled={picked.size === 0 || saving} onClick={() => void confirm()}>
        {saving ? "Adding…" : picked.size === 0 ? "Pick accounts" : `Add ${picked.size} ${picked.size === 1 ? "employee" : "employees"}`}
      </Button>
    </div>
  );

  return (
    <ModalOverlay open={open} onClose={onClose} title="Add from ERP accounts" icon={<UserPlus size={16} />} size="lg" footer={footer}>
      <div className="flex flex-col gap-3 text-[13px]">
        <p className="text-ink-secondary">
          These are the ERP accounts with no employee record yet. Tick the ones to add — name, phone, department and position come from the
          account; set their salary and statutory afterwards by clicking the row.
        </p>
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-muted" />
          <input
            className={`${inputCls} pl-7`}
            placeholder="Search name, email or position"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search ERP accounts"
          />
        </div>

        {options.loading && !options.data && <p className="text-ink-muted">Loading accounts…</p>}
        {options.error && <p className="text-err">{options.error}</p>}

        {options.data && available.length === 0 && (
          <p className="rounded-lg border border-border px-3 py-3 text-ink-muted">
            Every active ERP account already has an employee record. Add one by hand with “Add employee”, or import a spreadsheet.
          </p>
        )}

        {available.length > 0 && (
          <>
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
                <input type="checkbox" checked={allFilteredPicked} onChange={toggleAllFiltered} />
                Select all{search.trim() ? " shown" : ""} ({filtered.length})
              </label>
              <span className="text-[11px] text-ink-muted">{picked.size} selected{alreadyLinked > 0 ? ` · ${alreadyLinked} already added` : ""}</span>
            </div>
            <div className="max-h-[48vh] overflow-y-auto rounded-lg border border-border">
              {filtered.length === 0 ? (
                <p className="px-3 py-3 text-ink-muted">No account matches “{search}”.</p>
              ) : (
                groups.map(([dept, accts]) => {
                  const allIn = accts.every((a) => picked.has(a.id));
                  return (
                    <div key={dept}>
                      <div className="sticky top-0 z-[1] flex items-center justify-between border-b border-border-subtle bg-surface-dim px-3 py-1.5">
                        <label className="flex cursor-pointer items-center gap-2 text-[11px] font-semibold uppercase tracking-brand text-ink-secondary">
                          <input type="checkbox" checked={allIn} onChange={() => toggleGroup(accts, allIn)} />
                          {dept}
                        </label>
                        <span className="text-[10.5px] text-ink-muted">{accts.length}</span>
                      </div>
                      <ul>
                        {accts.map((a) => (
                          <li key={a.id} className="border-b border-border-subtle last:border-0">
                            <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 hover:bg-surface-dim">
                              <input type="checkbox" checked={picked.has(a.id)} onChange={() => toggleOne(a.id)} />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium text-ink">{a.name ?? a.email}</span>
                                <span className="block truncate text-[11px] text-ink-muted">
                                  {a.email}
                                  {a.position ? ` · ${a.position}` : ""}
                                </span>
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>
    </ModalOverlay>
  );
}
