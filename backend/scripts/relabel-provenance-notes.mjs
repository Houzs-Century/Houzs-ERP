// ----------------------------------------------------------------------------
// relabel-provenance-notes.mjs — move every stored PO provenance note onto the
// unified wording, and be able to put it back.
//
// WHAT THIS TOUCHES. `scm.purchase_orders.notes`, one column, on rows whose
// note carries a provenance label. Nothing else.
//
// WHY IT IS NOT COSMETIC, and must be read as a production data write. For a PO
// raised by the MRP shortage->PO convert, this note is the ONLY stored record
// of which Sales Orders it was bought for — those POs carry no per-line
// so_item_id. Eight readers parse it (see
// src/scm/shared/transfer-vocabulary.ts). Corrupt one note and that PO's
// provenance is gone from the relationship map, the coverage endpoint and the
// printed PO, with no error anywhere.
//
// THE INVARIANT, and the whole safety argument in one line:
//
//     the WORDING changes; the extracted set of doc numbers must NOT.
//
// It is enforced three times, deliberately, because each catches a different
// failure: once when the row is PLANNED (a row that would change its own
// meaning is refused, never written), once in the unit tests over the shared
// corpus, and once AFTER the write by RE-READING the row back out of the
// database and re-parsing it. The third is the only one that can see a write
// that did not land the way the plan said it would.
//
// WHY THE OWNER WAS WARNED. The recommendation was to leave the stored note
// alone and unify only the labels, because a backfill over a provenance record
// is a data risk with no functional upside. He was told that and chose to
// unify (2026-08-18). So it is unified — carefully, reversibly, and by default
// not at all: this script does NOTHING without APPLY=1.
//
// ── REVERSIBILITY ───────────────────────────────────────────────────────────
// Every run — DRY-RUN included — writes a COMPLETE manifest of {id, po_number,
// company_id, before, after} for every planned row, and the workflow uploads it
// as a build artifact with a 90-day retention. `before` is the exact original
// bytes, so the manifest alone is a full restore image.
//
// To roll back: download the manifest from the run's artifacts and
//
//     MODE=revert MANIFEST=<path> APPLY=1 node scripts/relabel-provenance-notes.mjs
//
// Revert restores `before` only where the row's CURRENT value still equals
// `after` — so a note a human edited after the migration is left alone and
// reported, never silently overwritten with a stale value.
//
// ── IDEMPOTENCE ─────────────────────────────────────────────────────────────
// relabelProvenanceNote returns its input BY IDENTITY when the label is already
// current, so a row already migrated is not planned at all. A second APPLY run
// plans zero rows and writes nothing. Same for revert.
//
// RE-RUN: a second run plans and writes NOTHING. relabelProvenanceNote returns
// its input by identity once the label is already current, so an already
// migrated row is never planned; the census still prints, the manifest is
// written with zero rows, and the post-condition verifies zero rows. Revert is
// idempotent the same way — it only restores rows that still hold exactly what
// the migration wrote, so a second revert matches nothing and reports it.
//
//   DATABASE_URL  required (env, or .dev.vars for local use)
//   APPLY=1       write. Anything else is a DRY RUN.
//   CONFIRM       required when APPLY=1: the exact phrase below. A dry run
//                 ignores it.
//   MODE          relabel (default) | revert
//   MANIFEST      manifest path (default out/relabel-provenance-notes.json)
//   COMPANY       optional company_id filter; default every company
//   SAMPLE        how many before/after pairs to print (default 10)
// ----------------------------------------------------------------------------
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import postgres from "postgres";
import {
  PROVENANCE_NOTE_LABELS,
  parseProvenanceNote,
  provenanceNoteLabel,
  provenanceNoteSqlPattern,
  relabelProvenanceNote,
} from "./lib/transfer-vocabulary.mjs";

const APPLY = process.env.APPLY === "1";
const MODE = (process.env.MODE || "relabel").trim().toLowerCase();
const MANIFEST = process.env.MANIFEST || "out/relabel-provenance-notes.json";
const SAMPLE = Number(process.env.SAMPLE || 10);
const COMPANY = process.env.COMPANY ? Number(process.env.COMPANY) : null;

if (!["relabel", "revert"].includes(MODE)) {
  console.error(`MODE must be relabel | revert (got "${MODE}")`);
  process.exit(2);
}
if (COMPANY !== null && !Number.isInteger(COMPANY)) {
  console.error(`COMPANY must be an integer company_id (got "${process.env.COMPANY}")`);
  process.exit(2);
}

/* A phrase that has to be TYPED, on the run that writes. APPLY=1 is one
   character away from a dry run and lives in a dispatch form's default; this
   does not. A dry run ignores it entirely, so the review pass stays one click. */
const CONFIRM_PHRASE = "relabel provenance notes";
if (APPLY && (process.env.CONFIRM ?? "").trim() !== CONFIRM_PHRASE) {
  console.error(
    `APPLY=1 needs CONFIRM="${CONFIRM_PHRASE}" — this rewrites stored provenance on every matching purchase order. Refusing.`,
  );
  process.exit(2);
}

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
  // Never echo the value — not here, not in an error, not in the manifest.
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : `WARN ${m}`);
const fail = (m) => console.error(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

/** The label a stored note actually carries, for the per-form census. */
const labelOf = (note) => {
  const trimmed = String(note ?? "").trim();
  for (const label of PROVENANCE_NOTE_LABELS) {
    const re = new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "im");
    if (re.test(trimmed)) return label;
  }
  // Matched the SQL filter but carries no label at the start of a line — free
  // text that merely mentions the words. Named, not silently bucketed.
  return "(no line-anchored label)";
};

const sameSet = (a, b) => {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
};

const writeManifest = (rows) => {
  mkdirSync(dirname(MANIFEST), { recursive: true });
  writeFileSync(
    MANIFEST,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        mode: MODE,
        applied: APPLY,
        current_label: provenanceNoteLabel("so"),
        // The exact bytes of every row this run planned. This IS the rollback.
        rows,
      },
      null,
      2,
    ),
  );
  log(`manifest: ${rows.length} row(s) -> ${MANIFEST}`);
};

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
let exitCode = 0;

try {
  log(`=== relabel-provenance-notes  mode=${MODE}  ${APPLY ? "APPLY" : "DRY-RUN"} ===`);
  log(`current label: "${provenanceNoteLabel("so")}"`);
  log(`accepted labels: ${PROVENANCE_NOTE_LABELS.map((l) => `"${l}"`).join(", ")}`);

  // ── REVERT ────────────────────────────────────────────────────────────────
  if (MODE === "revert") {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    const rows = manifest.rows ?? [];
    log(`manifest ${MANIFEST}: ${rows.length} row(s), written ${manifest.generated_at}`);
    if (rows.length === 0) {
      log("nothing to revert.");
    } else {
      let restored = 0;
      let skipped = 0;
      for (const r of rows) {
        if (!APPLY) continue;
        // Only where the row still holds exactly what we wrote. A note edited
        // by a human since the migration is NOT ours to overwrite.
        const res = await pg`
          UPDATE scm.purchase_orders
             SET notes = ${r.before}
           WHERE id = ${r.id}
             AND notes = ${r.after}`;
        if (res.count === 1) restored += 1;
        else {
          skipped += 1;
          warn(`${r.po_number}: note no longer matches what this run wrote — left as-is.`);
        }
      }
      if (APPLY) log(`reverted ${restored} row(s); ${skipped} left alone.`);
      else log(`DRY-RUN: would attempt ${rows.length} restore(s). Re-run with APPLY=1.`);
    }
    await pg.end();
    process.exit(0);
  }

  // ── 1. COUNT FIRST — the blast radius, by exact form, per company ─────────
  const pattern = provenanceNoteSqlPattern();
  const all = COMPANY === null
    ? await pg`
        SELECT id, po_number, company_id, notes
          FROM scm.purchase_orders
         WHERE notes IS NOT NULL AND notes ~* ${pattern}
         ORDER BY company_id, po_number`
    : await pg`
        SELECT id, po_number, company_id, notes
          FROM scm.purchase_orders
         WHERE notes IS NOT NULL AND notes ~* ${pattern}
           AND company_id = ${COMPANY}
         ORDER BY po_number`;

  log("");
  log(`=== census — POs carrying a provenance note: ${all.length} ===`);
  const census = new Map();
  for (const r of all) {
    // JSON key, not a delimiter-joined string: a label legitimately contains
    // spaces ("Transfer from Sales Order"), so any separator you can type is
    // one a label could also contain.
    const key = JSON.stringify([Number(r.company_id), labelOf(r.notes)]);
    census.set(key, (census.get(key) ?? 0) + 1);
  }
  if (census.size === 0) log("  (none)");
  for (const [key, n] of [...census.entries()].sort()) {
    const [company, label] = JSON.parse(key);
    log(`  company ${company}  "${label}:"  ${n}`);
  }

  // ── 2. PLAN, and REFUSE any row that would change its own meaning ─────────
  const plan = [];
  const refused = [];
  const alreadyCurrent = [];
  const notProvenance = [];
  for (const r of all) {
    const before = r.notes;
    const setBefore = parseProvenanceNote(before);
    if (setBefore.length === 0) {
      // The SQL filter is a deliberate SUPERSET — it has no line anchor, so it
      // also selects notes that merely CONTAIN the words ("See remarks.
      // From SOs: ..."). Those are free text, not a provenance record, and this
      // migration has no business rewriting a human's sentence.
      notProvenance.push(r);
      continue;
    }
    const after = relabelProvenanceNote(before);
    if (after === before) {
      // Identity: already on the current label. Not planned — this is what
      // makes a second run a no-op.
      alreadyCurrent.push(r);
      continue;
    }
    const setAfter = parseProvenanceNote(after);
    if (!sameSet(setBefore, setAfter)) {
      refused.push({ po_number: r.po_number, company_id: r.company_id, setBefore, setAfter });
      continue;
    }
    plan.push({
      id: r.id,
      po_number: r.po_number,
      company_id: Number(r.company_id),
      before,
      after,
      doc_nos: setBefore,
    });
  }

  log("");
  log(`already on the current label   : ${alreadyCurrent.length}`);
  log(`free text, NOT provenance      : ${notProvenance.length}  (matched the SQL filter, left alone)`);
  log(`planned for relabel            : ${plan.length}`);
  log(`REFUSED (meaning would change) : ${refused.length}`);
  for (const r of refused) {
    fail(
      `${r.po_number} (company ${r.company_id}) REFUSED: [${r.setBefore.join(", ")}] -> [${r.setAfter.join(", ")}]`,
    );
    exitCode = 1;
  }

  // ── 3. The manifest, ALWAYS — a dry run's manifest is the review copy ─────
  writeManifest(plan);

  // ── 4. Sample before/after ───────────────────────────────────────────────
  if (plan.length > 0) {
    log("");
    log(`=== sample (first ${Math.min(SAMPLE, plan.length)} of ${plan.length}) ===`);
    for (const p of plan.slice(0, SAMPLE)) {
      log(`  ${p.po_number} (company ${p.company_id})`);
      log(`    before: ${JSON.stringify(p.before)}`);
      log(`    after : ${JSON.stringify(p.after)}`);
    }
  }

  if (exitCode !== 0) {
    fail("refusals above — nothing written. Fix the data, then re-run.");
    await pg.end();
    process.exit(exitCode);
  }

  if (!APPLY) {
    log("");
    log(`DRY-RUN: ${plan.length} row(s) would be relabelled. Nothing written.`);
    log("Review the manifest artifact, then re-run with apply=1.");
    await pg.end();
    process.exit(0);
  }

  // ── 5. WRITE, one row at a time, optimistic on the exact prior value ─────
  log("");
  log(`=== APPLY — writing ${plan.length} row(s) ===`);
  let written = 0;
  const stale = [];
  for (const p of plan) {
    const res = await pg`
      UPDATE scm.purchase_orders
         SET notes = ${p.after}
       WHERE id = ${p.id}
         AND notes = ${p.before}`;
    if (res.count === 1) written += 1;
    else stale.push(p);
  }
  log(`wrote ${written} row(s).`);
  for (const p of stale) {
    warn(`${p.po_number}: note changed since the plan was built — skipped. Re-run.`);
  }

  // ── 6. POST-CONDITION — re-READ and re-PARSE. Not eyeballed, not trusted ──
  //
  // The plan proved the invariant against the string it computed. This proves
  // it against the bytes the DATABASE now holds, which is a different claim and
  // the only one that matters. Every touched row must parse to the SAME set of
  // doc numbers it parsed to before.
  log("");
  log("=== post-condition — re-reading every touched row on a FRESH connection ===");
  const touched = plan.filter((p) => !stale.includes(p));
  const ids = touched.map((p) => p.id);
  let verified = 0;
  const violations = [];
  // A SECOND client, opened after the write. The session that did the writing is
  // the worst possible witness that the writing landed — it can be inside an
  // open transaction, or reading its own uncommitted view. This one sees only
  // what is actually committed and visible to the application.
  const verifyPg = postgres(url, { ssl: "require", prepare: false, max: 1 });
  try {
    if (ids.length > 0) {
      const back = await verifyPg`
        SELECT id, po_number, notes FROM scm.purchase_orders WHERE id = ANY(${ids})`;
      const nowById = new Map(back.map((r) => [String(r.id), r]));
      for (const p of touched) {
        const row = nowById.get(String(p.id));
        if (!row) {
          violations.push(`${p.po_number}: row disappeared between write and verify`);
          continue;
        }
        // THE SHAPE, not a count: what the value now IS. A row count would have
        // said "7 of 7" while all 7 were re-corrupted.
        const nowSet = parseProvenanceNote(row.notes);
        if (!sameSet(nowSet, p.doc_nos)) {
          violations.push(
            `${p.po_number}: doc numbers CHANGED [${p.doc_nos.join(", ")}] -> [${nowSet.join(", ")}]`,
          );
          continue;
        }
        if (row.notes !== p.after) {
          violations.push(`${p.po_number}: stored bytes are not what was written`);
          continue;
        }
        verified += 1;
      }
    }
  } finally {
    await verifyPg.end({ timeout: 5 });
  }
  log(`verified ${verified} of ${touched.length} touched row(s): same doc numbers, new wording.`);
  for (const v of violations) {
    fail(v);
    exitCode = 1;
  }
  if (violations.length > 0) {
    fail(`INVARIANT BROKEN on ${violations.length} row(s). Revert with the manifest artifact:`);
    fail(`  MODE=revert MANIFEST=${MANIFEST} APPLY=1 node scripts/relabel-provenance-notes.mjs`);
  }

  // A last independent check: nothing anywhere still carries a legacy label
  // within the scope this run covered.
  const leftover = COMPANY === null
    ? await pg`
        SELECT count(*)::int AS n FROM scm.purchase_orders
         WHERE notes IS NOT NULL AND notes ~* ${pattern}
           AND notes !~* ${`^\\s*${provenanceNoteLabel("so")}:`}`
    : await pg`
        SELECT count(*)::int AS n FROM scm.purchase_orders
         WHERE notes IS NOT NULL AND notes ~* ${pattern}
           AND notes !~* ${`^\\s*${provenanceNoteLabel("so")}:`}
           AND company_id = ${COMPANY}`;
  log(`notes still not on the current label (mid-line labels included): ${leftover[0].n}`);
} catch (err) {
  fail(String(err?.stack ?? err));
  exitCode = 1;
} finally {
  await pg.end({ timeout: 5 });
}

process.exit(exitCode);
