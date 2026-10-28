// Read-only production audit of the PERMISSION SYSTEM as actually granted.
//
// WHY THIS EXISTS (CLAUDE.md "never ask the owner to run a query"). Every
// cohort rule in this repo is keyed off an EXACT POSITION NAME held in code
// (services/positionPolicy.ts GOD/MONEY/CONFIG sets, services/pmsAccess.ts
// DIRECTOR/PURCHASING sets and the getPmsRole regexes, services/salesJdAccess.ts
// isSalesCohort). Position names are OWNER-EDITABLE FREE TEXT. So the only way
// to know what a rule does is to read the live names and count the people behind
// them. Reading the code proves what the rule WOULD do; this proves what it DOES.
//
// Every position -> cohort / flag answer below is ASKED of that code
// (scripts/lib/position-classification.mjs), never restated here: the copies
// this file used to carry drifted (docs/bugs/0894). Run it under tsx:
//   npx tsx scripts/audit-permission-grants.mjs
//
// STRICTLY READ-ONLY -- SELECTs only, no writes, no DDL, no transaction.
// Exits 0 for every legitimate answer: it is a QUESTION, not a gate.
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { classifyPosition } from "./lib/position-classification.mjs";
// The catalogue itself, so "what does this role actually hold" is answered by
// the same parser login uses (tsx, like the classifier above).
import { droppedPermissions, parsePermissions } from "../src/services/permissions.ts";

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

/** A person is printed by user id, never by name: this runs in a PUBLIC
 *  repository's Actions log (docs/bugs/0895). The id opens the user in
 *  Team > Users for whoever needs the name. */
const personRef = (id) => `user #${id}`.padEnd(14);

const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : `\n${msg}`);


const MONEY_KEYS = [
  "scm.payment_voucher.create", "scm.payment_voucher.write",
  "scm.payment_voucher.post", "scm.payment_voucher.cancel",
  "scm.so.price_override", "scm.hr.manage", "scm.hr.close", "scm.hr.reopen",
  "scm.currency.manage", "scm.autocount.requeue", "scm.hr.read",
];
const STOCK_KEYS = [
  "scm.stock_take.supervise", "stock_transfer.approve", "stock_in.approve",
  "scm.config.write", "scm.so.remove_processing_date",
];
const ADMIN_KEYS = ["*", "users.manage", "roles.manage", "settings.manage", "udf.manage"];

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  // -- (1) LIVE POSITIONS vs the code's exact-name cohort lists --------------
  const positions = await pg`
    SELECT p.id, p.name, d.name AS dept,
           (SELECT count(*)::int FROM users u
             WHERE u.position_id = p.id AND u.status = 'active') AS active_users
      FROM positions p
      LEFT JOIN departments d ON d.id = p.department_id
     ORDER BY p.id`;
  // The per-Title policy rows (position_policy, Roles & Permissions › Titles):
  // a Title with a row is classified by it, exactly as login does; a Title
  // without one prints as policy:name so the gap is visible.
  const policyRows = new Map();
  for (const r of await pg`
    SELECT position_id, cohort, profile, can_move_money, can_write_config, is_fleet FROM position_policy`)
    policyRows.set(r.position_id, r);
  const rowFor = (id) => policyRows.get(id) ?? null;
  const rowByName = new Map(positions.map((p) => [p.name, rowFor(p.id)]));
  console.log(`  position_policy rows: ${policyRows.size} of ${positions.length} Titles have one`);

  notice("-- (1) LIVE POSITIONS -> which code cohort each one lands in --");
  console.log(
    "  id | position                  | department            | act | policy cohort              | PMS role   | flags",
  );
  for (const p of positions) {
    const k = classifyPosition(p.name, p.dept, rowFor(p.id));
    console.log(
      `  ${String(p.id).padStart(2)} | ${String(p.name).padEnd(25)} | ${String(p.dept ?? "-").padEnd(21)} | ${String(p.active_users).padStart(3)} | ${k.label.padEnd(26)} | ${k.pmsRole.padEnd(10)} | ${k.flags.join(",") || "-"}`,
    );
  }

  notice("-- (1b) each position-keyed rule -> the LIVE positions it admits (asked of the code) --");
  const admits = new Map();
  for (const p of positions) {
    const k = classifyPosition(p.name, p.dept, rowFor(p.id));
    for (const f of [`cohort:${k.cohort}`, ...k.flags]) {
      if (!admits.has(f)) admits.set(f, []);
      admits.get(f).push(`${p.name} (${p.active_users})`);
    }
  }
  for (const [rule, names] of [...admits.entries()].sort((a, b) => a[0].localeCompare(b[0])))
    console.log(`  ${rule.padEnd(24)} ${names.join(", ")}`);

  notice("-- (1c) PMS regex misses: live positions getPmsRole falls through to OTHER --");
  for (const p of positions) {
    if (classifyPosition(p.name, p.dept, rowFor(p.id)).pmsRole !== "OTHER") continue;
    console.log(`  ${String(p.name).padEnd(28)} -> OTHER  (${p.active_users} active users)`);
  }

  // -- (2) ROLES as granted --------------------------------------------------
  const roles = await pg`
    SELECT r.id, r.name, r.is_system, r.permissions,
           (SELECT count(*)::int FROM users u
             WHERE u.role_id = r.id AND u.status = 'active') AS active_users
      FROM roles r ORDER BY r.id`;

  notice("-- (2) ROLES as actually granted (active users + money/stock/admin keys) --");
  for (const r of roles) {
    let perms = [];
    try { perms = JSON.parse(r.permissions || "[]"); } catch { perms = ["<UNPARSEABLE>"]; }
    const money = MONEY_KEYS.filter((k) => perms.includes(k));
    const stock = STOCK_KEYS.filter((k) => perms.includes(k));
    const admin = ADMIN_KEYS.filter((k) => perms.includes(k));
    console.log(
      `  ${String(r.id).padStart(3)} | ${String(r.name).padEnd(24)} | sys=${r.is_system ? "Y" : "-"} | active=${String(r.active_users).padStart(3)} | keys=${String(perms.length).padStart(3)}`,
    );
    if (admin.length) console.log(`        ADMIN : ${admin.join(", ")}`);
    if (money.length) console.log(`        MONEY : ${money.join(", ")}`);
    if (stock.length) console.log(`        STOCK : ${stock.join(", ")}`);
  }

  notice("-- (2b) FULL key list for every role with >=1 active user --");
  for (const r of roles) {
    if (!r.active_users) continue;
    let perms = [];
    try { perms = JSON.parse(r.permissions || "[]"); } catch {}
    console.log(`\n  ${r.id} ${r.name} (${r.active_users} active, ${perms.length} keys):`);
    console.log(`      ${[...perms].sort().join("  ") || "(none)"}`);
  }

  // -- (2c) STORED vs EFFECTIVE: the keys login throws away --------------------
  // parsePermissions() filters every stored key through PERMISSIONS[]; a key
  // outside the catalogue is dropped at session hydration with no signal
  // (0478). A tick in the Roles matrix for such a key grants nothing. This is
  // the live-DB half the build-time drift test cannot see (it scans repo seeds).
  notice("-- (2c) roles whose STORED keys differ from what LOGIN keeps (catalogue drop) --");
  let dropTotal = 0;
  for (const r of roles) {
    const dropped = droppedPermissions(r.permissions);
    if (!dropped.length) continue;
    dropTotal++;
    const kept = parsePermissions(r.permissions).length;
    console.log(
      `  ${String(r.id).padStart(3)} | ${String(r.name).padEnd(34)} | active=${String(r.active_users).padStart(3)} | stored=${String(kept + dropped.length).padStart(3)} effective=${String(kept).padStart(3)} | dropped: ${dropped.sort().join(", ")}`,
    );
  }
  console.log(dropTotal ? `
  ${dropTotal} roles carry keys the catalogue does not know.` : "  (none — no stored key is outside the catalogue)");

  // -- (2d) roles that grant NOTHING to active people -----------------------
  // A role with zero effective keys on a full-cohort position is the
  // "sees every page, every button 403s" shape (owner 2026-09-16: 看得到、点不动).
  notice("-- (2d) roles with ZERO effective keys that active people hold --");
  const emptyRoles = roles.filter((r) => r.active_users > 0 && parsePermissions(r.permissions).length === 0);
  if (!emptyRoles.length) console.log("  (none)");
  for (const r of emptyRoles) {
    const holders = await pg`
      SELECT u.id, coalesce(p.name, '(no position)') AS position
        FROM users u LEFT JOIN positions p ON p.id = u.position_id
       WHERE u.role_id = ${r.id} AND u.status = 'active' ORDER BY u.id`;
    console.log(`  ${String(r.id).padStart(3)} | ${String(r.name).padEnd(34)} | ${r.active_users} active`);
    for (const h of holders) console.log(`        ${personRef(h.id)} position=${h.position}`);
  }

  // -- (3) WHO IS ACTUALLY IN THE SYSTEM ------------------------------------
  const people = await pg`
    SELECT u.id, u.status,
           r.name AS role_name, r.permissions AS role_perms,
           p.name AS position_name, d.name AS dept_name
      FROM users u
      JOIN roles r ON r.id = u.role_id
      LEFT JOIN positions p ON p.id = u.position_id
      LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.status = 'active'
     ORDER BY p.name NULLS FIRST, r.name, u.id`;

  notice(`-- (3) ACTIVE USERS: ${people.length} --`);
  const positionless = people.filter((u) => !u.position_name);
  console.log(`  active users with NO position (hydrate from the LEGACY ROLE matrix): ${positionless.length}`);
  for (const u of positionless)
    console.log(`      ${personRef(u.id)} role=${u.role_name} dept=${u.dept_name ?? "-"}`);

  const wild = people.filter((u) => {
    let perms = []; try { perms = JSON.parse(u.role_perms || "[]"); } catch {}
    return perms.includes("*") || classifyPosition(u.position_name, u.dept_name, rowByName.get(u.position_name) ?? null).cohort === "god";
  });
  console.log(`\n  EFFECTIVE WILDCARD "*" holders (role "*" OR god position): ${wild.length}`);
  for (const u of wild) {
    let perms = []; try { perms = JSON.parse(u.role_perms || "[]"); } catch {}
    const via = perms.includes("*") ? "role" : "position";
    console.log(`      ${personRef(u.id)} via ${via.padEnd(8)} role=${String(u.role_name).padEnd(20)} position=${u.position_name ?? "-"}`);
  }

  notice("-- (3b) COHORT HEADCOUNT (the number behind each rule) --");
  const tally = new Map();
  for (const u of people) {
    let perms = []; try { perms = JSON.parse(u.role_perms || "[]"); } catch {}
    const k = classifyPosition(u.position_name, u.dept_name, rowByName.get(u.position_name) ?? null);
    const c = perms.includes("*") || k.cohort === "god" ? "wildcard *" : k.label;
    tally.set(c, (tally.get(c) ?? 0) + 1);
  }
  for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(k).padEnd(30)} ${String(v).padStart(3)} active people`);

  notice("-- (3c) SALES cohort by DEPARTMENT but not by position prefix --");
  const deptOnlySales = people.filter(
    (u) =>
      (u.dept_name ?? "").toLowerCase().includes("sales") &&
      // A DATA question (whose position name carries no "Sales" prefix), not a copy of a rule.
      !/^sales/i.test((u.position_name ?? "").trim()),
  );
  console.log(`  ${deptOnlySales.length} people`);
  for (const u of deptOnlySales)
    console.log(`      ${personRef(u.id)} position=${u.position_name ?? "(none)"} dept=${u.dept_name}`);

  // -- (4) COMPANY GRANTS ---------------------------------------------------
  const companies = await pg`SELECT id, code, name, is_active FROM companies ORDER BY id`;
  notice("-- (4) COMPANIES + per-user grants --");
  for (const c of companies) console.log(`  ${c.id} ${c.code} ${c.name} active=${c.is_active}`);

  const grants = await pg`
    SELECT u.id, p.name AS position_name,
           coalesce(array_agg(c.code ORDER BY c.code) FILTER (WHERE c.code IS NOT NULL), '{}') AS codes
      FROM users u
      LEFT JOIN positions p ON p.id = u.position_id
      LEFT JOIN user_companies uc ON uc.user_id = u.id
      LEFT JOIN companies c ON c.id = uc.company_id
     WHERE u.status = 'active'
     GROUP BY u.id, p.name
     ORDER BY u.id`;
  const byGrant = new Map();
  for (const g of grants) {
    const key = (g.codes ?? []).join("+") || "(NO GRANT - fail closed)";
    byGrant.set(key, (byGrant.get(key) ?? 0) + 1);
  }
  console.log("\n  grant shape -> active people");
  for (const [k, v] of [...byGrant.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`      ${String(k).padEnd(28)} ${String(v).padStart(3)}`);
  const none = grants.filter((g) => !(g.codes ?? []).length);
  if (none.length) {
    console.log("\n  people with ZERO company grants (they see nothing):");
    for (const g of none) console.log(`      ${personRef(g.id)} position=${g.position_name ?? "-"}`);
  }

  // -- (7) WHICH ROLE EACH UNCLASSIFIED-POSITION PERSON HOLDS ----------------
  notice("-- (7) position x role for every active user --");
  const px = await pg`
    SELECT coalesce(p.name, '(no position)') AS position, r.name AS role,
           count(*)::int AS people,
           bool_or(r.permissions LIKE '%"scm.access"%') AS role_has_scm_access
      FROM users u
      JOIN roles r ON r.id = u.role_id
      LEFT JOIN positions p ON p.id = u.position_id
     WHERE u.status = 'active'
     GROUP BY 1, 2 ORDER BY 1, 2`;
  for (const r of px)
    console.log(
      `  ${String(r.position).padEnd(24)} | ${String(r.role).padEnd(34)} | ${String(r.people).padStart(3)} | role grants scm.access: ${r.role_has_scm_access ? "YES" : "no"}`,
    );

  // -- (7b) one position, several roles: the same Title, different API rights --
  // Pages come from the Title (positionPolicy), actions from the role. Two
  // people on one Title with different roles see the same screens and can do
  // different things on them — the "same job, different buttons" report.
  notice("-- (7b) positions whose active members are spread over more than one role --");
  const spread = new Map();
  for (const r of px) {
    if (!spread.has(r.position)) spread.set(r.position, []);
    spread.get(r.position).push(`${r.role} (${r.people})`);
  }
  let spreadCount = 0;
  for (const [position, rolesHeld] of [...spread.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (rolesHeld.length < 2) continue;
    spreadCount++;
    console.log(`  ${String(position).padEnd(24)} ${rolesHeld.length} roles: ${rolesHeld.join(", ")}`);
  }
  if (!spreadCount) console.log("  (none — no position spans two roles)");

  // -- (8) IS THE SCM WRITE FREEZE ON RIGHT NOW? ----------------------------
  notice("-- (8) scm.app_config['scm.write_freeze'] --");
  const freeze = await pg`
    SELECT company_id, value, description FROM scm.app_config WHERE key = 'scm.write_freeze'`;
  if (!freeze.length) console.log("  no row -> SCM writes are OPEN");
  for (const f of freeze)
    console.log(`  company_id=${f.company_id} value=${JSON.stringify(f.value)} description=${JSON.stringify(f.description)}`);

  // -- (9) IS THE SALES ENTRIES MODULE ACTUALLY LIVE? -----------------------
  // The whole Sales cohort (34 people) has page_access sales = 'none' -- the
  // owner's own saved row. Whether that is a lockout or a dead module is a
  // question about the DATA, not the code.
  notice("-- (9) sales_entries usage --");
  // created_at is TEXT on this table -- compare as text, never cast blindly.
  const se = await pg`
    SELECT count(*)::int AS total,
           max(created_at::text) AS newest,
           min(created_at::text) AS oldest,
           count(DISTINCT created_by)::int AS distinct_creators
      FROM sales_entries`;
  console.log(`  ${JSON.stringify(se[0])}`);

  // -- (9b) which companies the unclassified-position people are granted -----
  notice("-- (9b) company grants for the unclassified-position cohort --");
  const uc = (await pg`
    SELECT p.name AS position, d.name AS dept, coalesce(c.code, '(none)') AS company, count(DISTINCT u.id)::int AS people
      FROM users u
      JOIN positions p ON p.id = u.position_id
      LEFT JOIN departments d ON d.id = u.department_id
      LEFT JOIN user_companies g ON g.user_id = u.id
      LEFT JOIN companies c ON c.id = g.company_id
     WHERE u.status = 'active'
     GROUP BY 1, 2, 3 ORDER BY 1, 3`).filter((r) => classifyPosition(r.position, r.dept, rowByName.get(r.position) ?? null).cohort === "full");
  for (const r of uc)
    console.log(`  ${String(r.position).padEnd(24)} ${String(r.company).padEnd(8)} ${String(r.people).padStart(3)} people`);

  // -- (10) HAS THE FULL-COHORT EXPOSURE BEEN EXERCISED? --------------------
  notice("-- (10) audit_events by people on an UNCLASSIFIED position --");
  const acted = (await pg`
    SELECT p.name AS position, d.name AS dept, u.id AS person_id, count(*)::int AS events,
           max(a.created_at) AS newest
      FROM audit_events a
      JOIN users u ON u.id = a.actor_id
      JOIN positions p ON p.id = u.position_id
      LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.status = 'active'
     GROUP BY 1, 2, 3 ORDER BY 4 DESC`).filter((a) => classifyPosition(a.position, a.dept, rowByName.get(a.position) ?? null).cohort === "full");
  if (!acted.length) console.log("  (no audit_events rows for these people)");
  for (const a of acted)
    console.log(`  ${String(a.position).padEnd(24)} ${personRef(a.person_id)} ${String(a.events).padStart(5)} events, newest ${a.newest}`);

  console.log("\nDone. Read-only -- nothing was changed.");
} finally {
  await pg.end({ timeout: 3 }).catch(() => {});
}
