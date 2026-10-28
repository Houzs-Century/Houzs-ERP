/* Reopen a completed case for a DIFFERENT complaint (owner 2026-09-22). Three
 * things must hold and little else pins them, all in files where a refactor
 * could unhook them: (1) the OLD complaint is written to the timeline BEFORE the
 * field is overwritten, so it is never lost; (2) reopening clears the terminal
 * marks (closed_at + completion_date) — otherwise the case looks moved but still
 * closed; (3) the route sits under /:id (enforceCaseScope) gated on
 * service_cases.write and refuses an empty complaint. */
import { describe, expect, test } from 'vitest';
import { REOPEN_STAGES } from '../src/services/assrReopen';
import svcRaw from '../src/services/assrReopen.ts?raw';
import routeRaw from '../src/routes/assr.ts?raw';

describe('REOPEN_STAGES', () => {
  test('offers the three assessment stages before the supplier leg', () => {
    expect([...REOPEN_STAGES]).toEqual(['pending_review', 'pending_solution', 'under_verification']);
  });
});

describe('reopen preserves the old complaint + reactivates', () => {
  test('logs the previous complaint (case_reopened) before overwriting it', () => {
    expect(svcRaw).toMatch(/logActivity\([\s\S]{0,120}"case_reopened"/);
    // old complaint is the from_value, new complaint the to_value
    expect(svcRaw).toMatch(/before\.complaint_issue \?\? null,\s*complaint/);
  });
  test('clears the terminal marks so the case genuinely reactivates', () => {
    expect(svcRaw).toMatch(/closed_at = NULL, completion_date = NULL/);
    expect(svcRaw).toMatch(/status = 'In Progress'/);
  });
  test('sets the new complaint on the case', () => {
    expect(svcRaw).toMatch(/SET complaint_issue = \?/);
  });
  test('refuses an empty complaint with a 400', () => {
    expect(svcRaw).toMatch(/if \(!complaint\) return c\.json\(\{ error:/);
  });
});

describe('the reopen route is scoped + gated', () => {
  test('sits under /:id/reopen with service_cases.write', () => {
    expect(routeRaw).toMatch(/app\.post\("\/:id\/reopen", requirePermission\("service_cases\.write"\), reopenCaseRoute\)/);
  });
  test('enforceCaseScope covers the /:id child paths', () => {
    expect(routeRaw).toMatch(/app\.use\("\/:id\{\[0-9\]\+\}\/\*", enforceCaseScope\)/);
  });
});
