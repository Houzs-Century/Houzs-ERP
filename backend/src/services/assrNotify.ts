// ─────────────────────────────────────────────────────────────────────────
// assrNotify.ts — in-app notification when a Service Case (ASSR) is created or
// its responsible person changes.
//
// Owner spec 2026-07-15: when a service case is created OR its responsible
// agent/assignee changes, the responsible person AND their recursive upline
// (pyramid reporting-to) get an in-app notice. Same delivery model as the
// scan → Sales Order flow: a PRIVATE announcement (source='service_case') that
// surfaces on the /banner unread dot + Profile badge + Announcements screen.
// No WhatsApp / web-push (explicitly deferred).
//
// "Responsible" people on a case:
//   · assigned_to / assigned_to_2 — the service-desk owner(s) (users.id).
//   · sales_agent — the free-text salesperson NAME mirrored from AutoCount
//     (no id linkage on the row), resolved here to users.id by exact name.
// Each resolved id is expanded UP its manager_id chain (uplineUserIds) so the
// whole reporting line above the responsible person is notified too. Ids are
// de-duped before the single announcement insert.
//
// Best-effort: this NEVER throws — a notify failure must not fail the case
// create/assign. postPersonalNotice already swallows insert errors; the outer
// try/catch guards the id-resolution queries.
// ─────────────────────────────────────────────────────────────────────────

import type { Env } from "../types";
import { uplineUserIds } from "./orgScope";
import { postPersonalNotice } from "./personalNotice";
import { fmtDateTime } from "../scm/shared/format";

/** users.id rows whose display name matches `name` (lowercased, trimmed). */
async function resolveUserIdsByName(env: Env, name: string): Promise<number[]> {
  const n = name.trim().toLowerCase();
  if (!n) return [];
  const rows = await env.DB.prepare(
    `SELECT id FROM users WHERE LOWER(TRIM(name)) = ?`,
  )
    .bind(n)
    .all<{ id: number }>();
  return (rows.results ?? [])
    .map((r) => Number(r.id))
    .filter((id) => Number.isFinite(id) && id > 0);
}

/** Display names for the given user ids, input order preserved, blanks dropped.
 *  Used to NAME the new responsible person in the reassigned notice title so two
 *  reassignments of one case are distinguishable (owner 2026-07-20). */
async function resolveUserNamesByIds(env: Env, ids: number[]): Promise<string[]> {
  const clean = [...new Set(ids.filter((n) => Number.isFinite(n) && n > 0))];
  if (clean.length === 0) return [];
  const rows = await env.DB.prepare(
    `SELECT id, name FROM users WHERE id IN (${clean.map(() => "?").join(",")})`,
  )
    .bind(...clean)
    .all<{ id: number; name: string | null }>();
  const byId = new Map<number, string>();
  for (const r of rows.results ?? []) {
    const nm = (r.name ?? "").trim();
    if (nm) byId.set(Number(r.id), nm);
  }
  return clean.map((id) => byId.get(id)).filter((s): s is string => !!s);
}

// The notice is posted from a UTC Worker; fmtDateTime stamps the reassignment
// moment in Malaysia time (UTC+8, no DST) so the body reads at the wall-clock
// the office saw. This used to be a fifth hand-rolled copy of that shift.
const fmtMytDateTime = fmtDateTime;

export async function notifyServiceCaseResponsible(
  env: Env,
  opts: {
    reason: "created" | "reassigned";
    assrNo: string | null;
    customerName: string | null;
    /** Direct responsible users (assigned_to / assigned_to_2). */
    userIds?: Array<number | null | undefined>;
    /** Free-text sales_agent name(s) to resolve to users.id. */
    agentNames?: Array<string | null | undefined>;
  },
): Promise<void> {
  try {
    // 1. Collect the PRIMARY responsible ids: explicit assignees + any user
    //    whose name matches a sales_agent free-text value.
    const primary = new Set<number>();
    for (const v of opts.userIds ?? []) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) primary.add(n);
    }
    for (const name of opts.agentNames ?? []) {
      if (!name) continue;
      for (const id of await resolveUserIdsByName(env, name)) primary.add(id);
    }
    if (primary.size === 0) return; // nobody resolvable → nothing to notify

    // 2. Expand each primary id UP the reporting chain (self + all managers),
    //    then de-dupe the union.
    const targets = new Set<number>();
    for (const id of primary) {
      for (const up of await uplineUserIds(env, id)) targets.add(up);
    }
    if (targets.size === 0) return;

    // 3. English admin copy — no emoji (repo rule). Case number + customer +
    //    short reason.
    const assr = (opts.assrNo ?? "").trim() || "(new)";
    const customer = (opts.customerName ?? "").trim();
    const forWhom = customer ? ` for ${customer}` : "";
    // NAME the new responsible person(s) so two reassignments of one case read
    // differently (owner 2026-07-20 — identical "… reassigned" titles looked
    // like an accidental double-post). The label is the CHANGED assignee(s):
    // the free-text agent name(s) as given + the explicit assignee id(s)
    // resolved to display names — never the upline audience.
    const picLabel =
      opts.reason === "reassigned"
        ? [
            ...(opts.agentNames ?? []).map((n) => (n ?? "").trim()).filter(Boolean),
            ...(await resolveUserNamesByIds(
              env,
              (opts.userIds ?? []).map((v) => Number(v)),
            )),
          ]
            .filter((v, i, a) => a.indexOf(v) === i)
            .join(" · ")
        : "";
    // Timestamp lives in the BODY, not the title, so the title stays a stable
    // dedup key (postPersonalNotice de-dupes an identical still-unacked notice).
    const stamp = `${fmtMytDateTime(new Date())} MYT`;
    const title =
      opts.reason === "created"
        ? `New service case ${assr}`
        : picLabel
          ? `Service case ${assr} reassigned to ${picLabel}`
          : `Service case ${assr} reassigned`;
    const body =
      opts.reason === "created"
        ? `A new service case ${assr}${forWhom} has been created and assigned to your team.`
        : picLabel
          ? `Service case ${assr}${forWhom} was reassigned to ${picLabel} on ${stamp}.`
          : `Service case ${assr}${forWhom} now has a new responsible person (as of ${stamp}).`;

    await postPersonalNotice(env, {
      userIds: [...targets],
      category: "GENERAL",
      title,
      body,
      source: "service_case",
    });
  } catch (e) {
    console.error("[assr-notify] notify failed:", (e as Error).message);
  }
}
