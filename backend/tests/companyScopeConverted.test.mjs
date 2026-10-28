// ----------------------------------------------------------------------------
// The converted-file list may only GROW.
//
// backend/scripts/company-scope-converted.json names the files that have moved
// to scm/lib/scopedDb.ts, where a query's company scope is a REQUIRED argument.
// check-company-scope.mjs --strict (inside the required backend-typecheck job)
// fails if a listed file reaches for c.get('supabase') again.
//
// That gate only protects what is ON the list, and nothing in a Node script can
// see git history — so DELETING an entry would quietly delete the protection and
// the run would stay green. This suite is that half: it pins the entries, so
// removing one also means removing an assertion that says what it was for, in
// the same diff, where a reviewer sees it.
//
// It is in tests/classifyTests.test.mjs's MUST_GATE_MERGE list, because a
// regression here has to stop a MERGE. A shard failure only fails the deploy,
// which is after the fact — and the fact in question is a tenant boundary.
import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIST_PATH = path.join(backendRoot, 'scripts', 'company-scope-converted.json');

/** Entries pinned here may never be dropped from the JSON. One line per file,
 *  with what it costs to remove it. */
const PINNED = [
  // The pilot. Its PATCH /:id/cancel is the handler the 2026-07-22 "every
  // sibling flow" audit missed, which let a caller in company A cancel company
  // B's POSTED transfer and reverse B's stock. Un-listing this file removes the
  // only mechanical guard that it does not drift back.
  'src/scm/routes/stock-transfers.ts',
];

const load = () => JSON.parse(fs.readFileSync(LIST_PATH, 'utf8'));

describe('company-scope-converted.json', () => {
  test('parses and carries a non-empty converted array', () => {
    const list = load().converted;
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
  });

  test('every listed file exists — a rename must not silently un-gate a file', () => {
    for (const rel of load().converted) {
      expect(fs.existsSync(path.join(backendRoot, rel)), `${rel} is listed as converted but is not in the tree`).toBe(true);
    }
  });

  test('the list may only GROW — no pinned entry has been removed', () => {
    const list = load().converted;
    for (const rel of PINNED) {
      expect(list, `${rel} was removed from company-scope-converted.json. That deletes its guard silently, because the checker only looks at what the list names.`).toContain(rel);
    }
  });

  test('no duplicates, and every entry is a backend-relative path', () => {
    const list = load().converted;
    expect(new Set(list).size).toBe(list.length);
    for (const rel of list) {
      expect(rel.startsWith('src/'), `${rel} must be relative to backend/`).toBe(true);
      expect(rel.includes('\\'), `${rel} must use forward slashes`).toBe(false);
    }
  });
});
