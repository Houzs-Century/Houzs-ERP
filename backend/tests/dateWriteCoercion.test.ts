/* THE GATE for the blank-date class.
 *
 * The first version of this branch shipped a gate that asserted a REGEX knows
 * the word "date". It passed, green, on a clean origin/main with zero route
 * fixes — so it could not and did not catch five real unfixed sites in the very
 * files the branch had opened. A gate that passes on unpatched main is not a
 * gate.
 *
 * This one asserts the thing the task is actually about: no request-supplied
 * value reaches a DATE / TIMESTAMPTZ column without passing through the shared
 * coercion. It reads the whole of backend/src with the TypeScript parser and
 * reports every site that does; the scanner and its judging rules are in
 * tests/lib/date-write-scan.ts. There is NO allowlist — a finding is answered by
 * coercing the write, never by adding a line here.
 *
 * The production failure it exists for, 2026-08-17:
 *   PATCH /api/scm/mfg-purchase-orders/<id> with supplierDeliveryDate2/3/4 = ""
 *   → 500 `invalid input syntax for type date: ""`, and the WHOLE save lost.
 * An unfilled <input type="date"> posts `""`; `??` is nullish and passes it
 * straight through.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanFile, scanTree, listSourceFiles } from './lib/date-write-scan';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../src');

describe('no request value reaches a date column uncoerced', () => {
  /* A verdict computed over nothing must never read as a pass (CLAUDE.md).
     If the walker stops finding files, or the judging rules stop recognising
     the bug, this fails BEFORE the real assertion can go green. */
  it('the corpus and the detector are both alive', () => {
    expect(listSourceFiles(SRC).length).toBeGreaterThan(200);

    const probe = path.join(here, 'fixtures', 'date-write-probe.ts');
    const hits = scanFile(probe, 'date-write-probe.ts');
    const columns = hits.map((h) => `${h.kind}:${h.column}`).sort();
    /* Each of these is one real shape from this codebase; the SAFE half of the
       fixture must produce nothing. If the detector regresses in either
       direction this list stops matching. */
    expect(columns).toEqual([
      'write:amend_date_from_customer',
      'write:new_delivery_date',
      'write:paid_at',
      'write:supplier_delivery_date_2',
      'write:trip_date',
      'write:voucher_date',
      /* the three shapes a rewrite of the derivation pass LOST or never had.
         `for (const l of body.lines)` bound the head twice and the derived
         binding lost the tie; the destructured head beside it kept working,
         which is what made the hole read as covered. `.push()` builds the row
         array by mutation, so the declaration holds no columns. */
      'write:line_delivery_date',
      'write:due_date',
      'write:ship_date',
      'write:expected_delivery_date',
      'payload:updates',
    ].sort());
  });

  it('finds no uncoerced date write anywhere in backend/src', () => {
    const findings = scanTree(SRC);
    const report = findings.map((f) => `${f.file}:${f.line}  ${f.column}  ${f.text}`);
    /* Fix by coercing the write — `dateOrNull(x)` for a nullable column,
       `dateOrNull(x) ?? todayMyt()` where the column is NOT NULL and today is
       the document default, `coerceEmptyDates(payload)` for a field-map loop.
       Never by relaxing this assertion. */
    expect(report).toEqual([]);
    /* An EXPLICIT budget, not the default 5000ms, and not because anything here
       hangs: this is one bounded single-threaded pass over every .ts under
       backend/src (~480 files, ~1.0s alone after the cheap pre-filter in
       date-write-scan.ts). It runs beside 340 other suites competing for the
       same cores, and a CPU-bound job measured against a 5s budget is exactly
       the flake that made this branch's first regression test pass alone and
       fail in the full run. If this ever DOES take a minute, the scan has a real
       problem and should be read, not re-budgeted. */
  }, 60_000);
});
