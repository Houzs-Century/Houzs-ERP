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

  it('forwards the edit context so the grandfather carve-out works on an edit', () => {
    /* The edit surfaces send the order's ORIGINAL dates; without forwarding them
       an untouched already-past date would wrongly block the save. */
    expect(handler).toContain('origProcDate: str(body.origProcessingDate)');
    expect(handler).toContain('origDelivDate: str(body.origDeliveryDate)');
  });

  it('asks the INTRODUCED-mix question on an edit, not the flat one', () => {
    /* mixes(after) && !mixes(before): on a create origItemGroups is [] so it is
       flat; on an edit a pre-existing mix the change does not touch must not
       block (matches the server line-mix gate). */
    expect(handler).toContain('!mixesSofaWithOtherMain(((body.origItemGroups');
  });

  it('asks for the fair DAY through the shared rule (owner 2026-09-24)', () => {
    /* An event picked without a day of it blocks a confirmed save; the rule is
       fair-options.ts::fairDayMissing, the same bounds the save keeps a day by. */
    expect(handler).toContain('fairDayMissing: fairDayMissing(body,');
  });

  it('writes NOTHING — it is a dry run', () => {
    expect(handler).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    expect(handler).not.toContain('nextDocNo(');
    expect(handler).not.toContain('idempotency');
  });
});
