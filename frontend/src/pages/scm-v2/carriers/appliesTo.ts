// Which jobs an outstation price adds to (owner 2026-11-18: "check what
// Outstation applies to"). Delivery order by default — all it ever reached
// before the setting — and any of the other jobs a card prices. Pure.
import type { RateRule } from '../../../vendor/scm/lib/delivery-rate-card-queries';
import {
  BILLABLE_JOB_TYPES, JOB_LABEL, OUTSTATION_DEFAULT_APPLIES_TO, appliesToOf, type BillableJobType,
} from '../../../vendor/scm/lib/rate-rule-taxonomy';

const isSurcharge = (r: RateRule) => r.ruleType === 'OUTSTATION' || r.ruleType === 'OUTSTATION_TRIP';

/** A rule's jobs: what the server read back, else read from its params. */
export const jobsOf = (r: Pick<RateRule, 'appliesTo' | 'params'>): BillableJobType[] =>
  appliesToOf({ appliesTo: r.appliesTo ?? (r.params as Record<string, unknown> | null)?.appliesTo ?? null });

export const isDefaultJobs = (jobs: readonly string[]): boolean =>
  jobs.length === OUTSTATION_DEFAULT_APPLIES_TO.length && OUTSTATION_DEFAULT_APPLIES_TO.every((j) => jobs.includes(j));

/** "Delivery order, Setup". */
export const jobsLabel = (jobs: readonly BillableJobType[]): string => jobs.map((j) => JOB_LABEL[j]).join(', ');

/** The list with one job ticked or unticked, in DP order; the last one stays. */
export function toggleJob(jobs: readonly BillableJobType[], job: BillableJobType): BillableJobType[] {
  const next = jobs.includes(job) ? jobs.filter((j) => j !== job) : [...jobs, job];
  return next.length === 0 ? [...jobs] : BILLABLE_JOB_TYPES.filter((j) => next.includes(j));
}

/** What the card's town prices add to, when they all say the same; null when
 *  they differ (each town then shows its own) or the card has none. */
export function sharedJobs(rules: readonly RateRule[]): BillableJobType[] | null {
  const lists = rules.filter(isSurcharge).map(jobsOf);
  if (lists.length === 0) return null;
  const first = lists[0].join(',');
  return lists.every((l) => l.join(',') === first) ? lists[0] : null;
}

/** The card prices this destination with an outstation price, but none of
 *  them applies to this job: Price check says so instead of staying silent. */
export function surchargeSkipped(rules: readonly RateRule[], town: string, job: BillableJobType): boolean {
  const t = town.trim().toUpperCase();
  if (!t) return false;
  const here = rules.filter((r) => isSurcharge(r) && (r.zone ?? '').trim().toUpperCase() === t);
  return here.length > 0 && !here.some((r) => jobsOf(r).includes(job));
}
