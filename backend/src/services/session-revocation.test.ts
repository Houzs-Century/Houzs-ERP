import { describe, test, expect } from 'vitest';
import type { Env } from '../types';
import { sidFor, revokeUser, revokeSession, passIsRevoked } from './session-revocation';

const NOW = 1_700_000_000_000;

function fakeEnv(): Env {
  const m = new Map<string, string>();
  return {
    SESSION_CACHE: {
      get: async (k: string) => m.get(k) ?? null,
      put: async (k: string, v: string) => { m.set(k, v); },
    },
  } as unknown as Env;
}

describe('session-revocation — the cancelled-passes board', () => {
  test('sidFor is stable, differs per token, and does not leak the token', async () => {
    const a = await sidFor('token-abc');
    const b = await sidFor('token-abc');
    const c = await sidFor('token-xyz');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain('token');
    expect(a).toMatch(/^[0-9a-f]{24}$/);
  });

  test('revokeUser voids passes issued BEFORE it, honours those issued after', async () => {
    const env = fakeEnv();
    await revokeUser(env, 42, NOW);
    expect(await passIsRevoked(env, 42, null, NOW - 1000)).toBe(true);  // old pass → void
    expect(await passIsRevoked(env, 42, null, NOW + 1000)).toBe(false); // fresh login → ok
    expect(await passIsRevoked(env, 99, null, NOW - 1000)).toBe(false); // other user untouched
  });

  test('revokeSession voids ONE device, keyed by sid', async () => {
    const env = fakeEnv();
    const deviceA = await sidFor('device-A-token');
    const deviceB = await sidFor('device-B-token');
    await revokeSession(env, deviceA, NOW);
    expect(await passIsRevoked(env, 42, deviceA, NOW - 1000)).toBe(true);  // logged-out device
    expect(await passIsRevoked(env, 42, deviceB, NOW - 1000)).toBe(false); // same user, other device
  });

  test('no KV bound → fails OPEN (pass honoured, DB fallback is the net)', async () => {
    expect(await passIsRevoked({} as Env, 42, null, NOW)).toBe(false);
  });
});
