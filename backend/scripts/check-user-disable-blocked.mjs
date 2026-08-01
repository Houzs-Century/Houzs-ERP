// Read-only report on why "Disable" fails on the Team > Members page with
// "Something went wrong processing that request."
//
// WHY THIS EXISTS AS A SCRIPT AND A WORKFLOW
//
// The answer lives only in production's scm.staff rows, so the alternative was
// pasting a SELECT into a SQL console held by the owner -- an interruption, and
// the production DSN in front of a human for a read. Actions already holds
// secrets.DATABASE_URL for the deploy, so the check runs there instead.
//
// THE THEORY THIS TESTS (and can refute)
//
// PATCH /api/users/:id runs `UPDATE users SET status='disabled'`. Migration
// 0066 put an AFTER UPDATE OF name, status trigger on public.users --
// trg_sync_user_to_staff -- which mirrors the user into scm.staff:
//
//     UPDATE scm.staff SET name=..., active=..., initials=...
//      WHERE id = md5('houzs-user:'||NEW.id)::uuid OR user_id = NEW.id;
//     IF NOT FOUND THEN
//       INSERT INTO scm.staff (id, user_id, staff_code, ...)
//       VALUES (..., 'EMP-'||lpad(NEW.id::text,4,'0'), ...)
//       ON CONFLICT (id) DO UPDATE ...;
//     END IF;
//
// The UPDATE branch cannot fail (nothing it writes is constrained). The INSERT
// branch can: scm.staff carries `staff_staff_code_unique UNIQUE(staff_code)`,
// and the ON CONFLICT clause only covers the PRIMARY KEY (id) -- so a
// staff_code already held by a DIFFERENT staff row raises
// `duplicate key value violates unique constraint "staff_staff_code_unique"`.
// The trigger is AFTER UPDATE on the same statement, so the whole UPDATE rolls
// back and the account stays active. index.ts maps that error class to the
// generic 500 the owner sees.
//
// So a user is un-disable-able exactly when BOTH hold:
//   1. no scm.staff row is linked to them (neither by deterministic id nor
//      user_id), so the trigger takes the INSERT branch, AND
//   2. 'EMP-<zero-padded id>' is already taken by some OTHER staff row.
//
// Strictly SELECTs. No DDL, no writes, no transaction. Exits 0 for every
// legitimate answer -- including "no users are affected", which REFUTES the
// theory and is a real result, not a failure. Only an unreachable database or
// a query error exits non-zero.
import { readFileSync } from "node:fs";
import postgres from "postgres";

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
  // 1) What actually fires on a status update, live. If 0066's trigger is not
  //    here, the theory is wrong at step one and the rest is noise.
  const triggers = await pg`
    SELECT t.tgname,
           pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'users' AND NOT t.tgisinternal
     ORDER BY t.tgname`;

  notice(`triggers on public.users: ${triggers.length}`);
  for (const t of triggers) notice(`  ${t.tgname}: ${t.def}`);

  // 1b) The BODY of every function those triggers call. This is the part the
  //     repo cannot answer: the first run of this check found
  //     `trg_sync_user_to_tms` on public.users, and `sync_user_to_tms` appears
  //     NOWHERE in the migration tree or anywhere else in the repo -- it was
  //     applied straight to production. Reasoning about what a `users` write
  //     does from migrations-pg alone is therefore unsound, which is exactly
  //     how the first diagnosis went wrong. Print the source of truth.
  const fns = await pg`
    SELECT n.nspname || '.' || p.proname AS fqname,
           pg_get_functiondef(p.oid)     AS def
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.oid IN (
       SELECT t.tgfoid FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace cn ON cn.oid = c.relnamespace
       WHERE cn.nspname = 'public' AND c.relname = 'users' AND NOT t.tgisinternal
     )
     ORDER BY 1`;
  for (const f of fns) {
    notice(`--- FUNCTION ${f.fqname} ---`);
    for (const line of String(f.def).split("\n")) notice(`  ${line}`);
  }

  // 1c) What a hard delete has to get past. `DELETE /api/users/:id?hard=1`
  //     cleans a hand-written list of tables first; anything NOT on that list
  //     with a non-cascading FK blocks the delete.
  const fks = await pg`
    SELECT c.conname,
           cn.nspname || '.' || cl.relname AS from_table,
           pg_get_constraintdef(c.oid)     AS def
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_namespace cn ON cn.oid = cl.relnamespace
     WHERE c.contype = 'f' AND c.confrelid = 'public.users'::regclass
     ORDER BY 2, 1`;
  notice(`FKs referencing public.users: ${fks.length}`);
  for (const f of fks) notice(`  ${f.from_table}: ${f.def}`);

  // 2) The constraint the INSERT branch can trip.
  const uniques = await pg`
    SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE conrelid = 'scm.staff'::regclass AND contype IN ('u', 'p')
     ORDER BY conname`;
  notice(`scm.staff unique/pk constraints: ${uniques.map((u) => u.conname).join(", ")}`);

  // 2b) The OTHER statement a status-only PATCH runs, so a refutation above
  //     does not leave the operator with nowhere to look. PATCH also runs
  //     `DELETE FROM sessions WHERE user_id = $1` through Drizzle; if the live
  //     table disagrees with schema.pg.ts that DELETE is the raise instead --
  //     and it would fail for EVERY account, not just one.
  const sess = await pg`
    SELECT column_name, data_type
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'sessions'
     ORDER BY ordinal_position`;
  notice(
    `public.sessions columns: ${sess.map((s) => `${s.column_name} ${s.data_type}`).join(", ") || "TABLE MISSING"}`,
  );

  // 2c) lpad(id,4,'0') TRUNCATES in Postgres, so ids past 9999 collapse into
  //     codes an earlier user already owns ('EMP-1004' for both 1004 and
  //     10042). Harmless while ids stay small -- but it is the one way this
  //     collision becomes systemic later, so the range is worth printing.
  const [range] = await pg`SELECT min(id) AS lo, max(id) AS hi FROM public.users`;
  notice(
    `users.id range: ${range.lo}..${range.hi}` +
      (Number(range.hi) > 9999 ? "  <-- PAST 9999: lpad now truncates, codes can collide" : ""),
  );

  // 3) Simulate the trigger for every user, without writing anything.
  //    linked  -> the UPDATE branch runs; disabling is safe.
  //    !linked -> the INSERT branch runs; it explodes iff the code is taken.
  const rows = await pg`
    WITH u AS (
      SELECT id, email, name, status,
             md5('houzs-user:' || id::text)::uuid AS staff_uuid,
             'EMP-' || lpad(id::text, 4, '0')     AS want_code
        FROM public.users
    )
    SELECT u.id, u.email, u.name, u.status, u.want_code,
           link.id           AS linked_staff_id,
           clash.id          AS clash_staff_id,
           clash.name        AS clash_staff_name,
           clash.user_id     AS clash_staff_user_id,
           clash.active      AS clash_staff_active
      FROM u
      LEFT JOIN scm.staff link
        ON link.id = u.staff_uuid OR link.user_id = u.id
      LEFT JOIN scm.staff clash
        ON clash.staff_code = u.want_code
     ORDER BY u.id`;

  const unlinked = rows.filter((r) => r.linked_staff_id === null);
  const blocked = unlinked.filter((r) => r.clash_staff_id !== null);

  notice(`users total: ${rows.length}`);
  notice(`users with NO linked scm.staff row (trigger takes the INSERT branch): ${unlinked.length}`);
  notice(`users whose disable WILL throw duplicate key: ${blocked.length}`);

  if (blocked.length > 0) {
    notice("CONFIRMED — these accounts cannot be disabled (nor renamed):");
    for (const r of blocked) {
      notice(
        `  user #${r.id} ${r.email} (${r.name ?? "no name"}, ${r.status}) ` +
          `wants staff_code ${r.want_code}, already held by staff ${r.clash_staff_id} ` +
          `"${r.clash_staff_name}" (user_id=${r.clash_staff_user_id ?? "NULL"}, active=${r.clash_staff_active})`,
      );
    }
  } else if (unlinked.length > 0) {
    notice(
      "PARTIALLY REFUTED — some users have no staff row, but none of their " +
        "staff_codes collide, so the INSERT branch would succeed. Disable " +
        "failures on those accounts have a different cause.",
    );
    for (const r of unlinked.slice(0, 20)) {
      notice(`  unlinked: user #${r.id} ${r.email} (${r.status}) -> ${r.want_code} free`);
    }
    if (unlinked.length > 20) notice(`  ... and ${unlinked.length - 20} more`);
  } else {
    notice(
      "REFUTED — every user has a linked scm.staff row, so the trigger always " +
        "takes the safe UPDATE branch. Look elsewhere for the disable failure.",
    );
  }
} finally {
  await pg.end({ timeout: 5 });
}
