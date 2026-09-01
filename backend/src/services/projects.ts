import type { Env } from "../types";
import { recomputeAutoCostLines } from "./projectCostRates";
import { isSensitiveChecklistItem, isSetupDismantleSection } from "./pmsAccess";
import { todayMyt } from "../scm/lib/my-time";
import { canonicalizeMyState } from "../scm/lib/canonical-state";
import { canonicalizeVenue } from "../scm/lib/canonical-venue";
import { deriveProjectCode, deriveProjectName, syncedNameForOrganizerChange } from "./project-naming";
export { deriveProjectCode, deriveProjectName };

/** Disambiguate against existing codes by appending -2, -3, … */
export async function uniqueProjectCode(env: Env, base: string): Promise<string> {
  // Avoid LIKE here — D1's pattern-complexity guard has been observed
  // to reject even short LIKE patterns ("LIKE or GLOB pattern too
  // complex"), and a plain prefix comparison via substr() is both
  // immune to that and indexable.
  const prefix = `${base}-`;
  const rows = await env.DB.prepare(
    `SELECT code FROM projects
      WHERE code = ?1
         OR (length(code) > ?2 AND substr(code, 1, ?2) = ?3)`
  )
    .bind(base, prefix.length, prefix)
    .all<{ code: string }>();
  const used = new Set((rows.results ?? []).map((r) => r.code));
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// ── Activity log ──────────────────────────────────────────────

export async function logProjectActivity(
  env: Env,
  projectId: number,
  action: string,
  fromValue: string | null,
  toValue: string | null,
  note: string | null,
  userId?: number | null
) {
  await env.DB.prepare(
    `INSERT INTO project_activity (project_id, action, from_value, to_value, note, user_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(projectId, action, fromValue, toValue, note, userId ?? null)
    .run();
}

/** "Name (#id)" for an activity-trail endpoint, or null for unassigned.
 *  Deliberately NOT `?? ""` — an unassigned PIC and a user we failed to read
 *  are different facts, and the trail must not render the second as the first. */
async function describeUser(env: Env, userId: number | null): Promise<string | null> {
  if (userId == null) return null;
  const row = await env.DB.prepare(`SELECT name, email FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ name: string | null; email: string | null }>();
  const label = row?.name || row?.email;
  return label ? `${label} (#${userId})` : `#${userId}`;
}

// ── Crew membership ───────────────────────────────────────────
// Returns the phase(s) on which `userId` is crewed for `projectId`.
// Empty array = not on the crew. Used by the Driver App project
// endpoints (row-level gate) and by the phase-photo upload guard so
// a setup-only helper can't upload to dismantle.
export async function getUserPhasesOnProject(
  env: Env,
  projectId: number,
  userId: number,
  /** Owner 2026-07-21: the per-lorry crew editor stores people as
   *  {"name":"X","phone":…} JSON (setup_crew / dismantle_crew) with NO user
   *  ids, so id-only matching missed everyone crewed that way. Names come
   *  from the users master (fleet/staff picker), so a lowercase '"<name>"'
   *  containment match is an exact-name match — same rule listProjects'
   *  assigned_user_name arm uses. */
  userName?: string | null
): Promise<Array<"setup" | "dismantle">> {
  if (!userId) return [];
  const row = await env.DB.prepare(
    `SELECT setup_driver_user_id, setup_helper_1_id, setup_helper_2_id,
            dismantle_driver_user_id, dismantle_helper_1_id, dismantle_helper_2_id,
            setup_crew, dismantle_crew
       FROM projects WHERE id = ?`
  )
    .bind(projectId)
    .first<{
      setup_driver_user_id: number | null;
      setup_helper_1_id: number | null;
      setup_helper_2_id: number | null;
      dismantle_driver_user_id: number | null;
      dismantle_helper_1_id: number | null;
      dismantle_helper_2_id: number | null;
      setup_crew: string | null;
      dismantle_crew: string | null;
    }>();
  if (!row) return [];
  const nm = (userName ?? "").trim().toLowerCase();
  const inCrewJson = (json: string | null): boolean =>
    !!nm && (json ?? "").toLowerCase().includes(`"${nm}"`);
  const phases: Array<"setup" | "dismantle"> = [];
  if (
    row.setup_driver_user_id === userId ||
    row.setup_helper_1_id === userId ||
    row.setup_helper_2_id === userId ||
    inCrewJson(row.setup_crew)
  ) {
    phases.push("setup");
  }
  if (
    row.dismantle_driver_user_id === userId ||
    row.dismantle_helper_1_id === userId ||
    row.dismantle_helper_2_id === userId ||
    inCrewJson(row.dismantle_crew)
  ) {
    phases.push("dismantle");
  }
  return phases;
}

// ── Create ────────────────────────────────────────────────────

export interface CreateProjectInput {
  name: string;
  event_type_id?: number | null;
  brand?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  venue?: string | null;
  state?: string | null;
  organizer?: string | null;
  notion_url?: string | null;
  pic_id?: number | null;
  created_by: number;
  /** Multi-company (mig-pg 0093) — the ACTIVE company from the request
   *  (activeCompanyId(c)). Column + bind are appended ONLY when resolved so
   *  the pre-migration window / D1 test mirror inserts unchanged; the PG
   *  DEFAULT (base company) covers unstamped inserts. */
  company_id?: number;
}

export async function createProject(env: Env, input: CreateProjectInput) {
  if (input.start_date && input.end_date && input.end_date < input.start_date) {
    throw new Error("end_date must be on or after start_date");
  }
  const now = new Date();
  const anchor = input.start_date ? new Date(input.start_date) : now;
  const year = anchor.getFullYear();
  const month = anchor.getMonth() + 1;
  // Resolve event-type slug from the id so the derive helpers can
  // force the organizer slot to "SOLO" for solo events (matches the
  // frontend's auto-fill). Missing or unknown ids fall through as
  // null — derive helpers treat that as a non-solo event.
  let eventTypeSlug: string | null = null;
  if (input.event_type_id != null) {
    const et = await env.DB.prepare(
      `SELECT slug FROM project_event_types WHERE id = ?`
    )
      .bind(input.event_type_id)
      .first<{ slug: string | null }>();
    eventTypeSlug = et?.slug ?? null;
  }
  /* Mig 0175 (owner 2026-07-22) — canonicalize the state at the door so
     Projects stops writing UPPERCASE 'PENANG'/'KL' while SCM writes 'Pulau
     Pinang'/'Kuala Lumpur'. Foreign state names (China provinces) pass
     through unchanged. */
  input.state = canonicalizeMyState(input.state ?? null);
  // Fold showroom-venue aliases (e.g. "PJ Showroom") to the canonical "2990s PJ"
  // at the write front door so every surface that later reads this row agrees.
  input.venue = canonicalizeVenue(input.venue ?? null);

  // Derive code from identity fields. Throws if state/venue/brand are
  // missing; route layer converts to a 400. Organizer null OR
  // event_type=solo → "SOLO".
  const baseCode = deriveProjectCode({
    year,
    month,
    organizer: input.organizer,
    state: input.state,
    venue: input.venue,
    brand: input.brand,
    event_type_slug: eventTypeSlug,
  });
  const code = await uniqueProjectCode(env, baseCode);

  // Default the PIC to the creator so a sales rep who creates their
  // own project immediately sees it under the scoped filter. Admins
  // creating on someone else's behalf can override via input.pic_id.
  const picId = input.pic_id ?? input.created_by ?? null;
  // Auto-derive name when caller doesn't supply one. Keeps the "+ New
  // Project" form simple — boss just picks state/brand/organizer/venue.
  const name =
    input.name?.trim() ||
    deriveProjectName({
      state: input.state,
      brand: input.brand,
      organizer: input.organizer,
      venue: input.venue,
      event_type_slug: eventTypeSlug,
    });
  // Multi-company: stamp the active company (sales.ts idiom — column + bind
  // appended only when resolved). Child rows (finance / cloned checklist)
  // inherit the PG DEFAULT and are always read through project_id, so the
  // project row is the single source of company truth.
  const stampCo = input.company_id != null;
  const r = await env.DB.prepare(
    `INSERT INTO projects (
      code, name, stage,
      event_type_id, brand,
      start_date, end_date, venue, state, organizer, notion_url,
      pic_id, created_by${stampCo ? ", company_id" : ""}
    ) VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${stampCo ? ", ?" : ""})`
  )
    .bind(
      code,
      name,
      input.event_type_id ?? null,
      input.brand ?? null,
      input.start_date ?? null,
      input.end_date ?? null,
      input.venue ?? null,
      input.state ?? null,
      input.organizer ?? null,
      input.notion_url ?? null,
      picId,
      input.created_by,
      ...(stampCo ? [input.company_id] : [])
    )
    .run();
  const projectId = r.meta.last_row_id as number;

  // Seed finance row (so 1:1 always exists; UI edits update in place)
  await env.DB.prepare(
    `INSERT INTO project_finance (project_id) VALUES (?)`
  )
    .bind(projectId)
    .run();

  // If event type has a default template, clone its items now.
  if (input.event_type_id) {
    await instantiateChecklistFromEventType(env, projectId, input.event_type_id, input.start_date ?? null);
  }

  await logProjectActivity(env, projectId, "created", null, code, null, input.created_by);

  return { id: projectId, code };
}

// Clone checklist template items into project_checklist, resolving
// due_offset_days against the project's start_date if present.
//
// Mig 050: template sections are cloned to per-project sections first,
// then template_items.section_id is mapped to the new project section
// id when inserting tasks. Template items with `requires_review = 1`
// translate to `required_perm = 'projects.approve'` on the cloned task,
// reusing the existing review pipeline (mig 024).
export async function instantiateChecklistFromEventType(
  env: Env,
  projectId: number,
  eventTypeId: number,
  startDate: string | null
) {
  const et = await env.DB.prepare(
    `SELECT default_template_id FROM project_event_types WHERE id = ?`
  )
    .bind(eventTypeId)
    .first<{ default_template_id: number | null }>();
  const templateId = et?.default_template_id;
  if (!templateId) return;

  // 1. Clone sections, keeping a map from template section id → new
  //    project section id so we can translate item.section_id below.
  const tplSections = await env.DB.prepare(
    `SELECT id, name, sort_order, display_mode
       FROM project_checklist_template_sections
      WHERE template_id = ?
      ORDER BY sort_order, id`
  )
    .bind(templateId)
    .all<{ id: number; name: string; sort_order: number; display_mode: string | null }>();

  const sectionIdMap = new Map<number, number>();
  // Owner default (2026-06-24): items in the OPERATION section start as N/A so
  // they don't read as pending. N/A items are off the progress math everywhere
  // (done / (total − na)), so OPERATION renders 0/0 until a coordinator marks an
  // item applicable. Collect the template section ids named OPERATION so the
  // item loop below can seed the right status per section. Only runs at NEW
  // project creation — existing projects' rows are never touched.
  const operationSectionIds = new Set<number>();
  for (const s of tplSections.results ?? []) {
    if ((s.name ?? "").trim().toUpperCase() === "OPERATION") {
      operationSectionIds.add(s.id);
    }
    const ins = await env.DB.prepare(
      `INSERT INTO project_checklist_sections (project_id, name, sort_order, display_mode)
       VALUES (?, ?, ?, ?)`
    )
      .bind(projectId, s.name, s.sort_order, s.display_mode || "list")
      .run();
    sectionIdMap.set(s.id, ins.meta.last_row_id as number);
  }

  // 2. Clone items. requires_review = 1 → required_perm = projects.approve
  //    (unless the template already specifies a custom perm). Section_id
  //    maps via sectionIdMap; unmapped sections fall through as null.
  const items = await env.DB.prepare(
    `SELECT seq, title, description, required_perm, role_label, crew_visible,
            due_offset_days, section_id, requires_review, pill_kind, pill_value
       FROM project_checklist_template_items
      WHERE template_id = ?
      ORDER BY seq`
  )
    .bind(templateId)
    .all<{
      seq: number;
      title: string;
      description: string | null;
      required_perm: string | null;
      role_label: string | null;
      crew_visible: number | null;
      due_offset_days: number | null;
      section_id: number | null;
      requires_review: number | null;
      pill_kind: string | null;
      pill_value: string | null;
    }>();

  const rows = items.results ?? [];
  for (const item of rows) {
    const due = resolveDueDate(startDate, item.due_offset_days);
    const projectSectionId = item.section_id
      ? sectionIdMap.get(item.section_id) ?? null
      : null;
    const requiredPerm =
      item.required_perm ??
      (item.requires_review ? "projects.approve" : null);
    // Seed status: pill rows (payment/deposit) and OPERATION-section items
    // clone in as 'na' (off the progress math, never shown as pending);
    // everything else starts 'pending'.
    const isOperation =
      item.section_id != null && operationSectionIds.has(item.section_id);
    const seedStatus = item.pill_kind || isOperation ? "na" : "pending";
    await env.DB.prepare(
      `INSERT INTO project_checklist
         (project_id, section_id, seq, title, description, required_perm,
          role_label, crew_visible, due_date, due_offset_days, status, pill_kind, pill_value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        projectId,
        projectSectionId,
        item.seq,
        item.title,
        item.description,
        requiredPerm,
        item.role_label,
        item.crew_visible ? 1 : 0,
        due,
        item.due_offset_days,
        seedStatus,
        item.pill_kind,
        item.pill_value
      )
      .run();
  }
}

function resolveDueDate(startDate: string | null, offsetDays: number | null): string | null {
  if (!startDate || offsetDays == null) return null;
  const d = new Date(startDate);
  if (isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// ── Patch ─────────────────────────────────────────────────────

const PATCH_FIELDS = [
  "name", "stage", "status",
  "start_date", "end_date",
  "organizer", "state", "venue", "venue_address",
  "brand", "event_type_id",
  "booth_no", "size_sqm",
  "notion_url", "notes",
  "pic_id",
  // Logistics schedule (Notion parity)
  "setup_start_at", "setup_end_at",
  "dismantle_start_at", "dismantle_end_at",
  "setup_driver_user_id", "setup_lorry_id",
  "dismantle_driver_user_id", "dismantle_lorry_id",
  // Phase helper crew (mig 083) — mirrors trips.helper_1_id / helper_2_id /
  // helper_outsourced per phase so the trip-link auto-copy can fill the
  // trip's empty crew slots from the project's planned crew.
  "setup_helper_1_id", "setup_helper_2_id", "setup_helper_outsourced",
  "dismantle_helper_1_id", "dismantle_helper_2_id", "dismantle_helper_outsourced",
  // Phase crew editor (mig 0015) — JSON: drivers/helpers (name+phone),
  // lorries, outsourced (name/phone/plate).
  // service_crew (owner 2026-07-22): the mid-fair Service / Exchange trip —
  // same JSON shape as setup/dismantle plus a `remark` ("what service/exchange").
  "setup_crew", "dismantle_crew", "service_crew",
  // Schedule Reference remark (mig 0218, owner 2026-07-23): free-text
  // setup/dismantle times for solo events that have no handbook screenshot.
  "schedule_remark",
  // Banner
  "banner_message", "banner_tone",
] as const;

// Canonical list of Malaysian states used by the picker.  Kept as a
// JS constant rather than a DB enum so we can add a state without a
// migration. Free-text writes still land (backward-compatible with
// legacy rows), but the UI surfaces this list for new entries.
// 13 negeri + 3 federal territories (Wilayah Persekutuan) — ALL CAPS
// to match the canonical form used across the data. Cities (IPOH,
// SEREMBAN, KUANTAN, etc.) get rolled up to their state at write
// time and during data backfills.
export const MALAYSIA_STATES = [
  "JOHOR", "KEDAH", "KELANTAN", "KL", "LABUAN", "MELAKA", "NEGERI SEMBILAN",
  "PAHANG", "PENANG", "PERAK", "PERLIS", "PUTRAJAYA", "SABAH", "SARAWAK",
  "SELANGOR", "TERENGGANU",
] as const;

export const PAYMENT_STATUSES = [
  "not_started", "deposit_paid", "paid", "refund_pending", "refunded",
] as const;

export async function patchProject(
  env: Env,
  id: number,
  body: Record<string, any>,
  userId: number
): Promise<{ ok: boolean; shifted_tasks: number; delta_days: number }> {
  // Capture current stage + start_date in one read so we can both log the
  // stage transition and shift checklist due_dates by the start_date delta
  // without a second SELECT.
  const wantStageOrDate =
    "stage" in body || "start_date" in body || "end_date" in body;
  // pic_id joins the same pre-read because a PIC (re)assignment must land in
  // the activity trail with its from → to, exactly like a stage change and
  // like the sales_attendee_add / _remove entries its sibling endpoints
  // already write. It had no entry at all: the PIC dropdown saves through this
  // PATCH, so "who handed this project to whom, and when" was the one
  // assignment the project's own history could not answer.
  const wantPic = "pic_id" in body;
  let prevStage: string | null = null;
  let prevStart: string | null = null;
  let prevEnd: string | null = null;
  let prevPic: number | null = null;
  if (wantStageOrDate || wantPic) {
    const row = await env.DB.prepare(
      `SELECT stage, start_date, end_date, pic_id FROM projects WHERE id = ?`
    )
      .bind(id)
      .first<{
        stage: string;
        start_date: string | null;
        end_date: string | null;
        pic_id: number | null;
      }>();
    prevStage = row?.stage ?? null;
    prevStart = row?.start_date ?? null;
    prevEnd = row?.end_date ?? null;
    prevPic = row?.pic_id ?? null;
  }

  // end_date >= start_date when both are set after the patch.
  const nextStart =
    "start_date" in body ? (body.start_date as string | null) : prevStart;
  const nextEnd =
    "end_date" in body ? (body.end_date as string | null) : prevEnd;
  if (nextStart && nextEnd && nextEnd < nextStart) {
    throw new Error("end_date must be on or after start_date");
  }

  /* Mig 0175 — canonicalize MY state on the way in. Any PATCH that sends
     'PENANG'/'KL'/'W.P. Kuala Lumpur' is rewritten to the canonical form
     ('Pulau Pinang'/'Kuala Lumpur') the SCM surfaces use, so cross-module
     bucketing stops splitting the same physical state. */
  if ("state" in body) {
    body.state = canonicalizeMyState(body.state as string | null);
  }
  // Fold showroom-venue aliases to canonical on edit too (front door, same as create).
  if ("venue" in body) {
    body.venue = canonicalizeVenue(body.venue as string | null);
  }

  // Organizer edits follow through to the display name (owner 2026-08-17) —
  // swap rules in project-naming.ts. An explicit name in the same patch wins.
  if ("organizer" in body && !("name" in body)) {
    const cur = await env.DB.prepare(`SELECT name, organizer FROM projects WHERE id = ?`)
      .bind(id).first<{ name: string | null; organizer: string | null }>();
    const synced = syncedNameForOrganizerChange(cur?.name, cur?.organizer, body.organizer as string | null);
    if (synced) body.name = synced;
  }

  const sets: string[] = [];
  const binds: any[] = [];
  for (const k of PATCH_FIELDS) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push(body[k] ?? null);
    }
  }
  if (!sets.length) return { ok: false, shifted_tasks: 0, delta_days: 0 };
  sets.push("updated_at = datetime('now')");
  binds.push(id);

  const r = await env.DB.prepare(
    `UPDATE projects SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run();

  if (prevStage != null && body.stage && prevStage !== body.stage) {
    await logProjectActivity(env, id, "stage_change", prevStage, body.stage, null, userId);
  }

  // PIC (re)assignment — logged only on an ACTUAL change so a redundant
  // same-value save doesn't pad the trail. Names are resolved for both ends so
  // the entry stays readable after a user is renamed or deactivated; the id is
  // kept alongside because a name is not an identity.
  const nextPic = wantPic ? ((body.pic_id as number | null) ?? null) : prevPic;
  if (wantPic && nextPic !== prevPic) {
    await logProjectActivity(
      env,
      id,
      "pic_change",
      await describeUser(env, prevPic),
      await describeUser(env, nextPic),
      null,
      userId
    );
  }

  // Re-derive checklist due_dates from the new start_date and each
  // task's due_offset_days (the offset configured in Project
  // Maintenance, persisted onto the row at template-instantiation
  // time and on every manual due_date edit). Stock-transfer mirror
  // tasks (notes LIKE 'auto:%') are skipped — their due_date follows
  // the transferred_at field, not the project schedule.
  let shifted = 0;
  let deltaDays = 0;
  if (
    "start_date" in body &&
    body.start_date &&
    prevStart !== body.start_date
  ) {
    const out = await redateChecklistFromOffsets(
      env,
      id,
      body.start_date as string
    );
    shifted = out.shifted;
    deltaDays = out.deltaDays;
  }

  return {
    ok: r.meta.changes > 0,
    shifted_tasks: shifted,
    delta_days: deltaDays,
  };
}

async function redateChecklistFromOffsets(
  env: Env,
  projectId: number,
  nextStart: string
): Promise<{ shifted: number; deltaDays: number }> {
  // Normalise to YYYY-MM-DD so the SQLite `date(...)` builtin gets a
  // clean anchor regardless of any stray time/zone bits a legacy row
  // might carry.
  const nextDay = String(nextStart).slice(0, 10);
  if (isNaN(new Date(nextDay + "T00:00:00Z").getTime())) {
    return { shifted: 0, deltaDays: 0 };
  }
  // For each task with a known offset, due_date = nextDay + offset.
  // Skip auto-mirror rows (notes='auto:stock_transfer=<id>' etc.) and
  // already-completed work — completed tasks keep their original due
  // date for audit. Manual tasks without an offset are left alone.
  const r = await env.DB.prepare(
    `UPDATE project_checklist
        SET due_date = to_char((?::date + due_offset_days), 'YYYY-MM-DD'),
            updated_at = datetime('now')
      WHERE project_id = ?
        AND due_offset_days IS NOT NULL
        AND status != 'done'
        AND (notes IS NULL OR notes NOT LIKE 'auto:%')`
  )
    .bind(nextDay, projectId)
    .run();
  const shifted = r.meta.changes ?? 0;
  console.log(
    `[redateChecklistFromOffsets] project=${projectId} anchor=${nextDay} shifted=${shifted}`
  );
  // deltaDays kept on the return for the toast — leave at 0 since
  // we re-derive absolute dates rather than applying a single delta.
  return { shifted, deltaDays: 0 };
}

// ── Detail ────────────────────────────────────────────────────

export async function getProjectDetail(env: Env, id: number, companyId?: number) {
  // Multi-company: a detail fetch can only resolve within the active company —
  // a cross-company id answers null (the route 404s). Predicate skipped when
  // the company context is unresolved (pre-migration / D1 test mirror).
  const coSql = companyId != null ? " AND p.company_id = ?" : "";
  const project = await env.DB.prepare(
    `SELECT p.*,
            et.slug  as event_type_slug,
            et.name  as event_type_name,
            u1.name  as created_by_name,
            pic.name as pic_name,
            pic.phone as pic_phone,
            pic.email as pic_email,
            ud1.name as setup_driver_name,
            ud2.name as dismantle_driver_name,
            l1.plate as setup_lorry_plate,
            l2.plate as dismantle_lorry_plate,
            uhs1.name as setup_helper_1_name,
            uhs2.name as setup_helper_2_name,
            uhd1.name as dismantle_helper_1_name,
            uhd2.name as dismantle_helper_2_name,
            -- Crew phone numbers (owner 2026-08-12): the printed Event Summary
            -- lists each driver / helper with their contact, so the sheet is
            -- usable on site without opening the ERP.
            ud1.phone as setup_driver_phone,
            ud2.phone as dismantle_driver_phone,
            uhs1.phone as setup_helper_1_phone,
            uhs2.phone as setup_helper_2_phone,
            uhd1.phone as dismantle_helper_1_phone,
            uhd2.phone as dismantle_helper_2_phone
       FROM projects p
       LEFT JOIN project_event_types et ON et.id = p.event_type_id
       LEFT JOIN users u1 ON u1.id = p.created_by
       LEFT JOIN users pic ON pic.id = p.pic_id
       LEFT JOIN users ud1 ON ud1.id = p.setup_driver_user_id
       LEFT JOIN users ud2 ON ud2.id = p.dismantle_driver_user_id
       LEFT JOIN users uhs1 ON uhs1.id = p.setup_helper_1_id
       LEFT JOIN users uhs2 ON uhs2.id = p.setup_helper_2_id
       LEFT JOIN users uhd1 ON uhd1.id = p.dismantle_helper_1_id
       LEFT JOIN users uhd2 ON uhd2.id = p.dismantle_helper_2_id
       LEFT JOIN lorries l1 ON l1.id = p.setup_lorry_id
       LEFT JOIN lorries l2 ON l2.id = p.dismantle_lorry_id
      WHERE p.id = ?${coSql}`
  )
    .bind(id, ...(companyId != null ? [companyId] : []))
    .first<any>();
  if (!project) return null;

  const finance = await env.DB.prepare(
    `SELECT * FROM project_finance WHERE project_id = ?`
  )
    .bind(id)
    .first<any>();

  const checklist = await env.DB.prepare(
    `SELECT c.*, u.name as owner_name, uc.name as completed_by_name
       FROM project_checklist c
       LEFT JOIN users u  ON u.id  = c.owner_user_id
       LEFT JOIN users uc ON uc.id = c.completed_by
      WHERE c.project_id = ?
      ORDER BY c.seq, c.id`
  )
    .bind(id)
    .all();

  // Sections (mig 050) — ordered by sort_order. Tasks reference these
  // by section_id; tasks with section_id IS NULL render as
  // "Uncategorised" on the frontend.
  const sections = await env.DB.prepare(
    `SELECT id, name, sort_order, display_mode, created_at
       FROM project_checklist_sections
      WHERE project_id = ?
      ORDER BY sort_order, id`
  )
    .bind(id)
    .all();

  // Per-task attachments (mig 050) — replaces the project-level
  // Attachments panel. Attached to tasks by item_id.
  const checklistItemIdsRaw = (checklist.results ?? []).map((r: any) => r.id);
  let taskAttachments: any[] = [];
  if (checklistItemIdsRaw.length) {
    const placeholders = checklistItemIdsRaw.map(() => "?").join(",");
    const a = await env.DB.prepare(
      `SELECT att.*, u.name as uploader_name
         FROM project_checklist_attachments att
         LEFT JOIN users u ON u.id = att.uploaded_by
        WHERE att.item_id IN (${placeholders}) AND att.archived_at IS NULL
        ORDER BY att.uploaded_at DESC, att.id DESC`
    )
      .bind(...checklistItemIdsRaw)
      .all();
    taskAttachments = a.results ?? [];
  }

  // Per-attachment ACTION TIMELINE (owner 2026-07-29): append-only Ongoing /
  // Done log the purchaser + BD stamp on defect-list uploads. Fetched for the
  // whole project in one query; the UI groups by attachment_id.
  let attachmentActions: any[] = [];
  if (taskAttachments.length) {
    const attIds = taskAttachments.map((a: any) => a.id);
    const ph = attIds.map(() => "?").join(",");
    const acts = await env.DB.prepare(
      `SELECT act.*, u.name as user_name
         FROM project_checklist_attachment_actions act
         LEFT JOIN users u ON u.id = act.user_id
        WHERE act.attachment_id IN (${ph})
        ORDER BY act.id ASC`
    )
      .bind(...attIds)
      .all();
    attachmentActions = acts.results ?? [];
  }

  // Project-level attachments — kept for legacy data. The UI panel was
  // removed in mig 050; this stays in the response so any old client
  // doesn't 500 on a missing field.
  const attachments = await env.DB.prepare(
    `SELECT a.*, u.name as uploader_name
       FROM project_attachments a
       LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE a.project_id = ? AND a.archived_at IS NULL
      ORDER BY a.created_at DESC`
  )
    .bind(id)
    .all();

  const activity = await env.DB.prepare(
    `SELECT act.*, u.name as user_name
       FROM project_activity act
       LEFT JOIN users u ON u.id = act.user_id
      WHERE act.project_id = ? AND act.archived_at IS NULL
      ORDER BY act.created_at DESC
      LIMIT 100`
  )
    .bind(id)
    .all();

  const team = await env.DB.prepare(
    `SELECT t.*, u.name as user_name, u.email as user_email
       FROM project_team t
       LEFT JOIN users u ON u.id = t.user_id
      WHERE t.project_id = ?
      ORDER BY t.role, u.name`
  )
    .bind(id)
    .all();

  // Linked trips (project_id FK on trips). trips uses trip_no + trip_date
  // + notes — normalize to {code, scheduled_date, description} for the UI.
  const trips = await env.DB.prepare(
    `SELECT id,
            trip_no  as code,
            status,
            trip_date as scheduled_date,
            trip_type,
            notes    as description
       FROM trips
      WHERE project_id = ?
      ORDER BY trip_date DESC, id DESC
      LIMIT 50`
  )
    .bind(id)
    .all();

  // Progress: % of non-NA items marked done. Trip & finance excluded.
  const counts = {
    total: (checklist.results ?? []).length,
    done: (checklist.results ?? []).filter((r: any) => r.status === "done").length,
    na: (checklist.results ?? []).filter((r: any) => r.status === "na").length,
  };
  const denom = counts.total - counts.na;
  const progress_pct = denom > 0 ? Math.round((counts.done / denom) * 100) : 0;

  // Duration (days) — inclusive of both start and end date.
  let duration_days: number | null = null;
  if (project.start_date && project.end_date) {
    const s = new Date(project.start_date);
    const e = new Date(project.end_date);
    if (!isNaN(s.getTime()) && !isNaN(e.getTime())) {
      duration_days = Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
    }
  }

  // Defects — group by phase in the UI. Service returns both phases flat.
  const defects = await env.DB.prepare(
    `SELECT d.*, u.name as reported_by_name, a.assr_no as linked_assr_no
       FROM project_defects d
       LEFT JOIN users u ON u.id = d.reported_by
       LEFT JOIN assr_cases a ON a.id = d.linked_assr_id
      WHERE d.project_id = ? AND d.archived_at IS NULL
      ORDER BY d.phase, d.id DESC`
  )
    .bind(id)
    .all();

  const salesReports = await env.DB.prepare(
    `SELECT sr.*, u.name as uploaded_by_name
       FROM project_sales_reports sr
       LEFT JOIN users u ON u.id = sr.uploaded_by
      WHERE sr.project_id = ? AND sr.archived_at IS NULL
      ORDER BY sr.created_at DESC`
  )
    .bind(id)
    .all();

  // Checklist comments — attached to the item rows client-side via item_id.
  const checklistItemIds = (checklist.results ?? []).map((r: any) => r.id);
  let comments: any[] = [];
  if (checklistItemIds.length) {
    const placeholders = checklistItemIds.map(() => "?").join(",");
    const c = await env.DB.prepare(
      `SELECT cc.*, u.name as user_name
         FROM project_checklist_comments cc
         LEFT JOIN users u ON u.id = cc.user_id
        WHERE cc.item_id IN (${placeholders})
        ORDER BY cc.created_at ASC`
    )
      .bind(...checklistItemIds)
      .all();
    comments = c.results ?? [];
  }

  // Finance ledger lines — the new canonical source. Frontend shows
  // these directly; project_finance is only the cached rollup.
  const ledger = await listLedgerLines(env, id);

  // Sales entries surface as virtual income rows in the ledger so the
  // Finance section reflects rep-entered sales without double-bookkeeping.
  // sales_entries is the source of truth (managed via the Sales section);
  // these synthetic rows carry source='sales_entry' so the UI suppresses
  // edit/delete controls.
  const salesEntryLines = await env.DB.prepare(
    `SELECT s.id, s.amount, s.occurred_at, s.created_at,
            s.customer_name, s.ref_no, s.notes,
            COALESCE(sp.name, u.name) as created_by_name
       FROM sales_entries s
       LEFT JOIN users u  ON u.id  = s.created_by
       LEFT JOIN users sp ON sp.id = s.sales_person_id
      WHERE s.project_id = ?
        AND s.archived_at IS NULL
        AND s.status != 'void'
      ORDER BY s.occurred_at DESC, s.id DESC`
  )
    .bind(id)
    .all<{
      id: number;
      amount: number;
      occurred_at: string;
      created_at: string;
      customer_name: string;
      ref_no: string | null;
      notes: string | null;
      created_by_name: string | null;
    }>();
  // Quick-log rows (rep entered amount + ref_no only at the project)
  // carry the sentinel "(quick log)" in customer_name. Render them
  // with a friendlier "Quick log · {ref}" label in the project finance
  // ledger so the boss isn't squinting at a parenthesised placeholder.
  const QUICK_LOG_SENTINEL = "(quick log)";
  const synthIncome = (salesEntryLines.results ?? []).map((s) => ({
    id: -s.id,
    project_id: id,
    kind: "income" as const,
    category: "sales",
    description:
      s.customer_name === QUICK_LOG_SENTINEL
        ? `Quick log · ${s.ref_no ?? "no ref"}`
        : (s.ref_no ? `${s.ref_no} · ` : "") + s.customer_name,
    amount: s.amount,
    occurred_at: s.occurred_at,
    r2_key: null,
    file_name: null,
    mime_type: null,
    notes: s.notes,
    created_by_name: s.created_by_name,
    created_at: s.created_at,
    archived_at: null,
    source: "sales_entry" as const,
    source_id: s.id,
  }));
  const ledgerWithSales = [...ledger, ...synthIncome].sort((a: any, b: any) => {
    const ao = a.occurred_at ?? "";
    const bo = b.occurred_at ?? "";
    if (ao && bo) return bo.localeCompare(ao);
    if (!ao && bo) return 1;
    if (ao && !bo) return -1;
    return (b.id ?? 0) - (a.id ?? 0);
  });

  // Stock transfers — OUT + RETURN records, confirmation-tracked.
  const stockTransfers = await env.DB.prepare(
    `SELECT t.*, u.name as created_by_name, uc.name as confirmed_by_name
       FROM project_stock_transfers t
       LEFT JOIN users u ON u.id = t.created_by
       LEFT JOIN users uc ON uc.id = t.confirmed_by
      WHERE t.project_id = ? AND t.archived_at IS NULL
      ORDER BY t.direction, t.transferred_at DESC, t.id DESC`
  )
    .bind(id)
    .all();

  // Stage progress (mig 050) — one entry per section with done /
  // total / na counts. The UI replaces the percentage bar with this.
  // Sections that don't have any tasks yet are still returned (count
  // 0) so admins see them as empty stages.
  const sectionList = (sections.results ?? []) as Array<{
    id: number;
    name: string;
    sort_order: number;
  }>;
  const sectionProgress = sectionList.map((s) => {
    const items = (checklist.results ?? []).filter(
      (r: any) => r.section_id === s.id
    );
    const total = items.length;
    const done = items.filter((r: any) => r.status === "done").length;
    const na = items.filter((r: any) => r.status === "na").length;
    const denom = total - na;
    const complete = denom > 0 && done === denom;
    return {
      ...s,
      total,
      done,
      na,
      complete: complete ? 1 : 0,
    };
  });
  // Uncategorised bucket — tasks without a section_id.
  const uncatItems = (checklist.results ?? []).filter(
    (r: any) => r.section_id == null
  );
  if (uncatItems.length > 0) {
    const total = uncatItems.length;
    const done = uncatItems.filter((r: any) => r.status === "done").length;
    const na = uncatItems.filter((r: any) => r.status === "na").length;
    const denom = total - na;
    sectionProgress.push({
      id: 0,
      name: "Uncategorised",
      sort_order: 9999,
      total,
      done,
      na,
      complete: denom > 0 && done === denom ? 1 : 0,
    });
  }

  // Sales attendees (mig 087) — reps physically attending the project.
  // Reading from the sales_reps master so we can show code + name + the
  // user-name fallback when the rep has a workspace login.
  const salesAttendees = await env.DB.prepare(
    `SELECT a.sales_rep_id, a.created_at,
            r.code      as rep_code,
            r.name      as rep_name,
            r.phone     as rep_phone,
            r.user_id   as rep_user_id,
            u.name      as user_name
       FROM project_sales_attendees a
       LEFT JOIN sales_reps r ON r.id = a.sales_rep_id
       LEFT JOIN users u      ON u.id = r.user_id
      WHERE a.project_id = ?
      ORDER BY r.code, r.name`
  )
    .bind(id)
    .all();

  return {
    project: { ...project, progress_pct, duration_days },
    finance: finance ?? null,
    finance_lines: ledgerWithSales,
    stock_transfers: stockTransfers.results ?? [],
    checklist: checklist.results ?? [],
    checklist_comments: comments,
    checklist_attachments: taskAttachments,
    checklist_attachment_actions: attachmentActions,
    sections: sectionList,
    section_progress: sectionProgress,
    attachments: attachments.results ?? [],
    defects: defects.results ?? [],
    sales_reports: salesReports.results ?? [],
    sales_attendees: salesAttendees.results ?? [],
    activity: activity.results ?? [],
    team: team.results ?? [],
    trips: trips.results ?? [],
  };
}

/**
 * Server-side backstop for WF_SENSITIVE (quotation / agreement) visibility.
 * Returns a shallow copy of a project-detail payload with the sensitive
 * checklist rows — and their comments, attachments, and section-progress
 * contribution — removed. Called for a caller whose PMS role lacks
 * WF_SENSITIVE (pmsAccess `canSensitive` === false), mirroring how the
 * detail-GET strips finance / payment. Directors are unaffected: pass only
 * when the gate is closed. No-op (returns the same object) when the payload
 * carries no sensitive rows.
 */
export function stripSensitiveChecklist<
  T extends {
    checklist?: any[];
    checklist_comments?: any[];
    checklist_attachments?: any[];
    sections?: any[];
    section_progress?: any[];
  }
>(detail: T): T {
  const removed = (detail.checklist ?? []).filter((it) =>
    isSensitiveChecklistItem(it)
  );
  if (removed.length === 0) return detail;
  const removedIds = new Set(removed.map((r: any) => r.id));
  const checklist = (detail.checklist ?? []).filter(
    (it: any) => !removedIds.has(it.id)
  );
  const checklist_comments = (detail.checklist_comments ?? []).filter(
    (c: any) => !removedIds.has(c.item_id)
  );
  const checklist_attachments = (detail.checklist_attachments ?? []).filter(
    (a: any) => !removedIds.has(a.item_id)
  );
  // A section that held a sensitive item and now has NO remaining items is
  // dropped entirely — otherwise the gated user sees an empty section header
  // (e.g. an orphan "CONTRACT" stage) that hints a hidden row exists.
  // Sections that were already empty, or still hold other items, are kept.
  const remainingSectionIds = new Set(
    checklist.map((it: any) => it.section_id).filter((s: any) => s != null)
  );
  const emptiedSectionIds = new Set(
    removed
      .map((r: any) => r.section_id)
      .filter((s: any) => s != null && !remainingSectionIds.has(s))
  );
  const sections = (detail.sections ?? []).filter(
    (s: any) => !emptiedSectionIds.has(s.id)
  );
  // Recompute the affected section-progress rows so the count doesn't leak
  // that a hidden item exists; drop the row outright for an emptied section.
  // Uncategorised tasks (section_id null) roll up to the id-0 bucket.
  const section_progress = (detail.section_progress ?? [])
    .filter((sp: any) => !emptiedSectionIds.has(sp.id))
    .map((sp: any) => {
      const rm = removed.filter((r: any) => (r.section_id ?? 0) === sp.id);
      if (rm.length === 0) return sp;
      const total = Math.max(0, (sp.total ?? 0) - rm.length);
      const done = Math.max(
        0,
        (sp.done ?? 0) - rm.filter((r: any) => r.status === "done").length
      );
      const na = Math.max(
        0,
        (sp.na ?? 0) - rm.filter((r: any) => r.status === "na").length
      );
      const denom = total - na;
      return { ...sp, total, done, na, complete: denom > 0 && done === denom ? 1 : 0 };
    });
  return {
    ...detail,
    checklist,
    checklist_comments,
    checklist_attachments,
    sections,
    section_progress,
  };
}

/**
 * Server-side backstop for SETUP_DISMANTLE visibility (owner 2026-07-15).
 * Returns a shallow copy of a project-detail payload with the Setup & Dismantle
 * section fully removed: the crew JSON + scheduled times NULLed on the project
 * row, and the "SETUP & DISMANTLE DOCUMENTS" checklist rows — plus their
 * comments, attachments, sections, and section-progress — stripped. Called for
 * a caller whose PMS role lacks SETUP_DISMANTLE (pmsAccess `canSetupDismantle`
 * === false), mirroring how the detail-GET strips finance / payment /
 * WF_SENSITIVE. The crew fields are NULLed unconditionally (the crew editor is
 * part of the same hidden section) even when no document rows are present.
 */
export function stripSetupDismantle<
  T extends {
    project?: any;
    checklist?: any[];
    checklist_comments?: any[];
    checklist_attachments?: any[];
    sections?: any[];
    section_progress?: any[];
  }
>(detail: T): T {
  // Owner 2026-07-28 ("all users can view the setup & dismantle part"): the
  // crew blobs, service crew, schedule remark and scheduled times STAY on the
  // wire for every viewer — the S&D card is view-for-all, and editing remains
  // gated by the PATCH route + the UI's canWrite/canEdit tier. Only the
  // DOCUMENT rows below stay role-filtered.
  const project = detail.project;

  // Document rows are identified by their cloned section NAME. Owner
  // 2026-07-16: the sales PIC's OWN deliverables — the rows badged
  // "SALES PIC" (Setup Image / Defect List / Event Complete Image) — stay
  // on the wire for the stripped caller (this strip only ever runs for
  // sales-role callers); the DRIVER / PURCHASER document rows and the crew
  // editor stay hidden. A Setup & Dismantle section is dropped outright
  // only when nothing under it survives.
  const sdSectionIds = new Set(
    (detail.sections ?? [])
      .filter((s: any) => isSetupDismantleSection(s))
      .map((s: any) => s.id)
  );
  const removedItems = (detail.checklist ?? []).filter(
    (it: any) =>
      it.section_id != null &&
      sdSectionIds.has(it.section_id) &&
      // startsWith: the shared "SALES PIC & DRIVER" rows (Defect List pair,
      // owner 2026-07-29) are sales deliverables too — keep them on the wire.
      !String(it.role_label ?? "").trim().toUpperCase().startsWith("SALES PIC")
  );
  const removedItemIds = new Set(removedItems.map((it: any) => it.id));
  const removedSectionIds = new Set(
    [...sdSectionIds].filter(
      (sid) =>
        !(detail.checklist ?? []).some(
          (it: any) => it.section_id === sid && !removedItemIds.has(it.id)
        )
    )
  );

  const base = detail.project ? { ...detail, project } : detail;
  if (removedSectionIds.size === 0 && removedItemIds.size === 0) {
    // No document rows to strip — return only the crew-NULLed copy.
    return base;
  }

  const checklist = (detail.checklist ?? []).filter(
    (it: any) => !removedItemIds.has(it.id)
  );
  const checklist_comments = (detail.checklist_comments ?? []).filter(
    (c: any) => !removedItemIds.has(c.item_id)
  );
  const checklist_attachments = (detail.checklist_attachments ?? []).filter(
    (a: any) => !removedItemIds.has(a.item_id)
  );
  // Drop action-timeline rows whose attachment was stripped with its item.
  const removedAttIds = new Set(
    (detail.checklist_attachments ?? [])
      .filter((a: any) => removedItemIds.has(a.item_id))
      .map((a: any) => a.id)
  );
  const checklist_attachment_actions = (
    (detail as any).checklist_attachment_actions ?? []
  ).filter((act: any) => !removedAttIds.has(act.attachment_id));
  const sections = (detail.sections ?? []).filter(
    (s: any) => !removedSectionIds.has(s.id)
  );
  // section_progress rows key off the section id (0 sentinel = uncategorised).
  // Drop rows for fully-removed sections; recompute counts for sections that
  // keep their SALES PIC rows so the totals don't leak the hidden items.
  const section_progress = (detail.section_progress ?? [])
    .filter((sp: any) => !removedSectionIds.has(sp.id))
    .map((sp: any) => {
      const rm = removedItems.filter((r: any) => (r.section_id ?? 0) === sp.id);
      if (rm.length === 0) return sp;
      const total = Math.max(0, (sp.total ?? 0) - rm.length);
      const done = Math.max(
        0,
        (sp.done ?? 0) - rm.filter((r: any) => r.status === "done").length
      );
      const na = Math.max(
        0,
        (sp.na ?? 0) - rm.filter((r: any) => r.status === "na").length
      );
      const denom = total - na;
      return { ...sp, total, done, na, complete: denom > 0 && done === denom ? 1 : 0 };
    });
  return {
    ...base,
    checklist,
    checklist_comments,
    checklist_attachments,
    checklist_attachment_actions,
    sections,
    section_progress,
  };
}

// ── List ──────────────────────────────────────────────────────

export interface ListProjectsFilters {
  stage?: string;
  /** Date-derived event phase for the field/sales slim filter bar (owner
   *  2026-07-21). The `stage` enum is unmaintained (never reaches
   *  'dismantle'), so Setup/Dismantle filter on the event dates instead:
   *  "setup" = event not finished yet (build-up ahead / running);
   *  "dismantle" = event has ended but isn't closed (teardown pending).
   *  Cancelled events are excluded from both. */
  phase?: "setup" | "dismantle";
  brand?: string;
  event_type_id?: number;
  search?: string;
  /** Year(s) on start_date. `number` for legacy single-value callers, or a
   *  comma-separated string for the multi-select picker (owner 2026-08-07). */
  year?: number | string;
  /** Month(s) 1-12 on start_date. Single number or comma-separated list. */
  month?: number | string;
  /** Date range (owner 2026-08-11, ISO YYYY-MM-DD) — keep events overlapping
   *  [from, to]. Replaces the year/month dropdowns in the UI. Either may be blank. */
  from?: string;
  to?: string;
  state?: string;
  /** Active tasklist section name (mig 050). When set, the list only
   *  returns projects whose lowest-sort_order section with open tasks
   *  matches. Special values: "__done" = all sections complete; "__none"
   *  = project has no sections defined. */
  section?: string;
  /** Checklist TASK titles that must still be OUTSTANDING — COMMA-SEPARATED,
   *  multi-select since 2026-08-07 (owner: "make it can click multiple choice.
   *  and once export will export what already tick only"). Returns projects
   *  where AT LEAST ONE of these tasks has status not in (done, na) — the
   *  useful reading of "show me events still missing any of these". When set,
   *  each row also carries `task_pending_map` ('title=status' pairs joined by
   *  '|') for every ticked title, so the Excel export can render one column per
   *  ticked task. Exact title match (the picker feeds canonical template
   *  titles, none of which contain a comma or '='). */
  task_pending?: string;
  /** Project status filter (mig 088 palette): "confirmed" | "pending" |
   *  "cancelled". Pushed server-side so the list stays paginated even while
   *  a status pill is active (was previously filtered client-side over a
   *  fetch-all page). Additive / backward-compatible — unset ⇒ all statuses. */
  status?: string;
  /** When true, drop projects whose every section is complete (the
   *  same predicate `section === "__done"` matches positively). Used
   *  by the list page's "Hide completed" toggle. Independent of
   *  `section` — if the section filter is `__done`, this is ignored
   *  so the user can explicitly view the completed bucket. */
  exclude_done?: boolean;
  page?: number;
  per_page?: number;
  include_archived?: boolean;
  sort_by?: string;
  sort_dir?: "asc" | "desc";
  /** "My pending tasks" filter (role-based). When set, only return
   *  projects that have at least one PENDING checklist item with this
   *  role_label (e.g. "BD", "PURCHASER", "DRIVER", "SALES PIC",
   *  "LOGISTIC"). */
  pending_label?: string;
  /** Same as pending_label but matches the checklist item TITLE instead
   *  of the role chip — used for roles tied to a specific document
   *  (e.g. Management → "Agreement / Quotation"). */
  pending_title?: string;
  /** Logistic "pending" = the Setup & Dismantle section hasn't been
   *  arranged yet (no setup time scheduled). LOGISTIC isn't a checklist
   *  item, so it gets its own predicate. */
  pending_logistic?: boolean;
  /** Approver "pending" = the project has a due checklist item whose
   *  required_perm is one of these (e.g. Stock Approver → stock_transfer.approve).
   *  Used for directors/admins who only chase what they must approve. */
  pending_approve?: string[];
  /** Sales Director staging (owner 2026-07-21, tightened 2026-07-23). Their
   *  pending = whichever of these apply, OR-combined: stock-out awaiting
   *  approval (the purchaser submitted it), agreement/quotation still pending
   *  (agreement approvers only), the project's Sales Attending not yet
   *  assigned, and the Sales PIC not yet assigned. The staffing lanes
   *  (attending + pic) only fire once the CONTRACT section is cleared. */
  pending_director?: { stock?: boolean; stock_titles?: string[]; agreement?: boolean; sales_attending?: boolean; sales_pic?: boolean };
  /** Brands this approver is responsible for (owner 2026-08-10: Kris approves
   *  AKEMI + ERGOTEX stock-outs, Peter takes ZANOTTI). When non-empty the
   *  director APPROVAL lanes only surface events of these brands, so each
   *  director's My Pending shows just their own queue. Empty/absent = every
   *  brand, which keeps the existing unrestricted approvers unchanged. */
  approver_brands?: string[];
  /** Sales-attending "pending" = the project has no sales attendees assigned
   *  yet (Sales PIC + directors). Standalone predicate (not a checklist item). */
  pending_sales_attending?: boolean;
  /** Agreement/Quotation on its own timeline (Super Admin / weisiang). */
  pending_agreement?: boolean;
  /** Defect clean-or-replace review (Storekeeper Supervisor / Shukor, owner
   *  2026-08-07): projects with >=1 live defect-list attachment whose LATEST
   *  timeline entry is neither 'done' nor 'replace' — i.e. a fresh upload the
   *  reviewer has not triaged yet. Not a checklist item; own predicate. */
  pending_defect_review?: boolean;
  /** Two-warehouse defect-review split (owner 2026-08-11). The canonical states
   *  that route to Nancy (Ops Exec); Shukor takes everything else. With
   *  `pending_defect_review_exclude` the arm keeps projects whose state is NOT
   *  in this list (Shukor); without it, only those in the list (Nancy). */
  pending_defect_review_states?: string[];
  pending_defect_review_exclude?: boolean;
  /** Multi-company (mig-pg 0093): the ACTIVE company (activeCompanyId(c)).
   *  When set the list is isolated to that company; undefined (company
   *  context unresolved — pre-migration / D1 test mirror) = no predicate. */
  company_id?: number;
  /** "Assigned to me" (drivers/helpers, owner 2026-07-16): only projects
   *  where this user is on the setup/dismantle crew — matched via the FK
   *  driver/helper columns OR the crew-editor JSON (setup_crew /
   *  dismantle_crew store {name} entries; crew names come from the users
   *  master, so an exact quoted-name match is reliable). Pass BOTH fields. */
  assigned_user_id?: number;
  assigned_user_name?: string;
  /** Owner 2026-07-21: attach each row's OPEN role-badged tasks (due-gated,
   *  '|'-joined titles) as `my_pending_titles`, so the crew "My events" cards
   *  can show what's pending on their side. Set by the route for crew callers
   *  (label 'DRIVER'), and in My Pending mode for every role-label lane
   *  (owner 2026-07-22); whitelist-validated before interpolation. */
  pending_titles_label?: string;
  /** Logistic pending is derived from the project row (stock-out state +
   *  setup/dismantle time+crew), not a checklist item — when set,
   *  my_pending_titles carries the matching arrangement step instead. */
  pending_titles_logistic?: boolean;
  /** Defect-review pending is derived from the attachment timeline, not a
   *  checklist item — when set, my_pending_titles carries a "Review Defect
   *  Items" chip (every row in this lane is here because of a fresh defect). */
  pending_titles_defect_review?: boolean;
}

// Allow-listed sort columns for the project list. The default (when
// sort_by is unset) keeps the "nulls last, newest start_date first"
// behaviour the dashboard relies on.
const PROJECT_SORT_MAP: Record<string, string> = {
  code: "p.code",
  name: "p.name",
  stage: "p.stage",
  brand: "p.brand",
  start_date: "p.start_date",
  end_date: "p.end_date",
  state: "p.state",
  venue: "p.venue",
  booth_no: "p.booth_no",
  size_sqm: "p.size_sqm",
  event_type: "et.name",
  rental: "pf.rental",
  total_sales: "pf.total_sales",
  contractor_cost: "pf.contractor_cost",
  progress_pct: "progress_pct",
  pic_name: "pic.name",
  created_by_name: "cb.name",
};

/** Split a filter value that may be a COMMA-SEPARATED multi-select list (owner
 *  2026-08-07). Accepts the number|string the filters already carry, trims,
 *  drops blanks, and de-dupes — so `IN (…)` never gets an empty or repeated
 *  placeholder. A single value yields a one-element list, which keeps every
 *  pre-existing single-select caller behaving identically. */
function csvList(v: string | number | null | undefined): string[] {
  if (v == null) return [];
  return [...new Set(String(v).split(",").map((s) => s.trim()).filter(Boolean))];
}

export async function listProjects(env: Env, f: ListProjectsFilters) {
  const where: string[] = [];
  const binds: any[] = [];
  if (!f.include_archived) where.push("p.archived_at IS NULL");
  // Multi-company: PER-COMPANY isolation on the active company.
  if (f.company_id != null) {
    where.push("p.company_id = ?");
    binds.push(f.company_id);
  }
  if (f.stage) {
    const stages = f.stage.split(",").map((s) => s.trim()).filter(Boolean);
    if (stages.length === 1) {
      where.push("p.stage = ?");
      binds.push(stages[0]);
    } else if (stages.length > 1) {
      where.push(`p.stage IN (${stages.map(() => "?").join(",")})`);
      binds.push(...stages);
    }
  }
  // Date-derived Setup / Dismantle (owner 2026-07-21) — replaces the stale
  // `stage` enum for the field/sales slim bar. Same date idiom the pending
  // lanes use (substr(...,1,10) vs a YYYY-MM-DD MYT string).
  if (f.phase === "setup") {
    // Event not finished yet → build-up is ahead or it's currently running.
    where.push(
      "substr(COALESCE(p.end_date, p.start_date), 1, 10) >= ? AND COALESCE(p.status,'') <> 'cancelled'"
    );
    binds.push(todayMyt());
  } else if (f.phase === "dismantle") {
    // Event has ended but isn't closed (not marked completed) → teardown pending.
    where.push(
      "substr(COALESCE(p.end_date, p.start_date), 1, 10) < ? AND COALESCE(p.stage,'') <> 'completed' AND COALESCE(p.status,'') <> 'cancelled'"
    );
    binds.push(todayMyt());
  }
  // brand / status / year / month accept COMMA-SEPARATED lists since
  // 2026-08-07 (owner: "add multiple choice for all dropdown also"). A single
  // value still behaves exactly as before — csvList() yields one element and
  // the IN (?) collapses to equality.
  const brandList = csvList(f.brand);
  if (brandList.length) {
    where.push(`p.brand IN (${brandList.map(() => "?").join(",")})`);
    binds.push(...brandList);
  }
  const statusList = csvList(f.status);
  if (statusList.length) {
    where.push(`p.status IN (${statusList.map(() => "?").join(",")})`);
    binds.push(...statusList);
  }
  if (f.event_type_id != null) {
    where.push("p.event_type_id = ?");
    binds.push(f.event_type_id);
  }
  // Year / month are numeric lists. Non-numeric or out-of-range entries are
  // dropped rather than bound, so a hand-edited URL can't inject nonsense.
  const yearList = csvList(f.year).filter((y) => /^\d{4}$/.test(y));
  if (yearList.length) {
    where.push(`strftime('%Y', p.start_date) IN (${yearList.map(() => "?").join(",")})`);
    binds.push(...yearList);
  }
  const monthList = csvList(f.month)
    .map((m) => parseInt(m, 10))
    .filter((m) => Number.isFinite(m) && m >= 1 && m <= 12)
    .map((m) => String(m).padStart(2, "0"));
  if (monthList.length) {
    where.push(`strftime('%m', p.start_date) IN (${monthList.map(() => "?").join(",")})`);
    binds.push(...monthList);
  }
  // Date range (owner 2026-08-11) — keep events that OVERLAP [from, to]. Either
  // bound may be blank; hand-edited URLs that aren't ISO YYYY-MM-DD are ignored.
  const rangeFrom = typeof f.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f.from) ? f.from : "";
  const rangeTo = typeof f.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f.to) ? f.to : "";
  if (rangeFrom) {
    where.push(`substr(COALESCE(p.end_date, p.start_date), 1, 10) >= ?`);
    binds.push(rangeFrom);
  }
  if (rangeTo) {
    where.push(`substr(p.start_date, 1, 10) <= ?`);
    binds.push(rangeTo);
  }
  if (f.state) {
    where.push("p.state = ?");
    binds.push(f.state);
  }
  // "Assigned to me" (drivers/helpers): the FK driver/helper columns OR the
  // crew-editor JSON. The JSON stores people as {"name":"X","phone":…} (some
  // legacy imports as {"name" : "X"}), and names come from the users master,
  // so a lowercase '"<name>"' containment match is an exact-name match.
  if (f.assigned_user_id != null) {
    const arms = [
      "p.setup_driver_user_id = ?",
      "p.dismantle_driver_user_id = ?",
      "p.setup_helper_1_id = ?",
      "p.setup_helper_2_id = ?",
      "p.dismantle_helper_1_id = ?",
      "p.dismantle_helper_2_id = ?",
    ];
    for (const _ of arms) binds.push(f.assigned_user_id);
    const nm = (f.assigned_user_name || "").trim().toLowerCase();
    if (nm) {
      arms.push("lower(COALESCE(p.setup_crew,'')) LIKE ?");
      arms.push("lower(COALESCE(p.dismantle_crew,'')) LIKE ?");
      const pat = `%"${nm}"%`;
      binds.push(pat, pat);
    }
    where.push(`(${arms.join(" OR ")})`);
  }
  // "My pending tasks" — project has >=1 pending checklist item that
  // belongs to the caller's role (matched by chip label or, for
  // document-specific roles, by item title).
  // Time-gate shared by every "my pending" lane (owner 2026-07-13): a task
  // only surfaces once its scheduled date has arrived, so far-future events
  // stay hidden. Falls back to the project start when a task has no due date.
  //
  // "Has arrived" means arrived in MALAYSIA. due_date / start_date are MY
  // calendar dates, but SQL date('now') is the UTC one (d1-compat rewrites it
  // to an explicitly UTC to_char(timezone('UTC', now()), …)) — so before 08:00
  // MYT the gate compared against yesterday and a task due TODAY stayed hidden
  // until 08:00. DUE_GATE is the LAST clause of every lane below, so its
  // placeholder is always that lane's final bind: push `dueToday` after the
  // lane's own binds.
  const dueToday = todayMyt();
  const DUE_GATE = `substr(COALESCE(pc.due_date, p.start_date), 1, 10) <= ?`;
  // Interpolated (like APPROVER_BRAND_GATE) so the fixed bind order of the
  // lanes below is untouched; a compile-time date literal, never user input.
  const MY_PENDING_EPOCH = "2026-08-01";
  // A caller's "My Pending" can have SEVERAL sources; a project qualifies if
  // ANY match, so the lanes below OR together (each caller sets only a few).
  const pendingOr: string[] = [];
  const pendingBinds: any[] = [];
  // Staffing lanes only start once the CONTRACT section is cleared (owner
  // 2026-07-23: "pending contract should not appear" — while contract docs are
  // open the project is BD's pending, and far-future imports would otherwise
  // flood the directors with 100+ rows). No CONTRACT section at all counts as
  // cleared, so template variants without one still surface.
  const CONTRACT_CLEAR = `NOT EXISTS (SELECT 1 FROM project_checklist cc
        JOIN project_checklist_sections cs ON cs.id = cc.section_id
        WHERE cc.project_id = p.id AND cs.name = 'CONTRACT'
          AND cc.status NOT IN ('done', 'na'))`;
  // Sales Attending is a "pending" reminder only for events that HAVEN'T ended
  // yet (upcoming or currently running), are past CONTRACT, and have no reps
  // assigned — otherwise it floods with the whole historical backlog.
  // Timeline-gated per "pending follows the timeline". Binds one `?`
  // (dueToday) each time it's used.
  const SALES_ATTENDING_EMPTY = `(substr(COALESCE(p.end_date, p.start_date), 1, 10) >= ?
        AND ${CONTRACT_CLEAR}
        AND NOT EXISTS (SELECT 1 FROM project_sales_attendees sa WHERE sa.project_id = p.id))`;
  // Sales PIC not assigned yet (directors' duty, owner 2026-07-23). "Not
  // assigned" = pic_id NULL, a dangling id (deleted user), or the HOUZS
  // CENTURY house login (id 1) that imports stamp as a placeholder. Same
  // not-ended + past-CONTRACT gates as Sales Attending; one `?` (dueToday).
  const SALES_PIC_EMPTY = `(substr(COALESCE(p.end_date, p.start_date), 1, 10) >= ?
        AND ${CONTRACT_CLEAR}
        AND NOT EXISTS (SELECT 1 FROM users pu WHERE pu.id = p.pic_id AND pu.id <> 1))`;
  // Brand scope for the APPROVAL lanes (owner 2026-08-10). Interpolated, not
  // bound, because these lanes are assembled into one OR list whose bind order
  // is already fixed by dueToday; the values come from user_brands and are
  // quote-escaped here. Empty list = no restriction.
  const approverBrands = (f.approver_brands ?? [])
    .map((b) => String(b).trim())
    .filter(Boolean)
    .map((b) => `'${b.replace(/'/g, "''")}'`);
  const APPROVER_BRAND_GATE = approverBrands.length
    ? ` AND p.brand IN (${approverBrands.join(",")})`
    : "";
  // (The stock-awaiting-approval lane is built inline in the pending_director
  //  arm below — title-driven since 2026-08-21 so Stock In routes too.)
  // The Agreement / Quotation is the APPROVER's pending only once it has been
  // SUBMITTED for review (owner 2026-07-23, weisiang report): before BD uploads
  // it, it sits on BD's own lane, not the approver's. Mirror STOCK_OUT above —
  // gate on review_status, NOT a bare status='pending' (which showed every
  // not-yet-uploaded agreement on the Super Admin's My Pending).
  const AGREEMENT_PENDING = `EXISTS (SELECT 1 FROM project_checklist pc
                WHERE pc.project_id = p.id AND pc.title = 'Agreement / Quotation'
                  AND pc.status = 'pending'
                  AND pc.review_status IN ('pending_review', 'amended') AND ${DUE_GATE})`;
  // A submitted doc is the APPROVER's pending, not the submitter's (owner
  // 2026-07-21, Sim/Purchaser report): while it awaits review
  // ('pending_review', or 'amended' after a rejection round) the role/title
  // lanes stop counting it — the director lanes above chase it instead. A
  // rejection ('rejected') hands it back to the submitter's lane. Approval
  // sets status='done', which already drops it everywhere. No binds.
  const NOT_IN_REVIEW = `COALESCE(pc.review_status, '') NOT IN ('pending_review', 'amended')`;
  if (f.pending_label === "PURCHASER") {
    // Purchaser staging:
    //   - Stock Out Transfer Record unlocks once the Display Floor Plan is done
    //     (owner 2026-07-21).
    //   - Exchange List + Stock In Transfer Record now surface on their OWN due
    //     date for EVERY event (owner 2026-08-11) — no longer gated on a defect
    //     first existing. So at the end of each event the purchaser (Sim/Farra)
    //     sees both; they click N/A when none is needed, or upload/complete the
    //     task. Until one of those, the item stays 'pending' and keeps showing
    //     here. (Uploading a reviewable doc auto-submits it, so NOT_IN_REVIEW
    //     then drops it to the approver — it leaves the purchaser lane either way.)
    //   - Every other PURCHASER task surfaces on its own due date.
    pendingOr.push(
      `EXISTS (SELECT 1 FROM project_checklist pc
                WHERE pc.project_id = p.id
                  AND pc.status = 'pending'
                  AND pc.role_label = 'PURCHASER'
                  AND ${NOT_IN_REVIEW}
                  AND ${DUE_GATE}
                  AND (pc.title <> 'Stock Out Transfer Record'
                       OR EXISTS (SELECT 1 FROM project_checklist fp
                                   WHERE fp.project_id = p.id
                                     AND fp.title = 'Display Floor Plan'
                                     AND (fp.status = 'done' OR fp.review_status = 'approved'))))`
    );
    pendingBinds.push(dueToday);
    // Defect ACTIONING (owner 2026-07-29; two-stage 2026-08-07): a defect-list
    // file reaches the PURCHASER only once the Storekeeper Supervisor (Shukor)
    // has ESCALATED it — its LATEST timeline entry is 'replace'. He resolves
    // clean-able ones himself with 'done' (they never reach here); the purchaser
    // then closes a replace with 'done'. Timeline-gated to events that ended
    // within the last 30 days so the historical backlog does not flood the lane.
    // One bind (defectSince).
    const defectSince = (() => {
      const d = new Date(`${dueToday}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 30);
      return d.toISOString().slice(0, 10);
    })();
    pendingOr.push(
      `(substr(COALESCE(p.end_date, p.start_date), 1, 10) >= ?
        AND EXISTS (SELECT 1 FROM project_checklist dl
                JOIN project_checklist_attachments da
                  ON da.item_id = dl.id AND da.archived_at IS NULL
                WHERE dl.project_id = p.id
                  AND (dl.title LIKE 'Defect List%' OR dl.title LIKE 'Defect Item%')
                  AND COALESCE((SELECT act.status
                                  FROM project_checklist_attachment_actions act
                                 WHERE act.attachment_id = da.id
                                 ORDER BY act.id DESC LIMIT 1), '') = 'replace'))`
    );
    pendingBinds.push(defectSince);
  } else if (f.pending_label) {
    // LIKE contains-match so a combined badge (the "SALES PIC & DRIVER"
    // Defect List pair, owner 2026-07-29) lands in BOTH the sales lane and
    // the driver lane. Single labels behave exactly as before.
    pendingOr.push(
      `EXISTS (SELECT 1 FROM project_checklist pc
                WHERE pc.project_id = p.id AND pc.status = 'pending'
                  AND pc.role_label LIKE ? AND ${NOT_IN_REVIEW} AND ${DUE_GATE})`
    );
    pendingBinds.push(`%${f.pending_label}%`, dueToday);
  }
  if (f.pending_defect_review) {
    // Defect clean-or-replace REVIEW (owner 2026-08-07): the Storekeeper
    // Supervisor's lane (Shukor). A live defect-list attachment whose LATEST
    // timeline entry is neither 'done' (he cleaned it) nor 'replace' (he
    // escalated it to the purchaser) is a fresh upload awaiting his triage.
    // Same 30-day window as the purchaser arm so the pre-feature backlog stays
    // out. One bind (reviewSince).
    const reviewSince = (() => {
      const d = new Date(`${dueToday}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 30);
      return d.toISOString().slice(0, 10);
    })();
    // Region routing (owner 2026-08-11): Nancy sees only the region states,
    // Shukor everything else — including projects with a NULL/blank state.
    const stateBinds = f.pending_defect_review_states ?? [];
    const statePh = stateBinds.map(() => "?").join(",");
    const stateClause = stateBinds.length
      ? f.pending_defect_review_exclude
        ? ` AND (p.state IS NULL OR p.state NOT IN (${statePh}))`
        : ` AND p.state IN (${statePh})`
      : "";
    pendingOr.push(
      `(substr(COALESCE(p.end_date, p.start_date), 1, 10) >= ?${stateClause}
        AND EXISTS (SELECT 1 FROM project_checklist dl
                JOIN project_checklist_attachments da
                  ON da.item_id = dl.id AND da.archived_at IS NULL
                WHERE dl.project_id = p.id
                  AND (dl.title LIKE 'Defect List%' OR dl.title LIKE 'Defect Item%')
                  AND COALESCE((SELECT act.status
                                  FROM project_checklist_attachment_actions act
                                 WHERE act.attachment_id = da.id
                                 ORDER BY act.id DESC LIMIT 1), '') NOT IN ('done', 'replace')))`
    );
    pendingBinds.push(reviewSince, ...stateBinds);
  }
  if (f.pending_title) {
    pendingOr.push(
      `EXISTS (SELECT 1 FROM project_checklist pc
                WHERE pc.project_id = p.id AND pc.status = 'pending'
                  AND pc.title = ? AND ${NOT_IN_REVIEW} AND ${DUE_GATE})`
    );
    pendingBinds.push(f.pending_title, dueToday);
  }
  if (f.pending_approve && f.pending_approve.length) {
    // Approver lane: projects with a DUE item whose required_perm is one the
    // caller holds AND which has actually been SUBMITTED for review (owner
    // 2026-07-23, weisiang report). Gate on review_status, not a bare
    // status='pending' — an item nobody has uploaded yet is the submitter's
    // pending, not the approver's; it only reaches the approver on submit.
    const ph = f.pending_approve.map(() => "?").join(",");
    pendingOr.push(
      `EXISTS (SELECT 1 FROM project_checklist pc
                WHERE pc.project_id = p.id
                  AND pc.status = 'pending'
                  AND pc.review_status IN ('pending_review', 'amended')
                  AND pc.required_perm IN (${ph}) AND ${DUE_GATE})`
    );
    pendingBinds.push(...f.pending_approve, dueToday);
  }
  if (f.pending_logistic) {
    // Logistic work is staged:
    //   - SETUP is due once "Stock Out Transfer Record" is completed
    //     (done/approved) but the setup time+crew aren't filled yet.
    //   - DISMANTLE is due once setup is arranged but the dismantle
    //     time+crew aren't filled yet.
    pendingOr.push(`(
      (
        EXISTS (SELECT 1 FROM project_checklist pc
                 WHERE pc.project_id = p.id
                   AND pc.title = 'Stock Out Transfer Record'
                   AND (pc.status = 'done' OR pc.review_status = 'approved'))
        AND p.setup_start_at IS NULL
        AND COALESCE(p.setup_crew, '') IN ('', '{}')
      )
      OR
      (
        (p.setup_start_at IS NOT NULL OR COALESCE(p.setup_crew, '') NOT IN ('', '{}'))
        AND p.dismantle_start_at IS NULL
        AND COALESCE(p.dismantle_crew, '') IN ('', '{}')
      )
    )`);
  }
  // Sales Director staging (owner 2026-07-21): approve the stock-out record once
  // the purchaser submitted it, and assign the Sales Attending reps.
  if (f.pending_director) {
    if (f.pending_director.stock) {
      // Which stock documents this director approves (owner 2026-08-21: a
      // submitted Stock IN reached no approver lane — only Stock Out was
      // watched). The caller passes titles per the keys the user explicitly
      // holds; default keeps the historical Stock-Out-only behaviour.
      const stockTitles = f.pending_director.stock_titles?.length
        ? f.pending_director.stock_titles
        : ["Stock Out Transfer Record"];
      const ph = stockTitles.map(() => "?").join(",");
      pendingOr.push(
        `(EXISTS (SELECT 1 FROM project_checklist pc
                WHERE pc.project_id = p.id AND pc.title IN (${ph})
                  AND pc.status = 'pending'
                  AND pc.review_status IN ('pending_review', 'amended') AND ${DUE_GATE})${APPROVER_BRAND_GATE})`
      );
      pendingBinds.push(...stockTitles, dueToday);
    }
    if (f.pending_director.agreement) { pendingOr.push(AGREEMENT_PENDING); pendingBinds.push(dueToday); }
    if (f.pending_director.sales_attending) { pendingOr.push(SALES_ATTENDING_EMPTY); pendingBinds.push(dueToday); }
    if (f.pending_director.sales_pic) { pendingOr.push(SALES_PIC_EMPTY); pendingBinds.push(dueToday); }
  }
  // Sales Attending not yet assigned (Sales PIC).
  if (f.pending_sales_attending) { pendingOr.push(SALES_ATTENDING_EMPTY); pendingBinds.push(dueToday); }
  // Agreement / Quotation on its own timeline (Super Admin / weisiang).
  if (f.pending_agreement) { pendingOr.push(AGREEMENT_PENDING); pendingBinds.push(dueToday); }
  if (pendingOr.length) {
    // Only CONFIRMED events generate anyone's pending work (owner 2026-08-17:
    // "why event on status cancelled and pending appear in my pending task??
    // ... make sure these 2 status event not appear on my pending task").
    // Measured at the time of the report: 22 lane items sat on cancelled
    // events and 24 on unconfirmed ('pending'-status) ones. Applied to the
    // whole OR-block so every lane — role, title, approver, logistic,
    // director, defect — inherits it; NULL/legacy status still shows.
    where.push(`COALESCE(p.status, 'confirmed') NOT IN ('cancelled', 'pending')`);
    // Legacy events never surface (owner 2026-08-24: "event yg lama semua
    // jangan bagi keluar dekat my pending task ... just start bulan ni and
    // onward saja / apply to all user"). Events that ENDED before Aug 2026
    // carry years of deliberately-incomplete checklists (641 overdue items at
    // the time of the report, oldest from Feb 2025), so every lane skips them.
    // A FIXED epoch, not a rolling month: rolling would silently drop a
    // just-ended event's post-event tasks (Filled Floorplan T+3d, Event
    // Complete T+7d) at every month turn. end_date over start_date so an
    // event still running into August stays visible.
    where.push(`substr(COALESCE(p.end_date, p.start_date), 1, 10) >= '${MY_PENDING_EPOCH}'`);
    where.push(`(${pendingOr.join("\n      OR ")})`);
    binds.push(...pendingBinds);
  }
  // "Completed project" predicate — reused by both the positive
  // (section=__done) filter and the negative (exclude_done) toggle.
  const SECTION_DONE_PREDICATE = `(
    EXISTS (SELECT 1 FROM project_checklist_sections s WHERE s.project_id = p.id)
    AND NOT EXISTS (
      SELECT 1 FROM project_checklist_sections s
       WHERE s.project_id = p.id
         AND EXISTS (
           SELECT 1 FROM project_checklist c
            WHERE c.project_id = p.id
              AND c.section_id = s.id
              AND c.status NOT IN ('done','na')
         )
    )
  )`;

  // Hide-completed stands down when the caller explicitly asked for the
  // Completed bucket — checked against the whole multi-pick, not just an exact
  // "__done" (owner 2026-08-07 made section a list).
  if (f.exclude_done && !csvList(f.section).includes("__done")) {
    where.push(`NOT ${SECTION_DONE_PREDICATE}`);
  }

  // Section accepts a COMMA-SEPARATED list too (owner 2026-08-07). The two
  // sentinels stay meaningful inside a multi-pick: "__done" (everything
  // complete) and "__none" (no sections defined) become OR-ed alternatives
  // alongside the real section names, so "OPERATION or Completed" works.
  const sectionList = csvList(f.section);
  if (sectionList.length) {
    const names = sectionList.filter((s) => s !== "__done" && s !== "__none");
    const ors: string[] = [];
    if (sectionList.includes("__done")) ors.push(SECTION_DONE_PREDICATE);
    if (sectionList.includes("__none")) {
      ors.push(
        `NOT EXISTS (SELECT 1 FROM project_checklist_sections s WHERE s.project_id = p.id)`
      );
    }
    if (names.length) {
      // Match the active section (lowest sort_order with open tasks).
      ors.push(
        `(
           SELECT s.name FROM project_checklist_sections s
            WHERE s.project_id = p.id
              AND EXISTS (
                SELECT 1 FROM project_checklist c
                 WHERE c.project_id = p.id
                   AND c.section_id = s.id
                   AND c.status NOT IN ('done','na')
              )
            ORDER BY s.sort_order LIMIT 1
         ) IN (${names.map(() => "?").join(",")})`
      );
    }
    where.push(`(${ors.join(" OR ")})`);
    binds.push(...names);
  }
  // Outstanding-task filter (owner 2026-08-05, multi-select 2026-08-07): keep
  // events where AT LEAST ONE of the ticked tasks is still open. Deliberately
  // not `NOT EXISTS(... done ...)` — an event that never had the task at all is
  // not "incomplete", it is out of scope.
  const taskPendingList = (f.task_pending ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (taskPendingList.length) {
    const ph = taskPendingList.map(() => "?").join(",");
    where.push(
      `EXISTS (SELECT 1 FROM project_checklist tp
                WHERE tp.project_id = p.id
                  AND tp.title IN (${ph})
                  AND tp.status NOT IN ('done','na'))`
    );
    binds.push(...taskPendingList);
  }
  if (f.search) {
    // Restore mobile client-search coverage lost when the PMS list moved to
    // server pagination: brand + PIC name were previously searchable
    // client-side. `brand` is a plain column; PIC name resolves via a
    // correlated subquery to users (mirroring the `pic.name` display join at
    // the SELECT) so it also works inside the COUNT(*) query, which does NOT
    // join users. Additive — keeps code/name/venue/organizer.
    where.push(
      "(p.code LIKE ? OR p.name LIKE ? OR p.venue LIKE ? OR p.organizer LIKE ? OR p.brand LIKE ? OR (SELECT u.name FROM users u WHERE u.id = p.pic_id) LIKE ?)"
    );
    const like = `%${f.search}%`;
    binds.push(like, like, like, like, like, like);
  }
  // Row-level PIC/brand visibility ACL removed (owner decision 2026-08-19):
  // within a company, any user with the projects permission sees ALL that
  // company's projects. Visibility is governed only by the projects page-access
  // gate and the company predicate (p.company_id above); crew scoping
  // (assigned_user_id) is a separate axis and stays.
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const page = f.page && f.page > 0 ? f.page : 1;
  const perPage = Math.min(f.per_page ?? 50, 200);
  const offset = (page - 1) * perPage;

  const total = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM projects p ${whereSql}`
  )
    .bind(...binds)
    .first<{ count: number }>();

  // Build ORDER BY: explicit sort overrides the default. My Pending is a
  // work queue, so it follows the timeline — soonest event first (owner
  // 2026-07-23: "all pending task appear follow by timeline"); everywhere
  // else keeps the "nulls last, newest start_date first" dashboard default.
  const sortExpr = f.sort_by ? PROJECT_SORT_MAP[f.sort_by] : null;
  const sortDir = f.sort_dir === "asc" ? "ASC" : "DESC";
  const orderBy = sortExpr
    ? `ORDER BY ${sortExpr} ${sortDir}, p.id DESC`
    : pendingOr.length
      ? `ORDER BY
         CASE WHEN p.start_date IS NULL THEN 1 ELSE 0 END,
         p.start_date ASC, p.id ASC`
      : `ORDER BY
         CASE WHEN p.start_date IS NULL THEN 1 ELSE 0 END,
         p.start_date DESC, p.id DESC`;

  // Crew "My events" cards: the caller's own open role tasks, due-gated with
  // the same MYT rule as the my_pending lanes. Interpolated (no bind juggling
  // in the SELECT list) — label is whitelist-validated, dueToday is our own
  // YYYY-MM-DD string.
  const ptl =
    f.pending_titles_label && /^[A-Z ]{2,20}$/.test(f.pending_titles_label)
      ? f.pending_titles_label
      : null;
  // Director duties as title chips (owner 2026-07-23, Peter report): the
  // section chip reads as someone else's stage, so director rows tag WHY the
  // row is theirs. Each predicate mirrors its lane exactly (literal-date
  // variants — the SELECT list is interpolated, not bound). Segments start
  // with '|' so LTRIM(..., '|') strips the lead and keeps the separators;
  // NULLIF collapses "no duty matched" to NULL so the frontend falls back.
  const stockDutyLit = (title: string) => `EXISTS (SELECT 1 FROM project_checklist pc2
              WHERE pc2.project_id = p.id AND pc2.title = '${title.replace(/'/g, "''")}'
                AND pc2.review_status IN ('pending_review', 'amended')
                AND substr(COALESCE(pc2.due_date, p.start_date), 1, 10) <= '${dueToday}')`;
  const ATTENDING_DUTY_LIT = `(substr(COALESCE(p.end_date, p.start_date), 1, 10) >= '${dueToday}'
              AND ${CONTRACT_CLEAR}
              AND NOT EXISTS (SELECT 1 FROM project_sales_attendees sa2 WHERE sa2.project_id = p.id))`;
  const PIC_DUTY_LIT = `(substr(COALESCE(p.end_date, p.start_date), 1, 10) >= '${dueToday}'
              AND ${CONTRACT_CLEAR}
              AND NOT EXISTS (SELECT 1 FROM users pu2 WHERE pu2.id = p.pic_id AND pu2.id <> 1))`;
  const AGREEMENT_DUTY_LIT = `EXISTS (SELECT 1 FROM project_checklist pc4
              WHERE pc4.project_id = p.id AND pc4.title = 'Agreement / Quotation'
                AND pc4.status = 'pending'
                AND substr(COALESCE(pc4.due_date, p.start_date), 1, 10) <= '${dueToday}')`;
  const directorDutySegs: string[] = [];
  if (f.pending_director?.stock) {
    const dutyTitles = f.pending_director.stock_titles?.length
      ? f.pending_director.stock_titles
      : ["Stock Out Transfer Record"];
    for (const t of dutyTitles) {
      const label = t === "Stock In Transfer Record" ? "Approve Stock In Transfer" : "Approve Stock Out Transfer";
      directorDutySegs.push(`CASE WHEN ${stockDutyLit(t)} THEN '|${label}' ELSE '' END`);
    }
  }
  if (f.pending_director?.sales_pic)
    directorDutySegs.push(`CASE WHEN ${PIC_DUTY_LIT} THEN '|Set Sales PIC' ELSE '' END`);
  if (f.pending_director?.sales_attending)
    directorDutySegs.push(`CASE WHEN ${ATTENDING_DUTY_LIT} THEN '|Set Sales Attending' ELSE '' END`);
  if (f.pending_director?.agreement)
    directorDutySegs.push(`CASE WHEN ${AGREEMENT_DUTY_LIT} THEN '|Approve Agreement / Quotation' ELSE '' END`);
  const pendingTitlesCol = ptl
    ? `,
            NULLIF(LTRIM(
              COALESCE((SELECT group_concat(c3.title, '|') FROM project_checklist c3
                WHERE c3.project_id = p.id
                  AND c3.status NOT IN ('done', 'na')
                  AND COALESCE(c3.review_status, '') NOT IN ('pending_review', 'amended')
                  AND c3.role_label LIKE '%${ptl}%'
                  AND substr(COALESCE(c3.due_date, p.start_date), 1, 10) <= '${dueToday}'), '')
              || ${f.pending_sales_attending ? `CASE WHEN ${ATTENDING_DUTY_LIT} THEN '|Set Sales Attending' ELSE '' END` : `''`},
            '|'), '') as my_pending_titles`
    : directorDutySegs.length
      ? `,
            NULLIF(LTRIM(${directorDutySegs.join("\n              || ")},
            '|'), '') as my_pending_titles`
      : f.pending_titles_logistic
      ? `,
            CASE
              WHEN EXISTS (SELECT 1 FROM project_checklist sot
                            WHERE sot.project_id = p.id
                              AND sot.title = 'Stock Out Transfer Record'
                              AND (sot.status = 'done' OR sot.review_status = 'approved'))
                   AND p.setup_start_at IS NULL
                   AND COALESCE(p.setup_crew, '') IN ('', '{}')
                THEN 'Arrange Setup Time and Crew'
              WHEN (p.setup_start_at IS NOT NULL OR COALESCE(p.setup_crew, '') NOT IN ('', '{}'))
                   AND p.dismantle_start_at IS NULL
                   AND COALESCE(p.dismantle_crew, '') IN ('', '{}')
                THEN 'Arrange Dismantle Time and Crew'
            END as my_pending_titles`
      : f.pending_titles_defect_review
      ? `,
            'Review Defect Items' as my_pending_titles`
      : "";

  // Outstanding-task column (owner 2026-08-05; multi 2026-08-07) — only when
  // the filter is on. One 'title=status' pair per TICKED task, '|'-joined, so
  // the export renders a column per ticked task and Excel can be filtered on
  // each. Titles are BOUND, never interpolated.
  const taskPendingCols = taskPendingList.length
    ? `,
            (SELECT group_concat(tp2.title || '=' || tp2.status, '|')
               FROM project_checklist tp2
              WHERE tp2.project_id = p.id
                AND tp2.title IN (${taskPendingList.map(() => "?").join(",")})) as task_pending_map`
    : "";
  // SELECT-list binds come BEFORE the WHERE binds in prepare() order.
  const taskPendingBinds = taskPendingList.length ? [...taskPendingList] : [];

  // Part 3 of the Status-filter rework (owner 2026-08-14): when a REAL section
  // is picked, hand back that section's tasks per project so each row can show
  // a coloured badge per task (done / pending / overdue). Format is
  // 'title=status=due' ('|'-joined); the checklist titles carry no '=' so the
  // client splits cleanly, due is a bare YYYY-MM-DD or empty. 'na' tasks are out
  // of scope. Section names are BOUND, never interpolated. Empty when no real
  // section is picked, so the extra scan only runs for the filtered view.
  const reportSections = csvList(f.section).filter((s) => s !== "__done" && s !== "__none");
  const sectionTasksCols = reportSections.length
    ? `,
            (SELECT group_concat(
                      c5.title || '=' || c5.status || '=' || COALESCE(substr(c5.due_date, 1, 10), ''),
                      '|')
               FROM project_checklist c5
               JOIN project_checklist_sections s5 ON s5.id = c5.section_id
              WHERE c5.project_id = p.id
                AND s5.name IN (${reportSections.map(() => "?").join(",")})
                AND c5.status != 'na') as section_tasks_map`
    : "";
  const sectionTasksBinds = reportSections.length ? [...reportSections] : [];

  const rows = await env.DB.prepare(
    `SELECT p.id, p.code, p.name, p.stage, p.status, p.brand,
            p.start_date, p.end_date,
            p.state, p.venue, p.organizer, p.booth_no, p.size_sqm,
            p.archived_at,
            p.pic_id, pic.name as pic_name, pic.phone as pic_phone,
            p.created_by, cb.name as created_by_name,
            et.name as event_type_name,
            pf.rental, pf.total_sales, pf.contractor_cost,
            -- Ledger-derived per-category finance sums (whole RM integers).
            -- One grouped scan of the lines joined once (fl below), never a
            -- per-row fetch. Mirrors the category buckets the Finance tab uses
            -- in routes/projects.ts /finance/by-project. GP / NP / percent are
            -- derived client-side so the list stays a thin projection.
            COALESCE(fl.fin_revenue, 0) as fin_revenue,
            COALESCE(fl.fin_cogs, 0) as fin_cogs,
            COALESCE(fl.fin_cogs_matt_sofa, 0) as fin_cogs_matt_sofa,
            COALESCE(fl.fin_cogs_bedframe, 0) as fin_cogs_bedframe,
            COALESCE(fl.fin_cogs_accessories, 0) as fin_cogs_accessories,
            COALESCE(fl.fin_rental, 0) as fin_rental,
            COALESCE(fl.fin_total_cost, 0) as fin_total_cost,
            -- Computed progress %: done / (total − na). SUM(CASE…) for
            -- D1/SQLite compatibility — avoids the newer FILTER clause.
            (SELECT CASE
                      WHEN SUM(CASE WHEN c.status != 'na' THEN 1 ELSE 0 END) = 0 THEN 0
                      ELSE CAST(
                             100.0 * SUM(CASE WHEN c.status = 'done' THEN 1 ELSE 0 END)
                                   / SUM(CASE WHEN c.status != 'na' THEN 1 ELSE 0 END)
                             AS INTEGER)
                    END
               FROM project_checklist c
              WHERE c.project_id = p.id) as progress_pct,
            -- Section-driven stage tracker (mig 050).
            -- active_section = lowest-sort_order section with any open task.
            (SELECT s.name FROM project_checklist_sections s
              WHERE s.project_id = p.id
                AND EXISTS (
                  SELECT 1 FROM project_checklist c
                   WHERE c.project_id = p.id
                     AND c.section_id = s.id
                     AND c.status NOT IN ('done', 'na')
                )
              ORDER BY s.sort_order LIMIT 1) as active_section_name,
            -- Section totals so the UI can show "complete" when all are done.
            (SELECT COUNT(*) FROM project_checklist_sections s
              WHERE s.project_id = p.id) as sections_total,
            (SELECT COUNT(*) FROM project_checklist_sections s
              WHERE s.project_id = p.id
                AND NOT EXISTS (
                  SELECT 1 FROM project_checklist c
                   WHERE c.project_id = p.id
                     AND c.section_id = s.id
                     AND c.status NOT IN ('done', 'na')
                )) as sections_complete,
            -- Sales-only progress (owner 2026-07-21). Counts over SALES PIC
            -- badged tasks; done = status done/na or a live attachment exists
            -- (uploads are the sales completion signal). NOTE keep these SQL
            -- comments free of apostrophes / quoted words: the D1-to-PG shim
            -- mis-scans quotes inside comments and 500s the whole list query.
            (SELECT COUNT(*) FROM project_checklist c
              WHERE c.project_id = p.id
                AND c.role_label LIKE 'SALES PIC%') as sales_tasks_total,
            (SELECT COUNT(*) FROM project_checklist c
              WHERE c.project_id = p.id
                AND c.role_label LIKE 'SALES PIC%'
                AND (c.status IN ('done', 'na')
                     OR EXISTS (SELECT 1 FROM project_checklist_attachments a
                                 WHERE a.item_id = c.id
                                   AND a.archived_at IS NULL))) as sales_tasks_done${pendingTitlesCol}${taskPendingCols}${sectionTasksCols}
       FROM projects p
       LEFT JOIN project_event_types et ON et.id = p.event_type_id
       LEFT JOIN project_finance pf ON pf.project_id = p.id
       LEFT JOIN (
              SELECT l.project_id,
                     SUM(CASE WHEN l.kind = 'income' AND l.category = 'sales' THEN l.amount ELSE 0 END) as fin_revenue,
                     SUM(CASE WHEN l.kind = 'cost' AND l.category IN ('cogs','cogs_matt_sofa','cogs_bedframe','cogs_accessories') THEN l.amount ELSE 0 END) as fin_cogs,
                     SUM(CASE WHEN l.kind = 'cost' AND l.category = 'cogs_matt_sofa' THEN l.amount ELSE 0 END) as fin_cogs_matt_sofa,
                     SUM(CASE WHEN l.kind = 'cost' AND l.category = 'cogs_bedframe' THEN l.amount ELSE 0 END) as fin_cogs_bedframe,
                     SUM(CASE WHEN l.kind = 'cost' AND l.category = 'cogs_accessories' THEN l.amount ELSE 0 END) as fin_cogs_accessories,
                     SUM(CASE WHEN l.kind = 'cost' AND l.category = 'rental' THEN l.amount ELSE 0 END) as fin_rental,
                     SUM(CASE WHEN l.kind = 'cost' THEN l.amount ELSE 0 END) as fin_total_cost
                FROM project_finance_lines l
               WHERE l.archived_at IS NULL
               GROUP BY l.project_id
            ) fl ON fl.project_id = p.id
       LEFT JOIN users pic ON pic.id = p.pic_id
       LEFT JOIN users cb ON cb.id = p.created_by
     ${whereSql}
     ${orderBy}
     LIMIT ? OFFSET ?`
  )
    .bind(...taskPendingBinds, ...sectionTasksBinds, ...binds, perPage, offset)
    .all();

  return {
    data: rows.results ?? [],
    page,
    per_page: perPage,
    total: total?.count ?? 0,
  };
}

// ── Finance ───────────────────────────────────────────────────

const FINANCE_FIELDS = [
  "rental", "contractor_cost", "license_fee",
  "deposit_paid", "deposit_refund", "misc_cost",
  "total_sales", "notes",
] as const;

export async function patchFinance(
  env: Env,
  projectId: number,
  body: Record<string, any>,
  userId: number
) {
  const sets: string[] = [];
  const binds: any[] = [];
  for (const k of FINANCE_FIELDS) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push(body[k] ?? null);
    }
  }
  if (!sets.length) return false;
  // UPSERT (owner 2026-08-12 "why i cant save?"): this was UPDATE-only, so a
  // project with NO project_finance row could never be given a Total Sales or
  // rental — the UPDATE matched 0 rows, `changes > 0` was false and the route
  // answered 400 "No changes", which reads as "nothing to save" rather than
  // "there was nowhere to save it". 368 live projects were in that state (rows
  // are created with the project, so copies/imports that skipped it were
  // silently unwritable). Create the row first, then update it.
  await env.DB.prepare(
    `INSERT INTO project_finance (project_id)
     SELECT ? WHERE NOT EXISTS (SELECT 1 FROM project_finance WHERE project_id = ?)`
  )
    .bind(projectId, projectId)
    .run();
  sets.push("updated_at = datetime('now')", "updated_by = ?");
  binds.push(userId, projectId);
  const r = await env.DB.prepare(
    `UPDATE project_finance SET ${sets.join(", ")} WHERE project_id = ?`
  )
    .bind(...binds)
    .run();
  await logProjectActivity(env, projectId, "finance_edit", null, null, null, userId);
  return r.meta.changes > 0;
}

// ── Checklist ─────────────────────────────────────────────────

export interface CreateChecklistItemInput {
  project_id: number;
  title: string;
  description?: string | null;
  required_perm?: string | null;
  due_date?: string | null;
  owner_user_id?: number | null;
  seq?: number | null;
  section_id?: number | null;
}

export async function createChecklistItem(
  env: Env,
  input: CreateChecklistItemInput,
  userId: number
) {
  // Pick the next seq if not provided — append to end.
  let seq = input.seq ?? null;
  if (seq == null) {
    const row = await env.DB.prepare(
      `SELECT COALESCE(MAX(seq), 0) + 10 as next_seq
         FROM project_checklist WHERE project_id = ?`
    )
      .bind(input.project_id)
      .first<{ next_seq: number }>();
    seq = row?.next_seq ?? 10;
  }
  // Compute the offset relative to the project's start_date, so a
  // later project-level start_date change keeps this task at the
  // same relative position in the schedule.
  let dueOffsetDays: number | null = null;
  if (input.due_date) {
    const proj = await env.DB.prepare(
      `SELECT start_date FROM projects WHERE id = ?`
    )
      .bind(input.project_id)
      .first<{ start_date: string | null }>();
    if (proj?.start_date) {
      const due = new Date(String(input.due_date).slice(0, 10) + "T00:00:00Z");
      const start = new Date(String(proj.start_date).slice(0, 10) + "T00:00:00Z");
      if (!isNaN(due.getTime()) && !isNaN(start.getTime())) {
        dueOffsetDays = Math.round(
          (due.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
        );
      }
    }
  }
  const r = await env.DB.prepare(
    `INSERT INTO project_checklist
       (project_id, section_id, seq, title, description, required_perm, due_date, due_offset_days, owner_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.project_id,
      input.section_id ?? null,
      seq,
      input.title,
      input.description ?? null,
      input.required_perm ?? null,
      input.due_date ?? null,
      dueOffsetDays,
      input.owner_user_id ?? null
    )
    .run();
  await logProjectActivity(env, input.project_id, "checklist_add", null, input.title, null, userId);
  return { id: r.meta.last_row_id as number };
}

const CHECKLIST_PATCH_FIELDS = [
  "title", "description", "required_perm",
  "due_date", "owner_user_id", "seq", "notes",
  "section_id",
  "role_label",
  "crew_visible",
  "pill_value",
] as const;

export async function patchChecklistItem(
  env: Env,
  itemId: number,
  body: Record<string, any>,
  userId: number
) {
  const sets: string[] = [];
  const binds: any[] = [];
  for (const k of CHECKLIST_PATCH_FIELDS) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push(body[k] ?? null);
    }
  }

  // When the user moves a task's due_date by hand, re-anchor the
  // task's offset to the project's current start_date so a future
  // project-level start_date change preserves this manual shift.
  if ("due_date" in body) {
    const row = await env.DB.prepare(
      `SELECT c.project_id, p.start_date
         FROM project_checklist c
         JOIN projects p ON p.id = c.project_id
        WHERE c.id = ?`
    )
      .bind(itemId)
      .first<{ project_id: number; start_date: string | null }>();
    let nextOffset: number | null = null;
    if (body.due_date && row?.start_date) {
      const due = new Date(String(body.due_date).slice(0, 10) + "T00:00:00Z");
      const start = new Date(String(row.start_date).slice(0, 10) + "T00:00:00Z");
      if (!isNaN(due.getTime()) && !isNaN(start.getTime())) {
        nextOffset = Math.round(
          (due.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
        );
      }
    }
    sets.push("due_offset_days = ?");
    binds.push(nextOffset);
  }

  if (!sets.length) return false;
  sets.push("updated_at = datetime('now')");
  binds.push(itemId);
  const r = await env.DB.prepare(
    `UPDATE project_checklist SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run();
  return r.meta.changes > 0;
}

export async function setChecklistStatus(
  env: Env,
  itemId: number,
  status: "pending" | "done" | "na" | "blocked",
  userId: number
) {
  const item = await env.DB.prepare(
    `SELECT project_id, title, status FROM project_checklist WHERE id = ?`
  )
    .bind(itemId)
    .first<{ project_id: number; title: string; status: string }>();
  if (!item) return false;

  if (status === "done") {
    await env.DB.prepare(
      `UPDATE project_checklist
          SET status = 'done',
              completed_by = ?,
              completed_at = datetime('now'),
              updated_at = datetime('now')
        WHERE id = ?`
    )
      .bind(userId, itemId)
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE project_checklist
          SET status = ?,
              completed_by = NULL,
              completed_at = NULL,
              updated_at = datetime('now')
        WHERE id = ?`
    )
      .bind(status, itemId)
      .run();
  }

  await logProjectActivity(
    env,
    item.project_id,
    "checklist_status",
    item.status,
    status,
    item.title,
    userId
  );
  return true;
}

// ── Checklist review loop ────────────────────────────────────
// Rejection/amendment flow mirrors what the Notion page captured as
// free-text activity ("Design Reject — reason — Design Amended —
// Design Approved"). Each transition records a row in
// project_checklist_comments so the item has a traceable review
// history.

export async function addChecklistComment(
  env: Env,
  itemId: number,
  kind: "note" | "submit" | "reject" | "amend" | "approve" | "upload" | "remove", // upload/remove written as raw SQL by routes/projects.ts, bypassing here; mirror in pages/Projects.tsx, guarded by tests/checklistCommentKinds.test.ts
  body: string | null,
  userId: number
) {
  const r = await env.DB.prepare(
    `INSERT INTO project_checklist_comments (item_id, kind, body, user_id)
     VALUES (?, ?, ?, ?)`
  )
    .bind(itemId, kind, body ?? null, userId || null)
    .run();
  return { id: r.meta.last_row_id as number };
}

export async function submitChecklistForReview(env: Env, itemId: number, userId: number) {
  await env.DB.prepare(
    `UPDATE project_checklist
        SET review_status = 'pending_review',
            updated_at = datetime('now')
      WHERE id = ?`
  )
    .bind(itemId)
    .run();
  await addChecklistComment(env, itemId, "submit", null, userId);
}

export async function rejectChecklistItem(
  env: Env,
  itemId: number,
  reason: string,
  userId: number
) {
  await env.DB.prepare(
    `UPDATE project_checklist
        SET review_status = 'rejected',
            rejection_reason = ?,
            status = 'pending',
            updated_at = datetime('now')
      WHERE id = ?`
  )
    .bind(reason, itemId)
    .run();
  await addChecklistComment(env, itemId, "reject", reason, userId);
}

export async function amendChecklistItem(env: Env, itemId: number, note: string | null, userId: number) {
  await env.DB.prepare(
    `UPDATE project_checklist
        SET review_status = 'amended',
            updated_at = datetime('now')
      WHERE id = ?`
  )
    .bind(itemId)
    .run();
  await addChecklistComment(env, itemId, "amend", note, userId);
}

export async function approveChecklistItem(env: Env, itemId: number, userId: number) {
  // IDEMPOTENT (owner 2026-08-08 "approve button have bug"): the approver keeps
  // the Approve button after a decision (2026-07-31 rule, so it can be revisited),
  // but pressing it again on an ALREADY-approved item used to stack another
  // identical "Approved · name · time" line on the row — three clicks, three
  // lines, no state change. Re-approving an approved item is a no-op now: the
  // first decision and its timestamp stand, and the audit trail stays honest.
  // A rejection flips review_status away from 'approved', so re-approving after
  // a reject still records the new decision.
  const cur = await env.DB.prepare(
    `SELECT review_status FROM project_checklist WHERE id = ?`
  )
    .bind(itemId)
    .first<{ review_status: string | null }>();
  if ((cur?.review_status ?? "") === "approved") return;
  await env.DB.prepare(
    `UPDATE project_checklist
        SET review_status = 'approved',
            status = 'done',
            completed_by = ?,
            completed_at = datetime('now'),
            updated_at = datetime('now')
      WHERE id = ?`
  )
    .bind(userId || null, itemId)
    .run();
  await addChecklistComment(env, itemId, "approve", null, userId);
}

// ── Defects ──────────────────────────────────────────────────

export interface CreateDefectInput {
  project_id: number;
  phase: "setup" | "dismantle";
  reported_by_role: "sales" | "logistic";
  item_code?: string | null;
  item_description?: string | null;
  size?: string | null;
  quantity?: number | null;
  reason?: string | null;
  photo_r2_key?: string | null;
}

export async function createDefect(env: Env, input: CreateDefectInput, userId: number) {
  const r = await env.DB.prepare(
    `INSERT INTO project_defects
       (project_id, phase, reported_by_role, item_code, item_description,
        size, quantity, reason, photo_r2_key, reported_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.project_id,
      input.phase,
      input.reported_by_role,
      input.item_code ?? null,
      input.item_description ?? null,
      input.size ?? null,
      input.quantity ?? 1,
      input.reason ?? null,
      input.photo_r2_key ?? null,
      userId || null
    )
    .run();
  await logProjectActivity(
    env,
    input.project_id,
    "defect_add",
    null,
    `${input.phase}/${input.reported_by_role}`,
    input.item_code || input.item_description || null,
    userId
  );
  return { id: r.meta.last_row_id as number };
}

const DEFECT_PATCH_FIELDS = [
  "item_code", "item_description", "size", "quantity",
  "reason", "photo_r2_key", "resolved", "resolved_notes", "linked_assr_id",
] as const;

export async function patchDefect(
  env: Env,
  id: number,
  body: Record<string, any>,
  _userId: number
) {
  const sets: string[] = [];
  const binds: any[] = [];
  for (const k of DEFECT_PATCH_FIELDS) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push(body[k] ?? null);
    }
  }
  if (!sets.length) return false;
  binds.push(id);
  const r = await env.DB.prepare(
    `UPDATE project_defects SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run();
  return r.meta.changes > 0;
}

export async function archiveDefect(env: Env, id: number) {
  await env.DB.prepare(
    `UPDATE project_defects SET archived_at = datetime('now') WHERE id = ?`
  )
    .bind(id)
    .run();
}

// ── Sales reports ────────────────────────────────────────────

export interface CreateSalesReportInput {
  project_id: number;
  title?: string | null;
  sales_amount?: number | null;
  period_start?: string | null;
  period_end?: string | null;
  r2_key?: string | null;
  file_name?: string | null;
  mime_type?: string | null;
}

export async function createSalesReport(
  env: Env,
  input: CreateSalesReportInput,
  userId: number,
  options?: { syncToFinance?: boolean }
) {
  const r = await env.DB.prepare(
    `INSERT INTO project_sales_reports
       (project_id, title, sales_amount, period_start, period_end,
        r2_key, file_name, mime_type, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.project_id,
      input.title ?? null,
      input.sales_amount ?? null,
      input.period_start ?? null,
      input.period_end ?? null,
      input.r2_key ?? null,
      input.file_name ?? null,
      input.mime_type ?? null,
      userId || null
    )
    .run();

  // Opt-in roll-up into project_finance.total_sales. Summing all
  // non-archived sales_amounts is safer than incrementing — multiple
  // reports can be edited/deleted and we want finance to stay consistent.
  if (options?.syncToFinance) {
    await syncSalesTotalFromReports(env, input.project_id);
  }

  await logProjectActivity(
    env,
    input.project_id,
    "sales_report_add",
    null,
    input.title || String(input.sales_amount ?? ""),
    null,
    userId
  );
  return { id: r.meta.last_row_id as number };
}

export async function archiveSalesReport(env: Env, id: number, syncToFinance?: boolean) {
  const row = await env.DB.prepare(
    `SELECT project_id FROM project_sales_reports WHERE id = ?`
  )
    .bind(id)
    .first<{ project_id: number }>();
  await env.DB.prepare(
    `UPDATE project_sales_reports SET archived_at = datetime('now') WHERE id = ?`
  )
    .bind(id)
    .run();
  if (syncToFinance && row?.project_id) {
    await syncSalesTotalFromReports(env, row.project_id);
  }
}

export async function syncSalesTotalFromReports(env: Env, projectId: number) {
  const sum = await env.DB.prepare(
    `SELECT COALESCE(SUM(sales_amount), 0) as total
       FROM project_sales_reports
      WHERE project_id = ? AND archived_at IS NULL`
  )
    .bind(projectId)
    .first<{ total: number }>();
  await env.DB.prepare(
    `UPDATE project_finance
        SET total_sales = ?, updated_at = datetime('now')
      WHERE project_id = ?`
  )
    .bind(sum?.total ?? 0, projectId)
    .run();
}

// ── Finance ledger ───────────────────────────────────────────
// New model: project_finance_lines holds individual income/cost line
// items. project_finance stays as a rollup cache (summed per canonical
// category) so existing list queries keep working. Every ledger write
// triggers a resync.

// Categories the UI surfaces in its picker. Any string is accepted on
// write (forward-compatible with "cleaning fee", "insurance" etc.).
// The first eight (rental, cogs, setup, transport, commission,
// merchandise, contractor, license) are the ones surfaced as
// dedicated columns in the Finance List view + per-project breakdown
// stat strip; the rest roll up into "Others".
// 2026-05-08 — boss's Financial Snapshot model split COGS into
// product sub-categories and transport into rate-driven fee + actual
// logistics cost. Legacy `cogs` and `transport` slugs are kept so
// existing rows still display; new lines should pick from the
// sub-categories below.
export const LEDGER_COST_CATEGORIES = [
  // Rental + COGS family
  "rental",
  "cogs",                       // legacy bucket — kept for old rows
  "cogs_matt_sofa",
  "cogs_bedframe",
  "cogs_accessories",
  // Operations
  "setup",
  "transport",                  // legacy bucket — kept for old rows
  "transport_fee",              // % of sales, auto-applied by rate engine
  "transport_setup_dismantle",  // actual logistics cost
  "commission", "merchandise",
  // Misc
  "contractor", "license", "deposit", "permit",
  "accommodation", "staffing", "marketing", "misc",
] as const;

export const LEDGER_INCOME_CATEGORIES = [
  "sales", "deposit_refund", "rebate", "other_income",
] as const;

export interface CreateLedgerLineInput {
  project_id: number;
  kind: "income" | "cost";
  category: string;
  description?: string | null;
  amount: number;
  occurred_at?: string | null;
  r2_key?: string | null;
  file_name?: string | null;
  mime_type?: string | null;
  notes?: string | null;
}

export async function createLedgerLine(
  env: Env,
  input: CreateLedgerLineInput,
  userId: number
) {
  if (!Number.isFinite(input.amount) || input.amount < 0) {
    throw new Error("amount must be a non-negative number");
  }
  if (!input.category.trim()) throw new Error("category required");
  // Stamp company_id from the parent project (mig 0170). Subquery keeps this
  // atomic — if the project doesn't exist the FK below fails before the
  // subquery lands, so we never orphan a line under a null company.
  const r = await env.DB.prepare(
    `INSERT INTO project_finance_lines
       (project_id, kind, category, description, amount, occurred_at,
        r2_key, file_name, mime_type, notes, created_by, company_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             (SELECT company_id FROM projects WHERE id = ?))`
  )
    .bind(
      input.project_id,
      input.kind,
      input.category.trim(),
      input.description ?? null,
      input.amount,
      input.occurred_at ?? null,
      input.r2_key ?? null,
      input.file_name ?? null,
      input.mime_type ?? null,
      input.notes ?? null,
      userId || null,
      input.project_id
    )
    .run();
  // Auto cost-line engine (mig 063) runs after non-auto writes only.
  // Its own writes are tagged `auto_source` and don't traverse this
  // function, so the guard is mostly for symmetry with patch/archive.
  await recomputeAutoCostLines(env, input.project_id, userId);
  await syncFinanceRollup(env, input.project_id);
  await logProjectActivity(
    env,
    input.project_id,
    "finance_line_add",
    input.kind,
    input.category,
    String(input.amount),
    userId
  );
  return { id: r.meta.last_row_id as number };
}

const LEDGER_LINE_PATCH_FIELDS = [
  "kind", "category", "description", "amount", "occurred_at",
  "r2_key", "file_name", "mime_type", "notes",
] as const;

export async function patchLedgerLine(
  env: Env,
  lineId: number,
  body: Record<string, any>,
  userId: number
) {
  const line = await env.DB.prepare(
    `SELECT project_id, auto_source FROM project_finance_lines WHERE id = ?`
  )
    .bind(lineId)
    .first<{ project_id: number; auto_source: string | null }>();
  if (!line) return false;
  // Auto-generated rows are owned by the cost-rate engine — refuse
  // user edits so the next recompute doesn't silently overwrite them.
  if (line.auto_source) return false;

  const sets: string[] = [];
  const binds: any[] = [];
  for (const k of LEDGER_LINE_PATCH_FIELDS) {
    if (k in body) {
      sets.push(`${k} = ?`);
      binds.push(body[k] ?? null);
    }
  }
  if (!sets.length) return false;
  sets.push("updated_at = datetime('now')");
  binds.push(lineId);
  await env.DB.prepare(
    `UPDATE project_finance_lines SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run();
  await recomputeAutoCostLines(env, line.project_id, userId);
  await syncFinanceRollup(env, line.project_id);
  await logProjectActivity(env, line.project_id, "finance_line_edit", null, null, null, userId);
  return true;
}

export async function archiveLedgerLine(env: Env, lineId: number, userId: number) {
  const line = await env.DB.prepare(
    `SELECT project_id, auto_source FROM project_finance_lines WHERE id = ?`
  )
    .bind(lineId)
    .first<{ project_id: number; auto_source: string | null }>();
  if (!line) return false;
  // Auto rows are managed by the cost-rate engine — refuse user
  // deletes; users edit the rate card instead.
  if (line.auto_source) return false;
  await env.DB.prepare(
    `UPDATE project_finance_lines SET archived_at = datetime('now') WHERE id = ?`
  )
    .bind(lineId)
    .run();
  await recomputeAutoCostLines(env, line.project_id, userId);
  await syncFinanceRollup(env, line.project_id);
  await logProjectActivity(env, line.project_id, "finance_line_remove", null, null, null, userId);
  return true;
}

// Rebuild project_finance from the current line set. Called after any
// ledger mutation. total_sales stays in sync via this path too — when
// a sales-report line lands, its amount rolls into finance.total_sales.
export async function syncFinanceRollup(env: Env, projectId: number) {
  const sums = await env.DB.prepare(
    `SELECT kind, category, COALESCE(SUM(amount), 0) as total
       FROM project_finance_lines
      WHERE project_id = ? AND archived_at IS NULL
      GROUP BY kind, category`
  )
    .bind(projectId)
    .all<{ kind: string; category: string; total: number }>();

  const out: Record<string, number> = {
    rental: 0,
    contractor_cost: 0,
    license_fee: 0,
    deposit_paid: 0,
    deposit_refund: 0,
    misc_cost: 0,
    total_sales: 0,
  };

  for (const row of sums.results ?? []) {
    if (row.kind === "cost") {
      switch (row.category) {
        case "rental":
          out.rental += row.total;
          break;
        case "contractor":
          out.contractor_cost += row.total;
          break;
        case "license":
          out.license_fee += row.total;
          break;
        case "deposit":
          out.deposit_paid += row.total;
          break;
        default:
          // Everything else bucketed into misc so the rollup stays balanced.
          out.misc_cost += row.total;
      }
    } else if (row.kind === "income") {
      switch (row.category) {
        case "deposit_refund":
          out.deposit_refund += row.total;
          break;
        case "sales":
        case "rebate":
        case "other_income":
          out.total_sales += row.total;
          break;
        default:
          out.total_sales += row.total;
      }
    }
  }

  // Also roll in any project_sales_reports entries — they predate the
  // ledger and users may keep entering sales via that flow.
  const reportSum = await env.DB.prepare(
    `SELECT COALESCE(SUM(sales_amount), 0) as total
       FROM project_sales_reports
      WHERE project_id = ? AND archived_at IS NULL`
  )
    .bind(projectId)
    .first<{ total: number }>();
  // If reports exist, they supersede the "sales" category in lines
  // (which was only seeded from legacy total_sales as a historical anchor).
  // Otherwise fall back to the ledger-derived sum.
  const reportTotal = reportSum?.total ?? 0;
  if (reportTotal > 0) {
    // Keep the larger of the two — a defensive max avoids double-counting
    // during the window where an admin is transitioning from reports
    // into ledger entries.
    out.total_sales = Math.max(out.total_sales, reportTotal);
  }

  // Roll in sales_entries (mig 041, the rep-facing flow that replaced
  // the file-upload sales-reports section in mig 051). Drafts count too
  // — what dispatchers / Sales Director care about is "sales taken on
  // the floor", not just AutoCount-pushed ones. Voided + archived rows
  // are excluded.
  const entriesSum = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount), 0) as total
       FROM sales_entries
      WHERE project_id = ?
        AND archived_at IS NULL
        AND status != 'void'`
  )
    .bind(projectId)
    .first<{ total: number }>();
  const entriesTotal = entriesSum?.total ?? 0;
  // Add to whatever's already there. Reports and entries are distinct
  // record sets — a project can have both during the migration window.
  out.total_sales += entriesTotal;

  await env.DB.prepare(
    `UPDATE project_finance
        SET rental = ?, contractor_cost = ?, license_fee = ?,
            deposit_paid = ?, deposit_refund = ?, misc_cost = ?,
            total_sales = ?, updated_at = datetime('now')
      WHERE project_id = ?`
  )
    .bind(
      out.rental,
      out.contractor_cost,
      out.license_fee,
      out.deposit_paid,
      out.deposit_refund,
      out.misc_cost,
      out.total_sales,
      projectId
    )
    .run();
}

// ── Payment workflow ─────────────────────────────────────────
// Dedicated from finance ledger because "did we pay the organizer"
// is a different question from "what did it cost". A case can have
// a full ledger and still be blocked because the security deposit
// payment isn't recorded yet.

export async function setPaymentStatus(
  env: Env,
  projectId: number,
  status: string,
  opts: { notes?: string | null; proof_r2_key?: string | null; proof_file_name?: string | null },
  userId: number
) {
  if (!PAYMENT_STATUSES.includes(status as any)) {
    throw new Error(`Invalid payment_status: ${status}`);
  }
  const sets: string[] = [
    "payment_status = ?",
    "payment_updated_at = datetime('now')",
    "payment_updated_by = ?",
  ];
  const binds: any[] = [status, userId || null];
  if (opts.notes !== undefined) {
    sets.push("payment_notes = ?");
    binds.push(opts.notes ?? null);
  }
  if (opts.proof_r2_key !== undefined) {
    sets.push("payment_proof_r2_key = ?");
    binds.push(opts.proof_r2_key ?? null);
  }
  if (opts.proof_file_name !== undefined) {
    sets.push("payment_proof_file_name = ?");
    binds.push(opts.proof_file_name ?? null);
  }
  binds.push(projectId);
  await env.DB.prepare(
    `UPDATE projects SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run();
  await logProjectActivity(env, projectId, "payment_status", null, status, opts.notes ?? null, userId);
}

// ── Stock transfers ──────────────────────────────────────────

export interface CreateStockTransferInput {
  project_id: number;
  direction: "out" | "return";
  transferred_at?: string | null;
  record_r2_key?: string | null;
  file_name?: string | null;
  mime_type?: string | null;
  notes?: string | null;
}

export async function createStockTransfer(
  env: Env,
  input: CreateStockTransferInput,
  userId: number
) {
  // A transfer with no date DEFAULTS to today; it is never refused. Both the
  // mirror task's due_date and its title come from this one field, so a blank
  // one used to produce a `due_date NULL` row titled bare "Stock OUT" —
  // invisible to the tasklist's date column, the Gantt and every due-date
  // rollup, and permanently so, because redateChecklistFromOffsets skips
  // `notes LIKE 'auto:%'` rows on purpose (their date follows the transfer,
  // not the project schedule).
  //
  // Default-never-refuse is the owner's standing rule for this system — the
  // same shape the PO expected-date and the journal entry-date already use.
  // todayMyt() and NOT toISOString(): Workers run in UTC, so before 08:00 MYT
  // a raw UTC slice files the transfer under YESTERDAY, every morning shift.
  //
  // DATE-ONLY on purpose. We know the day; we do not know the time, and a
  // silently invented 00:00 is a worse answer than an honest date.
  const transferredAt = input.transferred_at?.trim() || todayMyt();
  const r = await env.DB.prepare(
    `INSERT INTO project_stock_transfers
       (project_id, direction, transferred_at, record_r2_key, file_name, mime_type, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.project_id,
      input.direction,
      transferredAt,
      input.record_r2_key ?? null,
      input.file_name ?? null,
      input.mime_type ?? null,
      input.notes ?? null,
      userId || null
    )
    .run();
  const transferId = r.meta.last_row_id as number;
  // Surface the transfer in the tasklist so it's visible alongside other
  // project work. Linked back via notes marker so confirm/archive can
  // toggle the matching task's status.
  await syncStockTransferTask(env, {
    transferId,
    projectId: input.project_id,
    direction: input.direction,
    transferredAt,
    confirmedAt: null,
    userId,
  });
  await logProjectActivity(
    env,
    input.project_id,
    "stock_transfer_add",
    null,
    input.direction,
    input.notes ?? null,
    userId
  );
  return { id: transferId };
}

// ── Stock transfer ↔ tasklist mirror ─────────────────────────
// Each non-archived stock transfer surfaces as one project_checklist row
// so admins can see it in the Tasklist alongside everything else. The
// link is by notes marker `auto:stock_transfer=<id>` (no schema change).
const STOCK_TRANSFER_TASK_MARKER = "auto:stock_transfer=";

function stockTransferTaskTitle(direction: string, transferredAt: string | null) {
  const verb = direction === "out" ? "Stock OUT" : "Stock RETURN";
  return transferredAt ? `${verb} — ${transferredAt}` : verb;
}

async function syncStockTransferTask(
  env: Env,
  args: {
    transferId: number;
    projectId: number;
    direction: string;
    transferredAt: string | null;
    confirmedAt: string | null;
    userId: number;
  }
) {
  const marker = `${STOCK_TRANSFER_TASK_MARKER}${args.transferId}`;
  const existing = await env.DB.prepare(
    `SELECT id FROM project_checklist WHERE project_id = ? AND notes = ? LIMIT 1`
  )
    .bind(args.projectId, marker)
    .first<{ id: number }>();
  const status = args.confirmedAt ? "done" : "pending";
  const title = stockTransferTaskTitle(args.direction, args.transferredAt);
  if (existing) {
    await env.DB.prepare(
      `UPDATE project_checklist
          SET title = ?, due_date = ?, status = ?,
              completed_by = CASE WHEN ? = 'done' THEN ? ELSE NULL END,
              completed_at = CASE WHEN ? = 'done' THEN datetime('now') ELSE NULL END,
              updated_at = datetime('now')
        WHERE id = ?`
    )
      .bind(title, args.transferredAt, status, status, args.userId || null, status, existing.id)
      .run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO project_checklist
       (project_id, seq, title, description, due_date, status,
        completed_by, completed_at, notes, created_at, updated_at)
     VALUES (?, 9000, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  )
    .bind(
      args.projectId,
      title,
      "Auto-generated from Stock Transfers section",
      args.transferredAt,
      status,
      status === "done" ? args.userId || null : null,
      status === "done" ? new Date().toISOString() : null,
      marker
    )
    .run();
}

async function deleteStockTransferTask(env: Env, transferId: number) {
  const marker = `${STOCK_TRANSFER_TASK_MARKER}${transferId}`;
  await env.DB.prepare(
    `DELETE FROM project_checklist WHERE notes = ?`
  )
    .bind(marker)
    .run();
}

export async function confirmStockTransfer(env: Env, transferId: number, userId: number) {
  const row = await env.DB.prepare(
    `SELECT project_id, direction, transferred_at
       FROM project_stock_transfers WHERE id = ?`
  )
    .bind(transferId)
    .first<{ project_id: number; direction: string; transferred_at: string | null }>();
  if (!row) return false;
  await env.DB.prepare(
    `UPDATE project_stock_transfers
        SET confirmed_at = datetime('now'), confirmed_by = ?
      WHERE id = ?`
  )
    .bind(userId || null, transferId)
    .run();
  await syncStockTransferTask(env, {
    transferId,
    projectId: row.project_id,
    direction: row.direction,
    transferredAt: row.transferred_at,
    confirmedAt: new Date().toISOString(),
    userId,
  });
  await logProjectActivity(
    env,
    row.project_id,
    "stock_transfer_confirm",
    null,
    row.direction,
    null,
    userId
  );
  return true;
}

export async function unconfirmStockTransfer(env: Env, transferId: number) {
  const row = await env.DB.prepare(
    `SELECT project_id, direction, transferred_at
       FROM project_stock_transfers WHERE id = ?`
  )
    .bind(transferId)
    .first<{ project_id: number; direction: string; transferred_at: string | null }>();
  await env.DB.prepare(
    `UPDATE project_stock_transfers
        SET confirmed_at = NULL, confirmed_by = NULL
      WHERE id = ?`
  )
    .bind(transferId)
    .run();
  if (row) {
    await syncStockTransferTask(env, {
      transferId,
      projectId: row.project_id,
      direction: row.direction,
      transferredAt: row.transferred_at,
      confirmedAt: null,
      userId: 0,
    });
  }
}

export async function archiveStockTransfer(env: Env, transferId: number) {
  await env.DB.prepare(
    `UPDATE project_stock_transfers SET archived_at = datetime('now') WHERE id = ?`
  )
    .bind(transferId)
    .run();
  await deleteStockTransferTask(env, transferId);
}

// ── Internal (existing) ──────────────────────────────────────

export async function listLedgerLines(env: Env, projectId: number) {
  const rows = await env.DB.prepare(
    `SELECT l.*, u.name as created_by_name
       FROM project_finance_lines l
       LEFT JOIN users u ON u.id = l.created_by
      WHERE l.project_id = ? AND l.archived_at IS NULL
      ORDER BY
        CASE WHEN l.occurred_at IS NULL THEN 1 ELSE 0 END,
        l.occurred_at DESC,
        l.id DESC`
  )
    .bind(projectId)
    .all();
  return rows.results ?? [];
}

export async function deleteChecklistItem(env: Env, itemId: number, userId: number) {
  const item = await env.DB.prepare(
    `SELECT project_id, title FROM project_checklist WHERE id = ?`
  )
    .bind(itemId)
    .first<{ project_id: number; title: string }>();
  if (!item) return false;
  // Child FKs (project_checklist_attachments.item_id, project_checklist_comments.item_id)
  // were ON DELETE CASCADE but the D1->PG load dropped them to NO ACTION, so a bare
  // delete throws once a task has any attachment or comment. Clear children first.
  await env.DB.prepare(`DELETE FROM project_checklist_attachments WHERE item_id = ?`).bind(itemId).run();
  await env.DB.prepare(`DELETE FROM project_checklist_comments WHERE item_id = ?`).bind(itemId).run();
  await env.DB.prepare(`DELETE FROM project_checklist WHERE id = ?`).bind(itemId).run();
  await logProjectActivity(env, item.project_id, "checklist_remove", item.title, null, null, userId);
  return true;
}
