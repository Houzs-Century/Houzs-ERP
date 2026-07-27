// Read-only diagnostic: which ROLE holds which flat permission key, with the
// SCM amendment gate keys called out (owner 2026-07-27: "purchasing 和
// logistic admin 没有权限 approve" — the SO Amendment gate actions 403 for
// them, and the answer to "what do their roles actually hold" lives only in
// production).
//
// WHY THIS EXISTS AS A SCRIPT (CLAUDE.md "never ask the owner to run a query").
// GitHub Actions already holds secrets.DATABASE_URL for the deploy, so the
// check runs there. Mirrors diag-pos-role-access.mjs / list-roles.mjs (manual
// workflow_dispatch, own concurrency group, exit 0 for every legitimate
// answer).
//
// WHAT IT PRINTS:
//   (1) every role: id | name | is_system | active users | wildcard | which
//       amendment-related keys it holds. is_system matters because the Roles
//       UI refuses permission edits on system roles — if an affected role is
//       system-locked, the grant can only land via migration.
//   (2) the FULL permission list for every role whose name looks purchasing /
//       logistic / ops / desk related (the amendment-approver candidates), so
//       the follow-up grant migration can match exact names.
//   (3) for each affected role: which of its ACTIVE users would gain the
//       amendment gate actions (name + position only — no contact PII).
//
// STRICTLY READ-ONLY — SELECTs only, no writes, no DDL, no transaction.
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

// The SO-amendment two-gate flow + the sibling single-gate PO-amendment flow
// (services/permissions.ts). approve_po also gates send + reject + withdraw.
const AMENDMENT_KEYS = [
  "scm.amendment.create",
  // Two-lane rework (mig 0216) — the live gate keys.
  "scm.amendment.approve_lines",
  "scm.amendment.approve_delivery",
  // Legacy chain keys (pre-rework rows only).
  "scm.amendment.supplier_confirm",
  "scm.amendment.approve_so",
  "scm.amendment.approve_po",
  "scm.po_amendment.create",
  "scm.po_amendment.approve",
];

const CANDIDATE_NAME = /purchas|logist|ops|desk|admin/i;

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  const roles = await pg`
    SELECT r.id, r.name, r.is_system, r.permissions,
           (SELECT count(*)::int FROM users u
             WHERE u.role_id = r.id AND u.status = 'active') AS active_users
    FROM roles r ORDER BY r.id`;

  notice("── (1) every role × amendment-related keys ──");
  console.log("  id | role                     | sys | users | *  | amendment keys held");
  for (const r of roles) {
    let perms = [];
    try { perms = JSON.parse(r.permissions || "[]"); } catch { perms = ["<UNPARSEABLE JSON>"]; }
    const star = perms.includes("*") ? "*" : "-";
    const held = AMENDMENT_KEYS.filter((k) => perms.includes(k));
    console.log(
      ` ${String(r.id).padStart(3)} | ${String(r.name).padEnd(24)} | ${r.is_system ? " Y " : " - "} | ${String(r.active_users).padStart(5)} | ${star.padEnd(2)} | ${held.join(", ") || "-"}`
    );
  }

  notice("── (2) full permission list — purchasing / logistic / ops / desk candidates ──");
  for (const r of roles) {
    if (!CANDIDATE_NAME.test(r.name)) continue;
    let perms = [];
    try { perms = JSON.parse(r.permissions || "[]"); } catch {}
    if (perms.includes("*")) {
      console.log(`\n  ${r.id} ${r.name} (system=${r.is_system ? "Y" : "-"}): wildcard "*" — holds everything`);
      continue;
    }
    console.log(`\n  ${r.id} ${r.name} (system=${r.is_system ? "Y" : "-"}, ${perms.length} keys):`);
    for (const p of [...perms].sort()) console.log(`      ${p}`);
  }

  notice("── (3) active users on the candidate roles (name + position only) ──");
  const candidateIds = roles.filter((r) => CANDIDATE_NAME.test(r.name)).map((r) => r.id);
  if (candidateIds.length) {
    const holders = await pg`
      SELECT u.name AS user_name, r.name AS role_name, p.name AS position_name
      FROM users u
      JOIN roles r ON r.id = u.role_id
      LEFT JOIN positions p ON p.id = u.position_id
      WHERE u.status = 'active' AND u.role_id IN ${pg(candidateIds)}
      ORDER BY r.name, u.name`;
    for (const h of holders) {
      console.log(`  ${String(h.role_name).padEnd(24)} | ${String(h.user_name).padEnd(28)} | ${h.position_name ?? "(no position)"}`);
    }
    if (!holders.length) console.log("  (none)");
  }

  console.log("\nDone. Read-only — nothing was changed.");
} finally {
  await pg.end({ timeout: 3 }).catch(() => {});
}
