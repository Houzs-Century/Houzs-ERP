/* A UNIT TEST CANNOT STOP A FOURTH COPY BEING TYPED INTO A FOURTH FILE.
 *
 * The rule "which company's accounting masters does a posting read" was written
 * THREE times as three hand-copied ternaries (engine.ts:94, rules.ts:93,
 * payments.ts:51) and all three silently substituted company 1. `0615` folded
 * them into acc/masters-company.ts. This is what stops them growing back.
 *
 * It lives in tests/ rather than beside the module because it reads the source
 * tree, and backend/src is typechecked against the Workers runtime where
 * `node:fs` does not exist.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ACC_DIR = join(__dirname, '..', 'src', 'acc');
const INLINE_FALLBACK = /companyId\s*(==|===)\s*null\s*\?\s*1\b|companyId\s*(\?\?|\|\|)\s*1\b/;

describe('the accounting company fallback has exactly one home', () => {
  it('no acc/ module re-implements it inline', () => {
    const files = readdirSync(ACC_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    /* The matcher must have run over a real population — a verdict computed
       over nothing must never read as a pass (CLAUDE.md). */
    expect(files.length).toBeGreaterThan(5);

    const offenders = files.filter((f) =>
      f !== 'masters-company.ts' && INLINE_FALLBACK.test(readFileSync(join(ACC_DIR, f), 'utf8')));
    expect(
      offenders,
      `call accMastersCompanyId instead of re-implementing the fallback: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('the matcher is not dead — it still recognises the expression it was written for', () => {
    expect(INLINE_FALLBACK.test('const co = companyId == null ? 1 : Number(companyId);')).toBe(true);
    expect(INLINE_FALLBACK.test(".eq('company_id', companyId == null ? 1 : Number(companyId))")).toBe(true);
    expect(INLINE_FALLBACK.test('const co = companyId ?? 1;')).toBe(true);
    expect(INLINE_FALLBACK.test('const co = accMastersCompanyId(companyId, "x");')).toBe(false);
  });
});
