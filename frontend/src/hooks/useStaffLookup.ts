// useStaffLookup — one-liner id→name lookup for the SCM V2 lists.
//
// The manufacture-side list endpoints (mfg-sales-orders, mfg-delivery-orders,
// sales-invoices, delivery-returns) return `salesperson_id` as a raw UUID
// but no friendly name. Rendering the UUID directly reads as gibberish
// (2026-07-08 bug report). This hook fetches the /staff roster (cached
// 10 min) and returns a helper that:
//   · returns `agent` verbatim when set to a NAME (some rows carry a text
//     `agent`),
//   · else looks up `salesperson_id` → `name` (or `staffCode` if the row
//     has no display name),
//   · else returns `fallback` (default "—") — NEVER a UUID.

import { useMemo } from "react";
import { useStaff } from "../vendor/scm/lib/admin-queries";

/* Nick 2026-07-09 — screenshot on the SO list showed the Salesperson
   column full of UUIDs like `c115a11d-5a53-a0c1-020a-c64cc4d9b4fb`.
   Some backend rows fill `agent` with the raw id instead of leaving it
   null; the previous helper returned that verbatim without giving the
   id → name map a chance. Skip UUID-shaped agents so the lookup path
   runs and a real name lands. */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function useStaffLookup() {
  const staffQ = useStaff();
  return useMemo(() => {
    const byId = new Map<string, string>();
    for (const s of staffQ.data ?? []) {
      if (s.id) byId.set(s.id, s.name || s.staffCode || "");
    }
    const nameOf = (
      agent: string | null | undefined,
      salespersonId: string | null | undefined,
      fallback = "—"
    ): string => {
      const trimmedAgent = agent?.trim();
      if (trimmedAgent && !UUID_RE.test(trimmedAgent)) return trimmedAgent;
      if (salespersonId) {
        const looked = byId.get(salespersonId);
        if (looked && looked.trim()) return looked;
      }
      /* Last-ditch: sometimes only `agent` is set and it's a UUID — try
         resolving IT as an id so the row still shows a name instead of
         the fallback dash. */
      if (trimmedAgent && UUID_RE.test(trimmedAgent)) {
        const looked = byId.get(trimmedAgent);
        if (looked && looked.trim()) return looked;
      }
      return fallback;
    };

    /* actorNameOf — the AUDIT-ACTOR twin of nameOf, for the `*_by` columns
       (requested_by / supplier_confirmed_by / so_approved_by / po_approved_by).
       Those carry a bare scm.staff uuid with no `agent` text alongside, so
       nameOf's agent-first path does not apply. 2026-07-16 owner report: the
       Amendments queue + job card printed requested_by verbatim, so the
       operator read a raw uuid where a person's name belongs.

       Empty id => `empty` ("no data"), which is NOT the same statement as an
       id that exists but resolves to nobody => "Unknown user". While the
       roster is still in flight we return `empty` rather than "Unknown user"
       so a real name never flashes as unknown first. Either way a uuid is
       never rendered. */
    const actorNameOf = (
      staffId: string | null | undefined,
      empty = "—"
    ): string => {
      const id = staffId?.trim();
      if (!id) return empty;
      if (staffQ.isLoading) return empty;
      return nameOf(null, id, "Unknown user");
    };

    return { nameOf, actorNameOf, byId, isLoading: staffQ.isLoading };
  }, [staffQ.data, staffQ.isLoading]);
}
