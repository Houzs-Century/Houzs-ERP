// Read-only report on why "Save" on Team > Members > a member's Details &
// Assignment fails with "Something went wrong processing that request."
//
// That message is index.ts humanizeError() folding a Postgres error (constraint,
// duplicate key, missing column, bad input) into one line, so the screen cannot
// say which statement failed. PATCH /api/users/:id issues, in order: the users
// UPDATE (plus any trigger on it, some of which were applied straight to
// production and exist nowhere in this repo), the user_departments insert, the
// user_companies replace (errors swallowed), and, when the department is a Sales
// one, the sales_reps roster sync (nextSalesRepCode + INSERT + activity row).
// This prints what production holds for each, and asks Workers Logs for the
// error text the backend logged ("[onError]"), so the failing step is named
// rather than guessed.
//
// Strictly reads: SELECTs, catalog lookups and EXPLAIN without ANALYZE (parses
// and plans, executes nothing). Exits 0 for every real answer. Only an
// unreachable database exits non-zero; the Workers Logs half is best-effort.
//
// PROBE_USER_ID defaults to 167 (EMP-0167, the member reported 2026-10-21).
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

const notice = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);
const line = (msg) => console.log(msg);
const show = (label, rows) => {
  line(`--- ${label} (${rows.length}) ---`);
  for (const r of rows) line(`  ${JSON.stringify(r)}`);
};

const probeId = Number(process.env.PROBE_USER_ID ?? 167) || 167;
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

// The tables a member save touches, directly or through the roster sync.
const TOUCHED = [
  ["public", "users"],
  ["public", "user_departments"],
  ["public", "user_companies"],
  ["public", "sales_reps"],
  ["public", "sales_team_activity"],
  ["public", "audit_events"],
  ["scm", "staff"],
];

try {
  // 1) The member as saved, and what the drawer offered.
  show(
    "member",
    await pg`
      SELECT u.id, u.name, u.email, u.status, u.department_id, d.name AS dept,
             u.position_id, p.name AS pos, p.slug AS pos_slug, p.department_id AS pos_dept,
             p.active AS pos_active, u.role_id, r.name AS role, u.manager_id,
             m.name AS manager, u.division, u.invited_at, u.joined_at
        FROM users u
        LEFT JOIN departments d ON d.id = u.department_id
        LEFT JOIN positions p ON p.id = u.position_id
        LEFT JOIN roles r ON r.id = u.role_id
        LEFT JOIN users m ON m.id = u.manager_id
       WHERE u.id = ${probeId}`,
  );
  show("member company grants", await pg`SELECT company_id FROM user_companies WHERE user_id = ${probeId}`);
  show("member department links", await pg`SELECT department_id FROM user_departments WHERE user_id = ${probeId}`);
  show("companies", await pg`SELECT id, code, name FROM companies ORDER BY id`);
  show("sales departments", await pg`SELECT id, name FROM departments WHERE name ILIKE '%sales%' ORDER BY id`);
  show(
    "positions named like Sales Executive",
    await pg`SELECT id, name, slug, department_id, active FROM positions WHERE name ILIKE '%sales exec%' ORDER BY id`,
  );
  show("roles named like Sales Person", await pg`SELECT id, name FROM roles WHERE name ILIKE '%sales person%' ORDER BY id`);
  show("users named Kris*", await pg`SELECT id, name, status, department_id, manager_id FROM users WHERE name ILIKE 'kris%' ORDER BY id`);

  // 2) Every non-internal trigger on those tables, with the body it runs. The
  //    repo is not the source of truth for these (see check-user-disable-blocked).
  for (const [schema, table] of TOUCHED) {
    const trg = await pg`
      SELECT t.tgname, pg_get_triggerdef(t.oid) AS def, p.oid::regprocedure::text AS fn
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE n.nspname = ${schema} AND c.relname = ${table} AND NOT t.tgisinternal
       ORDER BY t.tgname`;
    line(`--- triggers on ${schema}.${table} (${trg.length}) ---`);
    for (const t of trg) line(`  ${t.def}`);
  }
  const fns = await pg`
    SELECT DISTINCT p.oid::regprocedure::text AS fn, pg_get_functiondef(p.oid) AS def
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE NOT t.tgisinternal
       AND (n.nspname, c.relname) IN (
         ('public','users'), ('public','user_departments'), ('public','user_companies'),
         ('public','sales_reps'), ('public','sales_team_activity'), ('public','audit_events'),
         ('scm','staff'))`;
  for (const f of fns) {
    line(`--- FUNCTION ${f.fn} ---`);
    for (const l of String(f.def).split("\n")) line(`  ${l}`);
  }

  // 3) Constraints a write to those tables has to pass.
  for (const [schema, table] of TOUCHED) {
    const cons = await pg`
      SELECT con.conname, con.contype, pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ${schema} AND c.relname = ${table}
       ORDER BY con.contype, con.conname`;
    line(`--- constraints on ${schema}.${table} (${cons.length}) ---`);
    for (const k of cons) line(`  [${k.contype}] ${k.conname}: ${k.def}`);
  }

  // 4) The roster sync. nextSalesRepCode() reads the top code by TEXT order and
  //    adds one; reproduce it exactly (the d1 shim turns LIKE into ILIKE) and say
  //    whether the code it would mint is already taken.
  const top = await pg`SELECT id, code, user_id, archived_at FROM sales_reps WHERE code ILIKE 'SR-%' ORDER BY code DESC LIMIT 5`;
  show("sales_reps top codes by text order (what nextSalesRepCode reads)", top);
  let next = 1;
  if (top[0]?.code) {
    const n = parseInt(String(top[0].code).slice(3), 10);
    if (Number.isFinite(n)) next = n + 1;
  }
  const minted = `SR-${String(next).padStart(3, "0")}`;
  const taken = await pg`SELECT id, code, name, user_id, archived_at FROM sales_reps WHERE code = ${minted}`;
  notice(`nextSalesRepCode would mint ${minted}: ${taken.length ? "ALREADY TAKEN -> duplicate key on insert" : "free"}`);
  show("holder of that code", taken);
  show(
    "sales_reps codes that are not SR-<3 digits>",
    await pg`SELECT id, code, name, user_id, archived_at FROM sales_reps WHERE code !~ '^SR-[0-9]{3}$' ORDER BY code`,
  );
  show(
    "sales_reps numeric maximum",
    await pg`SELECT max((substring(code from '^SR-([0-9]+)$'))::int) AS max_n, count(*) AS reps FROM sales_reps`,
  );
  show(
    "sales_reps row for this member (by user_id or email)",
    await pg`
      SELECT r.id, r.code, r.name, r.email, r.user_id, r.status, r.archived_at
        FROM sales_reps r
       WHERE r.user_id = ${probeId}
          OR lower(r.email) = (SELECT lower(email) FROM users WHERE id = ${probeId})`,
  );

  // 4b) What the roster INSERT must satisfy beyond pg_constraint: NOT NULL
  //     columns without a default, and an id counter behind the table (a data
  //     load that copied ids without moving the sequence raises duplicate key
  //     on the primary key, which pg_constraint shows as a plain PK).
  for (const table of ["sales_reps", "sales_team_activity"]) {
    show(
      `${table} columns`,
      await pg`
        SELECT column_name, data_type, is_nullable, column_default, is_identity, identity_generation
          FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = ${table}
         ORDER BY ordinal_position`,
    );
    const seq = await pg`SELECT pg_get_serial_sequence(${"public." + table}, 'id') AS seq`;
    const seqName = seq[0]?.seq ?? null;
    const [{ max_id }] = await pg.unsafe(`SELECT max(id) AS max_id FROM public.${table}`);
    if (seqName) {
      const [state] = await pg.unsafe(`SELECT last_value, is_called FROM ${seqName}`);
      const nextId = state.is_called ? Number(state.last_value) + 1 : Number(state.last_value);
      notice(
        `${table}: sequence ${seqName} next id ${nextId}, table max id ${max_id} -> ` +
          (max_id != null && nextId <= Number(max_id) ? "BEHIND (insert raises duplicate key on the primary key)" : "ok"),
      );
    } else {
      notice(`${table}: no sequence owns id (max id ${max_id}) -> an insert without an explicit id gets NULL`);
    }
  }
  show(
    "sales_reps newest rows",
    await pg`SELECT id, code, user_id, created_at, archived_at FROM sales_reps ORDER BY id DESC LIMIT 5`,
  );
  show(
    "sales_team_activity newest rows",
    await pg`SELECT id, rep_id, action, to_value, note, user_id, created_at FROM sales_team_activity ORDER BY id DESC LIMIT 5`,
  );
  show(
    "audit for this member's email (invite)",
    await pg`
      SELECT id, created_at, actor_email, action, entity_id, summary, meta
        FROM audit_events
       WHERE entity_id = (SELECT email FROM users WHERE id = ${probeId})
          OR summary ILIKE ${"%" + "#" + String(probeId) + "%"}
       ORDER BY id DESC LIMIT 10`,
  );

  // 5) The roster statements themselves, parsed and planned only.
  const plans = [
    ["roster insert", `EXPLAIN INSERT INTO sales_reps (code, name, email, user_id, status) VALUES ('SR-PROBE', 'probe', NULL, ${probeId}, 'active') RETURNING *`],
    ["activity insert", `EXPLAIN INSERT INTO sales_team_activity (rep_id, action, from_value, to_value, note, user_id) VALUES (1, 'created', NULL, 'SR-PROBE', 'probe', NULL) RETURNING *`],
  ];
  for (const [label, text] of plans) {
    try {
      await pg.unsafe(text);
      line(`  EXPLAIN OK    ${label}`);
    } catch (e) {
      notice(`  EXPLAIN RAISE ${label} -> ${String(e?.message ?? e).slice(0, 300)}`);
    }
  }

  // 6) The member's own row in scm.staff (the POS PIN keys off it).
  show(
    "scm.staff for this member",
    await pg`SELECT id, user_id, staff_code, name, active FROM scm.staff WHERE user_id = ${probeId} OR staff_code = ${"EMP-" + String(probeId).padStart(4, "0")}`,
  );

  // 7) What the audit trail says got through: this member, then every member
  //    edit in the last three days (a save that dies before audit() logs nothing).
  show(
    "audit for this member",
    await pg`
      SELECT id, created_at, actor_email, action, summary
        FROM audit_events
       WHERE entity_type = 'user' AND entity_id = ${String(probeId)}
       ORDER BY id DESC LIMIT 15`,
  );
  show(
    "user.update events, last 3 days",
    await pg`
      SELECT id, created_at, actor_email, entity_id, summary
        FROM audit_events
       WHERE action = 'user.update' AND created_at > now() - interval '3 days'
       ORDER BY id DESC LIMIT 20`,
  );
} finally {
  await pg.end({ timeout: 5 });
}

// 8) The error text itself, from Workers Logs. Best-effort: a token without
//    observability read, or a changed response shape, prints why and moves on.
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!TOKEN || !ACCOUNT) {
  notice("Workers Logs: skipped (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set)");
} else {
  // Two needles: the request itself (invocation log, carries the status and the
  // request id), and the error line onError writes for it.
  const memberPath = `/api/users/${probeId}`;
  for (const needle of [memberPath, "[onError]", "sales_reps", "duplicate key"]) {
    try {
      const to = Date.now();
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/observability/telemetry/query`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            queryId: `member-save-blocked-${needle}`,
            timeframe: { from: to - 2 * 24 * 3600 * 1000, to },
            view: "events",
            limit: 100,
            parameters: { datasets: [], filters: [], needle: { value: needle, isRegex: false, matchCase: false } },
          }),
        },
      );
      const body = await res.json().catch(() => null);
      const events = body?.result?.events?.events ?? [];
      line(`--- Workers Logs "${needle}": HTTP ${res.status}, ${events.length} events ---`);
      if (!res.ok || !body?.success) line(`  ${JSON.stringify(body?.errors ?? body).slice(0, 800)}`);
      for (const ev of events) line(`  ${JSON.stringify(ev).slice(0, 3000)}`);
    } catch (e) {
      notice(`Workers Logs "${needle}": query failed -> ${String(e?.message ?? e).slice(0, 300)}`);
    }
  }
}
