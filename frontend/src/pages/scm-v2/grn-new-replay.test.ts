// The GRN replay says so — the dialog must never call a replayed receipt "created".
//
// GrnNew mints ONE idempotency key per mount and deliberately never rotates it
// (lib/idempotency.ts's standing ruling). The accepted residual: a re-press
// with untouched lines REPLAYS the first 201. The silent branch inside that
// residual: an operator receiving a SECOND identical batch pressed Create on
// the stale form and was told the goods were received when nothing was written
// (2026-08-21 audit, item B1). The page now detects the replay — same mount +
// same key can only ever mint one id, so the same id answered twice IS the
// replay — and the dialog names it instead of claiming a create.
//
// Structural: the submit path needs a live server; this pins the SOURCE shape
// so the detector cannot be dropped in a refactor without a test going red.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, './GrnNew.tsx'), 'utf8');

describe('GrnNew — the idempotent replay is announced, not dressed as a create', () => {
  it('detects the replay by comparing the answered id against the mount ref', () => {
    expect(SRC).toContain('const isReplay = lastCreatedIdRef.current === createRes.id;');
    expect(SRC).toContain('lastCreatedIdRef.current = createRes.id;');
  });

  it('the replay dialog says nothing new was written and points at the picker', () => {
    expect(SRC).toContain('was already created');
    expect(SRC).toContain('no second GRN or stock movement was written');
    expect(SRC).toContain('Transfer from Purchase Order');
  });

  it('the replay still runs the post half — the recovery path when post failed first time', () => {
    /* The detector sits BEFORE the post call and must not skip it: a create
       that succeeded whose post then failed is exactly the retry this key
       design exists for. Assert the order: isReplay is computed, THEN post
       runs, THEN the replay dialog returns. */
    const detect = SRC.indexOf('const isReplay = lastCreatedIdRef.current');
    const postCall = SRC.indexOf('await post.mutateAsync(createRes.id)', detect);
    const replayDialog = SRC.indexOf('was already created', detect);
    expect(detect).toBeGreaterThan(-1);
    expect(postCall).toBeGreaterThan(detect);
    expect(replayDialog).toBeGreaterThan(postCall);
  });
});
