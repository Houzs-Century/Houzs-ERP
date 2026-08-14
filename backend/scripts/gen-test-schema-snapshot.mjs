// Collapses `schema.sql` + every file under src/db/migrations into ONE
// snapshot that `tests/setup.ts` can apply in two round-trips.
//
// Why this exists. setup.ts is a vitest `setupFiles` entry, so it runs once
// per TEST FILE, and the suite is 277 files executed serially
// (`fileParallelism: false`). The old setup replayed the baseline plus all
// 147 migrations — 1020 statements, each its own awaited `prepare().run()` —
// against a fresh D1 every single time. That is ~283,000 round-trips for one
// full suite, and most of them were statements the baseline had already
// applied, throwing "duplicate column" / "already exists" and being swallowed.
//
// Measured on CI shard 3 of run 31700016666, before this change:
//   Duration 378.84s (transform 6.14s, setup 262.33s, tests 80.80s)
// Setup was 69% of the job and the actual tests were 21%.
//
// The output is deterministic and committed, and `--check` re-derives it and
// diffs, so a new migration that is not reflected here fails CI instead of
// silently giving the suite a stale schema. Same gen/audit pair as
// gen-autocount-item-map.mjs and gen-route-locator.mjs.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { readD1Migrations } from "@cloudflare/vitest-pool-workers";

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(here, "..");
const OUT_DDL = path.join(backendRoot, "tests/generated/test-schema-snapshot.sql");
const OUT_SEED = path.join(backendRoot, "tests/generated/test-schema-seed.json");

// The same two error classes tests/setup.ts swallowed, for the same reason:
// schema.sql is a snapshot taken partway through the migration history, so
// replaying the migrations on top of it legitimately re-applies some of them.
const BENIGN = ["duplicate column", "already exists"];
const isBenign = (msg) => BENIGN.some((b) => msg.includes(b));

// Two migrations gate themselves on rollout state rather than on schema, so
// the replay needs that state present to get past them. Both are reproduced
// here with FROZEN timestamps — a generated artifact has to be byte-identical
// run to run or `--check` reports drift forever — and both are then EXCLUDED
// from the seed dump. tests/setup.ts re-inserts them at runtime with real
// `datetime('now', ...)` values, exactly as it does today, so the state the
// suite sees is unchanged.
export const PHASE1_SUFFIX = "_idempotency_principal_company_hash.sql";
const PHASE2_SUFFIX = "_idempotency_phase2_constraints.sql";
const PHASE1_ROLLOUT_KEY = "rollout.idempotency_phase1_worker_live";
const FROZEN = "2000-01-01 00:00:00";

// Stands in for a `datetime('now')` the migrations produced. tests/setup.ts
// swaps it for the real thing at insert time. Exported so the parity test and
// setup.ts cannot drift on the spelling.
export const NOW_SENTINEL = "@@NOW@@";

/** Apply baseline + migrations to a throwaway in-memory SQLite. */
async function buildDatabase() {
  const baseline = await fs.readFile(
    path.join(backendRoot, "src/db/schema.sql"),
    "utf8",
  );
  const migrations = await readD1Migrations(
    path.join(backendRoot, "src/db/migrations"),
  );

  const db = new DatabaseSync(":memory:");
  // MUST match D1, which enforces foreign keys. SQLite defaults them OFF, and
  // with them off this replay produces a DIFFERENT DATABASE, not just a
  // laxer one: 079_clean_sales_team_demo.sql deletes from sales_reps and
  // documents that it is relying on `ON DELETE CASCADE` to clear
  // sales_rep_brands and sales_team_activity with it. No enforcement, no
  // cascade, and the snapshot keeps 90 orphan rows the real suite never sees.
  // tests/schemaSnapshotParity.test.ts is what caught this.
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(baseline);

  // Production's D1 runner creates the tracker before applying files.
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       name TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
  const phase1Name = migrations
    .map((m) => m.name)
    .find((name) => name.endsWith(PHASE1_SUFFIX));
  if (!phase1Name) throw new Error("D1 idempotency Phase-1 migration is missing");
  db.prepare(
    `INSERT OR REPLACE INTO _migrations (name, applied_at) VALUES (?, ?)`,
  ).run(phase1Name, FROZEN);

  for (const mig of migrations) {
    if (mig.name.endsWith(PHASE2_SUFFIX)) {
      db.prepare(
        `INSERT OR REPLACE INTO app_settings (key, value, updated_at)
         VALUES (?, '{"deployed":true}', ?)`,
      ).run(PHASE1_ROLLOUT_KEY, FROZEN);
    }
    for (const query of mig.queries) {
      const sql = query.trim();
      if (!sql) continue;
      try {
        db.exec(sql);
      } catch (e) {
        const msg = String(e?.message ?? e ?? "");
        if (isBenign(msg)) continue;
        throw new Error(`Migration ${mig.name} failed on:\n${sql}\n→ ${msg}`);
      }
    }
  }

  // Hand both rows back to the runtime. Leaving them in the snapshot would
  // freeze "26 hours ago" to the day the file was generated.
  db.exec(`DELETE FROM _migrations`);
  db.prepare(`DELETE FROM app_settings WHERE key = ?`).run(PHASE1_ROLLOUT_KEY);

  return { db, migrationCount: migrations.length };
}

/**
 * Drop `-- line comments`, leaving anything inside a string literal alone.
 *
 * sqlite_master stores the CREATE statement as it was written, comments and
 * all, and four of these tables document their columns inline. setup.ts folds
 * the whole snapshot onto one line before `exec()` (it has to — see the
 * trigger note there), and on one line a surviving `--` comments out every
 * column after it, which SQLite reports as `incomplete input`. A blunt
 * /--.*$/ would corrupt a literal that legitimately contains two hyphens, so
 * quote state is tracked.
 */
function stripSqlComments(sql) {
  let out = "";
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (inString) {
      out += c;
      // '' is an escaped quote inside a string, not the end of one.
      if (c === "'") {
        if (sql[i + 1] === "'") out += sql[++i];
        else inString = false;
      }
      continue;
    }
    if (c === "'") {
      inString = true;
      out += c;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

/** SQLite object DDL, ordered so dependencies exist before their dependents. */
function dumpDdl(db) {
  const objects = db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
        WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
        ORDER BY CASE type
                   WHEN 'table'   THEN 0
                   WHEN 'view'    THEN 1
                   WHEN 'index'   THEN 2
                   WHEN 'trigger' THEN 3
                   ELSE 4 END,
                 name`,
    )
    .all();

  // One statement per line. tests/setup.ts hands the whole blob to
  // `env.DB.exec()`, which treats the input as a statement sequence; keeping
  // each on its own line also makes the committed diff readable when a
  // migration changes one table.
  return objects
    .map((o) => `${stripSqlComments(o.sql).replace(/\s+/g, " ").trim()};`)
    .join("\n");
}

/**
 * Tables in an order that satisfies their foreign keys — parents before
 * children.
 *
 * The replay this snapshot replaces inserted seed rows in MIGRATION order,
 * which was implicitly safe: a migration cannot reference a table an earlier
 * one has not created. Dumping from the finished database loses that order,
 * and D1 (unlike the in-memory build here, which runs with foreign keys off)
 * enforces the constraints, so an alphabetical dump fails on the first child
 * row. Kahn's algorithm, with ties broken alphabetically so the output stays
 * byte-stable for `--check`.
 */
function seedOrder(db) {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all()
    .map((r) => r.name);

  const known = new Set(tables);
  const parentsOf = new Map(tables.map((t) => [t, new Set()]));
  for (const table of tables) {
    for (const fk of db.prepare(`PRAGMA foreign_key_list("${table}")`).all()) {
      // A self-reference cannot be resolved by ordering whole tables, and a
      // reference to a table that no longer exists cannot constrain anything.
      if (fk.table === table || !known.has(fk.table)) continue;
      parentsOf.get(table).add(fk.table);
    }
  }

  const ordered = [];
  const placed = new Set();
  let remaining = [...tables];
  while (remaining.length) {
    const ready = remaining.filter((t) =>
      [...parentsOf.get(t)].every((p) => placed.has(p)),
    );
    if (ready.length === 0) {
      // A foreign-key cycle. Nothing sensible left to order by, so emit the
      // rest alphabetically and let the caller find out — loudly — if any of
      // them actually carry seed rows that need the other side first.
      ordered.push(...remaining);
      break;
    }
    for (const t of ready) {
      ordered.push(t);
      placed.add(t);
    }
    remaining = remaining.filter((t) => !placed.has(t));
  }
  return ordered;
}

/**
 * Rows written by the migrations themselves (reference data, rollout flags,
 * test-parity seeds). Emitted as data rather than INSERT text so setup.ts can
 * push them through a single bound `env.DB.batch()` — no quoting rules to get
 * wrong, and no risk of a literal containing `--` or a newline being mangled
 * by the comment-stripping that the DDL path applies.
 */
function dumpSeed(db, window) {
  const tables = seedOrder(db);

  // Migrations that seed rows stamp them with `datetime('now')`, so a raw dump
  // differs on every run and `--check` would report drift forever. Any value
  // that landed inside this generation's own clock window is one of those
  // stamps: it is replaced by a sentinel, and tests/setup.ts substitutes a
  // fresh `datetime('now')` when it inserts. That is not an approximation of
  // today's behaviour, it IS today's behaviour — the migration used to run
  // per test file, so these columns always held the moment the file ran.
  const stampedNow = (v) => {
    if (typeof v !== "string") return false;
    if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(v)) return false;
    const t = Date.parse(v.replace(" ", "T") + (v.endsWith("Z") ? "" : "Z"));
    return Number.isFinite(t) && t >= window.from && t <= window.to;
  };

  const seed = [];
  for (const table of tables) {
    const rows = db.prepare(`SELECT * FROM "${table}"`).all();
    if (rows.length === 0) continue;
    const columns = Object.keys(rows[0]);
    seed.push({
      table,
      columns,
      rows: rows.map((r) =>
        columns.map((c) => {
          const v = r[c];
          if (stampedNow(v)) return NOW_SENTINEL;
          // node:sqlite hands back BigInt for INTEGER columns that exceed the
          // safe range. JSON cannot carry it, and D1 binds numbers, so narrow
          // it here where an out-of-range value would be visible.
          if (typeof v === "bigint") {
            if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
              throw new Error(`${table}.${c} exceeds MAX_SAFE_INTEGER: ${v}`);
            }
            return Number(v);
          }
          if (v instanceof Uint8Array) {
            throw new Error(
              `${table}.${c} is a BLOB; the seed encoder has no BLOB support yet`,
            );
          }
          return v;
        }),
      ),
    });
  }
  return seed;
}

const check = process.argv.includes("--check");

// Bracket the replay so dumpSeed can tell a migration's `datetime('now')`
// stamp from a genuine date that happens to be stored as text. 2s of slack
// each side covers clock granularity between SQLite and Date.now().
const startedAt = Date.now() - 2000;
const { db, migrationCount } = await buildDatabase();
const window = { from: startedAt, to: Date.now() + 2000 };

const ddl = dumpDdl(db);
const seed = dumpSeed(db, window);
db.close();

const header =
  `-- GENERATED by scripts/gen-test-schema-snapshot.mjs — DO NOT EDIT.\n` +
  `-- Run \`npm run gen:test-schema\` after adding a migration.\n` +
  `-- Source: src/db/schema.sql + ${migrationCount} files in src/db/migrations.\n`;
const ddlOut = `${header}${ddl}\n`;
const seedOut = `${JSON.stringify(seed, null, 2)}\n`;

if (check) {
  const [haveDdl, haveSeed] = await Promise.all([
    fs.readFile(OUT_DDL, "utf8").catch(() => null),
    fs.readFile(OUT_SEED, "utf8").catch(() => null),
  ]);
  // Compare CONTENT, not line endings. Git hands a Windows checkout CRLF while
  // the generator always builds LF, so a raw !== reported both files stale on
  // every Windows run — for a tree where nothing under src/db/migrations/ had
  // changed at all. It passes on Linux CI, which makes it the expensive kind of
  // wrong: the local gate says regenerate, regenerating produces a byte-identical
  // file, and `git diff` shows nothing to explain it.
  const eol = (s) => (s === null ? null : s.replace(/\r\n/g, "\n"));
  const stale = [];
  if (eol(haveDdl) !== eol(ddlOut)) stale.push(path.relative(backendRoot, OUT_DDL));
  if (eol(haveSeed) !== eol(seedOut)) stale.push(path.relative(backendRoot, OUT_SEED));
  if (stale.length) {
    console.error(
      `Test schema snapshot is stale: ${stale.join(", ")}\n` +
        `Something under src/db/ changed the schema without this being\n` +
        `regenerated, so the suite would run against a schema production does\n` +
        `not have. It is EITHER a new/edited file in src/db/migrations/ OR an\n` +
        `edit to the src/db/schema.sql baseline — both feed this snapshot, and\n` +
        `the baseline is the one people forget (it is what went stale first,\n` +
        `on 2026-08-13, via a change to sales_orders).\n` +
        `Fix: npm run gen:test-schema`,
    );
    process.exit(1);
  }
  console.log(
    `test schema snapshot up to date (${migrationCount} migrations, ` +
      `${seed.length} seeded tables)`,
  );
} else {
  await fs.mkdir(path.dirname(OUT_DDL), { recursive: true });
  await Promise.all([
    fs.writeFile(OUT_DDL, ddlOut),
    fs.writeFile(OUT_SEED, seedOut),
  ]);
  const rowCount = seed.reduce((s, t) => s + t.rows.length, 0);
  console.log(
    `wrote ${path.relative(backendRoot, OUT_DDL)} and ` +
      `${path.relative(backendRoot, OUT_SEED)}\n` +
      `  ${migrationCount} migrations collapsed, ` +
      `${seed.length} seeded tables, ${rowCount} rows`,
  );
}
