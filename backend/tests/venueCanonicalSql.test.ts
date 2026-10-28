import { describe, expect, test } from "vitest";
import { VENUE_CANONICAL_MAP, venueKey } from "../src/scm/lib/canonical-venue";

/* WHY THIS TEST EXISTS.
   The venue name has now been unified three times, and it drifted back twice —
   each cleanup was a one-shot backfill with no guard. 2026-07-29 added the TS
   front door (canonical-venue.ts) and this branch added the SQL net
   (migrations-pg/*_venue_canonicalize.sql). That means ONE rule now lives in
   three files: the TS module, the backfill script, and the SQL function. The
   failure mode this whole effort is about is two copies of a rule disagreeing —
   so "keep them in sync" is enforced here rather than written in a comment,
   the same reasoning as migrationNumbers.test.ts.

   Adding an alias to VENUE_CANONICAL_MAP and forgetting the SQL fails HERE, at
   PR time, instead of silently leaving a hole in the database-level guard.

   Globbed by SUFFIX, never by number: this migration gets renumbered whenever a
   parallel PR takes its slot on main, and a number-pinned glob resolves to
   nothing and passes vacuously. */

function onlySource(glob: Record<string, string>, what: string): string {
  const paths = Object.keys(glob);
  if (paths.length !== 1) {
    throw new Error(
      `expected exactly one ${what} venue-canonicalize migration, found ${paths.length}: ` +
        `${paths.join(", ") || "(none)"}`,
    );
  }
  return glob[paths[0]];
}

const pgSql = onlySource(
  import.meta.glob("../src/db/migrations-pg/*_venue_canonicalize.sql", {
    eager: true,
    query: "?raw",
    import: "default",
  }) as Record<string, string>,
  "Postgres",
);

const d1Sql = onlySource(
  import.meta.glob("../src/db/migrations/*_venue_canonicalize.sql", {
    eager: true,
    query: "?raw",
    import: "default",
  }) as Record<string, string>,
  "D1",
);

/** Every lookup key the TS map folds, canonical included. */
const allKeys = Object.entries(VENUE_CANONICAL_MAP).flatMap(([canonical, variants]) => [
  venueKey(canonical),
  ...variants.map(venueKey),
]);

describe("venue canonicalization: the TS map and the SQL guards agree", () => {
  test("the TS map is non-empty (guards against a vacuous pass)", () => {
    expect(allKeys.length).toBeGreaterThan(0);
  });

  test("the Postgres function maps every alias the TS map knows", () => {
    for (const [canonical, variants] of Object.entries(VENUE_CANONICAL_MAP)) {
      for (const key of [venueKey(canonical), ...variants.map(venueKey)]) {
        expect(
          pgSql,
          `scm.canonicalize_venue() has no WHEN branch for "${key}" — add it to the migration`,
        ).toContain(`WHEN '${key}'`);
      }
      expect(pgSql, `the Postgres function never returns "${canonical}"`).toContain(
        `THEN '${canonical}'`,
      );
    }
  });

  test("the D1 parity file carries the same alias list", () => {
    for (const [canonical, variants] of Object.entries(VENUE_CANONICAL_MAP)) {
      for (const key of [venueKey(canonical), ...variants.map(venueKey)]) {
        expect(
          d1Sql,
          `the D1 parity trigger does not fold "${key}"`,
        ).toContain(`'${key}'`);
      }
      expect(d1Sql).toContain(`'${canonical}'`);
    }
  });

  test("blanks stay blank — the Postgres function returns its input untouched", () => {
    // A NOT NULL venue column must survive this trigger; the owner asked to
    // unify the PJ alias, not to fill unassigned rows.
    expect(pgSql).toContain("IF input IS NULL THEN RETURN NULL; END IF;");
    expect(pgSql).toContain("IF trimmed = '' THEN RETURN input; END IF;");
  });
});
