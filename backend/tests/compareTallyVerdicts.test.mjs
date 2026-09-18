import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/* scripts/compare-tally-verdicts.mjs is what proves a reader change did not
 * quietly break a tally, so the two sentences it exists to say are pinned here.
 * It is SPAWNED rather than imported: it is a script that prints at module
 * scope, and testing what it actually prints is the point.
 *
 * No database and no network — the verdict payloads are built here, in the same
 * shape lib/ac-verdict-emit.mjs writes.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '../scripts/compare-tally-verdicts.mjs');

const row = (n, axes) => ({
  ac_doc_no: n, erp_no: n, clean: axes.length === 0,
  axes, axes_proceeded: axes, notes: {},
});
const payload = (type, work, cannot, ident, compared) => ({
  version: 1, type, company_id: 1,
  measured_at: new Date().toISOString(), run_id: 'test',
  snapshot_exported_at: '2026-09-09T00:18:49.235Z', source: 'local',
  summary: {},
  population: { documents: compared, compared },
  presence: { absent: [], phantom: [], decided: [] },
  rows: [
    /* a LOCKING axis -> work; an UNANSWERABLE axis -> cannot compare; none -> identical */
    ...Array.from({ length: work }, (_, i) => row(`${type}-W${i}`, ['colour / fabric'])),
    ...Array.from({ length: cannot }, (_, i) => row(`${type}-U${i}`, ['sofa build not verifiable'])),
    ...Array.from({ length: ident }, (_, i) => row(`${type}-I${i}`, [])),
  ],
});

function run(sides, types) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-tally-'));
  const before = path.join(dir, 'before');
  const after = path.join(dir, 'after');
  fs.mkdirSync(before); fs.mkdirSync(after);
  for (const [type, b, a] of sides) {
    fs.writeFileSync(path.join(before, `${type}-verdict.json`), JSON.stringify(payload(type, ...b)));
    fs.writeFileSync(path.join(after, `${type}-verdict.json`), JSON.stringify(payload(type, ...a)));
  }
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: path.resolve(HERE, '..'), encoding: 'utf8',
    env: { ...process.env, BEFORE_DIR: before, AFTER_DIR: after, TYPES: types },
  });
  return { out: r.stdout || '', err: r.stderr || '', status: r.status };
}

describe('compare-tally-verdicts: the two sentences it exists to say', () => {
  /* A NUMBER THAT GOES UP IS A LEGITIMATE RESULT and must be stated, not
     hidden. This is the shape docs/bugs/0745 produced: the reader now reads the
     book correctly and surfaces disagreements that were never compared. */
  test('a differ that ROSE is printed as a legitimate result, in words', () => {
    const { out, status } = run([['SO', [11, 30, 100, 141], [13, 30, 98, 141]]], 'SO');
    expect(status).toBe(0);
    expect(out).toMatch(/differ ROSE by 2/);
    expect(out).toMatch(/legitimate result if the reader now reads the book correctly/);
  });

  /* THE TRAP. A `differ` that fell because a comparison stopped happening is
     not a fix, and a table that prints only `differ` cannot tell the two
     apart. `compared` is printed beside it for exactly this. */
  test('a differ that fell WHILE fewer documents were compared is called out, not celebrated', () => {
    const { out, status } = run([['PO', [5, 6, 50, 61], [3, 6, 50, 59]]], 'PO');
    expect(status).toBe(0);
    expect(out).toMatch(/the number of documents COMPARED moved by -2/);
    expect(out).toMatch(/That is not a fix — prove the difference/);
    /* and it must NOT read as a win */
    expect(out).not.toMatch(/differ ROSE/);
  });

  test('an unchanged type says so rather than leaving the reader to subtract', () => {
    const { out } = run([['GR', [10, 6, 20, 36], [10, 6, 20, 36]]], 'GR');
    expect(out).toMatch(/GOODS RECEIPTS: unchanged\./);
  });

  /* A verdict computed over nothing must never read as a pass. */
  test('a missing side REFUSES rather than printing a comparison', () => {
    const { err, status } = run([['SO', [1, 0, 1, 2], [1, 0, 1, 2]]], 'SO,DO');
    expect(status).toBe(2);
    expect(err).toMatch(/DO BEFORE: no verdict file/);
    expect(err).toMatch(/must never read as a result/);
  });

  test('a typo in TYPES refuses instead of reporting on nothing', () => {
    const { status } = run([['SO', [1, 0, 1, 2], [1, 0, 1, 2]]], 'SO,NOPE');
    expect(status).not.toBe(0);
  });
});
