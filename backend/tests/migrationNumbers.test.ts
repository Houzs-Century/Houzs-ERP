import { describe, expect, test } from "vitest";

/* WHY THIS TEST EXISTS.
   On 2026-07-18 two files were numbered 0128 (#765). Within the hour of fixing and
   documenting that, the SAME collision was created again at 0136 — because the way
   "the next free number" gets picked is `ls *.sql`, and the file already holding
   0136 was a `.TEMPLATE`. The written rule ("a .TEMPLATE occupies its number") did
   not prevent the second occurrence, because the person applying the rule was the
   person who had just written it.

   So the rule is enforced here instead of documented. A duplicate is caught by a red
   test at PR time rather than by a failed pg-migrate mid-deploy — and a failed
   migration blocks EVERY deploy, not only its own.

   EXTENSION-BLIND ON PURPOSE: the trap is a non-.sql file whose whole purpose is to
   BECOME a .sql file later. It occupies its number from the day it lands.

   WHY import.meta.glob AND NOT readdirSync: this suite runs in workerd, where
   `readdirSync()` throws "not yet implemented in Workers". The first version of this
   test used it inside a try/catch and passed on an empty listing — it stayed green
   with a real duplicate planted in the directory, which is worse than no test at
   all. import.meta.glob is expanded by Vite at TRANSFORM time, in Node, so the file
   listing is baked into the bundle and is readable inside the isolate. The
   emptiness assertions below exist so that a glob which stops resolving fails LOUD
   instead of silently passing again. */

const MIGRATION_GLOBS: Record<string, Record<string, unknown>> = {
  "src/db/migrations-pg": import.meta.glob("../src/db/migrations-pg/*", { eager: false }),
  "src/db/migrations": import.meta.glob("../src/db/migrations/*", { eager: false }),
};

/* THE HISTORICAL BASELINE — numbers already claimed twice (0104 three times) when
   this test was written, all applied in prod. They are harmless: pg-migrate.mjs
   keys `_pg_migrations.filename` as its PRIMARY KEY and sorts by full name, so a
   number is a LABEL to the runner, never an identity. Two files sharing one is a
   readability problem, not an execution one — which is exactly why it kept
   happening unnoticed. Frozen here so the ratchet catches the NEXT one. */
const KNOWN_DUPLICATES: Record<string, string[]> = {
  // 0175 landed twice under an unfortunate rename chain in the same afternoon:
  //   1. #1039 merged as `0171_scm_warehouse_type_and_unify.sql`, colliding with
  //      `0171_idempotency_phase2_constraints.sql` (parallel PR from same base).
  //   2. #1044 hotfixed the red main by renaming the warehouse migration to
  //      `0175_scm_warehouse_type_and_unify.sql`.
  //   3. #1040 then merged as `0175_scm_state_canonicalize.sql` — the same PR
  //      had already renamed to 0175 to duck the 0172 collision it saw at
  //      branch time.
  //   4. That made 0175 a duplicate in turn. Renamed again to 0176 — which
  //      0176_scm_region_and_snapshot_backfill.sql had taken in the meantime —
  //      and finally to `0177_scm_warehouse_type_and_unify.sql`, the number read
  //      off the tree AFTER merging the true tip of main rather than the base the
  //      branch happened to start from. Five collisions on one file in one day:
  //      the number has to be taken against the tip you are about to merge INTO,
  //      not the tip you branched from.
  // Two 0175 files now on main, both applied under their own filenames in
  // `_pg_migrations`. Frozen here so the ratchet catches the NEXT one.
  // 0344 is DELIBERATE, not historical accident (2026-09-02): 0344_acc was
  // applied on staging (checksum locked) but pending on production, failing
  // on per-statement FK checks. The only position that runs BEFORE a pending
  // file is a name that sorts before it — 0344_aaa_defer_account_fks marks
  // the accounts FKs deferrable so 0344_acc's relay checks at commit. See
  // both files' headers.
  "src/db/migrations-pg": ["0029", "0091", "0092", "0093", "0094", "0104", "0108", "0112", "0123", "0344"],
  "src/db/migrations": ["010"],
};

/* THE FIX FOR THE COLLISION ITSELF, not just its detection.
   A sequential number can only be CLAIMED at merge, but it has to be CHOSEN at
   authoring time — so every branch open at once picks the same "next free" one
   and all but the first must rename. With ~10 PRs in flight this is constant:
   0300 was taken twice inside thirty minutes on 2026-08-18.

   A UTC timestamp is chosen at authoring time and is already unique, so two
   authors cannot pick the same one, and nobody has to rename. It sorts AFTER
   every numbered file (lexicographically "2" > "0"), which is the order
   pg-migrate applies in — it reads the directory, `.sort()`s by filename, and
   keys its tracker on the full filename, so the format is invisible to it.

   Existing numbered files are NOT renamed and never should be: pg-migrate
   matches by full filename, so a rename reads to it as an orphaned tracker row
   plus an unknown file, and it would run the SQL a second time.

       new:  20260818T0345_acc_gl_views_composite_account_key.sql
       old:  0303_acc_gl_views_composite_account_key.sql      (left alone)

   Generate one with:  npm run migration:new -- <slug>
*/
const TIMESTAMP_NAME = /^\d{8}T\d{4}_/;

/** number → the files claiming it, from the glob's KEYS (paths). */
function numbered(glob: Record<string, unknown>): Map<string, string[]> {
  const byNo = new Map<string, string[]>();
  for (const path of Object.keys(glob)) {
    const file = path.split("/").pop() ?? "";
    /* A TIMESTAMP-NAMED migration claims no number and cannot collide — that is
       the whole point of the format (see the header). \d{3,4} would match its
       first four digits ("2026") and file every one of them under the same
       phantom number, so they are excluded before the number is read. */
    if (TIMESTAMP_NAME.test(file)) continue;
    const m = file.match(/^(\d{3,4})[_-]/);
    if (!m) continue;
    const list = byNo.get(m[1]) ?? [];
    list.push(file);
    byNo.set(m[1], list);
  }
  return byNo;
}

/**
 * The next number nobody has taken in this directory, zero-padded to the width
 * the directory already uses.
 *
 * Named in the failure message on purpose. Three collisions in three days
 * (0235, 0239, 0240) all had the same shape: a branch open for an hour races
 * every other branch for the next number, and "pick the next free number
 * instead" makes you go and work out what that is — from a listing that has
 * moved since you last looked. Printing it turns a five-minute detour into a
 * rename.
 */
function nextFreeNumber(glob: Record<string, unknown>): string {
  const taken = new Set(numbered(glob).keys());
  const width = Math.max(...[...taken].map((n) => n.length), 4);
  let next = 0;
  for (const no of taken) next = Math.max(next, Number(no));
  return String(next + 1).padStart(width, "0");
}

describe("the next-free-number hint", () => {
  test("names a number nobody has taken, padded like its neighbours", () => {
    const glob = { "a/0007_x.sql": 1, "a/0008_y.sql": 1, "a/0008_z.sql": 1 };
    expect(nextFreeNumber(glob)).toBe("0009");
  });

  test("keeps counting past the clash rather than offering it back", () => {
    // The naive answer to "0008 is taken twice" is "use 0008" — which is the
    // collision again. The hint has to be the number after the HIGHEST.
    const glob = { "a/0008_x.sql": 1, "a/0008_y.sql": 1, "a/0012_z.sql": 1 };
    expect(nextFreeNumber(glob)).toBe("0013");
  });
});

describe("migration numbering", () => {
  for (const [dir, glob] of Object.entries(MIGRATION_GLOBS)) {
    test(`${dir}: the listing is non-empty (guards against a vacuous pass)`, () => {
      // If this fails, the two tests below prove NOTHING — fix the glob first.
      expect(Object.keys(glob).length, `no files globbed from ${dir}`).toBeGreaterThan(0);
    });

    test(`${dir}: every file is either numbered or timestamped`, () => {
      /* A file the parser skips is a file the duplicate check cannot see — so
         the two accepted shapes are enumerated here rather than assumed. A
         timestamp is skipped ON PURPOSE (it claims no number and cannot
         collide); anything that is NEITHER is an unnamed file that would slip
         past the duplicate check unnoticed, which is what this asserts. */
      const files = Object.keys(glob).map((p) => p.split("/").pop() ?? "");
      const unnamed = files.filter((f) => !TIMESTAMP_NAME.test(f) && !/^\d{3,4}[_-]/.test(f));
      expect(unnamed, `${dir}: neither NNNN_ nor YYYYMMDDTHHMM_`).toEqual([]);
    });

    test(`${dir}: no NEW duplicate numbers beyond the known historical ones`, () => {
      const dupes = [...numbered(glob)]
        .filter(([, files]) => files.length > 1)
        .map(([no]) => no)
        .sort();
      // A RATCHET, not a clean-room rule. Nine numbers were already doubled up
      // before this test existed and every one of them is applied in prod, so
      // demanding zero would fail every deploy and rewriting history to satisfy a
      // test would be worse than the mess. Adding a number that is already taken
      // fails here; the historical ones are frozen as accepted.
      const clashes = dupes.filter((no) => !KNOWN_DUPLICATES[dir].includes(no));
      expect(
        dupes,
        clashes.length > 0
          ? `${dir}: ${clashes.join(", ")} is taken twice — rename your file to ` +
            `${nextFreeNumber(glob)}_*.sql. Rename ONLY (do not edit the body): ` +
            `pg-migrate spots a rename by checksum, and an edited body reads to it ` +
            `as an orphaned tracker row plus an unknown file to apply.`
          : `NEW duplicate migration number in ${dir} — pick the next free number instead`,
      ).toEqual(KNOWN_DUPLICATES[dir]);
    });
  }
});
