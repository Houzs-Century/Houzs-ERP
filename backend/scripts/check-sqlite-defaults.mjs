// Unit + end-to-end check for the SQLite -> Postgres DEFAULT translation used by
// scripts/load-d1-dump-to-pg.mjs.
//
// RUN IT WITH (from backend/):
//   node --experimental-transform-types --test scripts/check-sqlite-defaults.mjs
//
// NO DEPENDENCIES and NOT part of `npm test`. Both are deliberate:
//   * no deps — `npm install` in a worktree destroys the main checkout's
//     node_modules, so a check that needs one is a check nobody runs. This file
//     uses node:test / node:assert / node:sqlite, all built in.
//   * not in `npm test` — `npm test` gates every production deploy (deploy.yml),
//     and the loader it covers is a one-shot environment builder that deploy.yml
//     never touches. Wiring a non-deploy script into the deploy gate is how the
//     is_active repair took every prod deploy down on 2026-06-26
//     (docs/pg-migration-dropped-defaults-coe.md §3). The filename avoids
//     `*.test.mjs` on purpose so vitest's default include never collects it.
//
// The second half builds a real in-memory SQLite database with the same column
// shapes the D1 dump actually contains, reads it back through PRAGMA table_info
// exactly as the loader does, and asserts on the DDL fragments produced. That is
// the closest thing to a real run available without a D1 dump and a Postgres.
import assert from "node:assert/strict";
import test from "node:test";

import { sqliteDefaultToPg } from "./lib/sqlite-default-to-pg.mjs";

// Same mapping the loader uses. Duplicated here rather than exported from the
// loader because importing the loader would execute it (it connects and DROPs).
const mapType = (ty) => {
  ty = (ty || "").toUpperCase();
  if (ty.includes("INT")) return "bigint";
  if (ty.includes("REAL") || ty.includes("FLOA") || ty.includes("DOUB")) return "double precision";
  if (ty.includes("BLOB")) return "bytea";
  return "text";
};

const carried = (raw, type) => {
  const r = sqliteDefaultToPg(raw, type);
  assert.equal(r.reason, null, `expected \`${raw}\` on ${type} to be carried, got skip: ${r.reason}`);
  return r.clause;
};
const skipReason = (raw, type) => {
  const r = sqliteDefaultToPg(raw, type);
  assert.equal(r.clause, null, `expected \`${raw}\` on ${type} to be SKIPPED, got: ${r.clause}`);
  assert.ok(r.reason && r.reason.length > 0, "a skip must carry a reason");
  return r.reason;
};

// The UTC "now" expression rewriteDialect emits. Asserted literally so a change
// to the shim's output shows up here as a failure rather than as a silently
// different schema.
const PG_NOW_STAMP = "to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')";
const PG_NOW_DATE = "to_char(timezone('UTC', now()), 'YYYY-MM-DD')";

test("date/time stamps — the silent variant that wrote NULL for a month", () => {
  // 77 creation-stamp columns lost this default in the cutover (mig 0098).
  assert.equal(carried("datetime('now')", "text"), `default ${PG_NOW_STAMP}`);
  assert.equal(carried("date('now')", "text"), `default ${PG_NOW_DATE}`);
  // CURRENT_TIMESTAMP is SQLite's own alias for datetime('now'); it must produce
  // the identical clause, not a Postgres CURRENT_TIMESTAMP (which is a
  // timestamptz and would render differently in a text column).
  assert.equal(carried("CURRENT_TIMESTAMP", "text"), `default ${PG_NOW_STAMP}`);
  assert.equal(carried("current_timestamp", "text"), `default ${PG_NOW_STAMP}`);
  assert.equal(carried("CURRENT_DATE", "text"), `default ${PG_NOW_DATE}`);
  // Parenthesised form, in case a sqlite build hands the wrapper back.
  assert.equal(carried("(datetime('now'))", "text"), `default ${PG_NOW_STAMP}`);
});

test("date modifiers are carried only when every one of them survives", () => {
  assert.equal(
    carried("datetime('now','-30 days')", "text"),
    "default to_char(timezone('UTC', now()) - interval '30 days', 'YYYY-MM-DD HH24:MI:SS')",
  );
  assert.equal(
    carried("date('now','+1 month')", "text"),
    "default to_char(timezone('UTC', now()) + interval '1 month', 'YYYY-MM-DD')",
  );
  // rewriteDialect does not understand 'start of month' and emits no interval
  // for it. Carrying that would stamp rows with plain now() forever.
  assert.match(skipReason("datetime('now','start of month')", "text"), /modifier/i);
  // The dynamic form from scripts/test-dialect.ts — rejected before translation.
  assert.match(skipReason("datetime('now','-' || ? || ' hours')", "text"), /unrecognised/i);
});

test("strftime('now') is refused — it would freeze at CREATE TABLE time", () => {
  // The one default in the live D1 schema that this loader cannot carry:
  // client_errors.created_at. rewriteDialect gets the FORMAT right but renders
  // the value as ('now')::timestamptz, which Postgres resolves when the literal
  // is read — so every row would get the load's timestamp, forever.
  const reason = skipReason("strftime('%Y-%m-%dT%H:%M:%SZ','now')", "text");
  assert.match(reason, /freeze/i);
  assert.match(reason, /0098_restore_timestamp_defaults/);
});

test("a date/time default never lands on a non-text column", () => {
  // The loader stores stamps as text; putting to_char() into a bigint would fail
  // the CREATE, and "fix" it by changing the column's meaning.
  assert.match(skipReason("datetime('now')", "bigint"), /text/i);
  assert.match(skipReason("CURRENT_TIMESTAMP", "double precision"), /text/i);
});

test("numeric literals — quoted for text columns, bare for numeric ones", () => {
  // is_active DEFAULT 1 (mig 0054), is_system DEFAULT 0 (mig 0012).
  assert.equal(carried("0", "bigint"), "default 0");
  assert.equal(carried("1", "bigint"), "default 1");
  assert.equal(carried("7", "bigint"), "default 7");
  assert.equal(carried("0", "double precision"), "default 0");
  assert.equal(carried("-1.5", "double precision"), "default -1.5");
  // Postgres refuses `text ... default 0` outright ("column is of type text but
  // default expression is of type integer"), and SQLite's text affinity stored
  // '0' anyway, so the literal is quoted.
  assert.equal(carried("0", "text"), "default '0'");
});

test("booleans — SQLite has none; TRUE/FALSE are 1/0", () => {
  assert.equal(carried("TRUE", "bigint"), "default 1");
  assert.equal(carried("false", "bigint"), "default 0");
  assert.equal(carried("TRUE", "text"), "default '1'");
});

test("hex literals are converted, not passed through", () => {
  // Postgres only accepts 0x literals from 16 onward; Supabase must not be
  // assumed to be there.
  assert.equal(carried("0x10", "bigint"), "default 16");
  assert.equal(carried("0xff", "text"), "default '255'");
});

test("string literals keep their SQL escaping", () => {
  // trip_type DEFAULT 'delivery', permissions DEFAULT '[]' (mig 0012 family).
  assert.equal(carried("'delivery'", "text"), "default 'delivery'");
  assert.equal(carried("'[]'", "text"), "default '[]'");
  assert.equal(carried("''", "text"), "default ''");
  assert.equal(carried("'it''s'", "text"), "default 'it''s'");
  // A quoted number into a numeric column is unquoted; a quoted word is refused
  // rather than handed to Postgres to fail (or worse, coerce).
  assert.equal(carried("'12'", "bigint"), "default 12");
  assert.match(skipReason("'open'", "bigint"), /non-numeric/i);
});

test("NULL is carried explicitly", () => {
  assert.equal(carried("NULL", "text"), "default null");
  assert.equal(carried("null", "bigint"), "default null");
});

test("anything not certain is skipped WITH a reason, never guessed", () => {
  for (const [raw, type] of [
    ["abs(-3)", "bigint"],
    ["lower('X')", "text"],
    ["other_column", "text"],
    ["'a' || 'b'", "text"],
    ["x'53514c697465'", "bytea"],
    ["CURRENT_TIME", "text"],
    ["", "text"],
  ]) {
    const reason = skipReason(raw, type);
    assert.ok(reason.length > 3, `reason for \`${raw}\` must be usable: ${reason}`);
  }
});

test("blob columns take nothing but NULL", () => {
  assert.equal(carried("NULL", "bytea"), "default null");
  assert.match(skipReason("0", "bytea"), /bytea/i);
  assert.match(skipReason("'x'", "bytea"), /bytea/i);
});

// ---------------------------------------------------------------------------
// End-to-end: a synthetic SQLite database, read back exactly as the loader does.
// node:sqlite is built in from Node 22.5; skipped rather than failed if absent.
// ---------------------------------------------------------------------------
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  /* older node — the unit tests above still cover the translation */
}

test("PRAGMA table_info round-trip on a synthetic D1-shaped schema", { skip: !DatabaseSync }, () => {
  const db = new DatabaseSync(":memory:");
  // Column shapes copied from src/db/schema.sql, plus two deliberate
  // untranslatable ones to prove the warning path fires.
  db.exec(`CREATE TABLE roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    permissions TEXT NOT NULL DEFAULT '[]',
    is_system INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    status TEXT DEFAULT 'Open',
    sync_status TEXT DEFAULT 'SYNCED' CHECK(sync_status IN ('SYNCED','ERROR')),
    horizon_days INTEGER NOT NULL DEFAULT 7,
    balance REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    computed INTEGER DEFAULT (abs(-3)),
    clock TEXT DEFAULT CURRENT_TIME
  )`);

  const cols = db.prepare('PRAGMA table_info("roles")').all();
  const pk = cols.filter((c) => c.pk > 0).map((c) => c.name);
  const singleIntPk = pk.length === 1 && /INT/i.test(cols.find((c) => c.name === pk[0]).type || "");
  assert.ok(singleIntPk, "id must still take the identity branch");

  const emitted = new Map();
  const skips = [];
  for (const c of cols) {
    if (singleIntPk && c.name === pk[0]) {
      // The identity branch never receives a DEFAULT.
      assert.equal(c.dflt_value, null);
      emitted.set(c.name, `"${c.name}" bigint generated by default as identity primary key`);
      continue;
    }
    const pgType = mapType(c.type);
    let def = `"${c.name}" ${pgType}${c.notnull && c.pk === 0 ? " not null" : ""}`;
    if (c.dflt_value !== null) {
      const { clause, reason } = sqliteDefaultToPg(c.dflt_value, pgType);
      if (clause) def += ` ${clause}`;
      else skips.push(`${c.name}: ${reason}`);
    }
    emitted.set(c.name, def);
  }

  assert.equal(emitted.get("permissions"), `"permissions" text not null default '[]'`);
  assert.equal(emitted.get("is_system"), `"is_system" bigint not null default 0`);
  assert.equal(emitted.get("is_active"), `"is_active" bigint not null default 1`);
  assert.equal(emitted.get("status"), `"status" text default 'Open'`);
  // CHECK is not carried by this loader (it never was) — only the literal is.
  assert.equal(emitted.get("sync_status"), `"sync_status" text default 'SYNCED'`);
  assert.equal(emitted.get("horizon_days"), `"horizon_days" bigint not null default 7`);
  assert.equal(emitted.get("balance"), `"balance" double precision default 0`);
  assert.equal(emitted.get("created_at"), `"created_at" text default ${PG_NOW_STAMP}`);
  assert.equal(emitted.get("updated_at"), `"updated_at" text default ${PG_NOW_STAMP}`);
  // The two untranslatable ones keep their column but lose the default, loudly.
  assert.equal(emitted.get("computed"), `"computed" bigint`);
  assert.equal(emitted.get("clock"), `"clock" text`);
  assert.equal(skips.length, 2, `expected exactly 2 skips, got: ${skips.join(" | ")}`);

  // NOT NULL, types, PK and column order are unchanged by this fix.
  assert.deepEqual(
    [...emitted.keys()],
    cols.map((c) => c.name),
  );
  db.close();
});
