/* Every job's On the way / Arrived / Done (scm.job_progress), one read shared by
   the driver's phone and the desktop Last Mile map. */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { authedFetch } from "./authed-fetch";
import type { JobProgress } from "./delivery-job";

export const JOB_PROGRESS_KEY = ["delivery-job-progress"];

/** Every job's progress in the last 45 days, keyed by jobKey. */
export function useJobProgressMap(enabled = true): Map<string, JobProgress> {
  const since = useMemo(() => new Date(Date.now() - 45 * 86400_000).toISOString().slice(0, 10), []);
  const q = useQuery({
    queryKey: [...JOB_PROGRESS_KEY, since],
    queryFn: () => authedFetch<{ progress: JobProgress[] }>(`/delivery-jobs/progress?since=${since}`),
    enabled,
    staleTime: 30_000,
    refetchInterval: enabled ? 30_000 : false,
  });
  return useMemo(() => {
    const m = new Map<string, JobProgress>();
    for (const p of q.data?.progress ?? []) m.set(`${p.source_type}:${p.source_id}:${p.leg}`, p);
    return m;
  }, [q.data]);
}
