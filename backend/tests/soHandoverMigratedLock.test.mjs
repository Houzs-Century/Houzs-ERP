// THE THIRD DOOR ONTO A MIGRATED SALES ORDER, pinned at the call site.
//
// `migratedSoReadonly()` is mounted on `/mfg-sales-orders/*` and
// `/so-amendments/*` (src/scm/index.ts) and resolves the document number out of
// the PATH. `POST /so-handover/apply` carries a LIST of document numbers in the
// BODY, so a third mount of that factory would find no doc number, answer "not
// migrated", and wave every write through — a guard that is worse than none,
// because it reads as applied. The decision therefore has to be asked per order
// inside the handler.
//
// WHY THIS IS SOURCE-ANCHORED, and why it lives in tests/ rather than beside
// the route. The property is not "the rule is right" — migratedSoLock.test.ts
// owns that — it is "the rule is APPLIED AT THIS CALL SITE", which is the
// lesson of docs/bugs/0099 and the instrument keyWithoutIdentityGuards.test.mjs
// already uses. It is a `.mjs` under tests/ because `backend/tsconfig.json`
// covers `src/**` and does not carry node types: the first version of these
// assertions sat in `src/scm/routes/so-handover.test.ts`, where `node:fs` and
// `import.meta.url` are both type errors. Vitest ran them green locally and
// `backend-typecheck` — a REQUIRED context — failed in CI. Green is not
// evidence until you know WHICH check ran.
//
// Every assertion below FAILED on the tree before fix/sync-human-edit-guard,
// where this route rewrote salesperson_id and agent on a migrated order while
// the lock was on. docs/bugs/0702-*. Re-anchor if the code moves; do not delete.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(HERE, '..');
const src = readFileSync(join(BACKEND, 'src/scm/routes/so-handover.ts'), 'utf8');

describe('POST /so-handover/apply respects the migrated-SO lock', () => {
  it('asks the same decision function the guard and the SO detail screen use', () => {
    expect(src).toContain("import { migratedSoReadonlyState } from '../lib/migrated-so-readonly';");
    /* UPDATED 2026-09-08 with the correctness-mode re-grain: the decision is
       now per DOCUMENT, so this route hands over the doc number it is looking
       at as well. The assertion still pins the same two things it was written
       to pin — that this route asks THE shared decision function, and that it
       computes `isMigrated` from the row it already read rather than letting it
       default. */
    expect(src).toContain('await migratedSoReadonlyState(c, docNo, before.linked_ac_docno != null)');
  });

  it('reads linked_ac_docno, or it could not answer', () => {
    expect(src).toMatch(/select\('doc_no, salesperson_id, agent, status, linked_ac_docno'\)/);
  });

  it('the refusal REACHES the operator instead of being a silent skip', () => {
    const i = src.indexOf('const lock = await migratedSoReadonlyState');
    expect(i, 'the lock check moved — re-anchor this test, do not delete it').toBeGreaterThan(-1);
    expect(src.slice(i, i + 400)).toContain('skipped.push({ docNo, reason: lock.reason');
  });

  it('refuses BEFORE the update, not after it', () => {
    const lockAt = src.indexOf('const lock = await migratedSoReadonlyState');
    const updateAt = src.indexOf("sb.from('mfg_sales_orders').update(updates)");
    expect(lockAt).toBeGreaterThan(-1);
    expect(updateAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(updateAt);
  });

  it('refuses PER ORDER, so one migrated document does not fail the whole batch', () => {
    const i = src.indexOf('const lock = await migratedSoReadonlyState');
    // `continue`, never `return` — the rest of the batch still moves.
    expect(src.slice(i, i + 400)).toContain('continue;');
    expect(src.slice(i, i + 400)).not.toContain('return c.json');
  });
});
