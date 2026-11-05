// ITEM_CODES must limit MODE=reconstruct as well as retro-cost (HC-0156): the
// owner wants two ARRUS families repaired alone, not all 22 the full run plans.
import { describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/backfill-fifo-divergence.mjs', import.meta.url));
// Nothing listens on port 1, so a mode that gets past the env checks fails on connect.
const run = (mode) => spawnSync(process.execPath, [SCRIPT], {
  env: { ...process.env, DATABASE_URL: 'postgres://x:x@127.0.0.1:1/x', MODE: mode, ITEM_CODES: '2990 ARRUS-FIRM MATT (Q)', APPLY: '' },
  encoding: 'utf8',
  timeout: 30000,
});
const refused = (r) => (r.stderr + r.stdout).includes('ITEM_CODES limits');

describe('backfill-fifo-divergence ITEM_CODES', () => {
  test('reconstruct accepts ITEM_CODES', () => {
    expect(refused(run('reconstruct'))).toBe(false);
  });
  test('a mode that ignores ITEM_CODES still refuses it', () => {
    const r = run('relabel');
    expect(r.status).toBe(2);
    expect(refused(r)).toBe(true);
  });
});
