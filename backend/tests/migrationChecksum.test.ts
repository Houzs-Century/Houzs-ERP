import { describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs helper shared with the deploy-time migration runner
import {
  ADOPTED_LEGACY_CHECKSUM,
  canonicalizeMigrationSql,
  checksumMigrationSql,
  isGenesisTracker,
  planMigrationChecksums,
} from "../scripts/lib/migration-checksum.mjs";
// @ts-expect-error - plain .mjs helper shared with the deploy-time migration runner
import { loadAppliedMigrationRows } from "../scripts/lib/migration-tracker.mjs";

describe("migration checksum canonicalisation", () => {
  it("has the same checksum on LF and CRLF checkouts", async () => {
    const lf = "CREATE TABLE example (id int);\n-- keep history\n";
    const crlf = lf.replace(/\n/g, "\r\n");

    expect(canonicalizeMigrationSql(crlf)).toBe(lf);
    expect(await checksumMigrationSql(crlf)).toBe(
      await checksumMigrationSql(lf),
    );
  });

  it("ignores a UTF-8 BOM but detects actual content changes", async () => {
    const original = "CREATE TABLE example (id int);\n";
    expect(await checksumMigrationSql(`\uFEFF${original}`)).toBe(
      await checksumMigrationSql(original),
    );
    expect(await checksumMigrationSql(`${original}-- edited\n`)).not.toBe(
      await checksumMigrationSql(original),
    );
  });
});

describe("migration checksum plan", () => {
  const file = (filename: string, checksum: string) => ({ filename, checksum });

  it("backfills old tracker rows once and leaves new files pending", () => {
    const result = planMigrationChecksums(
      [file("0001.sql", "sha256:a"), file("0002.sql", "sha256:b")],
      [{ filename: "0001.sql", checksum: null }],
    );

    expect(
      result.backfill.map((entry: { filename: string }) => entry.filename),
    ).toEqual(["0001.sql"]);
    expect(
      result.pending.map((entry: { filename: string }) => entry.filename),
    ).toEqual(["0002.sql"]);
    expect(result.drift).toEqual([]);
  });

  it("fails closed when an applied file changes", () => {
    const result = planMigrationChecksums(
      [file("0001.sql", "sha256:new")],
      [{ filename: "0001.sql", checksum: "sha256:old" }],
    );

    expect(result.drift).toEqual([
      expect.objectContaining({
        filename: "0001.sql",
        reason: "content_changed",
        storedChecksum: "sha256:old",
        currentChecksum: "sha256:new",
      }),
    ]);
  });

  it("fails closed when a checksum-tracked file is deleted", () => {
    const result = planMigrationChecksums([], [
      { filename: "0001.sql", checksum: "sha256:old" },
    ]);

    expect(result.drift).toEqual([
      expect.objectContaining({ filename: "0001.sql", reason: "file_deleted" }),
    ]);
  });

  it("fails closed for unverifiable pre-checksum deletions", () => {
    const result = planMigrationChecksums([], [
      { filename: "0001.sql", checksum: null },
    ]);

    expect(result.drift).toEqual([
      expect.objectContaining({
        filename: "0001.sql",
        reason: "legacy_file_deleted_unverifiable",
        storedChecksum: null,
        currentChecksum: null,
      }),
    ]);
  });

  it("fails closed when a retired historical filename is reused", () => {
    const retired = {
      filename: "0017_removed.sql",
      archivedChecksum: "sha256:archived",
      gitBlob: "0123456789012345678901234567890123456789",
    };
    const result = planMigrationChecksums(
      [file("0017_removed.sql", "sha256:new")],
      [],
      { retiredMigrations: [retired] },
    );

    expect(result.pending).toEqual([]);
    expect(result.drift).toEqual([
      expect.objectContaining({
        filename: "0017_removed.sql",
        reason: "retired_filename_reused",
      }),
    ]);
  });

  it("accepts only a known retirement with a legacy NULL or archived checksum", () => {
    const retired = {
      filename: "0017_removed.sql",
      archivedChecksum: "sha256:archived",
      gitBlob: "0123456789012345678901234567890123456789",
    };
    const legacy = planMigrationChecksums(
      [],
      [{ filename: retired.filename, checksum: null }],
      { retiredMigrations: [retired] },
    );
    expect(legacy.drift).toEqual([]);
    expect(legacy.retired).toEqual([expect.objectContaining({ filename: retired.filename })]);

    const archived = planMigrationChecksums(
      [],
      [{ filename: retired.filename, checksum: retired.archivedChecksum }],
      { retiredMigrations: [retired] },
    );
    expect(archived.drift).toEqual([]);
    expect(archived.retired).toHaveLength(1);

    const mismatch = planMigrationChecksums(
      [],
      [{ filename: retired.filename, checksum: "sha256:different" }],
      { retiredMigrations: [retired] },
    );
    expect(mismatch.retired).toEqual([]);
    expect(mismatch.drift).toEqual([
      expect.objectContaining({
        filename: retired.filename,
        reason: "retired_checksum_mismatch",
      }),
    ]);
  });
});

describe("genesis detection", () => {
  it("is true only while no tracker row carries a checksum", () => {
    expect(isGenesisTracker([])).toBe(true);
    expect(
      isGenesisTracker([
        { filename: "0001.sql", checksum: null },
        { filename: "0002.sql", checksum: null },
      ]),
    ).toBe(true);
    // One real checksum anywhere means the checksum runner has already run and
    // committed, so every later unexplained row is drift, not history.
    expect(
      isGenesisTracker([
        { filename: "0001.sql", checksum: null },
        { filename: "0002.sql", checksum: "sha256:a" },
      ]),
    ).toBe(false);
    // The adoption sentinel counts as "past genesis" for the same reason.
    expect(
      isGenesisTracker([{ filename: "0001.sql", checksum: ADOPTED_LEGACY_CHECKSUM }]),
    ).toBe(false);
  });
});

describe("first-run adoption of unverifiable legacy rows", () => {
  const file = (filename: string, checksum: string) => ({ filename, checksum });

  it("adopts an unknown pre-checksum orphan on the genesis run instead of blocking the deploy", () => {
    // Failing closed here buys nothing — there is no checksum and no file, so
    // no dump of production could verify the row either — and a failed
    // migration run blocks EVERY later migration.
    const result = planMigrationChecksums(
      [file("0001.sql", "sha256:a"), file("0002.sql", "sha256:b")],
      [
        { filename: "0001.sql", checksum: null },
        { filename: "0099_long_gone.sql", checksum: null },
      ],
      { genesis: true },
    );

    expect(result.drift).toEqual([]);
    expect(result.backfill.map((e: { filename: string }) => e.filename)).toEqual(["0001.sql"]);
    expect(result.pending.map((e: { filename: string }) => e.filename)).toEqual(["0002.sql"]);
    expect(result.adopted).toEqual([
      expect.objectContaining({ filename: "0099_long_gone.sql", alreadyAdopted: false }),
    ]);
  });

  it("fails closed on the same row once the tracker is past genesis", () => {
    const result = planMigrationChecksums([], [{ filename: "0099_long_gone.sql", checksum: null }], {
      genesis: false,
    });

    expect(result.adopted).toEqual([]);
    expect(result.drift).toEqual([
      expect.objectContaining({
        filename: "0099_long_gone.sql",
        reason: "legacy_file_deleted_unverifiable",
      }),
    ]);
  });

  it("carries an already-adopted row forward without re-adopting it", () => {
    const result = planMigrationChecksums(
      [],
      [{ filename: "0099_long_gone.sql", checksum: ADOPTED_LEGACY_CHECKSUM }],
      { genesis: false },
    );

    expect(result.drift).toEqual([]);
    expect(result.adopted).toEqual([
      expect.objectContaining({ filename: "0099_long_gone.sql", alreadyAdopted: true }),
    ]);
  });

  it("treats an adopted filename reappearing in the tree as drift", () => {
    const result = planMigrationChecksums(
      [file("0099_long_gone.sql", "sha256:resurrected")],
      [{ filename: "0099_long_gone.sql", checksum: ADOPTED_LEGACY_CHECKSUM }],
      { genesis: false },
    );

    expect(result.pending).toEqual([]);
    expect(result.drift).toEqual([
      expect.objectContaining({ filename: "0099_long_gone.sql", reason: "content_changed" }),
    ]);
  });
});

describe("renumber reconciliation", () => {
  const file = (filename: string, checksum: string) => ({ filename, checksum });

  it("repoints a byte-identical renumber instead of bricking the environment", () => {
    // The staging-brick scenario: 0165_x.sql was pushed to `staging`, applied
    // and tracked there; main then merged it as 0167_x.sql. Without this,
    // staging's tracker holds a filename that will never exist again and every
    // staging deploy fails closed forever.
    const result = planMigrationChecksums(
      [file("0167_x.sql", "sha256:same")],
      [{ filename: "0165_x.sql", checksum: "sha256:same" }],
    );

    expect(result.drift).toEqual([]);
    expect(result.pending).toEqual([]); // must NOT be replayed
    expect(result.renamed).toEqual([
      { from: "0165_x.sql", to: "0167_x.sql", checksum: "sha256:same" },
    ]);
  });

  it("refuses to guess when two orphans share a checksum", () => {
    const result = planMigrationChecksums(
      [file("0167_x.sql", "sha256:same")],
      [
        { filename: "0165_x.sql", checksum: "sha256:same" },
        { filename: "0166_y.sql", checksum: "sha256:same" },
      ],
    );

    expect(result.renamed).toEqual([]);
    expect(result.drift).toHaveLength(2);
    expect(result.pending.map((e: { filename: string }) => e.filename)).toEqual(["0167_x.sql"]);
  });

  it("refuses to guess when two pending files share the orphan's checksum", () => {
    const result = planMigrationChecksums(
      [file("0167_x.sql", "sha256:same"), file("0168_x_copy.sql", "sha256:same")],
      [{ filename: "0165_x.sql", checksum: "sha256:same" }],
    );

    expect(result.renamed).toEqual([]);
    // Still reported, still fail-closed — and it names the likelier of the two.
    expect(result.drift).toEqual([
      expect.objectContaining({
        filename: "0165_x.sql",
        reason: "probable_renumber",
        suspectedRenumberOf: "0167_x.sql",
      }),
    ]);
  });

  it("names the suspect loudly when a renumber also changed the content", () => {
    // A renumber usually rewrites the header comment, so the checksum moves and
    // the rename cannot be proven. Report it as a renumber with the exact fix
    // rather than as an anonymous deletion.
    const result = planMigrationChecksums(
      [file("0167_x.sql", "sha256:edited")],
      [{ filename: "0165_x.sql", checksum: "sha256:original" }],
    );

    expect(result.renamed).toEqual([]);
    expect(result.drift).toEqual([
      expect.objectContaining({
        filename: "0165_x.sql",
        reason: "probable_renumber",
        suspectedRenumberOf: "0167_x.sql",
        storedChecksum: "sha256:original",
        currentChecksum: "sha256:edited",
      }),
    ]);
    // The new file is still pending: nothing proved it had already run.
    expect(result.pending.map((e: { filename: string }) => e.filename)).toEqual(["0167_x.sql"]);
  });

  it("keeps calling a genuine deletion a deletion", () => {
    const result = planMigrationChecksums(
      [file("0167_unrelated.sql", "sha256:b")],
      [{ filename: "0165_x.sql", checksum: "sha256:a" }],
    );

    expect(result.drift).toEqual([
      expect.objectContaining({ filename: "0165_x.sql", reason: "file_deleted" }),
    ]);
  });

  it("never repoints onto a retired filename", () => {
    const retired = {
      filename: "0017_scm_suppliers.sql",
      archivedChecksum: "sha256:archived",
      gitBlob: "0123456789012345678901234567890123456789",
    };
    const result = planMigrationChecksums(
      [file("0167_scm_suppliers.sql", "sha256:archived")],
      [{ filename: retired.filename, checksum: "sha256:archived" }],
      { retiredMigrations: [retired] },
    );

    expect(result.renamed).toEqual([]);
    expect(result.retired).toHaveLength(1);
  });
});

describe("read-only migration tracker inspection", () => {
  function fakePg(tracker: { tracker_exists: boolean; checksum_exists: boolean }) {
    const calls: string[] = [];
    const rows = [{ filename: "0001.sql", checksum: tracker.checksum_exists ? "sha256:a" : null }];
    const pg = async (parts: TemplateStringsArray) => {
      const sql = parts.join("?").replace(/\s+/g, " ").trim();
      calls.push(sql);
      if (sql.includes("to_regclass")) return [tracker];
      return rows;
    };
    return { pg, calls, rows };
  }

  it.each([
    { tracker_exists: false, checksum_exists: false },
    { tracker_exists: true, checksum_exists: false },
    { tracker_exists: true, checksum_exists: true },
  ])("never executes DDL/DML in read-only mode: %o", async (tracker) => {
    const { pg, calls } = fakePg(tracker);
    await loadAppliedMigrationRows(pg, { readOnly: true });

    expect(calls.length).toBe(tracker.tracker_exists ? 2 : 1);
    expect(calls.every((sql) => /^SELECT\b/i.test(sql))).toBe(true);
    expect(calls.join("\n")).not.toMatch(/\b(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP)\b/i);
    if (tracker.tracker_exists && !tracker.checksum_exists) {
      expect(calls[1]).toContain("NULL::text AS checksum");
    }
  });
});
