// Read-only answer to "does this person actually have an account?"
//
// WHY THIS EXISTS AS A SCRIPT AND A WORKFLOW
//
// The repo can only say who was MEANT to exist. scripts/migrate-2990-staff.mjs
// lists nine people, but it is dry-run unless APPLY=1, so a name appearing
// there proves an intent, never a row. The only place the answer lives is
// production, and asking for it used to cost an owner interruption plus the
// production DSN in front of a human for a SELECT. Actions already holds
// secrets.DATABASE_URL for the deploy, so the lookup runs there instead.
//
// WHAT IT CHECKS, AND WHY THE STAFF HALF MATTERS
//
// A person is TWO rows here: public.users (who logs in) and scm.staff (who
// documents are attributed to). They are joined by scm.staff.user_id, and the
// app resolves a person's staff uuid BY user_id and never by recomputing the
// md5 -- see scm/lib/salesScope.ts resolveCallerStaffId. So "the account
// exists" is not the whole question; the account can exist and still be
// detached from the staff row every SO/DO/payment references.
//
// migrate-2990-staff.mjs documents the failure mode in detail: trg_sync_user_to_staff
// (mig 0066) mints a fresh md5 staff row when its UPDATE matches nothing, so a
// naively-inserted user ends up with TWO staff rows -- the real one carrying the
// history, and an empty new one carrying the login. Attribution splits silently.
// This check reports both sides so that split is visible rather than inferred.
//
// Strictly one SELECT. No DDL, no writes, no transaction. Exits 0 for every
// legitimate answer including "no such user" -- a red job would read as "the
// check broke", and the ANSWER is the output. Only an unreachable database or a
// query error exits non-zero.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const email = (process.env.EMAIL ?? "").trim();
if (!email) {
  console.error("EMAIL not set. Usage: EMAIL=someone@example.com node scripts/check-user.mjs");
  process.exit(1);
}

// Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars.
function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

// `notice` surfaces the verdict on the workflow run's summary page, so the
// answer is readable without opening the log.
const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  // One statement. The user row drives everything; the staff lookups are done
  // BOTH by user_id (the link the app trusts) and by email (the orphan a split
  // would leave behind), because reporting only the first would hide the split.
  const [r] = await pg`
    WITH u AS (
      SELECT id, email, name, status, role_id, position_id, department_id,
             created_at, joined_at, last_login_at
        FROM public.users
       WHERE lower(btrim(email)) = lower(btrim(${email}))
       LIMIT 1
    )
    SELECT
      (SELECT row_to_json(u) FROM u) AS usr,
      (SELECT ro.name FROM public.roles ro JOIN u ON ro.id = u.role_id) AS role_name,
      (SELECT po.name FROM public.positions po JOIN u ON po.id = u.position_id) AS position_name,
      (SELECT de.name FROM public.departments de JOIN u ON de.id = u.department_id) AS department_name,
      (SELECT json_agg(c.code ORDER BY c.id)
         FROM public.user_companies uc
         JOIN public.companies c ON c.id = uc.company_id
         JOIN u ON u.id = uc.user_id) AS companies,
      (SELECT json_agg(json_build_object(
                'id', s.id, 'staff_code', s.staff_code,
                'name', s.name, 'active', s.active))
         FROM scm.staff s JOIN u ON s.user_id = u.id) AS staff_by_link,
      (SELECT json_agg(json_build_object(
                'id', s.id, 'staff_code', s.staff_code,
                'name', s.name, 'active', s.active, 'user_id', s.user_id))
         FROM scm.staff s
        WHERE lower(btrim(s.email)) = lower(btrim(${email}))) AS staff_by_email`;

  if (!r?.usr) {
    notice(`NO ACCOUNT — public.users has no row for ${email}.`);
    const orphans = r?.staff_by_email ?? [];
    if (orphans.length) {
      notice(
        `But scm.staff HAS ${orphans.length} row(s) with that email: ` +
          orphans.map((s) => `${s.staff_code ?? "(no code)"}/${s.name}`).join(", ") +
          ". The person exists as staff and cannot log in.",
      );
    }
    notice("If this person was meant to exist, scripts/migrate-2990-staff.mjs was never run with APPLY=1.");
  } else {
    const u = r.usr;
    notice(`ACCOUNT EXISTS — users.id=${u.id}  ${u.name ?? "(no name)"}  <${u.email}>`);
    notice(`status=${u.status}  role=${r.role_name ?? "?"}  position=${r.position_name ?? "none"}  dept=${r.department_name ?? "none"}`);
    notice(`created=${u.created_at ?? "?"}  joined=${u.joined_at ?? "never"}  last_login=${u.last_login_at ?? "NEVER LOGGED IN"}`);
    notice(`companies=${(r.companies ?? []).join(", ") || "NONE GRANTED"}`);

    const linked = r.staff_by_link ?? [];
    if (linked.length === 0) {
      notice(
        "NO STAFF ROW LINKED — scm.staff has nothing with user_id=" + u.id +
          ". This person can log in but SCM documents cannot be attributed to them.",
      );
    } else if (linked.length === 1) {
      const s = linked[0];
      notice(`staff linked: ${s.staff_code ?? "(no code)"} / ${s.name} / active=${s.active} / ${s.id}`);
    } else {
      notice(
        `SPLIT ATTRIBUTION — ${linked.length} scm.staff rows point at user_id=${u.id}: ` +
          linked.map((s) => `${s.staff_code ?? "(no code)"}=${s.id}`).join(", "),
      );
    }

    // An email-matched staff row that is NOT the linked one is the orphan half
    // of the double-staff-row trap: history sits on it, the login does not.
    const linkedIds = new Set(linked.map((s) => s.id));
    const orphans = (r.staff_by_email ?? []).filter((s) => !linkedIds.has(s.id));
    if (orphans.length) {
      notice(
        `ORPHAN STAFF ROW(S) — ${orphans.length} scm.staff row(s) carry this email but are NOT linked to the account: ` +
          orphans.map((s) => `${s.staff_code ?? "(no code)"}=${s.id} (user_id=${s.user_id ?? "null"})`).join(", ") +
          ". Documents referencing those uuids are attributed to nobody who can log in.",
      );
    }
  }
} finally {
  await pg.end({ timeout: 5 });
}
