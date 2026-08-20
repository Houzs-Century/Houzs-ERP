// ----------------------------------------------------------------------------
// coverage-verdict — the coverage ratchet's PURE logic: merge istanbul reports,
// summarise per area, and decide pass/fail against the committed floors.
//
// No filesystem, no process, no argv — so `node --test scripts/check-coverage-verdict.mjs`
// can prove every branch, including the ones that only fire when the gate is
// pointed at a moved directory. A gate nobody has seen fail is a gate nobody
// knows works.
//
// NO DEPENDENCIES, on purpose (same rule as frontend/scripts/lib/bundle-verdict.mjs):
// `npm install` in a worktree destroys the main checkout's node_modules, so a
// checker that needs one is a checker nobody runs.
// ----------------------------------------------------------------------------

/** Reasons a run is REJECTED before any percentage is even compared. */
export const FATAL = {
  NO_REPORTS: 'no_reports',
  /* The gate has no FLOORS. Distinct from NO_REPORTS, which is having no
     measurement: this is having a measurement and nothing to hold it to, and it
     used to be an empty-object fallback that passed everything. */
  NO_BASELINE: 'no_baseline',
  EMPTY_AREA: 'empty_area',
  MISSING_FILES: 'missing_files',
  SHAPE_MISMATCH: 'shape_mismatch',
  UNKNOWN_AREA: 'unknown_area',
};

export const VERDICT = { PASS: 'pass', FAIL: 'fail' };

/**
 * Merge N istanbul-format coverage maps into one.
 *
 * CI shards the backend suite across four runners, so the same file is reported
 * four times with four different hit vectors and the union is the only honest
 * number. Hits are summed per statement.
 *
 * A file whose statementMap differs between two reports means the reports came
 * from DIFFERENT TREES (one shard checked out a stale commit, or a stale report
 * was left in the artifact directory). Averaging those would invent a number,
 * so it throws.
 */
export function mergeCoverage(maps) {
  const out = Object.create(null);
  for (const map of maps) {
    for (const [file, cov] of Object.entries(map ?? {})) {
      const prev = out[file];
      if (!prev) {
        out[file] = { statementMap: cov.statementMap ?? {}, s: { ...(cov.s ?? {}) } };
        continue;
      }
      const a = Object.keys(prev.statementMap).length;
      const b = Object.keys(cov.statementMap ?? {}).length;
      if (a !== b) {
        const err = new Error(
          `coverage reports disagree about ${file}: ${a} statements vs ${b}. ` +
            `These reports were produced from different trees — re-run them against one commit.`,
        );
        err.code = FATAL.SHAPE_MISMATCH;
        throw err;
      }
      for (const [k, n] of Object.entries(cov.s ?? {})) {
        prev.s[k] = (prev.s[k] ?? 0) + (n ?? 0);
      }
    }
  }
  return out;
}

/**
 * Line coverage for one file, computed exactly as istanbul-lib-coverage's
 * FileCoverage.getLineCoverage does: a line's hit count is the MAX over the
 * statements that start on it. Reimplemented rather than imported so the gate
 * keeps its zero-dependency rule — and so the number it prints is the same one
 * vitest's own text-summary prints, which is what makes the two cross-checkable.
 */
export function lineCoverageOf(cov) {
  const lines = new Map();
  for (const [id, st] of Object.entries(cov.statementMap ?? {})) {
    const line = st?.start?.line;
    if (typeof line !== 'number') continue;
    const hits = cov.s?.[id] ?? 0;
    const prev = lines.get(line);
    if (prev === undefined || prev < hits) lines.set(line, hits);
  }
  let covered = 0;
  for (const hits of lines.values()) if (hits > 0) covered += 1;
  return { total: lines.size, covered };
}

/** covered/total as a percentage, rounded to 2dp. An area with no lines is 100%
 *  by convention — but `summarise` rejects an EMPTY area before this is reached,
 *  so the convention never silently passes a scan that found nothing. */
export function pct(covered, total) {
  if (total === 0) return 100;
  return Math.round((covered / total) * 10000) / 100;
}

/**
 * Per-area summary from a merged coverage map.
 *
 * @param merged      merged istanbul map, keyed by REPO-RELATIVE path
 * @param areas       [{ id, ... }]
 * @param areaOf      (rel) => area | null
 * @param onDisk      { [areaId]: string[] } — the source files that actually exist
 * @param knownAbsent string[] — files legitimately not instrumentable, from the baseline
 */
export function summarise(merged, areas, areaOf, onDisk, knownAbsent = []) {
  const absentOk = new Set(knownAbsent);
  const byArea = new Map(areas.map((a) => [a.id, { id: a.id, files: [], lines: { total: 0, covered: 0 } }]));
  const unratcheted = { id: '(unratcheted)', files: [], lines: { total: 0, covered: 0 } };

  for (const [rel, cov] of Object.entries(merged)) {
    const area = areaOf(rel);
    const bucket = area ? byArea.get(area.id) : unratcheted;
    if (!bucket) continue;
    const { total, covered } = lineCoverageOf(cov);
    bucket.files.push({ file: rel, total, covered });
    bucket.lines.total += total;
    bucket.lines.covered += covered;
  }

  const fatal = [];
  const summary = [];
  for (const area of areas) {
    const b = byArea.get(area.id);
    const reported = new Set(b.files.map((f) => f.file));

    // A scan that found NOTHING must be an error, never a silent 100%. This is
    // what a moved directory, a renamed area id, or a coverage.include that
    // stopped matching looks like from here.
    if (b.files.length === 0) {
      fatal.push({
        code: FATAL.EMPTY_AREA,
        area: area.id,
        message: `area "${area.id}" matched ZERO files in the coverage report — the directory moved, or coverage.include no longer covers it. Refusing to report a percentage for an empty scan.`,
      });
    }

    // Every file that exists on disk must appear in the report. Without this,
    // turning `coverage.all` off shrinks the denominator and the percentage
    // JUMPS — a false green that looks like progress.
    const missing = (onDisk[area.id] ?? []).filter((f) => !reported.has(f) && !absentOk.has(f));
    if (missing.length) {
      fatal.push({
        code: FATAL.MISSING_FILES,
        area: area.id,
        message:
          `${missing.length} source file(s) in "${area.id}" exist on disk but are absent from the coverage report — ` +
          `the denominator is short, so the percentage is too high. First few: ${missing.slice(0, 5).join(', ')}`,
        files: missing,
      });
    }

    summary.push({
      id: area.id,
      ratchetNoTest: area.ratchetNoTest !== false,
      lines: b.lines,
      pct: pct(b.lines.covered, b.lines.total),
      files: b.files.length,
      zeroCoverageFiles: b.files.filter((f) => f.total > 0 && f.covered === 0).length,
    });
  }

  return {
    areas: summary,
    unratcheted: {
      id: unratcheted.id,
      lines: unratcheted.lines,
      pct: pct(unratcheted.lines.covered, unratcheted.lines.total),
      files: unratcheted.files.length,
      zeroCoverageFiles: unratcheted.files.filter((f) => f.total > 0 && f.covered === 0).length,
    },
    detail: byArea,
    fatal,
  };
}

/**
 * The ratchet itself. Two floors per area, both one-directional:
 *
 *   · lines.pct           may only go UP   — the percentage
 *   · zeroCoverageFiles   may only go DOWN — files with NO test executing them
 *
 * The second one exists because the first one cannot see the shape that hurts.
 * Adding a 400-line untested money module to a 291k-line area moves the
 * percentage by 0.1 and would sail through a percentage-only gate; it moves the
 * zero-coverage count by exactly 1, which is the number that matters.
 */
export function evaluate(summary, baseline) {
  const results = [];
  for (const area of summary.areas) {
    const floor = baseline.areas?.[area.id];
    if (!floor) {
      results.push({
        area: area.id,
        verdict: VERDICT.FAIL,
        reason: 'no_baseline',
        message: `area "${area.id}" has no entry in the baseline — add one with --update before enforcing it.`,
      });
      continue;
    }
    const failures = [];
    if (area.pct < floor.pct) {
      failures.push(
        `line coverage fell to ${area.pct.toFixed(2)}% from a floor of ${floor.pct.toFixed(2)}% ` +
          `(${area.lines.covered}/${area.lines.total} lines). Coverage in an area may only go up.`,
      );
    }
    if (area.ratchetNoTest !== false && area.zeroCoverageFiles > floor.zeroCoverageFiles) {
      failures.push(
        `${area.zeroCoverageFiles} files have NO test executing them, up from ${floor.zeroCoverageFiles}. ` +
          `A new file with no test at all is the shape that hurts, whatever it does to the percentage.`,
      );
    }
    results.push({
      area: area.id,
      verdict: failures.length ? VERDICT.FAIL : VERDICT.PASS,
      pct: area.pct,
      floorPct: floor.pct,
      zeroCoverageFiles: area.zeroCoverageFiles,
      floorZero: floor.zeroCoverageFiles,
      failures,
    });
  }
  const ok = summary.fatal.length === 0 && results.every((r) => r.verdict === VERDICT.PASS);
  return { ok, results, fatal: summary.fatal };
}

/**
 * The floor written for a measured percentage: a tenth of a point BELOW it.
 *
 * Not slack for the author — slack for the MERGE BASE. On a `pull_request`
 * GitHub builds the merge with main, so a PR inherits whatever main's coverage
 * currently is; a floor pinned to the exact measurement fails whichever PR
 * happens to run after someone else merges a few uncovered lines. This repo has
 * already paid for that lesson once on the bundle-size gate, where a DOCS-ONLY
 * PR failed by 0.1 KB (ci.yml, "Measure the merge base"). It was observed here
 * too, on this feature's own first CI run: main landed one more untested ops
 * script between the measurement and the run.
 *
 * Subtracting rather than rounding down, because rounding leaves NO slack at all
 * when the measurement already sits on a tenth — `backend/scripts` measured
 * exactly 4.20% and got a 4.20% floor, which is the failure above.
 *
 * The cost is bounded and the second floor covers it: 0.1pp is ~60 lines in
 * frontend/src and ~3 in scm/shared, and anything file-shaped — the case that
 * actually matters — trips `zeroCoverageFiles`, which carries NO tolerance in
 * the areas where it means anything.
 *
 * A fully covered area is the one exception: 100% floors at 100%, with no slack
 * at all. Handing back a line of a complete area is a regression worth failing
 * on, and there is no merge-base drift to absorb once every line is covered.
 */
export const floorFor = (measured) =>
  (measured >= 100 ? 100 : Math.max(0, Math.round((measured - 0.1) * 100) / 100));

/**
 * New baseline from a measured summary. Floors only ever RISE unless the caller
 * explicitly allows a drop — a re-baseline that quietly lowers the bar is how a
 * ratchet becomes a rubber stamp.
 */

export function nextBaseline(summary, baseline, { allowDrop = false } = {}) {
  /* Start from what is already committed and overwrite only the areas this run
     MEASURED. A re-baseline scoped to one area (--only) must not delete the
     floors of the areas it did not look at — that would silently un-ratchet
     everything else. */
  const areas = { ...(baseline.areas ?? {}) };
  const drops = [];
  for (const area of summary.areas) {
    const prev = baseline.areas?.[area.id];
    let nextPct = floorFor(area.pct);
    let nextZero = area.zeroCoverageFiles;
    if (prev) {
      if (nextPct < prev.pct) {
        drops.push(`${area.id}: floor ${prev.pct.toFixed(2)}% -> ${nextPct.toFixed(2)}%`);
        if (!allowDrop) nextPct = prev.pct;
      }
      if (area.zeroCoverageFiles > prev.zeroCoverageFiles) {
        drops.push(`${area.id}: ${prev.zeroCoverageFiles} -> ${area.zeroCoverageFiles} zero-coverage files`);
        if (!allowDrop) nextZero = prev.zeroCoverageFiles;
      }
    }
    areas[area.id] = {
      pct: nextPct,
      zeroCoverageFiles: nextZero,
      lines: { ...area.lines },
      files: area.files,
    };
  }
  return { baseline: { ...baseline, areas }, drops };
}

export const DOC_START = '<!-- MEASURED-TABLE -->';
export const DOC_END = '<!-- /MEASURED-TABLE -->';

/**
 * The markdown table that goes in docs/TESTING-RATCHET.md, rendered from the
 * COMMITTED baseline rather than from a live run — so syncing and checking the
 * doc costs nothing and needs no coverage report.
 *
 * This repo's own rule (docs/KNOWLEDGE-SYSTEM.md §3): a number must be
 * generated, never typed. CLAUDE.md described the database as D1 SQLite for a
 * month after the Postgres cutover because that one was typed.
 */
export function renderDocTable(baseline) {
  const rows = Object.entries(baseline.areas ?? {}).map(([id, a]) => {
    const lines = a.lines ?? { covered: 0, total: 0 };
    // MEASURED and FLOOR are different numbers on purpose — the floor is the
    // measurement rounded down to a tenth (see floorFor). Printing only one of
    // them is how a reader concludes the gate is stricter, or looser, than it is.
    const measured = pct(lines.covered, lines.total);
    return `| \`${id}\` | ${a.files ?? '?'} | ${lines.total} | ${lines.covered} | **${measured.toFixed(2)}%** | ${a.pct.toFixed(2)}% | ${a.zeroCoverageFiles} |`;
  });
  return [
    `| area | files | lines | covered | measured | floor | files with NO test |`,
    `|---|---:|---:|---:|---:|---:|---:|`,
    ...rows,
    '',
    `Floors as committed in \`coverage-baseline.json\`${baseline.measuredAt ? `, measured ${baseline.measuredAt}` : ''}.`,
  ].join('\n');
}

/** Splice a freshly rendered table between the markers. Throws if the markers
 *  are gone — a sync that silently wrote nothing is the stale-doc failure. */
export function spliceDocTable(markdown, table) {
  const a = markdown.indexOf(DOC_START);
  const b = markdown.indexOf(DOC_END);
  if (a < 0 || b < 0 || b < a) {
    throw new Error(`the ${DOC_START} / ${DOC_END} markers are missing from the doc — nothing to sync into.`);
  }
  return `${markdown.slice(0, a + DOC_START.length)}\n${table}\n${markdown.slice(b)}`;
}

/** One aligned row per area, for a CI log a human will actually read. */
export function formatTable(summary, baseline) {
  const rows = [
    ['area', 'lines', 'covered', 'pct', 'floor', 'files', 'no-test', 'floor'],
    ...summary.areas.map((a) => {
      const f = baseline?.areas?.[a.id];
      return [
        a.id,
        String(a.lines.total),
        String(a.lines.covered),
        `${a.pct.toFixed(2)}%`,
        f ? `${f.pct.toFixed(2)}%` : '-',
        String(a.files),
        String(a.zeroCoverageFiles),
        f ? String(f.zeroCoverageFiles) : '-',
      ];
    }),
  ];
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows
    .map((r, ri) => {
      const line = r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ');
      return ri === 0 ? `${line}\n${w.map((n) => '-'.repeat(n)).join('  ')}` : line;
    })
    .join('\n');
}
