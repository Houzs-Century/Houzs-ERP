import { describe, test, expect } from 'vitest';
import { verifySessionToken } from './session-token';
import {
  issueSessionPass,
  authUserFromPass,
  sessionSigningSecret,
  tryPassAuth,
  SESSION_PASS_TTL_MS,
  type SessionPassClaims,
} from './session-pass';
import { sidFor, revokeUser } from './session-revocation';
import type { AuthUser } from './auth';

const SECRET = 'a-sufficiently-long-signing-secret';
const NOW = 1_700_000_000_000;

const USER: AuthUser = {
  id: 42,
  email: 'tan@houzs.com',
  name: 'Tan',
  email_alias: null,
  role_id: 3,
  role_name: 'Sales',
  position_id: 7,
  position_name: 'Sales Exec',
  status: 'active',
  permissions: ['sales.read', 'sales.write'],
  permissions_set: new Set(['sales.read', 'sales.write']),
  manager_id: 9,
  scope_to_pic: true,
  department_id: 5,
  department_name: 'Sales Department',
  brand_scope: ['AKEMI', 'ZANOTTI'],
  page_access: { 'scm.sales': 'write', 'projects': 'read' } as unknown as AuthUser['page_access'],
  scm_l2_configured: true,
  authz_fingerprint: 'fp-abc-123',
  session_origin: null,
};

describe('session-pass — issue and rebuild the authorization envelope', () => {
  test('a pass carries the whole authz envelope and verifies', async () => {
    const pass = await issueSessionPass(USER, SECRET, NOW, 'sid-test-abc');
    const r = await verifySessionToken(pass, SECRET, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const c = r.claims as SessionPassClaims;
      expect(c.uid).toBe(42);
      expect(c.permissions).toEqual(['sales.read', 'sales.write']);
      expect(c.page_access).toEqual({ 'scm.sales': 'write', projects: 'read' });
      expect(c.brand_scope).toEqual(['AKEMI', 'ZANOTTI']);
      expect(c.scope_to_pic).toBe(true);
      expect(c.fp).toBe('fp-abc-123');
      expect(c.exp).toBe(NOW + SESSION_PASS_TTL_MS);
    }
  });

  test('authUserFromPass rebuilds an equivalent AuthUser, permissions_set included', async () => {
    const pass = await issueSessionPass(USER, SECRET, NOW, 'sid-test-abc');
    const r = await verifySessionToken(pass, SECRET, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rebuilt = authUserFromPass(r.claims as SessionPassClaims);
    expect(rebuilt.id).toBe(USER.id);
    expect(rebuilt.email).toBe(USER.email);
    expect(rebuilt.role_id).toBe(USER.role_id);
    expect(rebuilt.permissions).toEqual(USER.permissions);
    expect(rebuilt.permissions_set.has('sales.write')).toBe(true);
    expect(rebuilt.permissions_set.has('nope')).toBe(false);
    expect(rebuilt.brand_scope).toEqual(USER.brand_scope);
    expect(rebuilt.page_access).toEqual(USER.page_access);
    expect(rebuilt.scope_to_pic).toBe(USER.scope_to_pic);
    expect(rebuilt.scm_l2_configured).toBe(USER.scm_l2_configured);
    expect(rebuilt.authz_fingerprint).toBe(USER.authz_fingerprint);
    expect(rebuilt.department_name).toBe(USER.department_name);
  });

  test('the signing secret gate: unset or too short reads as OFF', () => {
    expect(sessionSigningSecret({})).toBeNull();
    expect(sessionSigningSecret({ SESSION_SIGNING_KEY: '' })).toBeNull();
    expect(sessionSigningSecret({ SESSION_SIGNING_KEY: 'short' })).toBeNull(); // < 16
    expect(sessionSigningSecret({ SESSION_SIGNING_KEY: 'x'.repeat(16) })).toBe('x'.repeat(16));
    expect(sessionSigningSecret(undefined)).toBeNull();
  });

  test('a pass signed for one book of claims cannot be reused past expiry', async () => {
    const pass = await issueSessionPass(USER, SECRET, NOW, 'sid-test-abc');
    const past = await verifySessionToken(pass, SECRET, NOW + SESSION_PASS_TTL_MS + 1);
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.reason).toBe('expired');
  });
});


function fakeKV() {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); } };
}

describe('tryPassAuth — verify + bind-to-token + revocation on the request path', () => {
  test('a valid pass bound to its token yields the AuthUser, no DB read', async () => {
    const token = 'the-opaque-token';
    const pass = await issueSessionPass(USER, SECRET, NOW, await sidFor(token));
    const env = { SESSION_SIGNING_KEY: SECRET, SESSION_CACHE: fakeKV() };
    const u = await tryPassAuth(env, pass, token, NOW);
    expect(u?.id).toBe(42);
    expect(u?.permissions_set.has('sales.write')).toBe(true);
  });

  test('a pass presented with a DIFFERENT token is refused (binding)', async () => {
    const pass = await issueSessionPass(USER, SECRET, NOW, await sidFor('token-A'));
    const env = { SESSION_SIGNING_KEY: SECRET, SESSION_CACHE: fakeKV() };
    expect(await tryPassAuth(env, pass, 'token-B', NOW)).toBeNull();
  });

  test('a revoked pass is refused so the caller falls back to the DB', async () => {
    const token = 'tok';
    const pass = await issueSessionPass(USER, SECRET, NOW, await sidFor(token));
    const env = { SESSION_SIGNING_KEY: SECRET, SESSION_CACHE: fakeKV() };
    await revokeUser(env as never, USER.id, NOW + 100); // revoke AFTER issue
    expect(await tryPassAuth(env, pass, token, NOW + 200)).toBeNull();
  });

  test('no signing secret set -> null (feature off)', async () => {
    const token = 't';
    const pass = await issueSessionPass(USER, SECRET, NOW, await sidFor(token));
    expect(await tryPassAuth({ SESSION_CACHE: fakeKV() }, pass, token, NOW)).toBeNull();
  });

  test('an expired pass -> null', async () => {
    const token = 't';
    const pass = await issueSessionPass(USER, SECRET, NOW, await sidFor(token));
    const env = { SESSION_SIGNING_KEY: SECRET, SESSION_CACHE: fakeKV() };
    expect(await tryPassAuth(env, pass, token, NOW + SESSION_PASS_TTL_MS + 1)).toBeNull();
  });
});
