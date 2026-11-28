import { describe, expect, it } from 'vitest';
import { DP_LORRY_BLOCK_PREFIX, dpLorryBlockReason, isDpLorryBlock } from './dp-lorry-block';


describe('the window a lorry-service job owns', () => {
  it('names the DP number, so one job can only ever delete its own window', () => {
    expect(dpLorryBlockReason('DP-260803-VQE01')).toBe('DP lorry service — DP-260803-VQE01');
    expect(dpLorryBlockReason('DP-260803-VQE01')).not.toBe(dpLorryBlockReason('DP-260803-VQE02'));
  });

  it('never collides with the Repair Days dashboard sentinel', () => {
    expect(dpLorryBlockReason('DP-260803-VQE01')).not.toBe('Repair days (dashboard)');
    expect(isDpLorryBlock('Repair days (dashboard)')).toBe(false);
  });

  it('recognises its own family and nothing else', () => {
    expect(isDpLorryBlock(dpLorryBlockReason('DP-260803-VQE01'))).toBe(true);
    expect(isDpLorryBlock('Gearbox rebuild')).toBe(false);
    expect(isDpLorryBlock(null)).toBe(false);
    expect(isDpLorryBlock('')).toBe(false);
    expect(isDpLorryBlock(DP_LORRY_BLOCK_PREFIX)).toBe(false);
  });
});
