import type { Env } from "../types";
// Case-level SLA clock — its own module (see assrSla.ts header). Re-exported
// because callers and tests have imported slaHoursFor from here since mig 065.
import { slaHoursFor, slaHoursForPriority } from "./assrSla";
export { slaHoursFor, slaHoursForPriority };
import { todayMyt } from "../scm/lib/my-time";
import { assrOpenStageSql } from "./assrStages";
import { isServiceLine } from "../scm/shared/service-sku";
import { AutoCountClient, cleanPhone } from "./autocount";
import { normalizePhone } from "../scm/shared/phone";
import { resolveCreditorForCase } from "./stockItems";
import { getActiveStaffToken } from "./caseTracking";
import { getSupabaseService, isSupabaseConfigured } from "../db/supabase";
import { assrVisibilityPredicateSql } from "./assrVisibility";

// ── Types ─────────────────────────────────────────────────────

export interface CreateAssrInput {
  doc_no: string;
  items: { item_code: string; item_description?: string; qty?: number }[];
  complaint_issue: string;
  /** Optional issue taxonomy entry captured at create time. Free-text
   *  string ("Product defect", "Missing / short item", or admin
   *  custom). Replaces the older service_category-driven flow on the
   *  intake form. */
  issue_category?: string | null;
  /** Optional priority slug — drives both `sla_hours` and the per-stage
   *  target snapshot (mig 082). Defaults to 'normal' when omitted. */
  priority?: string | null;
  /** Optional complaint date (assr_cases.complained_date) captured at
   *  intake as `YYYY-MM-DD`. Defaults to today (MYT) when omitted. */
  complained_date?: string | null;
  /** Customer reference (the SO's own customer docket, e.g. "HC14032").
   *  When omitted the AutoCount SO context's Ref is used as fallback. */
  ref_no?: string | null;
  /** Customer contact email captured at intake. */
  customer_email?: string | null;
  /** Product category. Multi-select since 2026-08: an array of names or
   *  slugs from the current UI, or a comma string from anything older. */
  service_category?: string | string[] | null;
  /** Operations PIC — assr_cases.assigned_to. When provided, overrides
   *  the admin-configured default assignee. */
  assigned_to?: number | null;
  created_by?: number;
  /** Multi-company (Phase 0b) — the active company (companies.id) resolved
   *  from the request via activeCompanyId(c). Left undefined pre-migration /
   *  cold-start; createAssrCase then falls back to the Houzs default and, if
   *  that too is unresolvable, omits the column entirely (single-company safe). */
  company_id?: number;
}

// v3.1 9-stage workflow. Old enum (registration / triage / action /
// logistics / resolution / closed) was renamed in mig 074. Inspection
// is now its own stage, and the legacy "logistics" stage split into 4
// explicit handover steps (item pickup / supplier pickup / item ready
// / delivery).
export type Stage =
  | "pending_review"            // Stage 1 — Service Admin
  | "under_verification"        // Stage 2 — Service Admin
  | "pending_solution"          // Stage 3 — Service Admin / Manager pick the fix
  //  (pending_inspection retired 2026-07-14 — inspection folded into
  //   Under Verification as inspect_by + QC-issue fields; mig 0105.
  //   pending_item_pickup retired 2026-07-14 too — the customer-side
  //   collection lives inside the Supplier stage now; mig 0110)
  | "pending_supplier_pickup"   // Stage 4 — supplier pickup AND return leg
  | "pending_item_ready"        // Stage 5 — QC after the supplier returns it
  | "pending_delivery_service"  // Stage 6 — SA assigns Logistic Admin
  | "completed"                 // Stage 7 — system
  //  voided — terminal alt-outcome (Nico 2026-07-29): the case was
  //  verified as not valid / not warranty-covered, so it closes here
  //  instead of running Solution → Supplier → Delivery. Parallel to
  //  'completed', NOT a pipeline step.
  | "voided";

type Priority = "low" | "normal" | "high" | "urgent";


// Maps stage → user-facing status (backward compat for legacy list
// renderers that still read `status`).
function statusForStage(stage: Stage): string {
  if (stage === "pending_review") return "Open";
  if (stage === "completed" || stage === "voided") return "Closed";
  return "In Progress";
}

// Stage transitions are unrestricted — ops can revert (e.g. flip a
// completed case back when the customer reports the same issue) or
// skip (proposal §8.3 legitimate skips: Replace Unit with in-stock SKU
// skips inspection + supplier pickup + item ready; Field Service Own
// Team skips supplier pickup + item ready; Return Visit skips item
// pickup + supplier pickup + item ready). The CHECK on the column
// still bounds the value set so bad inputs fail loud.
export const ALL_STAGES: ReadonlyArray<Stage> = [
  "pending_review",
  "pending_solution",
  "under_verification",
  "pending_supplier_pickup",
  "pending_item_ready",
  "pending_delivery_service",
  "completed",
  "voided",
];

// Default per-stage target days (proposal §8.1 — Normal profile).
// Phase B replaces this fallback with a lookup against the active
// assr_lead_time_profiles + assr_stage_targets row.
const DEFAULT_STAGE_TARGET_DAYS: Record<Stage, number> = {
  pending_review: 1,
  under_verification: 2,
  pending_solution: 2,
  pending_supplier_pickup: 3,
  pending_item_ready: 5,
  pending_delivery_service: 4,
  completed: 0,
  voided: 0,
};

/**
 * Snapshot of the per-stage target in days at the moment a case
 * enters that stage. Lookup order (mig 082 layered the priority
 * source on top of the existing profile):
 *
 *   1. The case's priority — `assr_priority_stage_targets` row for
 *      this (priority_slug, stage). Allows Urgent / Low to compress
 *      or stretch each stage independently.
 *   2. The currently-active Lead Time profile (mig 075) — fallback
 *      for legacy cases without a priority or priorities that haven't
 *      had targets defined yet.
 *   3. The hardcoded Normal defaults — last-resort safety net so a
 *      stage transition can never crash on missing config.
 */
async function lookupStageTargetDays(
  env: Env,
  stage: Stage,
  prioritySlug?: string | null
): Promise<number> {
  if (prioritySlug) {
    try {
      const row = await env.DB.prepare(
        `SELECT t.target_days
           FROM assr_priority_stage_targets t
           JOIN assr_priorities p ON p.id = t.priority_id
          WHERE p.slug = ? AND t.stage = ?
          LIMIT 1`
      )
        .bind(prioritySlug, stage)
        .first<{ target_days: number }>();
      if (row?.target_days != null) return row.target_days;
    } catch (e) {
      console.warn("[assr.lookupStageTargetDays] priority read failed:", e);
    }
  }
  try {
    const row = await env.DB.prepare(
      `SELECT t.target_days
         FROM assr_stage_targets t
         JOIN assr_lead_time_profiles p ON p.id = t.profile_id
        WHERE p.is_active = 1 AND t.stage = ?
        LIMIT 1`
    )
      .bind(stage)
      .first<{ target_days: number }>();
    if (row?.target_days != null) return row.target_days;
  } catch (e) {
    console.warn("[assr.lookupStageTargetDays] profile read failed:", e);
  }
  return DEFAULT_STAGE_TARGET_DAYS[stage] ?? 0;
}

/**
 * Returns the active Lead Time profile id, or null if none exists.
 * Stamped onto `assr_cases.lead_time_profile_id` at create time so
 * SLA accounting stays deterministic across amendments.
 */
export async function getActiveLeadTimeProfileId(env: Env): Promise<number | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT id FROM assr_lead_time_profiles WHERE is_active = 1 LIMIT 1`
    ).first<{ id: number }>();
    return row?.id ?? null;
  } catch (e) {
    console.warn("[assr.getActiveLeadTimeProfileId] read failed:", e);
    return null;
  }
}

// ── PO number generator (internal / service-issued) ───────────

/**
 * Generates the next internal service PO number in format
 * APO/YYMM-NNN (Assr Purchase Order). Sequence resets each month
 * and is based on the highest existing po_no in assr_cases that
 * matches the prefix — no dedicated counter table.
 */
export async function nextServicePONumber(env: Env): Promise<string> {
  const now = new Date();
  const yy = String(now.getUTCFullYear()).slice(-2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const prefix = `APO/${yy}${mm}`;

  const row = await env.DB.prepare(
    `SELECT po_no FROM assr_cases
      WHERE po_no LIKE ?
      ORDER BY po_no DESC LIMIT 1`
  )
    .bind(`${prefix}-%`)
    .first<{ po_no: string }>();

  let next = 1;
  if (row?.po_no) {
    const seq = parseInt(row.po_no.split("-")[1] ?? "", 10);
    if (!isNaN(seq)) next = seq + 1;
  }
  return `${prefix}-${String(next).padStart(3, "0")}`;
}

// ── ASSR number generator ─────────────────────────────────────

export async function nextAssrNumber(env: Env): Promise<string> {
  const now = new Date();
  const yy = String(now.getUTCFullYear()).slice(-2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const prefix = `ASSR/${yy}${mm}`;

  const row = await env.DB.prepare(
    `SELECT assr_no FROM assr_cases WHERE assr_no LIKE ? ORDER BY assr_no DESC LIMIT 1`
  )
    .bind(`${prefix}-%`)
    .first<{ assr_no: string }>();

  let next = 1;
  if (row?.assr_no) {
    const parts = row.assr_no.split("-");
    const seq = parseInt(parts[1] || "", 10);
    if (!isNaN(seq)) next = seq + 1;
  }
  return `${prefix}-${String(next).padStart(3, "0")}`;
}

// ── Company resolution (multi-company Phase 0b) ───────────────
//
// Service Cases are a CROSS-COMPANY queue, but each case still carries its
// owning company_id so the shared list can show + split by company. Resolve
// order (owner 2026-07-20 — 2990 runs Service Cases on the merged platform):
// the SO's OWN company when the doc resolves to a local scm."mfg_sales_orders"
// row (a case belongs to its order's company, whatever the creator's switcher
// says) → the request's company (passed from the route via
// assrCreateCompanyId(c): the caller's active switcher company) → the Houzs
// default. AutoCount-keyed Houzs docs carry no local company_id, so for them
// the route's value stays authoritative.
//
// Returns null when nothing is resolvable (companies master absent
// pre-migration, or a DB cold-start). The INSERT then omits the column,
// mirroring stampCompany's no-op so single-company Houzs keeps inserting
// unchanged.
async function resolveCaseCompanyId(
  env: Env,
  activeCompanyId?: number | null
): Promise<number | null> {
  if (activeCompanyId != null) return activeCompanyId;
  try {
    const row = await env.DB.prepare(
      `SELECT id FROM companies WHERE code = 'HOUZS' LIMIT 1`
    ).first<{ id: number | string }>();
    return row?.id != null ? Number(row.id) : null;
  } catch {
    return null;
  }
}

// ── SCM SO context (multi-company create path) ────────────────
//
// The platform-native SO row for a doc number, shaped like the AutoCount
// getSingle context so createAssrCase's binds stay source-agnostic, plus the
// SO's owning company_id (drives the case's company stamp). It covers 2990
// orders (live-mirrored into scm."mfg_sales_orders") and Houzs SCM-native
// orders that never reached AutoCount. Returns null when the doc is not
// there — or when the scm schema itself is absent (D1 test mirror,
// pre-migration) — so the caller falls through to the AutoCount path.
async function fetchScmSoContext(
  env: Env,
  docNo: string
): Promise<{ context: Record<string, unknown>; company_id: number | null } | null> {
  try {
    // 2990 SOs leave the free-text `agent` blank and carry the rep as
    // salesperson_id -> scm.staff, so COALESCE to that name — else a 2990
    // case's Sales Agent lands empty. (No `--` comments inside the SQL: the
    // d1-compat shim folds it to one line and would comment out the tail.)
    const row = await env.DB.prepare(
      `SELECT o.debtor_name, o.phone, o.sales_location,
              COALESCE(NULLIF(o.agent, ''), sp.name) AS agent,
              o.ref, o.address1, o.address2, o.address3, o.address4, o.company_id
         FROM scm."mfg_sales_orders" o
         LEFT JOIN scm.staff sp ON sp.id = o.salesperson_id
        WHERE LOWER(o.doc_no) = LOWER(?)
          AND o.status <> 'DRAFT' AND o.status <> 'CANCELLED'
        LIMIT 1`
    )
      .bind(docNo)
      .first<{
        debtor_name: string | null;
        phone: string | null;
        sales_location: string | null;
        agent: string | null;
        ref: string | null;
        address1: string | null;
        address2: string | null;
        address3: string | null;
        address4: string | null;
        company_id: number | string | null;
      }>();
    if (!row) return null;
    return {
      context: {
        DebtorName: row.debtor_name ?? null,
        Phone1: row.phone ?? null,
        SalesLocation: row.sales_location ?? null,
        SalesAgent: row.agent ?? null,
        // AutoCount-specific UDF (the internal service PO) — no SCM equivalent.
        SOUDF_ToPONo: null,
        InvAddr1: row.address1 ?? null,
        InvAddr2: row.address2 ?? null,
        InvAddr3: row.address3 ?? null,
        InvAddr4: row.address4 ?? null,
        Ref: row.ref ?? null,
      },
      company_id: row.company_id != null ? Number(row.company_id) : null,
    };
  } catch {
    // scm schema absent (D1 test mirror / pre-migration) or a transient DB
    // error — treat as "not an SCM doc" and let the AutoCount path decide.
    return null;
  }
}

// ── Create case ───────────────────────────────────────────────

export async function createAssrCase(
  env: Env,
  input: CreateAssrInput
): Promise<{ assr_no: string; id: number }> {
  // SO context — SCM-first (owner 2026-07-20: 2990 runs Service Cases on the
  // merged platform). The AutoCount and SCM doc spaces don't overlap in
  // practice, so legacy Houzs docs miss the scm lookup and take the unchanged
  // getSingle path.
  let context: any = null;
  let soCompanyId: number | null = null;
  const scmSo = await fetchScmSoContext(env, input.doc_no);
  if (scmSo) {
    context = scmSo.context;
    soCompanyId = scmSo.company_id;
  } else {
    const client = new AutoCountClient(env);
    try {
      context = await client.getSingle(input.doc_no);
    } catch (e) {
      console.warn(`[assr] getSingle failed for ${input.doc_no}`, e);
    }
  }

  // `let`, not `const` — the create loop below takes a FRESH number when the
  // unique guard (mig 0218 / D1 135) reports a concurrent create won the race.
  let assrNo = await nextAssrNumber(env);
  const today = todayMyt();
  // complained_date — honour an explicit intake value (validated to a
  // strict YYYY-MM-DD), else default to today (MYT). Anything malformed
  // falls back to today so the column never takes a junk string.
  const complainedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(input.complained_date ?? ""))
    ? String(input.complained_date)
    : today;
  // Use first item_code for the legacy column
  const firstItem = input.items[0]?.item_code ?? null;

  // SLA window from the case's priority (defaults to 'normal' when intake
  // didn't pick one). Read from assr_priorities on every create so a Service
  // Maintenance edit takes effect without a deploy — same reason the default
  // assignee below is read here rather than cached. Priority is stored as the
  // slug on assr_cases.priority; mig 082 also drives per-stage targets off it.
  const prioritySlug = input.priority ?? "normal";
  const slaHours = await slaHoursForPriority(env, prioritySlug);
  const deadlineAt = new Date(Date.now() + slaHours * 3600 * 1000).toISOString();

  // Optional default assignee — admin sets this in Settings → Service.
  // Read it on every create so a setting change takes effect without a
  // deploy. Falls back to NULL (unassigned) if missing or malformed.
  // An explicit PIC picked at intake (input.assigned_to) takes
  // precedence over the admin default.
  let defaultAssigneeId: number | null = null;
  let defaultAssignee2Id: number | null = null;
  if (input.assigned_to != null) {
    defaultAssigneeId = input.assigned_to;
  } else {
    try {
      const rows = await env.DB.prepare(
        `SELECT key, value FROM system_settings
          WHERE key IN ('assr_default_assignee_id', 'assr_default_assignee2_id')`
      ).all<{ key: string; value: string | null }>();
      for (const r of rows.results ?? []) {
        if (r.value == null) continue;
        const n = parseInt(r.value, 10);
        if (isNaN(n)) continue;
        if (r.key === "assr_default_assignee_id") defaultAssigneeId = n;
        else defaultAssignee2Id = n;
      }
      // The same person twice adds nothing — keep the co-slot empty.
      if (defaultAssignee2Id === defaultAssigneeId) defaultAssignee2Id = null;
    } catch (e) {
      console.warn("[assr.create] could not read default assignees:", e);
    }
  }

  // v3.1 — new cases enter Stage 1 (pending_review). Stage target is
  // snapshotted from the active profile so the alert engine has a
  // deterministic SLA even if the portal is amended later. The
  // lead_time_profile_id is stamped so reporting can show which
  // profile each case ran under.
  const initialStage: Stage = "pending_review";
  // Mig 082 — pass the priority slug so the lookup checks priority
  // targets before falling back to the active Lead Time profile.
  const initialTargetDays = await lookupStageTargetDays(env, initialStage, prioritySlug);
  const activeProfileId = await getActiveLeadTimeProfileId(env);
  const nowIso = new Date().toISOString();

  // Multi-company (Phase 0b): stamp the owning company — the SO's own company
  // outranks the request's (see resolveCaseCompanyId's doc). Append the column
  // + bind ONLY when resolved so the pre-migration / cold-start window (no
  // companies master, no company_id column yet) inserts unchanged.
  const companyId = await resolveCaseCompanyId(env, soCompanyId ?? input.company_id);
  const companyCol = companyId != null ? ", company_id" : "";
  const companyPlaceholder = companyId != null ? ", ?" : "";

  /* Product Category is multi-select, so the caller may send an array. It
     has to be folded into the display string BEFORE the INSERT binds it —
     binding an array trips D1_TYPE_ERROR. The join rows are written once we
     have an id, below. */
  const categories = input.service_category != null
    ? await resolveCategories(env, parseCategoryInput(input.service_category))
    : null;

  /* Guarded take-a-number. nextAssrNumber is read-max-then-+1 with no lock,
     so two concurrent creates can mint the same number — that is exactly how
     the 8 grandfathered 2604 duplicates happened. The partial unique index
     (PG mig 0218, D1 135) turns the race into a constraint error; losing
     racer takes a fresh number and retries. Bounded so a NON-race unique
     error (or an index misconfiguration) still surfaces instead of looping. */
  let result: Awaited<ReturnType<ReturnType<typeof env.DB.prepare>["run"]>> | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      result = await insertCase();
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < 3 && /unique|duplicate/i.test(msg)) {
        assrNo = await nextAssrNumber(env);
        continue;
      }
      throw e;
    }
  }

  function insertCase() {
    return env.DB.prepare(
    `INSERT INTO assr_cases (
       assr_no, status, stage, doc_no, complained_date, customer_name, phone, location,
       sales_agent, item_code, complaint_issue, issue_category, priority, po_no, addr1, addr2, addr3, addr4, created_by,
       ref_no, customer_email, service_category, delivery_order, do_date,
       assigned_to, assigned_to_2, sla_hours, deadline_at,
       stage_entered_at, stage_target_days, stage_changed_at, lead_time_profile_id${companyCol}
     ) VALUES (?, 'Open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${companyPlaceholder})`
  )
    .bind(
      assrNo,
      initialStage,
      input.doc_no,
      complainedDate,
      context?.DebtorName ?? null,
      normalizePhone(context?.Phone1) ?? cleanPhone(context?.Phone1),
      context?.SalesLocation ?? null,
      context?.SalesAgent ?? null,
      firstItem,
      input.complaint_issue,
      input.issue_category ?? null,
      prioritySlug,
      context?.SOUDF_ToPONo ?? null,
      context?.InvAddr1 ?? null,
      context?.InvAddr2 ?? null,
      context?.InvAddr3 ?? null,
      context?.InvAddr4 ?? null,
      input.created_by ?? null,
      // ref_no <- the SO's own customer reference (the pre-printed
      // customer docket, e.g. "HC14032"), distinct from the internal
      // service PO which maps to po_no above via SOUDF_ToPONo. An
      // explicit intake value wins; else fall back to the SO context.
      input.ref_no ?? context?.Ref ?? null,
      // customer_email / service_category <- captured on the intake
      // form so a case is created complete rather than backfilled.
      input.customer_email ?? null,
      categories?.display ?? null,
      // delivery_order / do_date <- the SO's linked DO. The AutoCount
      // /SalesOrder/getSingle context does not expose a DO doc no or
      // date, so these stay NULL at create time (case manager fills
      // them via PATCH). Bound explicitly so the columns stay covered
      // if the context ever starts carrying DO fields.
      null,
      null,
      defaultAssigneeId,
      defaultAssignee2Id,
      slaHours,
      deadlineAt,
      nowIso,
      initialTargetDays,
      nowIso,
      activeProfileId,
      ...(companyId != null ? [companyId] : [])
    )
    .run();
  }

  const assrId = result!.meta.last_row_id as number;

  // Seed the per-stage lifecycle row for Stage 1 so the Workflow
  // Progress Tracker has data and the alert engine has a target.
  // alerts_fired = 1 stamps FLAG_ENTERED so the scanner doesn't
  // double-fire on first tick.
  await env.DB.prepare(
    `INSERT INTO assr_stage_history (assr_id, stage, entered_at, target_days, alerts_fired)
     VALUES (?, ?, ?, ?, 1)`
  )
    .bind(assrId, initialStage, nowIso, initialTargetDays)
    .run();

  // Insert items
  for (const item of input.items) {
    await env.DB.prepare(
      `INSERT INTO assr_items (assr_id, item_code, item_description, qty)
       VALUES (?, ?, ?, ?)`
    )
      .bind(assrId, item.item_code, item.item_description ?? null, item.qty ?? 1)
      .run();
  }

  // The display string went in with the INSERT; the queryable rows need the
  // id, so they land here.
  if (categories?.slugs.length) await writeCaseCategories(env, assrId, categories.slugs);

  // Activity log
  await logActivity(env, assrId, "created", null, initialStage, null, input.created_by);

  // Log the default assignment so the timeline reflects who got it.
  if (defaultAssigneeId != null) {
    await logActivity(
      env,
      assrId,
      "assignment",
      null,
      String(defaultAssigneeId),
      "default assignee",
      input.created_by
    );
  }
  if (defaultAssignee2Id != null) {
    await logActivity(
      env,
      assrId,
      "assignment_2",
      null,
      String(defaultAssignee2Id),
      "default co-assignee",
      input.created_by
    );
  }

  // Fire-and-forget creditor resolution from the primary item. A
  // failed lookup (item unknown upstream, network, etc.) must not
  // block case creation — the case is already committed above.
  if (firstItem) {
    resolveCreditorForCase(env, assrId, firstItem).catch((e) =>
      console.warn(`[assr.create] creditor resolve failed for ${assrNo}:`, e?.message || e)
    );
  }

  return { assr_no: assrNo, id: assrId };
}

// ── Product categories (multi-select) ────────────────────────
//
// A case can be more than one category (mattress AND bedframe on the same
// complaint), so assr_case_categories holds one row per category — that is
// what grouping/counting must read, because a comma-joined string cannot
// count a Bedframe+Mattress case once on each side.
//
// assr_cases.service_category stays the DISPLAY value (comma-joined names,
// lookup order) because ~50 read sites — list column, CSV export, print,
// both portals, mobile — only ever render it. Both are written here and
// nowhere else, so they cannot drift.

/** "Bedframe, Mattress" | ["Bedframe","mattress"] | ["bed_frame"] -> tokens. */
function parseCategoryInput(v: unknown): string[] {
  const raw = Array.isArray(v)
    ? v.map((x) => String(x ?? ""))
    : String(v ?? "").split(",");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    const s = t.trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/**
 * Resolve caller tokens against the lookup by slug OR name (both
 * case-insensitive). Unrecognised tokens are NOT dropped — they survive in
 * the display string, matching the form's rule that a legacy/unknown value
 * stays selectable so reopening a case never silently discards it. They
 * simply get no row in the join table, i.e. they stay uncategorised for
 * reporting, exactly like the cases that never had a category at all.
 */
async function resolveCategories(
  env: Env,
  tokens: string[],
): Promise<{ display: string | null; slugs: string[] }> {
  if (!tokens.length) return { display: null, slugs: [] };
  const rows = await env.DB.prepare(
    `SELECT slug, name, sort_order FROM assr_product_categories`,
  ).all<{ slug: string; name: string; sort_order: number }>();
  const lookup = rows.results ?? [];
  const bySlug = new Map(lookup.map((r) => [r.slug.toLowerCase(), r]));
  const byName = new Map(lookup.map((r) => [r.name.trim().toLowerCase(), r]));

  const matched: { slug: string; name: string; sort_order: number }[] = [];
  const unknown: string[] = [];
  for (const t of tokens) {
    const hit = bySlug.get(t.toLowerCase()) ?? byName.get(t.toLowerCase());
    if (hit) matched.push(hit);
    else unknown.push(t);
  }
  matched.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  const display = [...matched.map((m) => m.name), ...unknown].join(", ");
  return { display: display || null, slugs: matched.map((m) => m.slug) };
}

/** Replace a case's category rows. Delete-then-insert: the caller always
 *  sends the complete set, so a removed category must disappear. */
async function writeCaseCategories(env: Env, caseId: number, slugs: string[]) {
  await env.DB.prepare(`DELETE FROM assr_case_categories WHERE case_id = ?`)
    .bind(caseId)
    .run();
  for (const slug of slugs) {
    await env.DB.prepare(
      `INSERT INTO assr_case_categories (case_id, slug) VALUES (?, ?)`,
    )
      .bind(caseId, slug)
      .run();
  }
}

/** The categories a case carries, in lookup order, as display names. */
export async function getCaseCategories(env: Env, caseId: number): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT p.name
       FROM assr_case_categories cc
       JOIN assr_product_categories p ON p.slug = cc.slug
      WHERE cc.case_id = ?
      ORDER BY p.sort_order ASC, p.name ASC`,
  )
    .bind(caseId)
    .all<{ name: string }>();
  return (rows.results ?? []).map((r) => r.name);
}

// ── Detail (composite) ───────────────────────────────────────

export async function getAssrDetail(env: Env, id: number) {
  const caseRow = await env.DB.prepare(
    `SELECT c.*,
            u1.name as assigned_to_name,
            u2.name as created_by_name,
            u3.name as approved_by_name,
            u4.name as verified_by_name,
            u5.name as assigned_to_2_name,
            cr.company_name as creditor_name,
            cr.email as creditor_email,
            cr.phone1 as creditor_phone,
            cr.mobile as creditor_mobile,
            cr.attention as creditor_attention,
            co.code as company_code,
            CAST((julianday(c.deadline_at) - julianday('now')) * 24 AS INTEGER) as hours_to_deadline,
            CASE
              WHEN NOT ${assrOpenStageSql("c")} THEN 0
              WHEN c.deadline_at IS NOT NULL AND datetime('now') > c.deadline_at THEN 1
              ELSE 0
            END as is_breached
       FROM assr_cases c
       LEFT JOIN users u1 ON u1.id = c.assigned_to
       LEFT JOIN users u2 ON u2.id = c.created_by
       LEFT JOIN users u3 ON u3.id = c.approved_by
       LEFT JOIN users u4 ON u4.id = c.verified_by
       LEFT JOIN users u5 ON u5.id = c.assigned_to_2
       LEFT JOIN creditors cr ON cr.creditor_code = c.creditor_code
       LEFT JOIN companies co ON co.id = c.company_id
      WHERE c.id = ?`
  )
    .bind(id)
    .first<any>();
  if (!caseRow) return null;

  // Same DO resolution the list does (transfer_to → ref-matched mirror →
  // SCM fallback) so the detail page's DO field also fills for cases
  // whose hand-entered delivery_order was never set — which is nearly
  // all of them.
  await attachDeliveryOrders(env, [caseRow]);

  const items = await env.DB.prepare(
    `SELECT * FROM assr_items WHERE assr_id = ? ORDER BY id`
  )
    .bind(id)
    .all();

  // Child queries filter out archived rows by default. If/when a
  // manager needs to see archived children, add an endpoint that
  // takes ?include_archived=1 for surgical audits.
  const attachments = await env.DB.prepare(
    `SELECT * FROM assr_attachments
      WHERE assr_id = ? AND archived_at IS NULL
      ORDER BY created_at DESC`
  )
    .bind(id)
    .all();

  const activity = await env.DB.prepare(
    `SELECT a.*, u.name as user_name
       FROM assr_activity a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.assr_id = ? AND a.archived_at IS NULL
      ORDER BY a.created_at DESC`
  )
    .bind(id)
    .all();

  const logistics = await env.DB.prepare(
    `SELECT l.*, u.name as assigned_to_name
       FROM assr_logistics l
       LEFT JOIN users u ON u.id = l.assigned_to
      WHERE l.assr_id = ? AND l.archived_at IS NULL
      ORDER BY l.created_at DESC`
  )
    .bind(id)
    .all();

  // v3.1 — per-stage lifecycle for the Workflow Progress Tracker.
  // Returns one row per stage (entered + exited timestamps), ordered
  // chronologically. The Tracker UI walks this list to colour completed
  // / current / skipped / future nodes.
  const stageHistory = await env.DB.prepare(
    `SELECT id, stage, entered_at, exited_at, target_days, status,
            skipped, skip_reason, alerts_fired, snoozes_applied
       FROM assr_stage_history
      WHERE assr_id = ?
      ORDER BY entered_at ASC, id ASC`
  )
    .bind(id)
    .all();

  const relatedPOs = await env.DB.prepare(
    `SELECT * FROM purchase_orders WHERE so_doc_no = ? ORDER BY doc_date DESC`
  )
    .bind(caseRow.doc_no)
    .all();

  // Active portal link (if any) so the staff UI can show the existing
  // link on panel-open instead of forcing a regenerate each time.
  const portalToken = await getActiveStaffToken(env, id);

  return {
    case: caseRow,
    // The multi-select form needs the categories as a list; the flat
    // service_category string on `case` stays for every read-only site.
    service_categories: await getCaseCategories(env, id),
    items: items.results ?? [],
    attachments: attachments.results ?? [],
    activity: activity.results ?? [],
    logistics: logistics.results ?? [],
    related_pos: relatedPOs.results ?? [],
    portal_token: portalToken,
    stage_history: stageHistory.results ?? [],
  };
}

// ── Stage transition ──────────────────────────────────────────

export async function transitionStage(
  env: Env,
  id: number,
  newStage: Stage,
  userId: number,
  note?: string,
  sourceChannel: string = "app",
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT stage, stage_entered_at, stage_target_days, priority FROM assr_cases WHERE id = ?`
  )
    .bind(id)
    .first<{ stage: Stage; stage_entered_at: string | null; stage_target_days: number | null; priority: string | null }>();
  if (!row) return false;

  if (!ALL_STAGES.includes(newStage)) {
    throw new Error(`Unknown stage: ${newStage}`);
  }
  // No-op when the stage hasn't actually changed.
  if (row.stage === newStage) return true;

  const newStatus = statusForStage(newStage);
  // Mig 082 — priority-driven per-stage targets. Falls back to active
  // Lead Time profile when the priority has no targets defined.
  const newTargetDays = await lookupStageTargetDays(env, newStage, row.priority);
  const nowIso = new Date().toISOString();
  // stage_changed_at + stage_entered_at both get refreshed so the
  // "days in stage" lead-time column reads cleanly without scanning
  // the activity log. stage_target_days snapshots the new target.
  const sets = [
    "stage = ?",
    "status = ?",
    "stage_changed_at = ?",
    "stage_entered_at = ?",
    "stage_target_days = ?",
    "updated_at = datetime('now')",
  ];
  const binds: any[] = [newStage, newStatus, nowIso, nowIso, newTargetDays];

  // Nick 2026-07-15 — switchable sub-status (小类). Entering a stage
  // that has sub-states seeds its first one; every other stage clears
  // the field so a stale value can't leak across stages. Ops switches
  // it afterwards via PATCH sub_status.
  const subDefault =
    newStage === "under_verification"
      ? "pending_inspection"
      : newStage === "pending_supplier_pickup"
        ? // Customer-pickup leg first (Nico 2026-09-01): the stage begins by
          // collecting the item FROM the customer; ops advances the sub to
          // supplier pickup / return as the item moves.
          "pending_customer_pickup"
        : null;
  sets.push("sub_status = ?");
  binds.push(subDefault);

  // Both terminal stages stop the SLA clock (closed_at). Only a genuine
  // 'completed' stamps completion_date + feeds the satisfaction survey;
  // 'voided' (not valid / not warranty-covered) closes without either,
  // so it stays out of the completed count + CSAT.
  // NB the D1 test mirror's stage CHECK does not yet list 'voided'
  // (prod PG carries no CHECK); don't add a voided-writing DB test there.
  if (newStage === "completed" || newStage === "voided") {
    sets.push("closed_at = ?");
    binds.push(nowIso);
  }
  if (newStage === "completed") {
    sets.push("completion_date = ?");
    binds.push(nowIso.slice(0, 10));
  }

  binds.push(id);
  await env.DB.prepare(
    `UPDATE assr_cases SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run();

  // Close the prior open stage-history row (set exited_at = now) and
  // insert a new open row for the new stage. The "open" row is
  // identified by exited_at IS NULL.
  await env.DB.prepare(
    `UPDATE assr_stage_history
        SET exited_at = ?
      WHERE assr_id = ? AND exited_at IS NULL`
  )
    .bind(nowIso, id)
    .run();

  // alerts_fired = 1 stamps the FLAG_ENTERED bit so the v3.1 alert
  // scanner (services/assrAlerts.ts) doesn't re-fire the entered
  // event on its next tick — the in-app timeline + assignment row
  // already cover "stage entered" notification.
  await env.DB.prepare(
    `INSERT INTO assr_stage_history (assr_id, stage, entered_at, target_days, alerts_fired)
     VALUES (?, ?, ?, ?, 1)`
  )
    .bind(id, newStage, nowIso, newTargetDays)
    .run();

  // v3.1 (mig 077): stamp how long the OLD stage took + what its
  // target was, plus the request's source_channel so the timeline can
  // distinguish app/portal/email-driven moves.
  let elapsedDays: number | null = null;
  if (row.stage_entered_at) {
    const enteredMs = new Date(
      row.stage_entered_at.endsWith("Z") ? row.stage_entered_at : row.stage_entered_at + "Z"
    ).getTime();
    elapsedDays = (Date.now() - enteredMs) / (1000 * 60 * 60 * 24);
  }
  await logActivity(env, id, "stage_change", row.stage, newStage, note ?? null, userId, {
    category: "system",
    stage_elapsed_days: elapsedDays,
    stage_target_days: row.stage_target_days,
    source_channel: sourceChannel,
  });
  return true;
}

// ── Admin-open auto-advance ───────────────────────────────────
//
// Mig 106 — Service Admin opens a pending_review case → the case
// auto-advances to under_verification and the activity log stamps
// who did it. No-op when the case is already past pending_review or
// when the caller doesn't have write permission (route enforces that
// gate; the service function itself is trust-based).
export async function markCaseOpened(
  env: Env,
  id: number,
  userId: number,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT stage FROM assr_cases WHERE id = ?`
  )
    .bind(id)
    .first<{ stage: Stage }>();
  if (!row) return false;
  if (row.stage !== "pending_review") return false;
  // Order change (Nico 2026-08-11): Solution now precedes Verification,
  // so first-open auto-advance lands on Pending Solution.
  return transitionStage(
    env,
    id,
    "pending_solution",
    userId,
    "auto-advanced when Service Admin opened the case",
  );
}

// ── Patch case fields ─────────────────────────────────────────

const PATCH_FIELDS = [
  // doc_no is editable since 2026-07-14 — sales fat-finger the SO no at
  // intake and the case never matches its customer. Changing it also
  // re-matches identity fields from the local SO mirror (see below).
  "doc_no",
  "customer_name", "customer_email", "phone", "location", "sales_agent", "item_code",
  "complaint_issue", "action_remark", "service_category",
  "completion_date", "po_no", "resolution_method", "issue_category",
  "priority", "assigned_to", "assigned_to_2", "ref_no", "delivery_order", "do_date",
  "satisfaction_rating", "satisfaction_notes",
  "addr1", "addr2", "addr3", "addr4",
  // QMS additions
  "ncr_category", "quality_review_passed",
  "po_amount", "customer_amount", "supplier_invoice_ref", "cost_notes",
  // SLA fields — allow manual override (ops can extend a deadline)
  "sla_hours", "deadline_at",
  // Mig 064 — supplier handover + ready dates
  "supplier_pickup_at", "items_ready_at",
  // Mig 107 — date we collect the faulty item from the customer's house
  "customer_pickup_at",
  // Mig 127 — on-site OWN-TEAM inspection visit date, de-conflated from
  // customer_pickup_at; drives a distinct INSPECTION leg on Delivery Planning.
  "inspection_visit_at",
  // Mig 074 — v3.1 fields
  "inspection_result", "email_for_survey",
  // Mig 081 — verification card (Under Verification → Pending Solution gate)
  "verification_outcome", "verified_root_cause",
  // Mig 105 — editable QC-on-receipt inspection date (distinct from
  // the auto-stamped verified_at audit timestamp).
  "qc_receipt_date",
  // Mig 106 — paperwork that travels with the item between Houzs and
  // supplier. Both are free text; ops edits goods_returned_note from
  // the main case, supplier edits supplier_service_note from the
  // supplier portal.
  "goods_returned_note", "supplier_service_note",
  // Mig 0073 — who performs the issue inspection: 'own' | 'supplier'.
  // Own-team inspections link into delivery planning for the visit.
  // Lives on the Under Verification stage since mig 0105.
  "inspection_by",
  "pickup_by",
  // Mig 0105 — QC-on-receipt result (pass/fail/na), shown next to
  // qc_receipt_date in the Verification stage panel.
  "qc_issue_result",
  // Nick 2026-07-15 — switchable sub-status (小类) inside Verification
  // and Supplier. Values are allow-listed in the PATCH route.
  "sub_status",
  // Void reason (Nico 2026-07-29) — why the case is not valid /
  // not warranty-covered, captured when it moves to 'voided'.
  "void_reason",
] as const;

// Human labels for the append-only per-field timeline audit. Anything not
// listed falls back to a prettified column name.
const FIELD_LABELS: Record<string, string> = {
  doc_no: "SO No", customer_name: "Customer Name", customer_email: "Customer Email",
  phone: "Phone", location: "Location", sales_agent: "Sales Agent", item_code: "Item Code",
  complaint_issue: "Complaint", action_remark: "Action Remark", service_category: "Service Category",
  completion_date: "Completion Date", po_no: "PO No", resolution_method: "Resolution Method",
  issue_category: "Issue Category", priority: "Priority", ref_no: "Reference No",
  delivery_order: "Delivery Order", do_date: "DO Date",
  satisfaction_rating: "Satisfaction Rating", satisfaction_notes: "Satisfaction Notes",
  addr1: "Address 1", addr2: "Address 2", addr3: "Address 3", addr4: "Address 4",
  ncr_category: "NCR Category", quality_review_passed: "Quality Review Passed",
  po_amount: "PO Amount", customer_amount: "Customer Amount",
  supplier_invoice_ref: "Supplier Invoice Ref", cost_notes: "Cost Notes",
  sla_hours: "SLA Hours", deadline_at: "Deadline",
  supplier_pickup_at: "Supplier Pickup Date", items_ready_at: "Supplier Return / Item Ready Date",
  customer_pickup_at: "Customer Pickup Date", inspection_visit_at: "Inspection Visit Date",
  inspection_result: "Inspection Result", email_for_survey: "Survey Email",
  verification_outcome: "Verification Outcome", verified_root_cause: "Verified Root Cause",
  qc_receipt_date: "QC Receipt Date", goods_returned_note: "Goods Returned Note",
  supplier_service_note: "Supplier Service Note", inspection_by: "Inspection By", pickup_by: "Pickup By",
  qc_issue_result: "QC Result",
};
// Only DATE and REMARK/note edits are worth a timeline entry (owner
// 2026-07-21 — "record date + remark, the rest no need"). Everything else
// (resolution method, verification outcome, priority, costs, identity, …)
// is config noise and is NOT recorded. Photos/files/videos are logged
// separately as attachment events, and item remarks via item_remark.
const FIELD_LOG_ALLOW = new Set<string>([
  // dates
  "customer_pickup_at", "supplier_pickup_at", "items_ready_at",
  "completion_date", "do_date", "qc_receipt_date",
  // remarks / free-text notes
  "goods_returned_note", "supplier_service_note", "action_remark", "satisfaction_notes",
]);
const fieldLabel = (k: string): string =>
  FIELD_LABELS[k] ?? k.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
const fieldDisplay = (v: any): string => {
  if (v === null || v === undefined || v === "") return "(empty)";
  const s = String(v);
  return s.length > 120 ? s.slice(0, 117) + "..." : s;
};

export async function patchAssrCase(
  env: Env,
  id: number,
  body: Record<string, any>,
  userId: number
): Promise<boolean> {
  const sets: string[] = [];
  const binds: any[] = [];

  // Correcting the SO number re-matches the customer identity from the
  // local sales_orders mirror (the AutoCount live API is disconnected —
  // AUTOCOUNT_SYNC_DISABLED — so this is the same source search-so
  // suggests from). Only fields the caller did NOT explicitly send are
  // refreshed, so a combined manual edit still wins. No mirror hit →
  // just the doc_no changes (mirror is frozen; new SOs may be absent).
  let prevDocNo: string | null = null;
  if ("doc_no" in body && typeof body.doc_no === "string" && body.doc_no.trim()) {
    body.doc_no = body.doc_no.trim();
    const prev = await env.DB.prepare(
      `SELECT doc_no FROM assr_cases WHERE id = ?`
    )
      .bind(id)
      .first<{ doc_no: string | null }>();
    prevDocNo = prev?.doc_no ?? null;
    if (prevDocNo !== body.doc_no) {
      let so = await env.DB.prepare(
        `SELECT ref, debtor_name, phone, sales_agent
           FROM sales_orders WHERE LOWER(doc_no) = LOWER(?)`
      )
        .bind(body.doc_no)
        .first<{ ref: string | null; debtor_name: string | null; phone: string | null; sales_agent: string | null }>();
      // 2990 / SCM-native SOs never reach the HOUZS AutoCount `sales_orders`
      // mirror, so a re-match to a 2990 doc found nothing and left the customer
      // blank. Fall back to the scm order table — the same source createAssrCase
      // hydrates from — so re-matching a 2990 SO fills the identity too. Same
      // "only fields the caller didn't send" rule applies below.
      if (!so) {
        const scm = await fetchScmSoContext(env, body.doc_no);
        if (scm) {
          so = {
            ref: (scm.context.Ref as string | null) ?? null,
            debtor_name: (scm.context.DebtorName as string | null) ?? null,
            phone: (scm.context.Phone1 as string | null) ?? null,
            sales_agent: (scm.context.SalesAgent as string | null) ?? null,
          };
        }
      }
      if (so) {
        if (!("customer_name" in body) && so.debtor_name) body.customer_name = so.debtor_name;
        if (!("phone" in body) && so.phone) body.phone = normalizePhone(so.phone) ?? cleanPhone(so.phone);
        if (!("sales_agent" in body) && so.sales_agent) body.sales_agent = so.sales_agent;
        if (!("ref_no" in body) && so.ref) body.ref_no = so.ref;
      }
    }
  } else if ("doc_no" in body) {
    // Blank / non-string doc_no would orphan the case from its SO —
    // ignore rather than null the linkage.
    delete body.doc_no;
  }

  // Snapshot the pre-update values of every auditable field, so each actual
  // change can be written to the timeline as an append-only entry. A later
  // edit or removal never erases the earlier recorded value — the history
  // stays fully reviewable.
  const beforeSnapshot = await env.DB.prepare(
    `SELECT ${PATCH_FIELDS.join(", ")} FROM assr_cases WHERE id = ?`
  )
    .bind(id)
    .first<Record<string, any>>();

  // Product Category is multi-select. Normalise the incoming value (array
  // from the current UI, comma string from anything older) into the display
  // form BEFORE the generic loop writes the column, and remember the slugs
  // so the join rows can be rewritten once the UPDATE lands.
  let pendingCategorySlugs: string[] | null = null;
  if ("service_category" in body) {
    const cats = await resolveCategories(env, parseCategoryInput(body.service_category));
    body.service_category = cats.display;
    pendingCategorySlugs = cats.slugs;
  }

  for (const k of PATCH_FIELDS) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push(body[k] ?? null);
    }
  }
  if (!sets.length) return false;

  // Mig 081 — when QA sets the verification outcome, server-stamp
  // verified_at + verified_by so the actor can't be spoofed from the
  // client. Clearing the outcome clears the stamps too. NULL the
  // verified_by FK when userId is 0/falsy (no auth context) — anything
  // else would trip the foreign-key constraint.
  if ("verification_outcome" in body) {
    if (body.verification_outcome) {
      sets.push("verified_at = datetime('now')", "verified_by = ?");
      binds.push(userId && userId > 0 ? userId : null);
    } else {
      sets.push("verified_at = NULL", "verified_by = NULL");
    }
  }

  // Sub-status switches land on the timeline as system events (like
  // stage changes) — capture the old value for the diff.
  let prevSubStatus: string | null = null;
  if ("sub_status" in body) {
    const prev = await env.DB.prepare(
      `SELECT sub_status FROM assr_cases WHERE id = ?`
    )
      .bind(id)
      .first<{ sub_status: string | null }>();
    prevSubStatus = prev?.sub_status ?? null;
  }

  // For audited fields (complaint_issue), capture the OLD value so the
  // service-log row reflects an actual diff, not just "edited at X".
  let prevComplaint: string | null = null;
  if ("complaint_issue" in body) {
    const prev = await env.DB.prepare(
      `SELECT complaint_issue FROM assr_cases WHERE id = ?`
    )
      .bind(id)
      .first<{ complaint_issue: string | null }>();
    prevComplaint = prev?.complaint_issue ?? null;
  }

  // When priority changes (and deadline isn't being set explicitly in the
  // same request), recompute deadline_at off the case's created_at so the
  // SLA clock tracks the new priority band.
  if ("priority" in body && !("deadline_at" in body) && !("sla_hours" in body)) {
    const newHours = await slaHoursForPriority(env, body.priority);
    const row = await env.DB.prepare(
      `SELECT created_at FROM assr_cases WHERE id = ?`
    )
      .bind(id)
      .first<{ created_at: string }>();
    if (row?.created_at) {
      const newDeadline = new Date(new Date(row.created_at).getTime() + newHours * 3600 * 1000).toISOString();
      sets.push("sla_hours = ?", "deadline_at = ?");
      binds.push(newHours, newDeadline);
    }
  }

  sets.push("updated_at = datetime('now')");
  binds.push(id);

  const r = await env.DB.prepare(
    `UPDATE assr_cases SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run();

  if (pendingCategorySlugs) await writeCaseCategories(env, id, pendingCategorySlugs);

  // Log assignment changes
  if ("assigned_to" in body) {
    await logActivity(env, id, "assignment", null, String(body.assigned_to ?? ""), null, userId);
  }
  if ("assigned_to_2" in body) {
    await logActivity(env, id, "assignment_2", null, String(body.assigned_to_2 ?? ""), null, userId);
  }

  if ("sub_status" in body && (prevSubStatus ?? null) !== (body.sub_status ?? null)) {
    const SUB_LABELS: Record<string, string> = {
      pending_inspection: "Pending Inspection",
      qc_issue_result: "QC Issue Result",
      pending_supplier_pickup: "Pending Supplier Pickup",
      pending_supplier_return: "Pending Supplier Return",
    };
    await logActivity(
      env,
      id,
      "sub_status_change",
      prevSubStatus,
      body.sub_status ?? null,
      body.sub_status
        ? `Sub-status → ${SUB_LABELS[body.sub_status] ?? body.sub_status}`
        : "Sub-status cleared",
      userId,
      { category: "system", source_channel: "app" }
    );
  }

  // Audit SO-number corrections — the case's whole customer identity
  // hangs off this key, so the change (and what it re-matched) must be
  // visible in the service log.
  if (prevDocNo !== null && "doc_no" in body && prevDocNo !== body.doc_no) {
    await logActivity(env, id, "so_changed", prevDocNo, body.doc_no, null, userId, {
      category: "service",
      source_channel: "app",
    });
  }

  // Audit complaint edits so the customer-facing description has a
  // diffable trail in the service log (mig 077).
  if ("complaint_issue" in body) {
    const next = body.complaint_issue ?? null;
    if ((prevComplaint ?? null) !== (next ?? null)) {
      await logActivity(
        env,
        id,
        "complaint_edited",
        prevComplaint,
        next,
        null,
        userId,
        { category: "customer" }
      );
    }
  }

  // Append-only per-field audit — records ONLY date + remark/note edits
  // (FIELD_LOG_ALLOW); all other field changes are config noise and are not
  // logged (owner 2026-07-21).
  for (const k of PATCH_FIELDS) {
    if (!(k in body) || !FIELD_LOG_ALLOW.has(k)) continue;
    const before = beforeSnapshot ? beforeSnapshot[k] ?? null : null;
    const after = body[k] ?? null;
    if (String(before ?? "") === String(after ?? "")) continue;
    await logActivity(
      env,
      id,
      "field_change",
      before === null ? null : String(before),
      after === null ? null : String(after),
      `${fieldLabel(k)}: ${fieldDisplay(before)} → ${fieldDisplay(after)}`,
      userId,
      { category: "service", source_channel: "app" }
    );
  }

  // When the case's item_code changes, re-resolve the creditor so the
  // link to the procurement supplier stays accurate. Fire-and-forget —
  // a failed lookup shouldn't fail the PATCH.
  if ("item_code" in body) {
    resolveCreditorForCase(env, id, body.item_code ?? null).catch((e) =>
      console.warn(`[assr.patch] creditor resolve failed for case=${id}:`, e?.message || e)
    );
  }

  return r.meta.changes > 0;
}

// ── Manual creditor assignment ────────────────────────────────
// AutoCount can't resolve every item (MainSupplier gaps, creditor sync
// off), so staff may hand-pick the supplier. creditor_source='manual'
// shields the choice from the auto-resolver and the bulk stock
// refresh; the explicit "Resolve now" (force) hands it back to
// AutoCount. Clearing the link resets the source so auto-resolution
// applies again.
export async function setCaseCreditorManual(
  env: Env,
  id: number,
  creditorCode: string | null,
  userId: number | null
): Promise<
  | { ok: true; creditor_name: string | null }
  | { ok: false; status: 400 | 404; error: string }
> {
  const existing = await env.DB.prepare(
    `SELECT creditor_code FROM assr_cases WHERE id = ? AND archived_at IS NULL`
  )
    .bind(id)
    .first<{ creditor_code: string | null }>();
  if (!existing) return { ok: false, status: 404, error: "Case not found" };

  let creditorName: string | null = null;
  if (creditorCode) {
    const cr = await env.DB.prepare(
      `SELECT company_name FROM creditors WHERE creditor_code = ?`
    )
      .bind(creditorCode)
      .first<{ company_name: string | null }>();
    if (!cr) {
      return {
        ok: false,
        status: 400,
        error: "Unknown supplier code — pick one from the search results or add it first",
      };
    }
    creditorName = cr.company_name ?? null;
  }

  await env.DB.prepare(
    `UPDATE assr_cases SET creditor_code = ?, creditor_source = ?, updated_at = datetime('now') WHERE id = ?`
  )
    .bind(creditorCode, creditorCode ? "manual" : null, id)
    .run();

  if ((existing.creditor_code ?? null) !== (creditorCode ?? null)) {
    await logActivity(
      env,
      id,
      "creditor_set",
      existing.creditor_code ?? null,
      creditorCode,
      creditorCode
        ? `Supplier set manually${creditorName ? ` (${creditorName})` : ""}`
        : "Supplier link cleared",
      userId,
      { category: "supplier" }
    );
  }
  return { ok: true, creditor_name: creditorName };
}

// ── Items management ──────────────────────────────────────────

export async function addItems(
  env: Env,
  assrId: number,
  items: { item_code: string; item_description?: string; qty?: number; remark?: string | null }[]
) {
  for (const item of items) {
    await env.DB.prepare(
      `INSERT INTO assr_items (assr_id, item_code, item_description, qty, remark) VALUES (?, ?, ?, ?, ?)`
    )
      .bind(
        assrId,
        item.item_code,
        item.item_description ?? null,
        item.qty ?? 1,
        (item.remark ?? "").trim() || null
      )
      .run();
  }
}

export async function removeItem(env: Env, assrId: number, itemId: number) {
  await env.DB.prepare(
    `DELETE FROM assr_items WHERE id = ? AND assr_id = ?`
  )
    .bind(itemId, assrId)
    .run();
}

// Per-item remark (Nick 2026-07-15) — edited from the Product Info
// card, printed in the ITEMS table's REMARK column on both the
// customer and supplier copies.
export async function setItemRemark(
  env: Env,
  assrId: number,
  itemId: number,
  remark: string | null
): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE assr_items SET remark = ? WHERE id = ? AND assr_id = ?`
  )
    .bind(remark, itemId, assrId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

// Supplier-copy remark (Nick 2026-07-21: remark 分别给客户和 Supplier).
// `remark` stays the customer-copy text; this one prints on the
// Supplier Service Order only.
export async function setItemSupplierRemark(
  env: Env,
  assrId: number,
  itemId: number,
  remark: string | null
): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE assr_items SET supplier_remark = ? WHERE id = ? AND assr_id = ?`
  )
    .bind(remark, itemId, assrId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

// Per-item quantity (Nick 2026-07-20) — editable in the Product Info
// card; feeds the ITEMS table's QTY column on both print copies.
export async function setItemQty(
  env: Env,
  assrId: number,
  itemId: number,
  qty: number
): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE assr_items SET qty = ? WHERE id = ? AND assr_id = ?`
  )
    .bind(qty, itemId, assrId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

// Per-item carton quantity (owner 2026-07-21) — a second, user-selected
// quantity beside the per-set qty; feeds the ITEMS table's CTN column on
// both print copies.
export async function setItemCartonQty(
  env: Env,
  assrId: number,
  itemId: number,
  qtyCarton: number
): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE assr_items SET qty_carton = ? WHERE id = ? AND assr_id = ?`
  )
    .bind(qtyCarton, itemId, assrId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

// ── Attachments ───────────────────────────────────────────────

export function assrAttachmentKey(
  assrId: number,
  category: string,
  ext: string
): string {
  return `assr/${assrId}/${category}-${Date.now()}.${ext}`;
}

export async function saveAttachment(
  env: Env,
  assrId: number,
  r2Key: string,
  fileName: string | null,
  contentType: string,
  category: string,
  uploadedBy: number | null
): Promise<number> {
  // Set visible_to_customer explicitly so it never lands NULL: the
  // Postgres cut-over dropped the D1 `DEFAULT 1`, and a NULL flag is
  // treated as hidden on the customer print + portal. Staff still flip
  // it to 0 to hide a specific photo.
  const r = await env.DB.prepare(
    `INSERT INTO assr_attachments (assr_id, r2_key, file_name, content_type, category, uploaded_by, visible_to_customer)
     VALUES (?, ?, ?, ?, ?, ?, 1)`
  )
    .bind(assrId, r2Key, fileName, contentType, category, uploadedBy)
    .run();
  return r.meta.last_row_id as number;
}

// ── Logistics ─────────────────────────────────────────────────

export async function createLogistics(
  env: Env,
  assrId: number,
  body: { type: string; scheduled_date?: string; scheduled_time_range?: string; assigned_to?: number; notes?: string }
): Promise<number> {
  const r = await env.DB.prepare(
    `INSERT INTO assr_logistics (assr_id, type, scheduled_date, scheduled_time_range, assigned_to, notes)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      assrId,
      body.type,
      body.scheduled_date ?? null,
      body.scheduled_time_range ?? null,
      body.assigned_to ?? null,
      body.notes ?? null
    )
    .run();
  return r.meta.last_row_id as number;
}

export async function patchLogistics(
  env: Env,
  assrId: number,
  logId: number,
  body: Record<string, any>
): Promise<boolean> {
  const allowed = ["scheduled_date", "scheduled_time_range", "assigned_to", "status", "notes", "completed_at"];
  const sets: string[] = [];
  const binds: any[] = [];
  for (const k of allowed) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push(body[k] ?? null);
    }
  }
  if (!sets.length) return false;
  sets.push("updated_at = datetime('now')");
  binds.push(logId, assrId);
  const r = await env.DB.prepare(
    `UPDATE assr_logistics SET ${sets.join(", ")} WHERE id = ? AND assr_id = ?`
  )
    .bind(...binds)
    .run();
  return r.meta.changes > 0;
}

// ── SO item lookup ────────────────────────────────────────────

/**
 * Look up the line items for a Sales Order. Calls AutoCount's
 * /SalesOrder/getDetail/{docNo} endpoint for the authoritative list.
 * Falls back to the local purchase_orders table if the middleware is
 * unreachable so offline/degraded lookups still return something.
 */
export async function lookupSOItems(
  env: Env,
  docNo: string
): Promise<{ item_code: string; item_description: string | null; qty: number }[]> {
  // SCM-first (owner 2026-07-20 — 2990 Service Cases): 2990 orders and Houzs
  // SCM-native orders keep their line items in scm."mfg_sales_order_items";
  // AutoCount has never heard of these docs. Same per-item aggregation shape
  // as the AutoCount branch below; cancelled lines drop out. The scm schema is
  // absent on the D1 test mirror — the catch falls through to AutoCount.
  try {
    // No boolean literal, no uuid in ORDER BY, exact doc_no: keep the SQL to the
    // plain shape the env.DB (Hyperdrive) shim is proven to run for the sibling
    // scm."mfg_sales_orders" reads. `cancelled` is a REAL Postgres boolean on
    // the SCM table (2990's convention — not the Houzs 0/1 flag convention), so
    // the drop-cancelled filter runs in JS below rather than as a SQL predicate.
    // No ORDER BY: a 2990 SO whose lines all carry a NULL line_no (an import
    // that never stamped the ordinal) came back EMPTY through env.DB while an SO
    // with 0/1/2 line_no returned fine — ordering by an all-NULL column is the
    // only difference, and the picker doesn't need a guaranteed order anyway.
    const rows = await env.DB.prepare(
      `SELECT item_code, description, qty, cancelled
         FROM scm."mfg_sales_order_items"
        WHERE doc_no = ?
          AND item_code IS NOT NULL AND item_code <> ''`
    )
      .bind(docNo)
      .all<{ item_code: string; description: string | null; qty: number | null; cancelled: unknown }>();
    const scmSeen = new Map<string, { item_code: string; item_description: string | null; qty: number }>();
    for (const r of rows.results ?? []) {
      // Skip cancelled lines. Coerce every truthy encoding the driver/shim might
      // hand back for the boolean (true / 1 / 't' / 'true') to "cancelled".
      if (r.cancelled === true || r.cancelled === 1 || r.cancelled === "t" || r.cancelled === "true") continue;
      const code = (r.item_code ?? "").trim();
      if (!code) continue;
      // Owner audit 2026-07-22 — Service Case is about a defective product /
      // delivery/service problem, NOT the delivery-fee line itself. Filter out
      // every SVC-* line (SVC-DELIVERY, SVC-DISPOSE, SVC-LIFT, …) so the New
      // Case dialog never lets a salesperson tick a fee as the "item that has
      // an issue" (owner sighting: SVC-DELIVERY appeared in the picker).
      if (isServiceLine({ itemCode: code })) continue;
      const qty = Number(r.qty ?? 0) || 0;
      const existing = scmSeen.get(code);
      if (existing) {
        existing.qty += qty;
        if (!existing.item_description && r.description) existing.item_description = r.description;
      } else {
        scmSeen.set(code, { item_code: code, item_description: r.description ?? null, qty });
      }
    }
    if (scmSeen.size > 0) return [...scmSeen.values()];
  } catch (e) {
    // scm schema absent (D1 test mirror / pre-migration) is expected → fall
    // through to AutoCount. A REAL error here (the 2990 item-lookup miss we are
    // chasing) must not stay silent, so surface it to wrangler tail.
    console.warn(`[assr] scm item lookup failed for ${docNo}:`, (e as Error)?.message ?? e);
  }

  try {
    const client = new AutoCountClient(env);
    const details = await client.getDetail(docNo);
    const seen = new Map<string, { item_code: string; item_description: string | null; qty: number }>();
    for (const d of details ?? []) {
      const code = (d.ItemCode ?? "").trim();
      if (!code) continue;
      // Same service-line filter as the SCM branch above — SVC-* codes are
      // fees, not the item that has the issue.
      if (isServiceLine({ itemCode: code })) continue;
      const desc = d.Description ?? d.ItemDescription ?? null;
      const qty = Number(d.Qty ?? 0) || 0;
      const existing = seen.get(code);
      if (existing) {
        existing.qty += qty;
        if (!existing.item_description && desc) existing.item_description = desc;
      } else {
        seen.set(code, { item_code: code, item_description: desc, qty });
      }
    }
    if (seen.size > 0) return [...seen.values()];
  } catch (e) {
    console.warn(`[assr] getDetail failed for ${docNo}, falling back to purchase_orders`, e);
  }

  // Fallback: derive from locally-cached purchase_orders
  const rows = await env.DB.prepare(
    `SELECT DISTINCT item_code, item_description
       FROM purchase_orders
      WHERE so_doc_no = ? AND item_code IS NOT NULL
      ORDER BY item_code`
  )
    .bind(docNo)
    .all<{ item_code: string; item_description: string | null }>();
  // Same SVC-* filter for the purchase_orders fallback so no path leaks a fee.
  return (rows.results ?? [])
    .filter((r) => !isServiceLine({ itemCode: r.item_code }))
    .map((r) => ({ ...r, qty: 1 }));
}

// ── Listing ───────────────────────────────────────────────────

export interface ListAssrFilters {
  stage?: string;
  status?: string;
  search?: string;
  assigned_to?: number;
  creditor_code?: string;
  page?: number;
  per_page?: number;
  include_archived?: boolean;
  /** Show ONLY archived rows (Nick 2026-07-21: the Show-archived
   *  toggle is a separate archived list, not a merged view). */
  archived_only?: boolean;
  /** Comma-separated stage slugs to exclude. Used by the "Hide
   *  completed" toggle to drop finished cases from the working list
   *  without dropping them from the dataset. */
  exclude_stage?: string;
  /** Calendar date-window bound (inclusive, `yyyy-mm-dd`) applied to the
   *  column named by `date_field`. Lets the Cases Calendar fetch ONLY the
   *  viewed month grid instead of fetch-all (perf: no freeze at scale).
   *  Backward-compatible — omit both and no predicate is added, so the
   *  List view and every other caller are unaffected. */
  from?: string;
  to?: string;
  /** Which date column `from`/`to` bound. `reported` → complained_date;
   *  `deadline` → COALESCE(deadline_at, complained_date), mirroring the
   *  calendar's own day-bucketing so no in-window case is ever lost.
   *  Defaults to `reported`. Only consulted when `from`/`to` is set. */
  date_field?: "reported" | "deadline";
  sort_by?: string;
  sort_dir?: "asc" | "desc";
  /** Row-level visibility scope (owner spec 2026-07, amended 2026-08-20): the
   *  caller + their full manager_id downline chain (services/orgScope.ts).
   *  undefined = unrestricted (admin `*` / service_cases.manage / director). An
   *  empty array matches NOTHING (fail closed). What the ids are matched ON is
   *  `assrVisibilityPredicateSql` (services/assrVisibility.ts): created_by /
   *  assigned_to / assigned_to_2, plus the salesperson of the case's ERP-native
   *  SO. Cases whose SO is the AutoCount mirror (or resolves nowhere) are
   *  company-scoped only and ignore this list entirely. */
  visible_to_user_ids?: number[];
  /** Multi-company: the company ids ASSR is scoped to. EVERY caller — including
   *  rank-and-file sales — passes their GRANTED set. `undefined` = unresolved →
   *  no predicate; `[]` = granted nothing → matches nothing. NOT interchangeable.
   *  The HOUZS pin this used to describe was removed 2026-07-20; the trail and
   *  what a stale copy of it cost are in docs/modules/service-case.md. */
  allowed_company_ids?: number[];
}

/** Shared company-scope WHERE fragment for the raw-SQL ASSR readers. Receives
 *  the caller's granted company ids from the route (see the field above — the
 *  HOUZS pin this used to describe was removed on 2026-07-20). The ids come from
 *  OUR companies master (validated integers), so inlining is safe.
 *
 *  THREE STATES (see the sentinel doc on companyScope.allowedCompanyIds):
 *  `undefined` = unresolved → NO predicate (single-company behaviour, and the
 *  pre-migration / D1 / cold-start path). `[]` = the caller is granted no active
 *  company → a predicate that matches NOTHING. Non-empty = scope to those ids.
 *  Treating `[]` as "no predicate" here would hand a restricted caller every
 *  company's cases. */
function pushAllowedCompanies(where: string[], ids: number[] | undefined): void {
  if (ids === undefined) return;
  const clean = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (clean.length === 0) {
    where.push(`1=0`);
    return;
  }
  where.push(`c.company_id IN (${clean.join(",")})`);
}

/** WHERE fragment for the visibility scope on the paginated list and the CSV
 *  export.
 *
 *  It does not STATE the rule — `assrVisibilityPredicateSql`
 *  (services/assrVisibility.ts) does, and the aggregate endpoints, the detail
 *  GET and the printable all resolve through that same string. This used to be
 *  a hand-maintained twin of `assrVisibilitySql` in routes/assr.ts and the two
 *  drifted, which is the leak `fix/assr-aggregate-scope` had to close when the
 *  list and its own totals disagreed. There is nothing left here to keep in
 *  sync.
 *
 *  No binds: every id is inlined after being re-validated as a positive integer
 *  inside the predicate builder, the same justification `allowedCompaniesSql`
 *  gives. The list's bind array is positional, so having one fewer thing that
 *  can be spliced at the wrong offset is the point. */
function pushVisibilityScope(
  where: string[],
  ids: number[] | undefined,
): void {
  const pred = assrVisibilityPredicateSql(ids, "c.");
  if (pred === null) return; // unrestricted
  where.push(`(${pred})`);
}

// Allow-listed sort columns. Computed aliases (stage_since,
// days_in_stage, is_breached, hours_to_deadline) and joined names
// reference the SELECT list — the outer query is wrapped in
// FROM (…) sub so the ORDER BY can name them directly.
const ASSR_SORT_MAP: Record<string, string> = {
  id: "id",
  assr_no: "assr_no",
  doc_no: "doc_no",
  status: "status",
  stage: "stage",
  // Semantic severity order (ASC = urgent first), not the raw text column —
  // alphabetically 'high' sorted BELOW 'low'/'normal', so a priority sort
  // never surfaced High cases second. Unknown values sink to the end.
  priority: "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4 END",
  customer_name: "customer_name",
  complained_date: "complained_date",
  completion_date: "completion_date",
  deadline_at: "deadline_at",
  closed_at: "closed_at",
  assigned_to: "assigned_to_name",
  created_by: "created_by_name",
  stage_since: "stage_since",
  days_in_stage: "days_in_stage",
  // Mig 064 — supplier handover + ready milestones
  supplier_pickup_at: "supplier_pickup_at",
  items_ready_at: "items_ready_at",
  stage_changed_at: "stage_changed_at",
  hours_to_deadline: "hours_to_deadline",
  is_breached: "is_breached",
  created_at: "created_at",
  updated_at: "updated_at",
  creditor_code: "creditor_code",
  creditor_name: "creditor_name",
};

export async function listAssrCases(env: Env, f: ListAssrFilters) {
  const where: string[] = [];
  const binds: any[] = [];

  // Soft-delete filter: archived_only flips the list to ONLY archived
  // rows (the UI's Archived view); otherwise archived rows are hidden
  // unless explicitly merged in with ?include_archived=1.
  if (f.archived_only) where.push("c.archived_at IS NOT NULL");
  else if (!f.include_archived) where.push("c.archived_at IS NULL");

  if (f.stage) {
    const stages = f.stage.split(",").map((s) => s.trim()).filter(Boolean);
    if (stages.length === 1) {
      where.push("c.stage = ?");
      binds.push(stages[0]);
    } else if (stages.length > 1) {
      where.push(`c.stage IN (${stages.map(() => "?").join(",")})`);
      binds.push(...stages);
    }
  }
  if (f.exclude_stage) {
    const ex = f.exclude_stage.split(",").map((s) => s.trim()).filter(Boolean);
    if (ex.length === 1) {
      where.push("c.stage != ?");
      binds.push(ex[0]);
    } else if (ex.length > 1) {
      where.push(`c.stage NOT IN (${ex.map(() => "?").join(",")})`);
      binds.push(...ex);
    }
  }
  if (f.status) {
    where.push("c.status = ?");
    binds.push(f.status);
  }
  if (f.assigned_to != null) {
    where.push("(c.assigned_to = ? OR c.assigned_to_2 = ?)");
    binds.push(f.assigned_to, f.assigned_to);
  }
  if (f.creditor_code) {
    where.push("c.creditor_code = ?");
    binds.push(f.creditor_code);
  }
  if (f.search) {
    // Case-insensitive (PG LIKE is case-sensitive, unlike SQLite) and
    // covers the Ref No column too (Nick 2026-07-07). LOWER() instead
    // of ILIKE so the D1 test mirror stays happy.
    //
    // Restore mobile client-search coverage lost when the Service Case list
    // moved to server pagination: the old client search also matched the
    // complaint issue text and the item code / description. complaint_issue
    // and item_code are denormalized columns on assr_cases; item_description
    // lives only in the child assr_items table, matched via a correlated
    // EXISTS so it also works inside the COUNT(*) query (no assr_items join).
    // Additive — keeps case no / SO doc / Ref / customer. Salesperson
    // (sales_agent) matches too, alongside its list column (2026-07-27).
    // Also match customer PHONE. assr_cases.phone is stored separator-free
    // (write path runs cleanPhone(so.phone) — strips +/-/space), so a term the
    // user types with dashes/spaces is cleanPhone'd the SAME way before the
    // LIKE; the raw predicate still catches an exact-format substring.
    where.push(
      "(LOWER(c.assr_no) LIKE ? OR LOWER(c.doc_no) LIKE ? OR LOWER(c.ref_no) LIKE ? OR LOWER(c.customer_name) LIKE ? OR LOWER(c.sales_agent) LIKE ? OR LOWER(c.complaint_issue) LIKE ? OR LOWER(c.item_code) LIKE ? OR LOWER(c.phone) LIKE ? OR LOWER(c.phone) LIKE ? OR EXISTS (SELECT 1 FROM assr_items i WHERE i.assr_id = c.id AND (LOWER(i.item_code) LIKE ? OR LOWER(i.item_description) LIKE ?)))"
    );
    const like = `%${f.search.toLowerCase()}%`;
    const digits = cleanPhone(f.search);
    const phoneLike = digits ? `%${digits.toLowerCase()}%` : like;
    binds.push(like, like, like, like, like, like, like, like, phoneLike, like, like);
  }
  // Calendar date-window bound (perf/servicecase-board-calendar-bound):
  // the Cases Calendar passes the viewed month grid as from/to so it pulls
  // only that window instead of the whole active backlog. We compare on the
  // yyyy-mm-dd prefix (substr 1..10) so the predicate lines up EXACTLY with
  // the client-side day bucketing (raw.slice(0,10)) and is immune to the
  // stored time-of-day. `deadline` basis coalesces to complained_date to
  // match the calendar's own fallback, so no in-window case is dropped.
  // Additive — no from/to means no predicate (List view unaffected).
  if (f.from || f.to) {
    const dateCol =
      f.date_field === "deadline"
        ? "COALESCE(c.deadline_at, c.complained_date)"
        : "c.complained_date";
    if (f.from) {
      where.push(`substr(${dateCol}, 1, 10) >= ?`);
      binds.push(f.from);
    }
    if (f.to) {
      where.push(`substr(${dateCol}, 1, 10) <= ?`);
      binds.push(f.to);
    }
  }
  pushVisibilityScope(where, f.visible_to_user_ids);
  pushAllowedCompanies(where, f.allowed_company_ids);

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const page = f.page && f.page > 0 ? f.page : 1;
  const perPage = Math.min(f.per_page ?? 50, 200);
  const offset = (page - 1) * perPage;

  // stage_since: when the case entered its current stage.
  //   - If there is a stage_change activity to the current stage, use its created_at
  //   - Otherwise fall back to the case's created_at (still in initial stage)
  // days_in_stage: whole days elapsed (SQLite julianday diff, floored)
  // We wrap the SELECT in FROM (…) sub so the outer ORDER BY can
  // reference the computed aliases (stage_since, days_in_stage,
  // hours_to_deadline, is_breached) directly without re-computing.
  const sortExpr = f.sort_by ? ASSR_SORT_MAP[f.sort_by] : null;
  const sortDir = f.sort_dir === "asc" ? "ASC" : "DESC";
  const orderBy = sortExpr
    ? `ORDER BY ${sortExpr} ${sortDir}, id DESC`
    : `ORDER BY id DESC`;

  const baseSelect = `
    SELECT c.*, u.name as assigned_to_name, u2.name as created_by_name,
           ua2.name as assigned_to_2_name,
           cr.company_name as creditor_name,
           cr.email as creditor_email,
           cr.phone1 as creditor_phone,
           -- Multi-company (Phase 0b): Service Cases are a CROSS-COMPANY queue —
           -- c.* already carries c.company_id; join the companies master so each
           -- row also shows a readable company_code column. Raw SQL via env.DB, so
           -- this bypasses the supabase-js companyScope helper by necessity.
           co.code as company_code,
           (SELECT group_concat(i.item_code, ', ')
              FROM assr_items i
             WHERE i.assr_id = c.id
               AND i.item_code IS NOT NULL AND i.item_code != '') as items_codes,
           COALESCE(
             (SELECT MAX(a.created_at)
                FROM assr_activity a
               WHERE a.assr_id = c.id
                 AND a.action = 'stage_change'
                 AND a.to_value = c.stage),
             c.created_at
           ) as stage_since,
           CAST(
             julianday('now') - julianday(
               COALESCE(
                 (SELECT MAX(a.created_at)
                    FROM assr_activity a
                   WHERE a.assr_id = c.id
                     AND a.action = 'stage_change'
                     AND a.to_value = c.stage),
                 c.created_at
               )
             ) AS INTEGER
           ) as days_in_stage,
           CAST(
             (julianday(c.deadline_at) - julianday('now')) * 24 AS INTEGER
           ) as hours_to_deadline,
           CASE
             WHEN NOT ${assrOpenStageSql("c")} THEN 0
             WHEN c.deadline_at IS NOT NULL AND datetime('now') > c.deadline_at THEN 1
             ELSE 0
           END as is_breached
      FROM assr_cases c
      LEFT JOIN users u ON u.id = c.assigned_to
      LEFT JOIN users u2 ON u2.id = c.created_by
      LEFT JOIN users ua2 ON ua2.id = c.assigned_to_2
      LEFT JOIN creditors cr ON cr.creditor_code = c.creditor_code
      LEFT JOIN companies co ON co.id = c.company_id
    ${whereSql}
  `;

  // The COUNT and the page itself are independent reads over the same
  // predicate, so they go out as one wave instead of the count blocking the
  // rows. Both statements are unchanged; this only removes a serial round trip
  // from every list load (the pattern PR #416 used on the SO list).
  const [total, rows] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) as count FROM assr_cases c ${whereSql}`)
      .bind(...binds)
      .first<{ count: number }>(),
    env.DB.prepare(
      `SELECT * FROM (${baseSelect})
     ${orderBy}
     LIMIT ? OFFSET ?`
    )
      .bind(...binds, perPage, offset)
      .all(),
  ]);

  const data = rows.results ?? [];
  await attachDeliveryOrders(env, data as any[]);

  return {
    data,
    page,
    per_page: perPage,
    total: total?.count ?? 0,
  };
}

/** Attach live DO numbers as `do_numbers` on each row. The case table's own
 *  delivery_order column stays NULL at create time (the AutoCount SO
 *  context carries no DO doc no), so the list resolves DOs from the
 *  systems that actually issue them (Nico 2026-07-27):
 *
 *  1. Houzs cases — EXACT linkage first: `sales_orders.transfer_to`,
 *     AutoCount's own SO → DO transfer chain (computed by the
 *     middleware's SO getSince and persisted by the 5-min pull). Then
 *     WIDENED by the AutoCount DO mirror (mig 0215) on the shared
 *     customer Ref — partial deliveries cut several DOs but the SO
 *     header only points at one, and rows the pull hasn't re-touched
 *     predate the transfer_to column. Union of both, deduped.
 *     Ref-matching is case-insensitive ("znt4951" vs "ZNT6121"); the DO
 *     HEADER itself has no FromDocNo (that exists per detail line only),
 *     which is why Ref carries the linkage at all.
 *  2. 2990 / still-unmatched cases — the SCM module's scm.delivery_orders
 *     via its real so_doc_no column (Supabase).
 *
 *  Fail-soft by design: any lookup erroring (or Supabase being absent,
 *  e.g. the D1 test env) leaves rows without do_numbers — the list itself
 *  must never 500 over an enrichment column. Failures are logged, not
 *  swallowed silently. */
async function attachDeliveryOrders(env: Env, rows: any[]) {
  if (rows.length === 0) return;

  const houzs = rows.filter((r) => !r.company_code || r.company_code === "HOUZS");

  const bySoDo = new Map<string, string>();
  const soDocNos = [...new Set(houzs.map((r) => r.doc_no).filter(Boolean))] as string[];
  if (soDocNos.length > 0) {
    try {
      const q = await env.DB.prepare(
        `SELECT doc_no, transfer_to FROM sales_orders
          WHERE transfer_to IS NOT NULL AND doc_no IN (${soDocNos.map(() => "?").join(",")})`
      )
        .bind(...soDocNos)
        .all();
      for (const d of (q.results ?? []) as any[]) {
        // XS-prefixed docs are AutoCount's cancelled-transfer artifacts —
        // the SO pull filters those SOs out today, but older mirror rows
        // may still carry one; never show them as a live DO.
        const t = d.transfer_to != null ? String(d.transfer_to).trim() : "";
        if (d.doc_no && t && !/^xs/i.test(t)) bySoDo.set(String(d.doc_no), t);
      }
    } catch (e) {
      console.warn("[assr-list] SO transfer_to lookup failed:", e);
    }
  }

  const byRef = new Map<string, string[]>();
  const refs = [
    ...new Set(
      houzs
        .map((r) => String(r.ref_no ?? "").trim().toLowerCase())
        // A ref can only be a matching KEY if it carries at least one
        // letter/digit. Operators park "-" / "—" / "." in Ref on both sides,
        // and placeholders are SHARED, not identifying: prod carries 22
        // mirror DOs whose ref is "-", so a case whose ref_no is also "-"
        // (ASSR/2607-065, 2026-07-29) glued all 22 unrelated DOs onto
        // itself. `Boolean` alone let every non-empty placeholder through.
        .filter((s) => /[a-z0-9]/.test(s))
    ),
  ];
  if (refs.length > 0) {
    try {
      const q = await env.DB.prepare(
        `SELECT doc_no, ref FROM autocount_delivery_orders
          WHERE cancelled = 0 AND LOWER(ref) IN (${refs.map(() => "?").join(",")})`
      )
        .bind(...refs)
        .all();
      for (const d of (q.results ?? []) as any[]) {
        const key = String(d.ref || "").trim().toLowerCase();
        if (!key || !d.doc_no) continue;
        const list = byRef.get(key) ?? [];
        list.push(String(d.doc_no));
        byRef.set(key, list);
      }
    } catch (e) {
      console.warn("[assr-list] AutoCount DO-mirror lookup failed:", e);
    }
  }

  for (const r of houzs) {
    const hits = new Set<string>();
    const exact = bySoDo.get(r.doc_no);
    if (exact) hits.add(exact);
    for (const d of byRef.get(String(r.ref_no ?? "").trim().toLowerCase()) ?? []) hits.add(d);
    if (hits.size > 0) r.do_numbers = [...hits].sort().join(" · ");
  }

  if (!isSupabaseConfigured(env)) return;
  const rest = rows.filter((r) => !r.do_numbers);
  const docNos = [...new Set(rest.map((r) => r.doc_no).filter(Boolean))] as string[];
  if (docNos.length === 0) return;
  try {
    const sb = getSupabaseService(env);
    const { data, error } = await sb
      .from("delivery_orders")
      .select("so_doc_no, do_number")
      .in("so_doc_no", docNos)
      .order("do_number", { ascending: true });
    if (error) throw error;
    const bySo = new Map<string, string[]>();
    for (const d of data ?? []) {
      if (!d.so_doc_no || !d.do_number) continue;
      const list = bySo.get(d.so_doc_no) ?? [];
      list.push(d.do_number);
      bySo.set(d.so_doc_no, list);
    }
    for (const r of rest) {
      r.do_numbers = bySo.get(r.doc_no)?.join(" · ") ?? null;
    }
  } catch (e) {
    console.warn("[assr-list] SCM delivery-order merge skipped:", e);
  }
}

// Full dump used by the CSV export route. Honors the same filters
// as listAssrCases but skips pagination — caller is responsible for
// applying a sensible safety cap if needed.
export async function exportAssrCases(
  env: Env,
  f: Omit<ListAssrFilters, "page" | "per_page">
) {
  const where: string[] = [];
  const binds: any[] = [];
  if (f.archived_only) where.push("c.archived_at IS NOT NULL");
  else if (!f.include_archived) where.push("c.archived_at IS NULL");
  if (f.stage) {
    const stages = f.stage.split(",").map((s) => s.trim()).filter(Boolean);
    if (stages.length === 1) {
      where.push("c.stage = ?");
      binds.push(stages[0]);
    } else if (stages.length > 1) {
      where.push(`c.stage IN (${stages.map(() => "?").join(",")})`);
      binds.push(...stages);
    }
  }
  if (f.exclude_stage) {
    const ex = f.exclude_stage.split(",").map((s) => s.trim()).filter(Boolean);
    if (ex.length === 1) {
      where.push("c.stage != ?");
      binds.push(ex[0]);
    } else if (ex.length > 1) {
      where.push(`c.stage NOT IN (${ex.map(() => "?").join(",")})`);
      binds.push(...ex);
    }
  }
  if (f.status) {
    where.push("c.status = ?");
    binds.push(f.status);
  }
  if (f.assigned_to != null) {
    where.push("(c.assigned_to = ? OR c.assigned_to_2 = ?)");
    binds.push(f.assigned_to, f.assigned_to);
  }
  if (f.search) {
    // Case-insensitive (PG LIKE is case-sensitive, unlike SQLite) and
    // covers the Ref No column too (Nick 2026-07-07). LOWER() instead
    // of ILIKE so the D1 test mirror stays happy.
    //
    // Restore mobile client-search coverage lost when the Service Case list
    // moved to server pagination: the old client search also matched the
    // complaint issue text and the item code / description. complaint_issue
    // and item_code are denormalized columns on assr_cases; item_description
    // lives only in the child assr_items table, matched via a correlated
    // EXISTS so it also works inside the COUNT(*) query (no assr_items join).
    // Additive — keeps case no / SO doc / Ref / customer. Salesperson
    // (sales_agent) matches too, alongside its list column (2026-07-27).
    // Also match customer PHONE. assr_cases.phone is stored separator-free
    // (write path runs cleanPhone(so.phone) — strips +/-/space), so a term the
    // user types with dashes/spaces is cleanPhone'd the SAME way before the
    // LIKE; the raw predicate still catches an exact-format substring.
    where.push(
      "(LOWER(c.assr_no) LIKE ? OR LOWER(c.doc_no) LIKE ? OR LOWER(c.ref_no) LIKE ? OR LOWER(c.customer_name) LIKE ? OR LOWER(c.sales_agent) LIKE ? OR LOWER(c.complaint_issue) LIKE ? OR LOWER(c.item_code) LIKE ? OR LOWER(c.phone) LIKE ? OR LOWER(c.phone) LIKE ? OR EXISTS (SELECT 1 FROM assr_items i WHERE i.assr_id = c.id AND (LOWER(i.item_code) LIKE ? OR LOWER(i.item_description) LIKE ?)))"
    );
    const like = `%${f.search.toLowerCase()}%`;
    const digits = cleanPhone(f.search);
    const phoneLike = digits ? `%${digits.toLowerCase()}%` : like;
    binds.push(like, like, like, like, like, like, like, like, phoneLike, like, like);
  }
  pushVisibilityScope(where, f.visible_to_user_ids);
  pushAllowedCompanies(where, f.allowed_company_ids);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await env.DB.prepare(
    `SELECT c.assr_no, c.doc_no, c.ref_no, c.stage, c.status, c.priority,
            c.customer_name, c.phone AS customer_phone, c.location,
            c.sales_agent, c.delivery_order,
            c.service_category, c.ncr_category, c.resolution_method,
            c.item_code, c.complaint_issue,
            c.complained_date, c.created_at, c.deadline_at,
            c.po_amount, c.po_no,
            u.name as assigned_to_name, u2.name as created_by_name,
            c.creditor_code as creditor_code,
            cr.company_name as creditor_name,
            co.code as company_code,
            CASE WHEN NOT ${assrOpenStageSql("c")} THEN 0
              WHEN c.deadline_at IS NOT NULL AND datetime('now') > c.deadline_at THEN 1 ELSE 0 END as is_breached
       FROM assr_cases c
       LEFT JOIN users u ON u.id = c.assigned_to
       LEFT JOIN users u2 ON u2.id = c.created_by
       LEFT JOIN creditors cr ON cr.creditor_code = c.creditor_code
       LEFT JOIN companies co ON co.id = c.company_id
     ${whereSql}
     ORDER BY c.id DESC
     LIMIT 10000`
  )
    .bind(...binds)
    .all();
  const results = (rows.results ?? []) as any[];
  await attachDeliveryOrders(env, results);
  return results;
}

// ── Activity log helper ───────────────────────────────────────

// `category` (mig 064) drives the timeline filter pills. Mig 0108
// renames 'purchasing' and splits it into audience buckets (Nick
// 2026-07-14: "purchasing 换成 service / customer / supplier / sales"):
//   service    — internal service-team notes (the old 'purchasing')
//   customer   — customer-visible milestones (rendered on the portal)
//   supplier   — supplier coordination (incl. supplier-portal posts)
//   sales      — sales follow-ups (incl. sales-portal comments)
//   system     — automatic events (stage_change, assigned, created)
//
// v3.1 (mig 077) adds:
//   stage_elapsed_days / stage_target_days — snapshots on stage_change rows
//   source_channel    — request origin (app / customer_portal / supplier_portal / email / cron)
//   references_entry_id + is_correction — append-only correction pointer
//
// All v3.1 fields are optional; existing callers don't need updating.
export type LogActivityExtras = {
  category?: "service" | "customer" | "supplier" | "sales" | "system";
  stage_elapsed_days?: number | null;
  stage_target_days?: number | null;
  source_channel?: string | null;
  references_entry_id?: number | null;
  is_correction?: boolean;
};

async function logActivity(
  env: Env,
  assrId: number,
  action: string,
  fromValue: string | null,
  toValue: string | null,
  note: string | null,
  userId?: number | null,
  categoryOrExtras: "service" | "customer" | "supplier" | "sales" | "system" | LogActivityExtras = "system",
) {
  const extras: LogActivityExtras =
    typeof categoryOrExtras === "string" ? { category: categoryOrExtras } : categoryOrExtras;
  const category = extras.category ?? "system";
  await env.DB.prepare(
    `INSERT INTO assr_activity (
       assr_id, action, from_value, to_value, note, user_id, category,
       stage_elapsed_days, stage_target_days, source_channel,
       references_entry_id, is_correction
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      assrId,
      action,
      fromValue,
      toValue,
      note,
      userId ?? null,
      category,
      extras.stage_elapsed_days ?? null,
      extras.stage_target_days ?? null,
      extras.source_channel ?? null,
      extras.references_entry_id ?? null,
      extras.is_correction ? 1 : 0,
    )
    .run();
}

export { logActivity };

// ── Survey tokens ─────────────────────────────────────────────
// Reused by the manual survey-token endpoint AND by the auto-email
// dispatch on case close — pulled out so both paths agree on the
// "reuse unsubmitted token" behavior.

// mig 015 shipped assr_survey_tokens.expires_at as "nullable -- null =
// never expires" and then no code ever wrote it, so every survey token
// minted since has been immortal while the route's 404 claimed
// otherwise. A survey is asked for right after the case closes and
// goes stale fast -- a rating submitted a year later is noise -- and
// the link sits on an unauthenticated route that echoes the customer's
// name and SO number, so the window is the exposure. 90 days is far
// past any real response and still ends.
export const SURVEY_TTL_DAYS = 90;

export async function issueSurveyToken(env: Env, assrId: number): Promise<string> {
  // The reuse branch has to honour the TTL too. Without the expiry
  // predicate this hands back a token routes/survey.ts now rejects --
  // a link that 404s the moment it is shared, which is worse than the
  // immortal one it replaced.
  const existing = await env.DB.prepare(
    `SELECT token FROM assr_survey_tokens
      WHERE assr_id = ? AND submitted_at IS NULL
        AND expires_at IS NOT NULL
        AND expires_at > ?
      ORDER BY created_at DESC LIMIT 1`
  )
    .bind(assrId, new Date().toISOString())
    .first<{ token: string }>();
  if (existing) return existing.token;
  const token = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const expiresAt = new Date(Date.now() + SURVEY_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO assr_survey_tokens (token, assr_id, expires_at) VALUES (?, ?, ?)`
  )
    .bind(token, assrId, expiresAt)
    .run();
  return token;
}
