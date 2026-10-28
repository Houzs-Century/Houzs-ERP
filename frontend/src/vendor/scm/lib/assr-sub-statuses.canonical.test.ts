/* The browser half of the service-case sub-status list — docs/bugs/0890.
 *
 * The screens offered Pending Customer Pickup and the server's save refused it:
 * the list lived in vendor/scm/lib/assr/stages.ts and, separately, as a
 * hand-kept allowlist in backend/src/routes/assr.ts. The desktop select then
 * swallowed the refusal, so a user saw the choice snap back with no word.
 *
 * What is pinned here: this file and the server's copy are the same bytes;
 * stages.ts hands the screens THIS list rather than a copy; and the desktop
 * select says so when a save is refused. The server's own files are pinned by
 * backend/tests/assrSubStatusOneHome.test.ts.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ASSR_SUB_STATUSES } from './assr-sub-statuses';
import { ASSR_SUB_STATUSES as FROM_STAGES } from './assr/stages';
import { stripComments } from '../../../auth/sourceScan.testutil';

const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8');

describe('one sub-status list for the server and the screens', () => {
  test('backend/src/scm/shared/assr-sub-statuses.ts is byte-identical to this one', () => {
    const norm = (rel: string) => read(rel).replace(/\r\n/g, '\n');
    expect(norm('../backend/src/scm/shared/assr-sub-statuses.ts')).toBe(norm('src/vendor/scm/lib/assr-sub-statuses.ts'));
  });

  test('stages.ts hands the screens this very list, not a copy of it', () => {
    expect(FROM_STAGES).toBe(ASSR_SUB_STATUSES);
    const stages = stripComments(read('src/vendor/scm/lib/assr/stages.ts'));
    expect(stages.includes('"pending_customer_pickup"')).toBe(false);
  });

  test('the desktop sub-status select tells the user when a save is refused', () => {
    const page = stripComments(read('src/pages/ServiceCases.tsx'));
    expect(/onSubChange=\{\(k\) => \{ patch\(\{ sub_status: k \}\)\.catch\(\(e: unknown\) => toast\.error\(/.test(page)).toBe(true);
  });
});
