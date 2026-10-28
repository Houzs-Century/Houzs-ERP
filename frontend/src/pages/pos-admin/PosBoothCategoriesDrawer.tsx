/* POS Items > Add by category: tick the inventory categories the booth sells.
 * "Add" tags every product of a ticked category that has a selling price and
 * is not a POS item yet; "Keep only ticked" switches off the POS items in the
 * unticked categories (the same as the trash on a row). Counts come from the
 * dry run, so the owner sees what each button will do before pressing it. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import { cn } from "../../lib/utils";
import { ResizableDrawer } from "../../components/ResizableDrawer";
import { POS_ADMIN } from "./posAdminApi";
import { Empty, Table, dangerBtn, errText, primaryBtn, td, th } from "./posAdminUi";
import { categoryTitle, defaultTicks, planFor, type CategoryCount } from "./boothCategories";

type DryRun = { by_category: CategoryCount[]; total_active: number };

export function PosBoothCategoriesDrawer({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const dialog = useDialog();
  const [counts, setCounts] = useState<CategoryCount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.post<DryRun>(`${POS_ADMIN}/items/add-all`, { dry_run: true });
      setCounts(r.by_category);
      setTicked((t) => t ?? defaultTicks(r.by_category));
      setError(null);
    } catch (e) {
      setError(errText(e, "Could not count the inventory."));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const plan = useMemo(() => planFor(counts ?? [], ticked ?? new Set()), [counts, ticked]);
  const categories = [...(ticked ?? [])].filter((c) => c !== "");

  const toggle = (c: string) => setTicked((t) => { const n = new Set(t); if (n.has(c)) n.delete(c); else n.add(c); return n; });

  async function add() {
    if (categories.length === 0) { toast.info("Tick at least one category."); return; }
    setBusy(true);
    try {
      const r = await api.post<{ added: number }>(`${POS_ADMIN}/items/add-all`, { categories });
      toast.success(`${r.added} POS item(s) added. Press Refresh catalog on the devices.`);
      onChanged();
      await load();
    } catch (e) {
      toast.error(errText(e, "Could not add the inventory."));
    } finally {
      setBusy(false);
    }
  }

  async function keepOnly() {
    if (categories.length === 0) { toast.info("Tick at least one category to keep."); return; }
    const ok = await dialog.confirm({
      title: `Switch off ${plan.to_remove} POS item(s) outside the ticked categories?`,
      message: `${plan.kept} POS item(s) in the ticked categories stay on. The others stop reaching devices on their next refresh; bills already sold keep their lines, and Add from Inventory turns an item back on.`,
      confirmLabel: "Keep only ticked",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.post<{ removed: number }>(`${POS_ADMIN}/items/keep-categories`, { categories });
      toast.success(`${r.removed} POS item(s) switched off.`);
      onChanged();
      await load();
    } catch (e) {
      toast.error(errText(e, "Could not switch the items off."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ResizableDrawer
      onClose={onClose}
      title="Add by category"
      subtitle="Tick what the booth sells. Furniture stays out of the POS unless ticked."
      storageKey="pos-admin-booth-categories"
      defaultWidth={560}
      footer={
        <div className="flex flex-wrap items-center gap-2 p-2">
          <button type="button" className={primaryBtn} disabled={busy || plan.to_add === 0} onClick={() => void add()}>Add {plan.to_add} item(s)</button>
          <button type="button" className={dangerBtn} disabled={busy || plan.to_remove === 0} onClick={() => void keepOnly()}>Keep only ticked (switch off {plan.to_remove})</button>
          <span className="ml-auto text-[11px] text-ink-muted">{plan.kept} in POS stay on</span>
        </div>
      }
    >
      <div className="space-y-2 p-3">
        {!counts && !error && <div className="text-[11px] text-ink-muted">Counting the inventory…</div>}
        {error && <div className="rounded-md border border-err/40 bg-err/5 p-2 text-[11px] text-err">{error}</div>}
        {counts && counts.length === 0 && <Empty>No active inventory products.</Empty>}
        {counts && counts.length > 0 && (
          <Table minWidth={480} head={<>
            <th className={th} /><th className={th}>Category</th><th className={cn(th, "text-right")}>In POS</th>
            <th className={cn(th, "text-right")}>To add</th><th className={cn(th, "text-right")}>Off</th><th className={cn(th, "text-right")}>No price</th>
          </>}>
            {counts.map((c) => {
              const on = ticked?.has(c.category) ?? false;
              const pickable = c.category !== "";
              return (
                <tr key={c.category} className={cn("border-t border-border-subtle", pickable && "cursor-pointer hover:bg-bg/40")} onClick={() => pickable && toggle(c.category)}>
                  <td className={td}>{pickable && <input type="checkbox" checked={on} onChange={() => toggle(c.category)} onClick={(e) => e.stopPropagation()} aria-label={categoryTitle(c.category)} />}</td>
                  <td className={cn(td, "font-semibold", !on && "text-ink-muted")}>{categoryTitle(c.category)}</td>
                  <td className={cn(td, "text-right font-mono")}>{c.active}</td>
                  <td className={cn(td, "text-right font-mono", on && c.to_add > 0 && "text-accent")}>{c.to_add}</td>
                  <td className={cn(td, "text-right font-mono text-ink-muted")}>{c.off}</td>
                  <td className={cn(td, "text-right font-mono text-ink-muted")} title="No selling price in the inventory; never added">{c.no_price}</td>
                </tr>
              );
            })}
          </Table>
        )}
        <p className="text-[11px] text-ink-muted">In POS = items already on. To add = products with a selling price not in the POS yet. Off = items removed by hand; they stay off.</p>
      </div>
    </ResizableDrawer>
  );
}
