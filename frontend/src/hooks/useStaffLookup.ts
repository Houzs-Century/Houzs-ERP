
import { useMemo } from "react";
import { useStaff } from "../vendor/scm/lib/admin-queries";

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
