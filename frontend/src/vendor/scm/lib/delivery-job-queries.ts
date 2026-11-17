import { useQuery } from "@tanstack/react-query";
import { authedFetch } from "./authed-fetch";
import { jobKey, str, type JobCtx, type JobRef, type JobResponse } from "./delivery-job";

export const jobApiPath = (r: JobRef) =>
  `/delivery-jobs/${r.sourceType}/${encodeURIComponent(r.sourceId)}/${encodeURIComponent(r.leg)}`;

/** One non-SO job (context + progress). The job panel and the Last Mile stop
 *  drawer share this key, so the drawer's contact line costs no extra request. */
export const useDeliveryJob = (jobRef: JobRef | null) =>
  useQuery({
    queryKey: ["delivery-job", jobRef ? jobKey(jobRef) : ""],
    queryFn: () => authedFetch<JobResponse>(jobApiPath(jobRef as JobRef)),
    enabled: jobRef !== null,
    staleTime: 15_000,
  });

/** The person to ask for at the stop (a supplier's or venue's contact), or null.
 *  A contact that is just the stop's own name says nothing new. */
export function stopContactName(ctx: JobCtx | null | undefined, customer: string): string | null {
  const name = str(ctx?.contact_name);
  if (!name) return null;
  return name.trim().toLowerCase() === customer.trim().toLowerCase() ? null : name;
}
