import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* WHY A SOURCE SCAN. The handler is registered on a Hono router and reaching it
 * needs the whole request context; the property worth pinning is one line of the
 * query, so this reads the source the way assrStageLabelOneHome.test.ts does.
 *
 * WHAT WENT WRONG. scm.fabric_trackings.id is a GLOBAL text primary key and is
 * DERIVED FROM THE FABRIC CODE (`code.toUpperCase().replace(/\s+/g, '_')`), so two
 * organisations importing the same code address the SAME row. The bulk import's
 * upsert passed no `ignoreDuplicates`, which makes it ON CONFLICT DO UPDATE, and
 * the rows it writes carry `company_id`. So the merge did not merely overwrite the
 * other organisation's row — it RE-HOMED it. The original owner then could not see
 * it (GET / is company-scoped) or delete it (DELETE /:id answers NOT_THIS_COMPANY).
 * Silent, and only reachable from a bulk import.
 *
 * The two upserts beside it already knew: both pass `ignoreDuplicates: true`.
 *
 * WHY NOT JUST ADD ignoreDuplicates HERE. That trades an overwrite for a silent
 * DROP — the importer is told nothing and gets no row. Both directions lose data
 * quietly, which is the actual defect. The conflicting ids are named and refused.
 *
 * 0089_multicompany_extend_scoping.sql records why the id cannot simply gain a
 * company column: for these masters the TEXT primary key IS the code, and a PK
 * redesign is the price of changing it. Until then the ids must be distinct across
 * organisations, and this is the check that says so instead of assuming it. */

const root = fileURLToPath(new URL('../src/scm/routes/fabric-tracking.ts', import.meta.url));
const src = readFileSync(root, 'utf8');

/** Only the code, so a comment quoting the old shape cannot satisfy the test. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');

describe('the fabric bulk import cannot take a row that belongs to another organisation', () => {
  it('refuses conflicting ids rather than merging over them', () => {
    expect(code, 'the cross-company pre-check is gone from bulk-upsert')
      .toMatch(/fabric_id_belongs_to_another_company/);
    expect(code, 'the pre-check no longer excludes the active company')
      .toMatch(/\.neq\(\s*['"]company_id['"]\s*,\s*cid\s*\)/);
    expect(code, 'the refusal must be a 409, not a silent success')
      .toMatch(/fabric_id_belongs_to_another_company[\s\S]{0,600}?\}\s*,\s*409\s*\)/);
  });

  it('still merges within one organisation — a re-import updates your own rows', () => {
    /* The fix must not turn the importer into insert-only. `ignoreDuplicates` is
       absent here ON PURPOSE: re-importing your own fabric list is an UPDATE. */
    expect(code, "bulk-upsert gained ignoreDuplicates, so a re-import now silently drops rows")
      .not.toMatch(/from\(['"]fabric_trackings['"]\)\s*\.upsert\([^)]*ignoreDuplicates/);
  });

  it('the id really is derived from the code, which is what makes this reachable', () => {
    /* If this ever stops being true the whole hazard changes shape, and the
       reasoning above — not just this test — needs re-reading. */
    expect(code).toMatch(/const id\s*=[\s\S]{0,200}?toUpperCase\(\)\.replace\(/);
  });
});
