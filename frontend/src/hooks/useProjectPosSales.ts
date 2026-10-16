/* The Houzs POS bills of one event (GET /api/project-pos-sales/:projectId),
 * read once by the project page's Sales section and by the mobile panel. The
 * filter is part of the cache key, so each filter is its own read. */
import { api } from "../api/client";
import { useQuery, type QueryState } from "./useQuery";
import {
  normalizeProjectPosSales,
  posSalesFilterQuery,
  type PosSalesFilter,
  type ProjectPosSalesResponse,
} from "../lib/projectPosSales";

export const PROJECT_POS_SALES_KEY = "/api/project-pos-sales/:";

export function useProjectPosSales(
  projectId: number,
  filter: PosSalesFilter,
  enabled: boolean,
): QueryState<ProjectPosSalesResponse> {
  const qs = posSalesFilterQuery(filter);
  return useQuery<ProjectPosSalesResponse>(
    PROJECT_POS_SALES_KEY,
    () => api.get<unknown>(`/api/project-pos-sales/${projectId}${qs}`).then(normalizeProjectPosSales),
    [projectId, qs],
    { enabled },
  );
}
