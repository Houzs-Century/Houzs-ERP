/* The project's pasted sales report, read once per page and shared by the
 * Sales section (the block), Sales Attending (the red numbers) and the chat
 * (which messages are already saved). One key, so the three stay in step and
 * a save invalidates all of them at once. */
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { usePageAccess } from "../auth/PageGuard";
import { canLogSalesEntry, isDirectorUser, isSalesStaff } from "../auth/salesAccess";
import { normalizeProjectSalesBills, type ProjectSalesBillsResponse } from "../lib/projectSalesBills";
import { useQuery, type QueryState } from "./useQuery";

export const PROJECT_SALES_BILLS_KEY = "/api/project-sales-bills/:";

export function useProjectSalesBills(projectId: number, enabled: boolean): QueryState<ProjectSalesBillsResponse> {
  return useQuery<ProjectSalesBillsResponse>(
    PROJECT_SALES_BILLS_KEY,
    () => api.get<unknown>(`/api/project-sales-bills/${projectId}`).then(normalizeProjectSalesBills),
    [projectId],
    { enabled },
  );
}

/** Drop every cached read of this feature so the page re-reads after a save. */
export function useInvalidateProjectSalesBills(): () => void {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["uq", PROJECT_SALES_BILLS_KEY] });
  };
}

/** The Sales section's own viewer rule — the same three gates
 *  ProjectSalesEntriesSection reads (flat "sales" page access, or Sales staff,
 *  or a director by position), so the report is read for exactly the people
 *  who see the section it sits in. */
export function useCanViewProjectSales(): { canLogSale: boolean; canViewSales: boolean } {
  const auth = useAuth();
  const salesLevel = usePageAccess("sales");
  const canLogSale = canLogSalesEntry(salesLevel);
  return { canLogSale, canViewSales: canLogSale || isSalesStaff(auth.user) || isDirectorUser(auth.user) };
}
