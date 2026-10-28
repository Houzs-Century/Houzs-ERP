// One-shot seed for User Management (NOT a numbered migration — CLAUDE.md:
// demo/canonical data goes in a script). Idempotent. Creates:
//   1. the 3 canonical departments (SALES / OPERATION / HQ)
//   2. the 17 positions (department × position)
//   3. one ACTIVE test account per position (shared simple password) so the
//      owner can log into each and see exactly what that position sees.
//
// Page access is NOT seeded here: a Title's pages come from its position_policy
// row (seeded by migration, edited on Roles & Permissions › Titles).
//
// Usage:
//   node scripts/seed-user-management.mjs --dry-run   # print plan, no DB
//   node scripts/seed-user-management.mjs             # apply to DATABASE_URL (.dev.vars)
//
// NOTE: the test accounts use @example.my emails so they're trivially findable
// for cleanup. Run scripts/seed-user-management.mjs --remove-tests to delete them
// before real go-live.

import { existsSync, readFileSync } from "node:fs";
import postgres from "postgres";
import { webcrypto as crypto } from "node:crypto";

const DRY = process.argv.includes("--dry-run");
const REMOVE = process.argv.includes("--remove-tests");
const TEST_PASSWORD = "houzs1234"; // simplest, per owner; shared by all test accounts
const TEST_DOMAIN = "example.my";

// ── department × position ──────────────────────────────────────────────────
const DEPARTMENTS = ["SALES", "OPERATION", "HQ"];

// slug, name, department, level (lower = more senior), role = base role for verbs
const POSITIONS = [
  // HQ
  { slug: "super_admin", name: "Super Admin", dept: "HQ", level: 10, role: "Owner" },
  { slug: "hr_manager", name: "HR Manager", dept: "HQ", level: 20, role: "Position Preview" },
  { slug: "finance_manager", name: "Finance Manager", dept: "HQ", level: 20, role: "Position Preview" },
  { slug: "admin_assistant", name: "Admin Assistant", dept: "HQ", level: 30, role: "Position Preview" },
  // SALES
  { slug: "sales_director", name: "Sales Director", dept: "SALES", level: 10, role: "Position Preview" },
  { slug: "sales_manager", name: "Sales Manager", dept: "SALES", level: 15, role: "Position Preview" },
  { slug: "sales_executive", name: "Sales Executive", dept: "SALES", level: 20, role: "Position Preview" },
  { slug: "sales_person", name: "Sales Person", dept: "SALES", level: 25, role: "Position Preview" },
  { slug: "sales_trainee", name: "Sales Trainee", dept: "SALES", level: 30, role: "Position Preview" },
  // OPERATION
  { slug: "ops_director", name: "Ops Director", dept: "OPERATION", level: 10, role: "Position Preview" },
  { slug: "ops_manager", name: "Ops Manager", dept: "OPERATION", level: 15, role: "Position Preview" },
  { slug: "ops_executive", name: "Ops Executive", dept: "OPERATION", level: 20, role: "Position Preview" },
  { slug: "purchasing", name: "Purchasing", dept: "OPERATION", level: 25, role: "Position Preview" },
  { slug: "logistic", name: "Logistic", dept: "OPERATION", level: 25, role: "Position Preview" },
  { slug: "storekeeper", name: "Storekeeper", dept: "OPERATION", level: 25, role: "Position Preview" },
  { slug: "driver", name: "Driver", dept: "OPERATION", level: 30, role: "Driver" },
  { slug: "helper", name: "Helper", dept: "OPERATION", level: 30, role: "Helper" },
];

// who reports to whom (org chart). slug -> manager slug.
const MANAGER = {
  hr_manager: "super_admin", finance_manager: "super_admin", admin_assistant: "hr_manager",
  sales_director: "super_admin", sales_manager: "sales_director", sales_executive: "sales_manager",
  sales_person: "sales_manager", sales_trainee: "sales_executive",
  ops_director: "super_admin", ops_manager: "ops_director", ops_executive: "ops_manager",
  purchasing: "ops_manager", logistic: "ops_manager", storekeeper: "ops_manager",
  driver: "logistic", helper: "logistic",
};

// Broad read-only verb bundle for the "Position Preview" role so that pages a
// position can SEE also return data (page visibility is from the position
// matrix; this role just supplies the read verbs the data endpoints check).
// Deliberately NO '*' (which would bypass the position matrix) and NO manage.
const PREVIEW_PERMS = [
  "projects.read", "sales.read", "sales_orders.read", "delivery_orders.read",
  "purchase_orders.read", "service_cases.read", "balance.read", "overdue.read",
  "fleet.read", "trips.read.all", "sales_team.read", "petty_cash.read",
  "users.read", "roles.read", "logs.read",
];

// ── PBKDF2 password hash — must match backend/src/services/auth.ts ───────────
const PBKDF2_ITERATIONS = 100_000;
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, key, 256);
  return `${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

const emailFor = (slug) => `${slug}@${TEST_DOMAIN}`;

function planSummary() {
  console.log(`Departments: ${DEPARTMENTS.join(", ")}`);
  console.log(`Positions: ${POSITIONS.length}`);
  console.log(`Test accounts (password "${TEST_PASSWORD}"):`);
  for (const p of POSITIONS) {
    console.log(`  ${emailFor(p.slug).padEnd(26)} ${p.dept}/${p.name}  (role ${p.role}, mgr ${MANAGER[p.slug] ?? "-"})`);
  }
}

if (DRY) {
  console.log("DRY RUN — no DB writes\n");
  planSummary();
  process.exit(0);
}

// Resolve DATABASE_URL. Env var takes precedence so CI (workflows/seed-*.yml)
// can bind the target Supabase URL without writing a .dev.vars file into the
// runner. Local dev keeps working the same — .dev.vars is only read as a
// fallback when the env var is absent AND the file exists.
let url = process.env.DATABASE_URL;
if (!url && existsSync(".dev.vars")) {
  url = readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
}
if (!url) { console.error("No DATABASE_URL in env or .dev.vars"); process.exit(1); }
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, idle_timeout: 4 });

async function upsertDepartment(name) {
  const existing = await sql`SELECT id FROM departments WHERE name = ${name}`;
  if (existing.length) return existing[0].id;
  // color + sort_order are NOT NULL with no DB default (the D1->PG load dropped
  // Drizzle's ORM-level defaults), so set them explicitly.
  const ins = await sql`INSERT INTO departments (name, color, sort_order)
    VALUES (${name}, ${"64748b"}, 0) RETURNING id`;
  return ins[0].id;
}

async function upsertRole(name, perms) {
  const existing = await sql`SELECT id FROM roles WHERE name = ${name}`;
  if (existing.length) return existing[0].id;
  const ins = await sql`INSERT INTO roles (name, description, permissions, is_system, scope_to_pic)
    VALUES (${name}, ${"Read-only preview role for position test accounts"}, ${JSON.stringify(perms)}, 0, 0) RETURNING id`;
  return ins[0].id;
}

async function upsertPosition(p, deptId) {
  const existing = await sql`SELECT id FROM positions WHERE slug = ${p.slug}`;
  if (existing.length) {
    await sql`UPDATE positions SET name=${p.name}, department_id=${deptId}, level=${p.level}, active=1 WHERE id=${existing[0].id}`;
    return existing[0].id;
  }
  const ins = await sql`INSERT INTO positions (department_id, slug, name, level, sort_order, active)
    VALUES (${deptId}, ${p.slug}, ${p.name}, ${p.level}, ${p.level}, 1) RETURNING id`;
  return ins[0].id;
}

if (REMOVE) {
  const del = await sql`DELETE FROM users WHERE email LIKE ${"%@" + TEST_DOMAIN}`;
  console.log(`Removed ${del.count} test account(s).`);
  await sql.end();
  process.exit(0);
}

// 1. departments
const deptId = {};
for (const d of DEPARTMENTS) deptId[d] = await upsertDepartment(d);

// 2. preview role + ensure Owner/Driver/Helper roles exist (look up by name)
const previewRoleId = await upsertRole("Position Preview", PREVIEW_PERMS);
async function roleIdByName(name) {
  const r = await sql`SELECT id FROM roles WHERE name = ${name}`;
  return r.length ? r[0].id : previewRoleId; // fall back to preview if a base role is missing
}

// 3. positions
const posId = {};
for (const p of POSITIONS) posId[p.slug] = await upsertPosition(p, deptId[p.dept]);

// 5. test accounts (one per position, active, with org tree)
const hash = await hashPassword(TEST_PASSWORD);
const userId = {};
for (const p of POSITIONS) {
  const email = emailFor(p.slug);
  const roleId = await roleIdByName(p.role);
  const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
  if (existing.length) {
    await sql`UPDATE users SET name=${p.name + " (test)"}, role_id=${roleId}, position_id=${posId[p.slug]},
      department_id=${deptId[p.dept]}, status='active', password_hash=${hash} WHERE id=${existing[0].id}`;
    userId[p.slug] = existing[0].id;
  } else {
    const ins = await sql`INSERT INTO users (email, name, role_id, position_id, department_id, status, password_hash, joined_at, points_balance, gifting_balance, current_streak)
      VALUES (${email}, ${p.name + " (test)"}, ${roleId}, ${posId[p.slug]}, ${deptId[p.dept]}, 'active', ${hash},
        to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS'), 0, 0, 0) RETURNING id`;
    userId[p.slug] = ins[0].id;
  }
}
// wire managers (second pass so all users exist)
for (const p of POSITIONS) {
  const mgr = MANAGER[p.slug];
  if (mgr && userId[mgr]) await sql`UPDATE users SET manager_id=${userId[mgr]} WHERE id=${userId[p.slug]}`;
}

console.log(`Seeded: ${DEPARTMENTS.length} departments, ${POSITIONS.length} positions, ${POSITIONS.length} test accounts.`);
console.log(`\nTest accounts — log in at erp.houzscentury.com, password "${TEST_PASSWORD}":`);
for (const p of POSITIONS) console.log(`  ${emailFor(p.slug).padEnd(26)} ${p.dept} / ${p.name}`);
await sql.end();
process.exit(0);
