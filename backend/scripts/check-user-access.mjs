// Read-only answer to "why can this person not do X?" — prints the facts the
// session envelope is hydrated from (services/auth.ts hydrateAuthUser): role and
// its permission keys, Title (position) and its position_policy row, department,
// company grants. Those decide page_access and scm_l2_configured, which is what
// scm/middleware/area-guard.ts checks on every SCM write.
//
// Usage: NAME="part of the name" node scripts/check-user-access.mjs
//
// Strictly SELECTs. Exits 0 for every legitimate answer including "no match";
// only an unreachable database or a query error exits non-zero.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const name = (process.env.NAME ?? "").trim();
if (!name) {
  console.error('NAME not set. Usage: NAME="part of the name" node scripts/check-user-access.mjs');
  process.exit(1);
}

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

const notice = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  const rows = await pg`
    SELECT u.id, u.name, u.email, u.status, u.last_login_at,
           r.id AS role_id, r.name AS role_name, r.permissions AS role_permissions,
           p.id AS position_id, p.name AS position_name, pd.name AS position_department,
           pp.cohort AS policy_cohort, pp.profile AS policy_profile,
           pp.can_write_config AS policy_config,
           d.name AS department_name,
           (SELECT json_agg(c.code ORDER BY c.id)
              FROM public.user_companies uc
              JOIN public.companies c ON c.id = uc.company_id
             WHERE uc.user_id = u.id) AS companies
      FROM public.users u
      LEFT JOIN public.roles r ON r.id = u.role_id
      LEFT JOIN public.positions p ON p.id = u.position_id
      LEFT JOIN public.departments pd ON pd.id = p.department_id
      LEFT JOIN public.position_policy pp ON pp.position_id = u.position_id
      LEFT JOIN public.departments d ON d.id = u.department_id
     WHERE regexp_replace(lower(coalesce(u.name, '') || ' ' || coalesce(u.email, '')), '\\s+', '', 'g')
           LIKE '%' || regexp_replace(lower(${name}), '\\s+', '', 'g') || '%'
     ORDER BY u.id`;

  if (rows.length === 0) notice(`NO MATCH — no public.users name contains "${name}".`);

  for (const u of rows) {
    let perms = [];
    try {
      perms = Array.isArray(u.role_permissions) ? u.role_permissions : JSON.parse(u.role_permissions ?? "[]");
    } catch {
      perms = [`(unparseable: ${String(u.role_permissions).slice(0, 80)})`];
    }
    notice(`users.id=${u.id}  ${u.name}  <${u.email}>  status=${u.status}  last_login=${u.last_login_at ?? "never"}`);
    notice(`role=${u.role_id}/${u.role_name}  position=${u.position_id ?? "none"}/${u.position_name ?? "none"} (dept ${u.position_department ?? "-"})  user dept=${u.department_name ?? "none"}`);
    notice(`position_policy=${u.policy_cohort ? `${u.policy_cohort}/${u.policy_profile ?? "-"} config=${u.policy_config}` : "NO ROW (name rule decides)"}`);
    notice(`companies=${(u.companies ?? []).join(", ") || "NONE GRANTED"}`);
    notice(`role holds '*': ${perms.includes("*")}  scm.access: ${perms.includes("scm.access")}`);
    notice(`role keys (${perms.length}): ${perms.join(", ")}`);
  }
} finally {
  await pg.end();
}
