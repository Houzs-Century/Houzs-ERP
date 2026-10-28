// Read-only diagnostic for the POS director-access question (owner 2026-07-24:
// "do we even have an Assistant Director position, and why don't our directors
// get the right POS access?").
//
// WHY THIS EXISTS AS A SCRIPT (CLAUDE.md "never ask the owner to run a query").
// The answer lives only in production. GitHub Actions already holds
// secrets.DATABASE_URL for the deploy, so the check runs there. Mirrors
// diag-supplier-reachability.mjs + check-soak-gate.mjs (manual workflow_dispatch,
// own concurrency group, exit 0 for every legitimate answer).
//
// WHAT IT ANSWERS — the live POS (2990s/apps/pos/lib/staff.ts) decides SO
// Maintenance mode from scm.staff.role: {sales_director, admin, super_admin} ->
// FULL, everyone else -> view-only. But Houzs drives access from public.positions
// (routes/pos.ts: "scm.staff.role can't gate"). So a Houzs director identified by
// POSITION can still land view-only if their scm.staff.role isn't one of those
// three. This reports:
//   (1) public.positions + how many users hold each (does "Assistant Director"
//       exist at all? who is a director?).
//   (2) scm.staff.role distribution (what the POS actually reads).
//   (3) the JOIN: for every director/sales-ish position, the scm.staff.role its
//       holders carry -> whether the POS would give them FULL or view-only.
//
// STRICTLY READ-ONLY — SELECTs only, no writes/DDL/transaction. Nothing here
// changes a permission; it only reports what the current data resolves to.
import { readFileSync } from "node:fs";
import postgres from "postgres";

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

const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

// The POS roles that unlock FULL SO-Maintenance (mirror of the POS client's
// maintenanceMode + isGlobalCurator).
const POS_FULL_ROLES = new Set(["sales_director", "admin", "super_admin"]);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  // ── (1) positions + user counts ──────────────────────────────────────────
  const positions = await pg`
    SELECT p.name, p.slug, count(u.id)::int AS users
    FROM public.positions p
    LEFT JOIN public.users u ON u.position_id = p.id
    GROUP BY p.name, p.slug
    ORDER BY users DESC, p.name`;
  notice("── (1) positions (public.positions) + user counts ──");
  if (positions.length === 0) {
    notice("public.positions is EMPTY.");
  } else {
    for (const r of positions) notice(`${r.name} [slug=${r.slug}] : ${r.users} users`);
    const dirLike = positions.filter((r) => /assist|deputy|director|manager/i.test(r.name));
    notice(
      `director / assistant / manager-like positions: ${
        dirLike.length ? dirLike.map((r) => `${r.name} (${r.users})`).join(", ") : "NONE"
      }`,
    );
    const asst = positions.filter((r) => /assist/i.test(r.name));
    notice(
      `EXPLICIT "Assistant …" positions: ${
        asst.length ? asst.map((r) => `${r.name} (${r.users})`).join(", ") : "NONE — no Assistant Director position exists"
      }`,
    );
  }

  // ── (2) scm.staff.role distribution (what the POS reads) ──────────────────
  const roles = await pg`
    SELECT COALESCE(role::text, '(null)') AS role, count(*)::int AS n
    FROM scm.staff
    GROUP BY role
    ORDER BY n DESC`;
  notice("── (2) scm.staff.role distribution (the POS gates on THIS) ──");
  for (const r of roles) {
    const flag = POS_FULL_ROLES.has(r.role) ? "  → POS FULL" : "";
    notice(`role=${r.role} : ${r.n}${flag}`);
  }

  // ── (3) director / sales-position holders → their scm.staff.role ──────────
  const mapping = await pg`
    SELECT p.name AS position,
           COALESCE(s.role::text, '(no scm.staff row / null role)') AS staff_role,
           count(*)::int AS n
    FROM public.users u
    JOIN public.positions p ON p.id = u.position_id
    LEFT JOIN scm.staff s ON s.user_id = u.id
    WHERE p.name ILIKE '%director%' OR p.name ILIKE '%manager%' OR p.slug ILIKE 'sales%'
    GROUP BY p.name, s.role
    ORDER BY p.name, n DESC`;
  notice("── (3) director/sales position → scm.staff.role → POS mode ──");
  if (mapping.length === 0) {
    notice("No director/sales-ish positions with users found.");
  } else {
    for (const r of mapping) {
      const mode = POS_FULL_ROLES.has(r.staff_role) ? "POS=FULL" : "POS=view-only";
      const warn = mode === "POS=view-only" ? "  <-- would be READ-ONLY in POS" : "";
      notice(`${r.position} → staff.role=${r.staff_role} : ${r.n} [${mode}]${warn}`);
    }
  }

  notice("DONE — read-only, no rows changed.");
} finally {
  await pg.end({ timeout: 5 });
}
