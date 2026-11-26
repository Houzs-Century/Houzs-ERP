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
    const detect = SRC.indexOf('const isReplay = lastCreatedIdRef.current');
    const postCall = SRC.indexOf('await post.mutateAsync(createRes.id)', detect);
    const replayDialog = SRC.indexOf('was already created', detect);
    expect(detect).toBeGreaterThan(-1);
    expect(postCall).toBeGreaterThan(detect);
    expect(replayDialog).toBeGreaterThan(postCall);
  });
});
