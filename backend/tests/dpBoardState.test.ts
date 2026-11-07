import { describe, expect, it } from 'vitest';
import { dpBoardState } from '../src/scm/lib/dp-board-state';

describe('a DP job on the board', () => {
  it('is delivered once the crew completes it', () => {
    expect(dpBoardState('COMPLETED')).toBe('DELIVERED');
  });
  it('is pending delivery while scheduled, pending schedule before', () => {
    expect(dpBoardState('SCHEDULED')).toBe('PENDING_DELIVERY');
    expect(dpBoardState('PENDING_SCHEDULE')).toBe('PENDING_SCHEDULE');
    expect(dpBoardState(null)).toBe('PENDING_SCHEDULE');
  });
});
