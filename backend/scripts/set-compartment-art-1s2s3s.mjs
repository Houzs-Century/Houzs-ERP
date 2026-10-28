#!/usr/bin/env node
/**
 * One-shot: set scm.compartment_library.art_filename for the 3 just-added
 * sofa-module ids (1S / 2S / 3S) which were inserted with an empty
 * art_filename ('').
 *
 * Background: the original 15 compartment_library rows (seeded in
 * migration 0022) all carry an art_filename like '1A(LHF).png' / 'CNR.png'.
 * The three later-added rows 1S / 2S / 3S have art_filename = '' which is
 * out of parity with the rest. The matching art (1S.png / 2S.png / 3S.png)
 * now lives under frontend/public/sofa-modules/ (copied from 2990).
 *
 * NOTE: this column has NO code consumer in the current frontend — the
 * Maintenance Compartments pool renders from sofaCompartmentMeta[code].imageKey
 * (R2 upload) falling back to /sofa-modules/{id}.svg in /public. This update is
 * purely DB parity with the other 15 rows.
 *
 * Per CLAUDE.md this is a one-shot script (NOT a numbered migration):
 * it's environment-specific data convergence, not a schema change.
 *
 * Idempotent: re-running is a no-op once 1S/2S/3S already carry their png.
 *
 * Usage (from backend/, reads DATABASE_URL from .dev.vars):
 *   node scripts/set-compartment-art-1s2s3s.mjs [--dry]
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";

const dry = process.argv.slice(2).includes("--dry");
const url = readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="?([^"\n]+)"?/)[1];
const sql = postgres(url, { ssl: "require" });

const TARGETS = [
  { id: "1S", art_filename: "1S.png" },
  { id: "2S", art_filename: "2S.png" },
  { id: "3S", art_filename: "3S.png" },
];

try {
  console.log(`[set-compartment-art] connected (dry=${dry})`);

  for (const t of TARGETS) {
    if (dry) {
      const [cur] = await sql`
        SELECT id, art_filename FROM scm.compartment_library WHERE id = ${t.id}
      `;
      console.log(
        `  DRY ${t.id}: current art_filename=${JSON.stringify(cur?.artFilename ?? cur?.art_filename ?? null)} -> would set ${JSON.stringify(t.art_filename)}`,
      );
      continue;
    }
    const updated = await sql`
      UPDATE scm.compartment_library
         SET art_filename = ${t.art_filename}
       WHERE id = ${t.id}
       RETURNING id, art_filename
    `;
    if (updated.length === 0) {
      console.warn(`  WARN ${t.id}: no row in scm.compartment_library (skipped)`);
    } else {
      const r = updated[0];
      console.log(`  SET  ${r.id} -> ${r.artFilename ?? r.art_filename}`);
    }
  }

  // Read back the full table so the caller can verify every art_filename
  // has a matching file under frontend/public/sofa-modules/.
  const all = await sql`
    SELECT id, art_filename FROM scm.compartment_library ORDER BY sort_order, id
  `;
  console.log("\n[set-compartment-art] all compartment_library rows:");
  for (const r of all) {
    console.log(`  ${r.id}\t${JSON.stringify(r.artFilename ?? r.art_filename ?? "")}`);
  }
  console.log(`\n[set-compartment-art] ${all.length} rows total`);
} finally {
  await sql.end({ timeout: 5 });
}
