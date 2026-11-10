/* "Delivered with issue" — the one logic layer for the crew's problem report
   (MobilePOD, MobileJobStop) and the office's views of it (DO / SO detail on
   desktop and mobile, Last Mile). Server: backend/src/scm/routes/delivery-issues.ts.
   The delivery is still recorded delivered; the report adds an issue and opens
   a Service Case. */
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { uploadSlipFull } from './slip';
import { deliveryIssueKindLabel, type DeliveryIssueKind } from './delivery-issue-kinds';
import type { JobRef } from './delivery-job';

export type DeliveryIssue = {
  id: string;
  delivery_order_id: string | null;
  do_number: string | null;
  so_doc_no: string | null;
  source_type: string | null;
  source_id: string | null;
  leg: string | null;
  kinds: string[];
  note: string | null;
  photo_keys: string[];
  assr_case_id: number | null;
  assr_no: string | null;
  reported_by: number | null;
  reported_at: string;
};

export type DeliveryIssueDraft = { kinds: DeliveryIssueKind[]; note: string; photos: File[] };

export const DELIVERY_ISSUES_KEY = ['delivery-issues'] as const;

/** Every issue read shares one root so a report refreshes every screen. */
export function invalidateDeliveryIssues(qc: QueryClient) {
  return qc.invalidateQueries({ queryKey: DELIVERY_ISSUES_KEY });
}

/** What is wrong with the draft, in the crew's words; null when it can be sent. */
export function deliveryIssueDraftError(d: DeliveryIssueDraft): string | null {
  if (!d.kinds.length) return 'Tick at least one problem.';
  if (d.kinds.includes('other') && !d.note.trim()) return 'Describe the problem when you tick "Other".';
  return null;
}

export function deliveryIssueSummary(i: Pick<DeliveryIssue, 'kinds'>): string {
  return i.kinds.map(deliveryIssueKindLabel).join(', ');
}

/** The Service Cases page, opened on the case. */
export function serviceCaseHref(i: Pick<DeliveryIssue, 'assr_case_id'>): string | null {
  return i.assr_case_id != null ? `/assr/${i.assr_case_id}` : null;
}

async function send(path: string, d: DeliveryIssueDraft): Promise<DeliveryIssue> {
  const err = deliveryIssueDraftError(d);
  if (err) throw new Error(err);
  const photoKeys: string[] = [];
  for (const f of d.photos) photoKeys.push((await uploadSlipFull({ file: f })).r2Key);
  const r = await authedFetch<{ issue: DeliveryIssue }>(path, {
    method: 'POST',
    body: JSON.stringify({ kinds: d.kinds, note: d.note.trim() || null, photoKeys }),
  });
  return r.issue;
}

/** Report on a delivery order (its number or id). */
export const reportDoDeliveryIssue = (doRef: string, d: DeliveryIssueDraft) =>
  send(`/delivery-orders-mfg/${encodeURIComponent(doRef)}/delivery-issue`, d);

/** Report on a non-DO run-sheet job (setup / dismantle / service leg / DP job). */
export const reportJobDeliveryIssue = (job: JobRef, d: DeliveryIssueDraft) =>
  send(`/delivery-jobs/${job.sourceType}/${encodeURIComponent(job.sourceId)}/${encodeURIComponent(job.leg)}/issue`, d);

export function useDoDeliveryIssues(doId: string | null | undefined) {
  return useQuery({
    queryKey: [...DELIVERY_ISSUES_KEY, 'do', doId ?? ''],
    queryFn: () => authedFetch<{ issues?: DeliveryIssue[] }>(`/delivery-orders-mfg/${encodeURIComponent(doId!)}/delivery-issues`).then((r) => r.issues ?? []),
    enabled: !!doId,
    staleTime: 30_000,
  });
}

export function useSoDeliveryIssues(docNo: string | null | undefined) {
  return useQuery({
    queryKey: [...DELIVERY_ISSUES_KEY, 'so', docNo ?? ''],
    queryFn: () => authedFetch<{ issues?: DeliveryIssue[] }>(`/mfg-sales-orders/${encodeURIComponent(docNo!)}/delivery-issues`).then((r) => r.issues ?? []),
    enabled: !!docNo,
    staleTime: 30_000,
  });
}

export type RunKeys = { so?: string[]; do?: string[]; jobs?: string[] };

/** Last Mile and the crew screens: issues by SO, DO number or job key
 *  ("assr:12:delivery", the run-sheet's jobKey). */
/** `refetchMs`: an open crew stop screen asks again so a problem the other crew
 *  member reported shows without a refresh; omitted = no polling. */
export function useRunDeliveryIssues(keys: RunKeys, enabled = true, refetchMs?: number) {
  const norm = (xs?: string[]) => [...new Set(xs ?? [])].sort();
  const so = norm(keys.so), dos = norm(keys.do), jobs = norm(keys.jobs);
  const any = so.length + dos.length + jobs.length > 0;
  return useQuery({
    queryKey: [...DELIVERY_ISSUES_KEY, 'run', so.join(','), dos.join(','), jobs.join(',')],
    queryFn: () => {
      const usp = new URLSearchParams();
      if (so.length) usp.set('so', so.join(','));
      if (dos.length) usp.set('do', dos.join(','));
      if (jobs.length) usp.set('jobs', jobs.join(','));
      return authedFetch<{ issues?: DeliveryIssue[] }>(`/delivery-planning/delivery-issues?${usp.toString()}`).then((r) => r.issues ?? []);
    },
    enabled: enabled && any,
    staleTime: 30_000,
    refetchInterval: enabled && any && refetchMs ? refetchMs : false,
  });
}

type RowKeys = { rowType: string; soDocNo: string; doNumber: string | null; jobKey: string | null };

/** The issues of one Last Mile row: a sales-order row by its DO (an SO split
 *  over several DOs shows only this run's DO), else by its job. */
export function issuesForRow(issues: DeliveryIssue[] | undefined, r: RowKeys): DeliveryIssue[] {
  return (issues ?? []).filter((i) => r.rowType === 'so'
    ? !!i.delivery_order_id && (r.doNumber ? i.do_number === r.doNumber : i.so_doc_no === r.soDocNo)
    : !!r.jobKey && `${i.source_type}:${i.source_id}:${i.leg}` === r.jobKey);
}

/** The query keys for a set of Last Mile rows. */
export function runKeysOf(rows: RowKeys[]): RunKeys {
  return {
    so: rows.filter((r) => r.rowType === 'so' && r.soDocNo).map((r) => r.soDocNo),
    jobs: rows.map((r) => r.jobKey).filter((k): k is string => !!k),
  };
}
