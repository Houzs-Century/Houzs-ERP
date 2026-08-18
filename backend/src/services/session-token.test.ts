import { describe, test, expect } from 'vitest';
import { signSessionToken, verifySessionToken, SESSION_TOKEN_PREFIX } from './session-token';

const SECRET = 'a-test-signing-secret-not-for-prod';
const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

describe('session-token — the staff pass sign/verify pair', () => {
  test('a signed pass verifies, and the claims survive the round trip', async () => {
    const token = await signSessionToken(
      { exp: NOW + 8 * HOUR, uid: 42, perms: ['sales.read', 'sales.write'] },
      SECRET,
      NOW,
    );
    expect(token.startsWith(SESSION_TOKEN_PREFIX)).toBe(true);
    const r = await verifySessionToken(token, SECRET, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claims.uid).toBe(42);
      expect(r.claims.perms).toEqual(['sales.read', 'sales.write']);
      expect(r.claims.iat).toBe(NOW); // stamped by sign()
      expect(r.claims.exp).toBe(NOW + 8 * HOUR);
    }
  });

  test('a FORGED pass — payload changed, signature not — is refused', async () => {
    const token = await signSessionToken({ exp: NOW + HOUR, uid: 42 }, SECRET, NOW);
    // Swap the payload for one claiming a different user, keep the old signature.
    const [prefixHead, , sig] = token.split('.');
    const forgedPayload = btoa(JSON.stringify({ exp: NOW + HOUR, uid: 1 }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const forged = `${prefixHead}.${forgedPayload}.${sig}`;
    const r = await verifySessionToken(forged, SECRET, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad-signature');
  });

  test('a pass signed with a DIFFERENT secret is refused', async () => {
    const token = await signSessionToken({ exp: NOW + HOUR, uid: 42 }, 'attacker-secret', NOW);
    const r = await verifySessionToken(token, SECRET, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad-signature');
  });

  test('a tampered signature is refused', async () => {
    const token = await signSessionToken({ exp: NOW + HOUR, uid: 42 }, SECRET, NOW);
    // Flip the LAST character of the signature, staying base64url-legal, so the
    // token stays well-formed and only the signature is wrong (a garbage suffix
    // would be `malformed`, a different failure — see the malformed test).
    const last = token.slice(-1);
    const flipped = token.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    const r = await verifySessionToken(flipped, SECRET, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad-signature');
  });

  test('an EXPIRED pass is refused (nowMs at or past exp)', async () => {
    const token = await signSessionToken({ exp: NOW + HOUR, uid: 42 }, SECRET, NOW);
    const atExpiry = await verifySessionToken(token, SECRET, NOW + HOUR);
    const pastExpiry = await verifySessionToken(token, SECRET, NOW + HOUR + 1);
    expect(atExpiry.ok).toBe(false);
    expect(pastExpiry.ok).toBe(false);
    if (!pastExpiry.ok) expect(pastExpiry.reason).toBe('expired');
    // still valid one ms before expiry
    const justBefore = await verifySessionToken(token, SECRET, NOW + HOUR - 1);
    expect(justBefore.ok).toBe(true);
  });

  test('a LEGACY opaque token (no prefix) returns not-signed, never an error', async () => {
    // This is what makes the two token kinds coexist: the middleware sees
    // not-signed and falls back to the DB path unchanged.
    const r = await verifySessionToken('a1b2c3d4e5f6opaquerandomtoken', SECRET, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not-signed');
    const empty = await verifySessionToken('', SECRET, NOW);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toBe('not-signed');
  });

  test('a malformed signed token is refused without throwing', async () => {
    for (const bad of [
      SESSION_TOKEN_PREFIX + 'onlyonepart',
      SESSION_TOKEN_PREFIX + '.emptybody',
      SESSION_TOKEN_PREFIX + 'body.',
      SESSION_TOKEN_PREFIX + '!!!.@@@',
    ]) {
      const r = await verifySessionToken(bad, SECRET, NOW);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(['malformed', 'bad-signature']).toContain(r.reason);
    }
  });

  test('signing refuses a pass with no expiry or an expiry already past', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(signSessionToken({} as any, SECRET, NOW)).rejects.toThrow(/exp is required/);
    await expect(signSessionToken({ exp: NOW - 1 }, SECRET, NOW)).rejects.toThrow(/in the past/);
  });

  test('an empty signing secret is refused at both ends', async () => {
    await expect(signSessionToken({ exp: NOW + HOUR }, '', NOW)).rejects.toThrow(/empty signing secret/);
    const token = await signSessionToken({ exp: NOW + HOUR }, SECRET, NOW);
    const r = await verifySessionToken(token, '', NOW);
    expect(r.ok).toBe(false); // empty secret can't verify → bad-signature
  });
});
