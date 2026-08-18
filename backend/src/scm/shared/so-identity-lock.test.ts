import { describe, it, expect } from 'vitest';
import {
  SO_IDENTITY_LOCK_COLS,
  changedIdentityLockCols,
  salespersonReattributed,
} from './so-identity-lock';

/* The lock decides whether a delivered order can be edited at all, so these pin
   both directions: what it still freezes, and the 2026-08-17 carve-out that lets
   a resigning salesperson's orders move to their replacement. */

const before = {
  debtor_name: 'ACME',
  address1: '12 Jalan Satu',
  salesperson_id: 'staff-a',
  agent: 'Alice',
};

describe('SO_IDENTITY_LOCK_COLS', () => {
  it('still freezes what a DO / SI snapshots', () => {
    for (const col of ['debtor_name', 'address1', 'agent', 'so_date', 'currency']) {
      expect(SO_IDENTITY_LOCK_COLS.has(col)).toBe(true);
    }
  });

  it('does NOT freeze salesperson_id — a handover must survive delivery', () => {
    expect(SO_IDENTITY_LOCK_COLS.has('salesperson_id')).toBe(false);
  });
});

describe('changedIdentityLockCols', () => {
  it('reports only columns that genuinely changed', () => {
    expect(changedIdentityLockCols({ debtor_name: 'ACME' }, before)).toEqual([]);
    expect(changedIdentityLockCols({ debtor_name: 'OTHER' }, before)).toEqual(['debtor_name']);
  });

  it('treats null / undefined / empty string as the same absence', () => {
    expect(changedIdentityLockCols({ address2: '' }, { address2: null })).toEqual([]);
  });

  it('lets a moved salesperson through, and the agent that followed it', () => {
    const updates = { salesperson_id: 'staff-b', agent: 'Bernard' };
    expect(
      changedIdentityLockCols(updates, before, { agentFollowedSalesperson: true }),
    ).toEqual([]);
  });

  it('still locks an agent the client authored itself', () => {
    // No salesperson move behind it, so the follow flag is false and `agent`
    // is exactly the identity column it has always been.
    expect(changedIdentityLockCols({ agent: 'Bernard' }, before)).toEqual(['agent']);
  });

  it('does not let the carve-out smuggle other identity fields along', () => {
    const updates = { salesperson_id: 'staff-b', agent: 'Bernard', debtor_name: 'OTHER' };
    expect(
      changedIdentityLockCols(updates, before, { agentFollowedSalesperson: true }),
    ).toEqual(['debtor_name']);
  });
});

describe('salespersonReattributed', () => {
  it('is true only for a genuine move', () => {
    expect(salespersonReattributed({ salesperson_id: 'staff-b' }, before)).toBe(true);
    expect(salespersonReattributed({ salesperson_id: 'staff-a' }, before)).toBe(false);
    expect(salespersonReattributed({ debtor_name: 'OTHER' }, before)).toBe(false);
  });

  it('counts CLEARING the salesperson — an unowned order is a re-attribution too', () => {
    expect(salespersonReattributed({ salesperson_id: null }, before)).toBe(true);
  });
});
