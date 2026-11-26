import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { issueSessionPass, sessionSigningSecret, type SessionPassClaims } from '../services/session-pass';
import { verifySessionToken } from '../services/session-token';
import type { AuthUser } from '../services/auth';

const SECRET = 'a-sufficiently-long-signing-secret';

const USER = {
  id: 42, email: 'tan@houzs.com', name: 'Tan', email_alias: null,
  role_id: 3, role_name: 'Sales', position_id: null, position_name: null,
  status: 'active', permissions: ['sales.read'], permissions_set: new Set(['sales.read']),
  manager_id: null, scope_to_pic: false, department_id: null, department_name: null,
  brand_scope: [], page_access: {} as AuthUser['page_access'], scm_l2_configured: false,
  authz_fingerprint: 'fp-1', session_origin: null,
} as unknown as AuthUser;

function appWithDbPath(env: Record<string, unknown>, nowMs: number) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    const secret = sessionSigningSecret(env);
    const reissued = secret ? await issueSessionPass(USER, secret, nowMs, 'sid-1') : null;
    if (reissued) c.header('X-Session-Pass', reissued);
    await next();
  });
  app.get('/x', (c) => c.json({ ok: true }));
  return app;
}

describe('the pass is re-issued on the authoritative path', () => {
  it('hands a fresh pass back when the secret is set', async () => {
    const res = await appWithDbPath({ SESSION_SIGNING_KEY: SECRET }, 1_700_000_000_000).request('/x');
    const pass = res.headers.get('X-Session-Pass');
    expect(pass, 'no renewal was issued — every later request pays the DB read again').toBeTruthy();
    const v = await verifySessionToken(pass!, SECRET, 1_700_000_000_000);
    expect(v.ok).toBe(true);
  });

  it('issues NOTHING while the secret is unset — the whole feature stays inert', async () => {
    const res = await appWithDbPath({}, 1_700_000_000_000).request('/x');
    expect(res.headers.get('X-Session-Pass')).toBeNull();
  });

  it('issues nothing for a key too short to sign with', async () => {
    const res = await appWithDbPath({ SESSION_SIGNING_KEY: 'short' }, 1_700_000_000_000).request('/x');
    expect(res.headers.get('X-Session-Pass')).toBeNull();
  });

  it('the re-issued pass has a NEWER iat, so revocation still bites', async () => {
    const t0 = 1_700_000_000_000;
    const first = await issueSessionPass(USER, SECRET, t0, 'sid-1');
    const res = await appWithDbPath({ SESSION_SIGNING_KEY: SECRET }, t0 + 60_000).request('/x');
    const later = res.headers.get('X-Session-Pass')!;
    const a = await verifySessionToken(first, SECRET, t0);
    const b = await verifySessionToken(later, SECRET, t0 + 60_000);
    if (!a.ok || !b.ok) throw new Error('a pass failed to verify — the iat comparison is meaningless');
    const iatA = (a.claims as SessionPassClaims).iat ?? 0;
    const iatB = (b.claims as SessionPassClaims).iat ?? 0;
    expect(iatA, 'the primitive stamps iat; a 0 here means it stopped').toBeGreaterThan(0);
    expect(iatB).toBeGreaterThan(iatA);
  });
});
