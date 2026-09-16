/* POST /mfg-sales-orders/validate — the dry-run submit check (owner 2026-09-16,
 * 「跟 backend 串通, frontend 只是显示问题」). The 12,000-line router cannot be
 * driven end to end here, so this pins the WIRING: the route runs the shared
 * collectSoSubmitProblems and returns problems[], and — being a dry run — writes
 * NOTHING (no insert / update / delete, no doc number minted, no idempotency).
 * The problem set + wording themselves are pinned in
 * shared/so-submit-problems.test.ts. */
import { describe, expect, it } from 'vitest';
import { soRouterSource } from '../../../tests/lib/so-router-source';

const raw = soRouterSource();
const start = raw.indexOf("mfgSalesOrders.post('/validate'");
const handler = start < 0 ? '' : raw.slice(start, raw.indexOf('\nmfgSalesOrders.', start + 10));

describe('the validate route is wired to the shared collector', () => {
  it('finds the handler (a pin over nothing must not pass)', () => {
    expect(start).toBeGreaterThan(-1);
  });

  it('runs the shared collectSoSubmitProblems and returns problems[]', () => {
    expect(handler).toContain('collectSoSubmitProblems({');
    expect(handler).toMatch(/return c\.json\(\{ problems \}, 200\)/);
  });

  it('reuses the shared payment sub-field cascade rather than a private copy', () => {
    expect(handler).toContain('soPaymentSubFieldGap(');
  });

  it('writes NOTHING — it is a dry run', () => {
    expect(handler).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    expect(handler).not.toContain('nextDocNo(');
    expect(handler).not.toContain('idempotency');
  });
});
