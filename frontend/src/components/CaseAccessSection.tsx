import { ShieldCheck } from "lucide-react";
import { useToast } from "../hooks/useToast";
import { api } from "../api/client";
import { UserMultiSelect, type UserOptionItem } from "./UserMultiSelect";
import { PanelSection } from "./Panel";

/**
 * Access — Nth-person visibility (owner 2026-09-09). Grants extra staff read
 * access to a service case WITHOUT changing the Salesperson or the two
 * Assigned-to slots. Unlimited; each chip is a granted person who (with their
 * upline) can see and open the case. Lives in its own component so the ~9k-line
 * ServiceCases.tsx does not grow past its size ceiling.
 *
 * The picker hands back the full desired id set; diff it against the current
 * grants and POST additions / DELETE removals.
 */
export function CaseAccessSection({
  caseId,
  access,
  onChanged,
}: {
  caseId: number;
  access: any[];
  onChanged: () => void;
}) {
  const toast = useToast();
  // Chips resolve from the access rows themselves (each carries user_name), so a
  // granted person always displays even if outside the loaded users list.
  const accessIds: number[] = access
    .map((a: any) => Number(a.user_id ?? a.userId))
    .filter((n: number) => Number.isFinite(n) && n > 0);
  const accessItems: UserOptionItem[] = access.map((a: any) => ({
    id: Number(a.user_id ?? a.userId),
    name: (a.user_name ?? a.userName ?? `#${a.user_id ?? a.userId}`) as string,
  }));

  async function syncAccess(ids: number[]) {
    const current = new Set(accessIds);
    const wanted = new Set(ids);
    const toAdd = ids.filter((x) => !current.has(x));
    const toRemove = [...current].filter((x) => !wanted.has(x));
    try {
      for (const uid of toAdd) await api.post(`/api/assr/${caseId}/access`, { user_id: uid });
      for (const uid of toRemove) await api.del(`/api/assr/${caseId}/access/${uid}`);
    } catch (e: any) {
      toast.error(e?.message || "Couldn't update access");
    }
    onChanged();
  }

  return (
    <PanelSection title="Access" icon={<ShieldCheck size={13} />}>
      <UserMultiSelect
        value={accessIds}
        selectedItems={accessItems}
        onChange={(ids) => syncAccess(ids)}
        placeholder="Search to grant access"
      />
      <div className="mt-1.5 text-[11px] leading-snug text-ink-muted">
        Extra people who can see this case. Does not change the Salesperson or Assigned-to.
      </div>
    </PanelSection>
  );
}
