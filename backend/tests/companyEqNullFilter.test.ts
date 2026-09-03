/* `.eq("company_id", <nullable>)` IS A MALFORMED FILTER, NOT "NO COMPANY".
 *
 * PostgREST renders it as `company_id=eq.null`, which is `company_id = NULL` and
 * is never true — so the query matches NOTHING. That is not a wide read and it
 * is not a refusal; it is a silent empty answer, and which direction it breaks
 * depends entirely on what the caller was asking:
 *
 *   a LIST  -> an empty page over rows that exist        (fleet-maintenance GET /workshops)
 *   an EDIT -> a phantom "not found" 404 over a real row (PATCH /workshops/:id)
 *   a MINT  -> zero existing codes read, the sequence restarts at 1, and it
 *              issues a DUPLICATE                        (mintWorkshopCode, mintRecordNo)
 *
 * The mint case is the dangerous one, and the comment sitting directly above
 * `mintWorkshopCode` was already about not minting duplicates.
 *
 * `scm/lib/companyScope.ts` has had the two purpose-built helpers all along, and
 * its own docstring (:136) names this exact mistake. Nothing here forbids
 * scoping — it forbids hand-rolling it past a nullable:
 *
 *   scopeToCompany(query, c)              fails CLOSED when the context resolved
 *   scopeToCompanyIdOrOpen(query, id)     falls OPEN — right for a MINT, where
 *                                         seeing more codes is the safe error
 *
 * Traced in docs/bugs/0618.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');

/* `.eq(` on company_id whose value is a nullable expression — either an explicit
   `?? null` or a bare identifier the codebase types as `number | null`. Only the
   first is matched: a bare identifier cannot be judged by regex, and a matcher
   that guesses is worse than one that is narrow and honest about it. */
/* `[^;\n]*` and not `[^)]*`: the value is routinely a CALL —
   `activeCompanyId(c) ?? null` — so a class that stops at the first `)`
   matches nothing and reports the tree clean. The self-test below exists
   because the first version of this line did exactly that. */
const EQ_NULLABLE = /\.eq\(\s*['"]company_id['"]\s*,[^;\n]*\?\?\s*null\s*\)/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('a nullable company id never goes straight into .eq()', () => {
  const files = walk(SRC);

  it('the matcher ran over a real population', () => {
    /* A verdict computed over nothing must never read as a pass (CLAUDE.md). */
    expect(files.length).toBeGreaterThan(100);
  });

  it('the matcher is not dead — it still recognises the four shapes it was written for', () => {
    expect(EQ_NULLABLE.test('.eq("company_id", activeCompanyId(c) ?? null)')).toBe(true);
    expect(EQ_NULLABLE.test(".eq('company_id', activeCompanyId(c) ?? null)")).toBe(true);
    expect(EQ_NULLABLE.test('.eq( "company_id" , co.id ?? null )')).toBe(true);
    /* The helpers, and an honest non-null id, must NOT match. */
    expect(EQ_NULLABLE.test('scopeToCompany(q, c)')).toBe(false);
    expect(EQ_NULLABLE.test('scopeToCompanyIdOrOpen(q, companyId)')).toBe(false);
    expect(EQ_NULLABLE.test('.eq("company_id", companyId)')).toBe(false);
  });

  it('no source file hand-rolls it', () => {
    const offenders = files.filter((f) => {
      /* Strip BOTH comment forms before scanning. A guard that trips on the
         note explaining the repair is a guard nobody can leave in place — and
         the repaired sites deliberately quote the broken expression so the next
         reader can see what was wrong. */
      const body = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
      return EQ_NULLABLE.test(body);
    }).map((f) => f.slice(SRC.length + 1));

    expect(
      offenders,
      `use scopeToCompany (fails closed) or scopeToCompanyIdOrOpen (falls open — right for a mint): ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
