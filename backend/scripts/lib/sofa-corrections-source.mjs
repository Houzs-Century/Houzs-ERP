/**
 * WHICH FILES HOLD THE OWNER-APPROVED SOFA BUILDS, AND HOW THEY ARE READ.
 *
 * There is more than one file now. `sofa-compartment-corrections-2026-08.json`
 * is the record of the cutover round and is STILL the source for the builds
 * already written — re-running must be inert on them, which it can only be if
 * the file is still loaded. The 2026-09 round is a SECOND file next to it, not
 * a replacement, so that a build stays where its evidence and its `why` were
 * written.
 *
 * ── THE TWO FILES DO NOT NAME THEIR ARRAY THE SAME ──────────────────────────
 * 2026-08 calls it `corrections`; 2026-09 calls it `entries`. That difference
 * is REAL and was measured, not assumed — the 2026-09 file arrived already
 * approved with `entries`, and editing owner-approved data to fit a loader is
 * exactly the wrong direction. So the loader reads either name and nothing
 * downstream has to care.
 *
 * A file may also carry `_held`: builds deliberately NOT applied, each with the
 * reason. Those are merged too, because the operator's log prints them and a
 * held build that stops being printed reads as a build that was done.
 *
 * Zero dependencies beyond node:fs — `node --test scripts/lib/*.test.mjs` runs
 * its test on a bare checkout, which is what the working-agreement workflow
 * does.
 */
import fs from "node:fs";
import path from "node:path";

/** The files, oldest first. Order is the order the operator sees them applied.
 *
 * ── WHY THE THIRD AND FOURTH FILES ARE NOT DATED ────────────────────────────
 * `FILE=` is a SUBSTRING filter, so a file called `...-2026-09-08.json` would
 * make `FILE=2026-09` select TWO rounds at once — which is why HC-SO-013475
 * went into the 2026-09 file rather than a file of its own, and the test below
 * pins that. These two are named by their SOURCE instead, which is the thing an
 * operator actually needs to choose between:
 *
 *   `-book-aligned`   the ACCOUNT BOOK's own decoded text. No drawing was read.
 *                     `FILE=book` plans that round alone.
 *   `-drawings`       builds read off the ORDER SLIP's drawing. `FILE=drawings`.
 *
 * The distinction is not cosmetic. `lib/sofa-rulings.mjs` feeds every build in
 * these files to the reconcile as `deps.sofaRuling`, and a RULED verdict means
 * "the ERP differs from the book BY THE OWNER'S DECISION". A book-aligned build
 * can never produce one — its target IS the book, so the multiset agrees and
 * the ruling is never reached — but the `why` on every entry says which it is
 * anyway, because the next person to read a build's provenance should not have
 * to re-derive it from the verdict it happens to produce.
 */
export const CORRECTION_FILES = [
  "sofa-compartment-corrections-2026-08.json",
  "sofa-compartment-corrections-2026-09.json",
  "sofa-compartment-corrections-book-aligned.json",
  "sofa-compartment-corrections-drawings.json",
  "sofa-compartment-corrections-purchase-side.json",
  /* The 2026-09-10 direction round. Named by its SOURCE, not by a date, for the
     same reason the two above are: `FILE=` is a SUBSTRING filter and a dated
     name would make `FILE=2026-09` select two rounds at once. */
  "sofa-compartment-corrections-tv-direction.json",
];

/**
 * The builds a single already-parsed file carries, each tagged with the file it
 * came from so a log line can say which round a build belongs to.
 *
 * @param {any} doc the parsed JSON
 * @param {string} source the file's basename
 * @returns {{ builds: any[], held: any[] }}
 */
export function readCorrectionsDoc(doc, source) {
  const pick = (...names) => {
    for (const n of names) if (Array.isArray(doc?.[n])) return doc[n];
    return [];
  };
  /* `corrections` (2026-08) or `entries` (2026-09). Both, if a future file
     carries both — concatenated, never one silently winning. */
  const builds = [...pick("corrections"), ...pick("entries")].map((c) => ({ ...c, source }));
  const held = pick("_held").map((h) => ({ ...h, source }));
  return { builds, held };
}

/**
 * Load every corrections file from a directory.
 *
 * @param {string} dir the `scripts/data` directory
 * @param {string} [only] substring: load only files whose name contains it
 *   (e.g. "2026-09" to plan one round without replanning the other)
 * @returns {{ builds: any[], held: any[], files: string[] }}
 */
export function loadCorrections(dir, only = "") {
  const files = CORRECTION_FILES.filter((f) => !only || f.includes(only));
  const builds = [], held = [], loaded = [];
  for (const f of files) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    const doc = JSON.parse(fs.readFileSync(p, "utf8"));
    const got = readCorrectionsDoc(doc, f);
    builds.push(...got.builds);
    held.push(...got.held);
    loaded.push(`${f} (${got.builds.length} builds${got.held.length ? `, ${got.held.length} held` : ""})`);
  }
  return { builds, held, files: loaded };
}
