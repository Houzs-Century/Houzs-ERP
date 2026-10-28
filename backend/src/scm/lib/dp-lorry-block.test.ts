import { describe, expect, it } from 'vitest';
import { DP_LORRY_BLOCK_PREFIX, dpLorryBlockReason, isDpLorryBlock } from './dp-lorry-block';

/**
 * The reason string IS the key that ties a lorry_maintenance window back to the
 * DP job that created it — lorry_maintenance has no source link. Cancel deletes
 * by exact match, so anything that makes two different jobs (or a job and the
 * Repair Days dashboard) share a string would let one cancel free a lorry that
 * is still in the workshop for another reason.
 */

describe('the window a lorry-service job owns', () => {
  it('names the DP number, so one job can only ever delete its own window', () => {
    expect(dpLorryBlockReason('DP-260803-VQE01')).toBe('DP lorry service — DP-260803-VQE01');
    expect(dpLorryBlockReason('DP-260803-VQE01')).not.toBe(dpLorryBlockReason('DP-260803-VQE02'));
  });

  it('never collides with the Repair Days dashboard sentinel', () => {
    // lorry-capacity.ts deletes rows matching 'Repair days (dashboard)' exactly
    // before writing its own window. If a DP job produced that string, planning
    // a repair-days figure would silently release a lorry that is at a workshop.
    expect(dpLorryBlockReason('DP-260803-VQE01')).not.toBe('Repair days (dashboard)');
    expect(isDpLorryBlock('Repair days (dashboard)')).toBe(false);
  });

  it('recognises its own family and nothing else', () => {
    expect(isDpLorryBlock(dpLorryBlockReason('DP-260803-VQE01'))).toBe(true);
    expect(isDpLorryBlock('Gearbox rebuild')).toBe(false);
    expect(isDpLorryBlock(null)).toBe(false);
    expect(isDpLorryBlock('')).toBe(false);
    // The prefix ALONE is not one of ours: a window with no DP number attached
    // cannot be matched back to a job, so cancel must not claim it.
    expect(isDpLorryBlock(DP_LORRY_BLOCK_PREFIX)).toBe(false);
  });
});
