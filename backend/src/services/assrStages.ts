/**
 * Which service-case stages are TERMINAL — one definition, for every query that
 * has to ask "is this case still open?".
 *
 * There are two terminal stages, not one. `completed` is the resolution; `voided`
 * is the alt-outcome the office uses when a case should never have been raised
 * (wrong customer, duplicate, withdrawn). Both stamp `closed_at`
 * (`services/assr.ts` — `if (newStage === "completed" || newStage === "voided")`),
 * and `stageLabel` renders both as "Closed".
 *
 * Every open/backlog/aging/SLA query in this codebase nevertheless wrote
 * `stage != 'completed'` by hand — 30-odd copies of a predicate that names ONE
 * of the two. So a voided case stayed in the backlog count, kept aging, went on
 * breaching its SLA, and — the part that reached people — was picked up by the
 * daily escalation cron, which stamped `escalated_at`, wrote an activity row and
 * emailed the assignee plus every `service_cases.manage` holder about a case
 * that had been deliberately closed. Voiding a case is exactly what someone does
 * to make it stop mattering.
 *
 * The CLOSED side is deliberately NOT collapsed into this. `stage = 'completed'`
 * drives the resolved counts and the average-resolution-time figures; a voided
 * case was not resolved, and folding it in would flatter those numbers. "Not
 * open" and "resolved" are different questions, and this file answers only the
 * first.
 *
 * SQL fragment rather than a value list, because these are raw `env.DB.prepare`
 * strings and a NULL stage (legacy rows) must read as OPEN — `stage NOT IN (…)`
 * alone is NULL, which is not TRUE, so those rows would silently leave every
 * backlog count. The explicit `IS NULL` arm is what preserves them.
 */
export const ASSR_TERMINAL_STAGES = ["completed", "voided"] as const;

/**
 * `TRUE` for a case that is still open. Pass the table alias used by the query
 * (`"c"` for `assr_cases c`, `""` when the query has no alias).
 */
export function assrOpenStageSql(alias = ""): string {
  const p = alias ? `${alias}.` : "";
  const list = ASSR_TERMINAL_STAGES.map((s) => `'${s}'`).join(", ");
  return `(${p}stage IS NULL OR ${p}stage NOT IN (${list}))`;
}
