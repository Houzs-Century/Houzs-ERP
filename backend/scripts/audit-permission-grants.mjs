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
// STRICTLY READ-ONLY -- SELECTs only, no writes, no DDL, no transaction.
// Exits 0 for every legitimate answer: it is a QUESTION, not a gate.
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
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : `\n${msg}`);

// -- The cohort lists, COPIED from the TypeScript that enforces them ---------
const norm = (s) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

const GOD_POSITIONS = ["Super Admin", "Owner"].map(norm); // positionPolicy
const MONEY_WRITE_POSITIONS = ["Finance Manager", "Super Admin"].map(norm);
const CONFIG_WRITE_POSITIONS = [
  "Procurement/Purchasing", "Operation Manager", "Operation Executive",
  "Logistic Admin", "Super Admin",
].map(norm);
const RESTRICTED_POSITIONS = ["Driver", "Helper", "Storekeeper", "Storekeeper Supervisor"].map(norm);
const DIRECTOR_POSITION_NAMES = ["Super Admin", "Sales Director", "Finance Manager"].map(norm);
const SALES_DIRECTOR_POSITION_NAMES = ["Sales Director"].map(norm);
const PURCHASING_POSITION_NAMES = ["Procurement/Purchasing", "Purchasing"].map(norm);

// pmsAccess.getPmsRole -- the PMS section router. Regexes, NOT the exact-name sets.
const PMS_DRIVER = /^(Driver|Helper)$/i;
const PMS_PURCHASING = /^Purchasing$/i;
const PMS_LOGISTIC = /^Logistics?$/i;
const PMS_SALES = /^Sales /i; // NOTE the trailing space
const SALES_POSITION_PREFIX = /^sales/i;

function pmsRole(posName, isWildcard) {
  const pos = (posName ?? "").trim();
  if (isWildcard || DIRECTOR_POSITION_NAMES.includes(norm(pos))) return "DIRECTOR";
  if (PMS_DRIVER.test(pos)) return "DRIVER";
  if (PMS_PURCHASING.test(pos)) return "PURCHASING";
  if (PMS_LOGISTIC.test(pos)) return "LOGISTIC";
  if (PMS_SALES.test(pos)) return "PIC/SALES";
  return "OTHER";
}

function policyCohort(posName, deptName) {
  const n = norm(posName);
  if (!n) return "positionless (role matrix)";
  if (GOD_POSITIONS.includes(n)) return "god(*)";
  if (RESTRICTED_POSITIONS.includes(n)) return "restricted (L2 ENFORCED)";
  const dept = (deptName ?? "").toLowerCase();
  if (dept.includes("sales") || SALES_POSITION_PREFIX.test((posName ?? "").trim()))
    return "sales (L2 ENFORCED)";
  return "FULL (L2 inert)";
}

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

  notice("-- (1) LIVE POSITIONS -> which code cohort each one lands in --");
  console.log(
    "  id | position                  | department            | act | policy cohort              | PMS role   | flags",
  );
  for (const p of positions) {
    const n = norm(p.name);
    const flags = [];
    if (GOD_POSITIONS.includes(n)) flags.push("WILDCARD*");
    if (MONEY_WRITE_POSITIONS.includes(n)) flags.push("money-write");
    if (CONFIG_WRITE_POSITIONS.includes(n)) flags.push("config-write");
    if (DIRECTOR_POSITION_NAMES.includes(n)) flags.push("pms-DIRECTOR");
    if (SALES_DIRECTOR_POSITION_NAMES.includes(n)) flags.push("sales-director-admin");
    if (PURCHASING_POSITION_NAMES.includes(n)) flags.push("cost-viewer");
    console.log(
      `  ${String(p.id).padStart(2)} | ${String(p.name).padEnd(25)} | ${String(p.dept ?? "-").padEnd(21)} | ${String(p.active_users).padStart(3)} | ${policyCohort(p.name, p.dept).padEnd(26)} | ${pmsRole(p.name, false).padEnd(10)} | ${flags.join(",") || "-"}`,
    );
  }

  notice("-- (1b) DRIFT: a name in a CODE list that no live position carries --");
  const liveNames = new Set(positions.map((p) => norm(p.name)));
  for (const [label, list] of [
    ["GOD_POSITIONS", GOD_POSITIONS],
    ["MONEY_WRITE_POSITIONS", MONEY_WRITE_POSITIONS],
    ["CONFIG_WRITE_POSITIONS", CONFIG_WRITE_POSITIONS],
    ["RESTRICTED (positionPolicy)", RESTRICTED_POSITIONS],
    ["DIRECTOR (pmsAccess)", DIRECTOR_POSITION_NAMES],
    ["PURCHASING (cost viewer)", PURCHASING_POSITION_NAMES],
  ]) {
    const missing = list.filter((n) => !liveNames.has(n));
    console.log(`  ${label.padEnd(30)} missing in prod: ${missing.join(", ") || "(none)"}`);
  }

  notice("-- (1c) PMS regex misses: live positions getPmsRole falls through to OTHER --");
  for (const p of positions) {
    if (pmsRole(p.name, false) !== "OTHER") continue;
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

  // -- (3) WHO IS ACTUALLY IN THE SYSTEM ------------------------------------
  const people = await pg`
    SELECT u.id, u.name, u.status,
           r.name AS role_name, r.permissions AS role_perms,
           p.name AS position_name, d.name AS dept_name
      FROM users u
      JOIN roles r ON r.id = u.role_id
      LEFT JOIN positions p ON p.id = u.position_id
      LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.status = 'active'
     ORDER BY p.name NULLS FIRST, r.name, u.name`;

  notice(`-- (3) ACTIVE USERS: ${people.length} --`);
  const positionless = people.filter((u) => !u.position_name);
  console.log(`  active users with NO position (hydrate from the LEGACY ROLE matrix): ${positionless.length}`);
  for (const u of positionless)
    console.log(`      ${String(u.name).padEnd(28)} role=${u.role_name} dept=${u.dept_name ?? "-"}`);

  const wild = people.filter((u) => {
    let perms = []; try { perms = JSON.parse(u.role_perms || "[]"); } catch {}
    return perms.includes("*") || GOD_POSITIONS.includes(norm(u.position_name));
  });
  console.log(`\n  EFFECTIVE WILDCARD "*" holders (role "*" OR god position): ${wild.length}`);
  for (const u of wild) {
    let perms = []; try { perms = JSON.parse(u.role_perms || "[]"); } catch {}
    const via = perms.includes("*") ? "role" : "position";
    console.log(`      ${String(u.name).padEnd(28)} via ${via.padEnd(8)} role=${String(u.role_name).padEnd(20)} position=${u.position_name ?? "-"}`);
  }

  notice("-- (3b) COHORT HEADCOUNT (the number behind each rule) --");
  const tally = new Map();
  for (const u of people) {
    let perms = []; try { perms = JSON.parse(u.role_perms || "[]"); } catch {}
    const isWild = perms.includes("*") || GOD_POSITIONS.includes(norm(u.position_name));
    const c = isWild ? "wildcard *" : policyCohort(u.position_name, u.dept_name);
    tally.set(c, (tally.get(c) ?? 0) + 1);
  }
  for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(k).padEnd(30)} ${String(v).padStart(3)} active people`);

  notice("-- (3c) SALES cohort by DEPARTMENT but not by position prefix --");
  const deptOnlySales = people.filter(
    (u) =>
      (u.dept_name ?? "").toLowerCase().includes("sales") &&
      !SALES_POSITION_PREFIX.test((u.position_name ?? "").trim()),
  );
  console.log(`  ${deptOnlySales.length} people`);
  for (const u of deptOnlySales)
    console.log(`      ${String(u.name).padEnd(28)} position=${u.position_name ?? "(none)"} dept=${u.dept_name}`);

  // -- (4) COMPANY GRANTS ---------------------------------------------------
  const companies = await pg`SELECT id, code, name, is_active FROM companies ORDER BY id`;
  notice("-- (4) COMPANIES + per-user grants --");
  for (const c of companies) console.log(`  ${c.id} ${c.code} ${c.name} active=${c.is_active}`);

  const grants = await pg`
    SELECT u.id, u.name, p.name AS position_name,
           coalesce(array_agg(c.code ORDER BY c.code) FILTER (WHERE c.code IS NOT NULL), '{}') AS codes
      FROM users u
      LEFT JOIN positions p ON p.id = u.position_id
      LEFT JOIN user_companies uc ON uc.user_id = u.id
      LEFT JOIN companies c ON c.id = uc.company_id
     WHERE u.status = 'active'
     GROUP BY u.id, u.name, p.name
     ORDER BY u.name`;
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
    for (const g of none) console.log(`      ${String(g.name).padEnd(28)} position=${g.position_name ?? "-"}`);
  }

  // -- (5) The page-access TABLES the position policy no longer reads --------
  const ppa = await pg`
    SELECT p.name, count(*)::int AS rows
      FROM position_page_access a JOIN positions p ON p.id = a.position_id
     GROUP BY p.name ORDER BY p.name`;
  notice("-- (5) position_page_access rows still in the table (NO LONGER READ for a positioned user) --");
  for (const r of ppa) console.log(`  ${String(r.name).padEnd(28)} ${String(r.rows).padStart(4)} rows`);

  const rpa = await pg`
    SELECT r.name, count(*)::int AS rows
      FROM role_page_access a JOIN roles r ON r.id = a.role_id
     GROUP BY r.name ORDER BY r.name`;
  notice("-- (5b) role_page_access rows (THE live source for a POSITIONLESS user) --");
  for (const r of rpa) console.log(`  ${String(r.name).padEnd(28)} ${String(r.rows).padStart(4)} rows`);

  console.log("\nDone. Read-only -- nothing was changed.");
} finally {
  await pg.end({ timeout: 3 }).catch(() => {});
}
