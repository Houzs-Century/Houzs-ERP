#!/usr/bin/env node
// Bring 2990's staff into Houzs as public.users. Owner-authorised 2026-07-17:
// "把 2990 的 members 全部都移植进来,要不然我们淘汰掉的时候它就不能用了."
//
// DRY-RUN unless APPLY=1. Idempotent. Every write runs in ONE transaction.
//
//   node scripts/migrate-2990-staff.mjs            # dry run (default)
//   APPLY=1 node scripts/migrate-2990-staff.mjs    # write
//
// ---------------------------------------------------------------------------
// THE DOUBLE-STAFF-ROW TRAP, AND WHY THIS SCRIPT RELINKS
// ---------------------------------------------------------------------------
// migrations-pg/0066 puts trg_sync_user_to_staff on public.users. Its body is:
//
//     UPDATE scm.staff SET ... WHERE id = v_id OR user_id = NEW.id;
//     IF NOT FOUND THEN INSERT INTO scm.staff (id, user_id, ...) VALUES (
//       md5('houzs-user:'||NEW.id)::uuid, NEW.id, ...) ON CONFLICT (id) DO UPDATE ...
//
// 2990's staff are ALREADY rows in scm.staff -- imported by
// migrate-2990-into-houzs.mjs, which special-cases them (NO_CID = { staff: {
// forceInactive: true } }): they carry 2990's OWN uuids, no company_id,
// active=false, and user_id NEVER set.
//
// So on a naive INSERT of a new user, the trigger's UPDATE matches NOTHING --
// v_id is a fresh md5 that no row has, and the 2990 row's user_id is NULL, not
// NEW.id. IF NOT FOUND fires and MINTS A SECOND STAFF ROW. One person, two
// rows: the 2990 one every 2990 SO/DO/amendment/payment references by uuid, and
// a fresh empty md5 one. Attribution splits; the old row stays orphaned and
// inactive. That is the shape of the pos-cart leak #633 (see
// src/scm/middleware/auth.ts's header).
//
// We RELINK instead: inside one transaction we insert the user, delete the
// trigger-minted md5 row, and set user_id on the EXISTING 2990 row. This is
// correct, not merely convenient, for three reasons established from the code:
//
//   1. The app resolves a person's staff uuid BY user_id, never by recomputing
//      the md5. scm/lib/salesScope.ts resolveCallerStaffId does
//      .from("staff").select("id").eq("user_id", houzsUserId), and
//      resolveSalesScopeIds does .in("user_id", userIds). The md5 appears only
//      in comments. So whichever row carries user_id IS the person -- and
//      pointing that at the 2990 uuid is exactly what keeps every 2990 SO
//      reference resolving.
//   2. The relink is SELF-SUSTAINING, not a one-off patch the trigger undoes.
//      The trigger's `OR user_id = NEW.id` arm means every later name/status
//      UPDATE finds the relinked 2990 row and updates it in place. It can never
//      mint again for that user.
//   3. The partial unique index uq_staff_user_id (staff(user_id) WHERE user_id
//      IS NOT NULL) permits ONE staff row per user, so the delete MUST precede
//      the relink and the DB itself rejects any ordering mistake.
//
// WHY WE COUNT FK REFERENCES BEFORE DELETING ANY STAFF ROW
// Most FKs into scm.staff are ON DELETE SET NULL -- including
// mfg_sales_orders_salesperson_id_staff_id_fk. Deleting a REFERENCED staff row
// would therefore NOT fail loudly; it would silently null out salesperson
// attribution on real orders. So we never trust the FK to stop us: we count
// references first (columns discovered from pg_constraint, not hardcoded) and
// refuse to delete anything with refs > 0.
//
// This matters most for Shui Hor. He is an EXISTING Houzs user (id 46) and so
// 0066's backfill already gave him an md5 staff row that Houzs documents may
// reference. Unlike the nine new users -- whose md5 row is milliseconds old and
// provably unreferenced -- his cannot be assumed disposable. If it is
// referenced, this script REFUSES the relink and reports it for an owner
// ruling, because either choice would drop attribution.
// ---------------------------------------------------------------------------

import { register } from "node:module";
// Registered before the dynamic import of auth.ts below (static imports are
// hoisted; the TS module is pulled in at runtime, after this line).
register("./_ts-resolve.mjs", import.meta.url);

import { readFileSync } from "node:fs";
import postgres from "postgres";

// The REAL hasher (PBKDF2-SHA256 100k, "<saltB64>$<hashB64>"). Imported, never
// re-implemented: a hand-copied hasher that drifts mints logins nobody can use.
// seed-user-management.mjs copied it; this does not.
const { hashPassword } = await import("../src/services/auth.ts");

const APPLY = process.env.APPLY === "1";

// Positions/departments are resolved BY NAME against the target DB, never by a
// hardcoded id: the names below are the owner's prod-verified ones and differ
// from seed-user-management.mjs's dev names (HQ vs Management, Ops Manager vs
// Operation Manager). A name that does not resolve BLOCKS that person loudly.
const PEOPLE = [
  { staffCode: "2990S-002", name: "Chew",       email: "chew.acchouzs@gmail.com",  position: "Finance Manager",   companies: ["HOUZS", "2990"] },
  { staffCode: "2990S-007", name: "Tammy",      email: "hr@2990s.com",             position: "HR Manager",        companies: ["HOUZS", "2990"] },
  { staffCode: "2990S-009", name: "Marketing",  email: "marketing@2990s.com",      position: null,                companies: ["HOUZS", "2990"] },
  { staffCode: "OPS",       name: "Operations", email: "operation@2990s.com",      position: "Operation Manager", companies: ["HOUZS", "2990"] },
  // Synthetic POS identities: no mailbox, so they cannot be invited -> password.
  { staffCode: "2990S-001", name: "Ashe",     email: "2990s-001+pos@2990s.local", position: "Sales Executive", companies: ["2990"], synthetic: true },
  { staffCode: "2990S-003", name: "Bernard",  email: "2990s-003+pos@2990s.local", position: "Sales Manager",   companies: ["2990"], synthetic: true },
  { staffCode: "2990S-004", name: "Ltrey",    email: "2990s-004+pos@2990s.local", position: "Sales Executive", companies: ["2990"], synthetic: true },
  { staffCode: "2990S-005", name: "Kah Wai",  email: "2990s-005+pos@2990s.local", position: "Sales Executive", companies: ["2990"], synthetic: true },
  { staffCode: "2990S-006", name: "Scarlett", email: "2990s-006+pos@2990s.local", position: "Sales Executive", companies: ["2990"], synthetic: true },
];

// Owner ruling 2026-07-17: 2990 has shuihor00@gmail.com, Houzs has
// suihor00@gmail.com (one letter apart) -- "houzs的是對的 - suihor00@gmail.com".
// Houzs user 46 IS him. Never create a user; grant BOTH + relink 2990's row.
const SHUI_HOR = { houzsEmail: "suihor00@gmail.com", staffEmail: "shuihor00@gmail.com", companies: ["HOUZS", "2990"] };

// Owner: "除了 sales 是 2990/houzs 的而已" -- Sales is EXCLUDED from the sweep.
const BOTH_GRANT_DEPARTMENTS = ["Operation Department", "Management"];
const EXPECTED_SWEEP_MATCHES = 28; // owner-verified against prod 2026-07-17

const norm = (e) => String(e ?? "").trim().toLowerCase();

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const DB = resolveUrl();
if (!DB) {
  console.error("need DATABASE_URL (env or backend/.dev.vars)");
  process.exit(2);
}
const sql = postgres(DB, { ssl: "require", prepare: false, max: 1 });

// Every FK column pointing at scm.staff, discovered rather than hardcoded so a
// new referencing table cannot silently escape the safety count.
async function staffRefColumns() {
  return sql`
    SELECT n.nspname AS sch, cl.relname AS tbl, a.attname AS col, c.confdeltype AS ondelete
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
     WHERE c.contype = 'f' AND c.confrelid = 'scm.staff'::regclass
     ORDER BY 1, 2, 3`;
}

// Non-zero reference counts for one staff uuid, as [{ where, n }].
// `db` is the caller's handle: inside a transaction it MUST be the tx, both to
// see uncommitted state and because the pool is max:1 -- a second handle would
// wait forever on the connection the transaction is holding.
async function countStaffRefs(db, cols, uuid) {
  if (!cols.length) return [];
  const parts = cols.map(
    (c) => `SELECT '${c.sch}.${c.tbl}.${c.col}' AS ref, count(*)::int AS n
              FROM "${c.sch}"."${c.tbl}" WHERE "${c.col}" = '${uuid}'::uuid`,
  );
  const rows = await db.unsafe(
    `SELECT ref, n FROM (${parts.join(" UNION ALL ")}) t WHERE n > 0 ORDER BY ref`,
  );
  return rows.map((r) => ({ where: r.ref, n: Number(r.n) }));
}

// Decide what the 2990 staff row needs, for a user that ALREADY exists. Shared
// by the nine and by Shui Hor: "relink" is a property of the staff row, not of
// whether this run happened to create the user. A person the owner already
// added by hand in User Management must still get relinked, or they keep the
// orphaned-2990-row + fresh-md5-row split this script exists to prevent.
// Always re-reads the staff row by id: this tree is shared-live, and the APPLY
// call happens inside a transaction the plan was read outside of.
async function planRelink(db, refCols, userId, staffId) {
  if (!staffId) return { action: "blocked", why: "2990 staff row not resolved" };
  const cur = await db`SELECT id, user_id FROM scm.staff WHERE id = ${staffId}`;
  if (!cur.length) return { action: "blocked", why: `2990 staff row ${staffId} vanished` };
  const staffRow = cur[0];
  if (Number(staffRow.user_id) === Number(userId)) return { action: "noop" };
  if (staffRow.user_id != null) {
    return { action: "blocked", why: `2990 staff row already links to user ${staffRow.user_id}, not ${userId}` };
  }
  const md5 = (await db`SELECT md5('houzs-user:' || ${userId}::text)::uuid AS id`)[0].id;
  const rows = await db`SELECT id FROM scm.staff WHERE id = ${md5}`;
  if (!rows.length) return { action: "relink", md5: null, staffId: staffRow.id, refs: [] };
  const refs = await countStaffRefs(db, refCols, md5);
  const total = refs.reduce((a, r) => a + r.n, 0);
  if (total > 0) {
    return {
      action: "blocked",
      refs,
      total,
      why: `md5 staff row is referenced by ${total} row(s); deleting it would SET NULL that attribution, keeping it blocks the relink (uq_staff_user_id) -- owner ruling required`,
    };
  }
  return { action: "relink", md5, staffId: staffRow.id, refs: [] };
}

async function main() {
  console.log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);

  // scm.staff is a SHARED master. 0083's header is explicit: "SHARED masters
  // (users/roles/positions/departments/permissions, audit, mail, branding) and
  // AMBIGUOUS tables get NO company_id". Verified, not assumed -- a company_id
  // stamp on staff would target a column that does not exist.
  const [{ has: staffHasCompanyId }] = await sql`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='scm' AND table_name='staff'
                      AND column_name='company_id') AS has`;
  console.log(`scm.staff.company_id present: ${staffHasCompanyId}`);
  if (!staffHasCompanyId) {
    console.log("  -> staff is a shared master with NO company_id; nothing to stamp.");
  }

  const companies = await sql`SELECT id, code FROM companies WHERE is_active = 1 ORDER BY id`;
  const cid = Object.fromEntries(companies.map((c) => [c.code, Number(c.id)]));
  for (const code of ["HOUZS", "2990"]) {
    if (!cid[code]) throw new Error(`companies row '${code}' missing`);
  }
  console.log(`companies: ${companies.map((c) => `${c.code}=${c.id}`).join(" ")}`);

  const refCols = await staffRefColumns();
  const setNull = refCols.filter((c) => c.ondelete === "n").length;
  console.log(
    `scm.staff FK referencing columns: ${refCols.length} (${setNull} are ON DELETE SET NULL -> a blind delete would SILENTLY null attribution)`,
  );

  const positions = await sql`SELECT id, name, department_id FROM positions WHERE active = 1`;
  const posByName = new Map(positions.map((p) => [norm(p.name), p]));
  const departments = await sql`SELECT id, name FROM departments`;
  const deptByName = new Map(departments.map((d) => [norm(d.name), d]));
  const deptNameById = new Map(departments.map((d) => [Number(d.id), d.name]));

  const blocked = [];

  // ---- 1. the nine users --------------------------------------------------
  console.log("\n=== 1. CREATE users from 2990 staff ===");
  const plan = [];
  for (const p of PEOPLE) {
    const row = { ...p, issues: [] };

    const existing = await sql`SELECT id, status FROM users WHERE lower(btrim(email)) = ${norm(p.email)} LIMIT 1`;
    row.userId = existing.length ? Number(existing[0].id) : null;

    const staffRows = await sql`SELECT id, name, active, user_id FROM scm.staff WHERE staff_code = ${p.staffCode}`;
    if (staffRows.length !== 1) {
      row.issues.push(`scm.staff staff_code='${p.staffCode}' matched ${staffRows.length} rows (want exactly 1)`);
    } else {
      row.staff = staffRows[0];
    }

    if (p.position) {
      const pos = posByName.get(norm(p.position));
      if (!pos) row.issues.push(`position '${p.position}' not found`);
      else {
        row.positionId = Number(pos.id);
        // Mirror routes/users.ts: department comes from the position.
        row.departmentId = pos.department_id ? Number(pos.department_id) : null;
      }
    }

    // users.role_id is NOT NULL and the owner specified no role. Copy what
    // colleagues at the same position already have -- never invent one.
    if (row.positionId) {
      const peer = await sql`
        SELECT role_id, count(*)::int AS n FROM users
         WHERE position_id = ${row.positionId} AND status = 'active' AND role_id IS NOT NULL
         GROUP BY role_id ORDER BY n DESC LIMIT 1`;
      if (peer.length) {
        row.roleId = Number(peer[0].role_id);
        row.roleFrom = `peer at '${p.position}' (${peer[0].n} user(s))`;
      }
    }
    if (!row.roleId && process.env.FALLBACK_ROLE_NAME) {
      const r = await sql`SELECT id FROM roles WHERE lower(btrim(name)) = ${norm(process.env.FALLBACK_ROLE_NAME)} LIMIT 1`;
      if (r.length) {
        row.roleId = Number(r[0].id);
        row.roleFrom = `FALLBACK_ROLE_NAME='${process.env.FALLBACK_ROLE_NAME}'`;
      }
    }
    if (!row.roleId && !row.userId) {
      row.issues.push("cannot resolve role_id (NOT NULL): no active peer at this position; set FALLBACK_ROLE_NAME=<role>");
    }
    if (row.roleId) {
      const rn = await sql`SELECT name FROM roles WHERE id = ${row.roleId}`;
      row.roleName = rn.length ? rn[0].name : String(row.roleId);
    }

    // A user that already exists may still need the relink (see planRelink).
    // For a user we are about to CREATE, the md5 row does not exist yet, so the
    // decision is deferred to the transaction, which asserts refs=0 there.
    if (row.userId && row.staff) {
      row.relink = await planRelink(sql, refCols, row.userId, row.staff.id);
      if (row.relink.action === "blocked") row.issues.push(row.relink.why);
    }

    plan.push(row);
    if (row.issues.length) blocked.push(row);

    const act = row.userId ? `EXISTS id=${row.userId} (no insert)` : "CREATE";
    console.log(`\n${p.staffCode} ${p.name} <${p.email}>`);
    console.log(`  user       : ${act}`);
    console.log(`  position   : ${p.position ?? "(none -- owner: leave NULL)"}${row.positionId ? ` -> id=${row.positionId}, dept=${row.departmentId ? deptNameById.get(row.departmentId) : "NULL"}` : ""}`);
    console.log(`  role_id    : ${row.roleId ?? "UNRESOLVED"}${row.roleName ? ` (${row.roleName}) via ${row.roleFrom}` : ""}`);
    console.log(`  login      : ${p.synthetic ? "status=active + generated password (no mailbox to invite)" : "status=invited (owner sends invite from User Management)"}`);
    console.log(`  2990 staff : ${row.staff ? `${row.staff.id} "${row.staff.name}" active=${row.staff.active} user_id=${row.staff.user_id ?? "NULL"}` : "NOT RESOLVED"}`);
    if (row.staff) {
      const rl = row.relink;
      if (rl?.action === "noop") {
        console.log(`  relink     : already linked to user ${row.staff.user_id} -- no-op`);
      } else if (rl?.action === "relink") {
        console.log(`  relink     : link 2990 row ${row.staff.id} -> user ${row.userId}${rl.md5 ? `, DELETE unreferenced md5 row ${rl.md5}` : ""}`);
      } else if (rl?.action === "blocked") {
        for (const r of rl.refs ?? []) console.log(`     ref: ${r.where} x${r.n}`);
      } else if (!row.userId) {
        console.log(`  relink     : SET user_id + active=true on the 2990 row (keeps its uuid, so 2990 docs keep resolving)`);
        console.log(`  md5 row    : trigger will mint md5('houzs-user:'||id); DELETE it after asserting 0 FK refs`);
      }
    }
    for (const i of row.issues) console.log(`  BLOCKED    : ${i}`);
  }

  // ---- 2. Shui Hor --------------------------------------------------------
  console.log("\n=== 2. Shui Hor (existing user -- NEVER created) ===");
  const sh = await sql`SELECT id, name, email FROM users WHERE lower(btrim(email)) = ${norm(SHUI_HOR.houzsEmail)} LIMIT 1`;
  let shPlan = null;
  if (!sh.length) {
    console.log(`  BLOCKED: no Houzs user with ${SHUI_HOR.houzsEmail}`);
    blocked.push({ name: "Shui Hor", issues: ["houzs user not found"] });
  } else {
    const uid = Number(sh[0].id);
    const shStaff = await sql`SELECT id, name, user_id, active FROM scm.staff WHERE lower(btrim(email)) = ${norm(SHUI_HOR.staffEmail)}`;
    const md5row = await sql`SELECT id, user_id FROM scm.staff WHERE id = md5('houzs-user:' || ${uid}::text)::uuid`;
    console.log(`  houzs user : id=${uid} ${sh[0].name} <${sh[0].email}>`);
    console.log(`  2990 staff : ${shStaff.length === 1 ? `${shStaff[0].id} user_id=${shStaff[0].user_id ?? "NULL"}` : `${shStaff.length} rows matched ${SHUI_HOR.staffEmail}`}`);

    if (shStaff.length !== 1) {
      blocked.push({ name: "Shui Hor", issues: [`scm.staff email='${SHUI_HOR.staffEmail}' matched ${shStaff.length} rows`] });
      console.log(`  BLOCKED    : cannot identify his 2990 staff row`);
    } else {
      // Unlike the nine, he PREDATES this migration, so 0066's backfill already
      // gave him an md5 staff row that Houzs documents may reference. His grants
      // are applied either way; only the relink is conditional.
      console.log(`  md5 row    : ${md5row.length ? `${md5row[0].id} (0066 backfill)` : "absent"}`);
      const rl = await planRelink(sql, refCols, uid, shStaff[0].id);
      if (rl.action === "noop") {
        console.log(`  relink     : already linked -- no-op`);
        shPlan = { uid, relink: false };
      } else if (rl.action === "relink") {
        console.log(`  relink     : link 2990 row ${shStaff[0].id} -> user ${uid}${rl.md5 ? `, DELETE unreferenced md5 row ${rl.md5}` : ""}`);
        shPlan = { uid, relink: true, md5: rl.md5, staffId: rl.staffId };
      } else {
        for (const r of rl.refs ?? []) console.log(`     ref: ${r.where} x${r.n}`);
        console.log(`  BLOCKED    : ${rl.why}`);
        console.log(`               Relink SKIPPED; his BOTH-company grant still applies.`);
        blocked.push({ name: "Shui Hor", issues: [rl.why] });
        shPlan = { uid, relink: false };
      }
    }
  }

  // ---- 3. company grants --------------------------------------------------
  console.log("\n=== 3. user_companies grants ===");
  console.log("companyContext FAILS OPEN: a user with ZERO grant rows sees ALL active");
  console.log("companies. So writing a grant row is a NARROWING, never a widening.");

  const sweepDeptIds = [];
  for (const dn of BOTH_GRANT_DEPARTMENTS) {
    const d = deptByName.get(norm(dn));
    if (!d) {
      console.log(`  BLOCKED: department '${dn}' not found. Actual: ${departments.map((x) => x.name).join(" | ")}`);
      blocked.push({ name: dn, issues: ["department not found"] });
    } else sweepDeptIds.push(Number(d.id));
  }

  let sweep = [];
  if (sweepDeptIds.length === BOTH_GRANT_DEPARTMENTS.length) {
    sweep = await sql`
      SELECT u.id, u.name, u.email, u.department_id,
             (SELECT count(*)::int FROM user_companies uc WHERE uc.user_id = u.id) AS grants
        FROM users u
       WHERE u.status = 'active' AND u.department_id = ANY(${sweepDeptIds})
       ORDER BY u.id`;
    console.log(`\nsweep (${BOTH_GRANT_DEPARTMENTS.join(" + ")}, Sales EXCLUDED per owner): ${sweep.length} active users`);
    if (sweep.length !== EXPECTED_SWEEP_MATCHES) {
      console.log(`  NOTE: expected ${EXPECTED_SWEEP_MATCHES} (owner-verified 2026-07-17); prod data may have moved since.`);
    }
    const already = sweep.filter((u) => u.grants > 0);
    console.log(`  already have >=1 grant: ${already.length ? already.map((u) => u.id).join(",") : "none"}`);
    console.log(`  would gain BOTH grants : ${sweep.filter((u) => u.grants === 0).length} users`);
    console.log(`  BOTH == every active company, so these users see exactly what they see today (no narrowing).`);
  }

  const grantPlan = [];
  for (const r of plan) if (!r.issues.length) grantPlan.push({ who: `${r.name} <${r.email}>`, codes: r.companies });
  if (shPlan) grantPlan.push({ who: `Shui Hor <${SHUI_HOR.houzsEmail}>`, codes: SHUI_HOR.companies });
  for (const u of sweep) grantPlan.push({ who: `${u.name ?? "?"} <${u.email}> (sweep)`, codes: ["HOUZS", "2990"] });

  const allCodes = companies.map((c) => c.code);
  const narrowing = grantPlan.filter((g) => g.codes.length < allCodes.length);
  if (narrowing.length) {
    console.log(`\nNARROWING -- these get a STRICT SUBSET of the ${allCodes.length} active companies (${allCodes.join(",")}).`);
    console.log(`Absent a grant row they would see ALL companies; the row is what confines them:`);
    for (const g of narrowing) console.log(`  ${g.who} -> ${g.codes.join(",")} ONLY`);
  }

  // ---- 4. apply -----------------------------------------------------------
  if (blocked.length) {
    console.log(`\n${blocked.length} BLOCKED item(s) -- resolve before APPLY. Unblocked items still proceed.`);
  }
  if (!APPLY) {
    // A dry run is a REPORT: it exits 0 even with blocked items, so the workflow
    // can still reach its APPLY step. APPLY is the gate, and it exits non-zero
    // when anything was skipped.
    console.log("\nDRY-RUN -- nothing written. Re-run with APPLY=1 to write.");
    return 0;
  }

  const secrets = [];
  await sql.begin(async (tx) => {
    for (const r of plan) {
      if (r.issues.length) continue;
      if (!r.userId) {
        let pw = null, hash = null;
        if (r.synthetic) {
          pw = `2990-${Math.random().toString(36).slice(2, 8)}-${Math.random().toString(36).slice(2, 6)}`;
          hash = await hashPassword(pw);
        }
        // joined_at / invited_at are TEXT columns in this schema, so the stamp is
        // formatted here rather than nested as a SQL fragment.
        const nowUtc = new Date().toISOString().slice(0, 19).replace("T", " ");
        const ins = await tx`
          INSERT INTO users (email, name, role_id, position_id, department_id, status, password_hash, joined_at, invited_at)
          VALUES (${r.email}, ${r.name}, ${r.roleId}, ${r.positionId ?? null}, ${r.departmentId ?? null},
                  ${r.synthetic ? "active" : "invited"}, ${hash},
                  ${r.synthetic ? nowUtc : null}, ${r.synthetic ? null : nowUtc})
          RETURNING id`;
        r.userId = Number(ins[0].id);
        if (pw) secrets.push({ email: r.email, password: pw });
        console.log(`created user ${r.userId} ${r.email}`);
      }

      // Re-decide inside the transaction. For a user just created this sees the
      // md5 row the AFTER INSERT trigger has already minted; for a pre-existing
      // user it re-checks refs against live state. Either way the delete is
      // asserted safe rather than assumed -- most FKs into scm.staff are
      // ON DELETE SET NULL and would swallow a mistake silently, not raise.
      const rl = await planRelink(tx, refCols, r.userId, r.staff?.id);
      if (rl.action === "blocked") throw new Error(`refusing relink for ${r.email}: ${rl.why}`);
      if (rl.action === "relink") {
        if (rl.md5) await tx`DELETE FROM scm.staff WHERE id = ${rl.md5}`;
        await tx`UPDATE scm.staff SET user_id = ${r.userId}, active = true, updated_at = now() WHERE id = ${rl.staffId}`;
        console.log(`  relinked 2990 staff ${rl.staffId} -> user ${r.userId}${rl.md5 ? " (md5 row removed)" : ""}`);
      }
      for (const code of r.companies) {
        await tx`INSERT INTO user_companies (user_id, company_id) VALUES (${r.userId}, ${cid[code]}) ON CONFLICT DO NOTHING`;
      }
    }

    if (shPlan?.relink) {
      // Re-check under the transaction: the plan was read outside it.
      const refs = await countStaffRefs(tx, refCols, shPlan.md5);
      const total = refs.reduce((a, x) => a + x.n, 0);
      if (total > 0) throw new Error(`refusing: Shui Hor md5 staff ${shPlan.md5} referenced ${total}x`);
      if (shPlan.md5) await tx`DELETE FROM scm.staff WHERE id = ${shPlan.md5}`;
      await tx`UPDATE scm.staff SET user_id = ${shPlan.uid}, active = true, updated_at = now() WHERE id = ${shPlan.staffId}`;
      console.log(`relinked Shui Hor 2990 staff ${shPlan.staffId} -> user ${shPlan.uid}`);
    }
    if (shPlan) {
      for (const code of SHUI_HOR.companies) {
        await tx`INSERT INTO user_companies (user_id, company_id) VALUES (${shPlan.uid}, ${cid[code]}) ON CONFLICT DO NOTHING`;
      }
    }

    for (const u of sweep) {
      for (const code of ["HOUZS", "2990"]) {
        await tx`INSERT INTO user_companies (user_id, company_id) VALUES (${Number(u.id)}, ${cid[code]}) ON CONFLICT DO NOTHING`;
      }
    }
  });

  if (secrets.length) {
    // Printed ONCE, for the owner to distribute. Never committed, never stored.
    console.log("\n=== GENERATED PASSWORDS (printed once -- distribute, then this log is the only copy) ===");
    for (const s of secrets) console.log(`  ${s.email}  ${s.password}`);
    console.log("=== end ===");
  }
  console.log("\nAPPLY complete.");
  if (blocked.length) {
    // Exit red: the unblocked work landed and is committed, but these were
    // skipped and still need a decision. Re-running after fixing is safe.
    console.log(`SKIPPED ${blocked.length} blocked item(s): ${blocked.map((b) => b.name).join(", ")}`);
    return 1;
  }
  return 0;
}

main()
  .then(async (code) => {
    await sql.end();
    process.exit(code ?? 0);
  })
  .catch(async (e) => {
    console.error("MIGRATE_STAFF_FAIL", e.message);
    await sql.end();
    process.exit(1);
  });
