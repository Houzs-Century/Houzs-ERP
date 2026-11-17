import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
import { EditDpOrderDrawer } from "../../vendor/scm/components/EditDpOrderDrawer";
import type { DpOrderRow } from "../../vendor/scm/lib/delivery-planning-queries";

/* The DP job's own postcode / state rows and its Edit action, inside the job
   drawer's Job section (owner 2026-11-17: a scheduled supplier pickup showed
   no postcode and the drawer gave no way to fix it). Reads the dp_orders row
   (GET /dp-orders/:id, which shows a postcode written only in the address), and
   edits it with the same form the DP Orders registry uses. */
/** `showFacts` false: the host (the Last Mile stop drawer) already shows the
 *  postcode and state, so only the Edit action is added. */
export function DpJobDetails({ dpId, showFacts }: { dpId: string; showFacts: boolean }) {
  const q = useQuery({
    queryKey: ["dp-order", dpId],
    queryFn: () => authedFetch<{ dpOrder: DpOrderRow }>(`/dp-orders/${encodeURIComponent(dpId)}`),
    staleTime: 15_000,
  });
  const [editing, setEditing] = useState(false);
  if (q.isPending) return null;
  if (q.error) return <div className="mt-2 text-[12.5px] text-red-600 dark:text-red-300">{(q.error as Error).message}</div>;
  const row = q.data.dpOrder;
  const line = (k: string, v: string | null | undefined) => (
    <div className="flex justify-between gap-3 border-b border-border-subtle py-1.5 last:border-b-0">
      <span className="text-[12.5px] text-ink-muted">{k}</span>
      <span className={`text-right text-[13px] ${v ? "font-semibold text-ink" : "text-ink-muted"}`}>{v || "—"}</span>
    </div>
  );
  return (
    <>
      {showFacts && line("Postcode", row.postcode)}
      {showFacts && line("State", row.state)}
      {showFacts && line("City", row.city)}
      {row.status !== "CANCELLED" && (
        <button type="button" onClick={() => setEditing(true)}
          className="mt-3 w-full rounded-md border border-border py-2 text-[13px] font-semibold text-accent">
          Edit job details
        </button>
      )}
      {editing && <EditDpOrderDrawer row={row} onClose={() => setEditing(false)} />}
    </>
  );
}
