import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Proves the collapsed snapshot is the migrations.
 *
 * tests/setup.ts no longer replays `schema.sql` + 147 migrations per test
 * file; it applies `tests/generated/`, produced by
 * `npm run gen:test-schema`. That is only safe while the two agree, and
 * "agree" has to be checked in THIS runtime — the generator builds with
 * node:sqlite, the suite runs on workerd's D1, and a DDL difference between
 * them would otherwise surface as a mystery failure in an unrelated test.
 *
 * So: `env.DB` already holds the snapshot-built schema (setup.ts ran). This
 * replays the real migration history into `env.DB_PARITY` the old way, and
 * compares. `npm run audit:test-schema` catches a migration added without
 * regenerating; this catches the snapshot being wrong in a way regeneration
 * would not reveal.
 */

const BENIGN = ["duplicate column", "already exists"];

/** The pre-snapshot setup.ts, verbatim in behaviour, against DB_PARITY. */
async function replayMigrations(db: D1Database) {
  await db.exec(
    env.TEST_BASELINE_SQL.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim(),
  );
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    )
    .run();
  const phase1Name = env.TEST_MIGRATIONS.map((m) => m.name).find((name) =>
    name.endsWith("_idempotency_principal_company_hash.sql"),
  );
  if (!phase1Name) throw new Error("D1 idempotency Phase-1 migration is missing");
  await db
    .prepare(
      `INSERT OR REPLACE INTO _migrations (name, applied_at)
       VALUES (?, datetime('now', '-26 hours'))`,
    )
    .bind(phase1Name)
    .run();

  for (const mig of env.TEST_MIGRATIONS) {
    if (mig.name.endsWith("_idempotency_phase2_constraints.sql")) {
      await db
        .prepare(
          `INSERT OR REPLACE INTO app_settings (key, value, updated_at)
           VALUES ('rollout.idempotency_phase1_worker_live', '{"deployed":true}', datetime('now', '-25 hours'))`,
        )
        .run();
    }
    for (const q of mig.queries) {
      const sql = q.trim();
      if (!sql) continue;
      try {
        await db.prepare(sql).run();
      } catch (e: any) {
        const msg = String(e?.message ?? e ?? "");
        if (BENIGN.some((b) => msg.includes(b))) continue;
        throw new Error(`Migration ${mig.name} failed on:\n${sql}\n→ ${msg}`);
      }
    }
  }
}

/** name -> normalised DDL, for every object SQLite records with a definition. */
async function schemaOf(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
        WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
        ORDER BY type, name`,
    )
    .all<{ type: string; name: string; sql: string }>();
  return Object.fromEntries(
    results.map((r) => [`${r.type}:${r.name}`, r.sql.replace(/\s+/g, " ").trim()]),
  );
}

/**
 * Both databases stamp rows relative to the moment they are built, seconds
 * apart, so raw values cannot be compared. Anything that looks like a
 * timestamp inside the relative window is collapsed to a marker.
 *
 * The window is 48h, not "recent", because the stamps are not all `now`: the
 * Phase-1 rollout flag is written at `now - 25 hours` and the migration
 * tracker row at `now - 26 hours`, deliberately, to clear the Phase-2 soak
 * gate. A 1-hour cutoff leaves those two comparing raw and failing on the
 * seconds between the two builds. Reference data carrying a genuine date is
 * from whenever the migration was authored — months out — so it still
 * survives normalisation and a real content change is still caught.
 */
const RELATIVE_WINDOW_MS = 48 * 60 * 60 * 1000;

function normaliseRow(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  const cutoff = Date.now() - RELATIVE_WINDOW_MS;
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(v)) {
      const t = Date.parse(v.replace(" ", "T") + (v.endsWith("Z") ? "" : "Z"));
      if (Number.isFinite(t) && t >= cutoff) {
        out[k] = "<generated-now>";
        continue;
      }
    }
    out[k] = v;
  }
  return out;
}

async function tableNames(db: D1Database) {
  const { results } = await db
    .prepare(
      // `_cf_METADATA` is D1's own bookkeeping table. It is not in
      // sqlite_master's reserved `sqlite_` namespace, but selecting from it
      // is refused with SQLITE_AUTH, and it is not part of our schema.
      `SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
          AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
        ORDER BY name`,
    )
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

describe("generated test schema", () => {
  // Once for the whole file, not per test. The baseline opens with
  // `DROP TABLE IF EXISTS ...`, which is a no-op on an empty database but
  // fails against a populated one the moment foreign keys are enforced — so a
  // second replay into the same DB_PARITY would blow up rather than start
  // clean. Storage isolation is per file here, not per test.
  beforeAll(async () => {
    await replayMigrations(env.DB_PARITY);
  });

  it("is identical to replaying schema.sql + every migration", async () => {
    const [fromSnapshot, fromMigrations] = await Promise.all([
      schemaOf(env.DB),
      schemaOf(env.DB_PARITY),
    ]);

    // Compare the key sets first: a missing table produces one readable
    // failure instead of a wall of DDL.
    expect(Object.keys(fromSnapshot).sort()).toEqual(
      Object.keys(fromMigrations).sort(),
    );
    for (const key of Object.keys(fromMigrations)) {
      expect(`${key} :: ${fromSnapshot[key]}`).toBe(
        `${key} :: ${fromMigrations[key]}`,
      );
    }
  });

  it("seeds the same rows the migrations seed", async () => {
    for (const table of await tableNames(env.DB_PARITY)) {
      // _migrations is written by setup.ts on one side and by the replay on
      // the other, with intentionally different content; it is asserted
      // separately below.
      if (table === "_migrations") continue;

      const [a, b] = await Promise.all([
        env.DB.prepare(`SELECT * FROM "${table}"`).all(),
        env.DB_PARITY.prepare(`SELECT * FROM "${table}"`).all(),
      ]);
      const norm = (rows: Record<string, unknown>[]) =>
        rows.map(normaliseRow).map((r) => JSON.stringify(r)).sort();

      expect(
        `${table}: ${JSON.stringify(norm(a.results as Record<string, unknown>[]))}`,
      ).toBe(
        `${table}: ${JSON.stringify(norm(b.results as Record<string, unknown>[]))}`,
      );
    }
  });

  it("leaves the Phase-1 soak row where the Phase-2 guard can see it", async () => {
    // The one piece of state deliberately kept OUT of the snapshot, because it
    // is relative to now. If setup.ts ever stops writing it, the Phase-2
    // migration's 24-hour guard silently changes meaning.
    const row = await env.DB.prepare(
      `SELECT name, applied_at FROM _migrations
        WHERE name LIKE '%_idempotency_principal_company_hash.sql'`,
    ).first<{ name: string; applied_at: string }>();

    expect(row).not.toBeNull();
    const age = Date.now() - Date.parse(row!.applied_at.replace(" ", "T") + "Z");
    expect(age).toBeGreaterThan(24 * 60 * 60 * 1000);
  });
});
