/* A signed pass must carry the Title's policy row and its capability grants,
 * and a pass minted without them must not authorize.
 *
 * 2026-09-28: a Finance Executive (Title cohort full, can_move_money on) got
 * 403 on every accounting write while every read worked. Her requests
 * authenticated on the signed-pass fast path, and the v1 pass carried
 * permissions + page_access but NOT position_policy — so moneyWriteDenial fell
 * back to the position-NAME rule, which only admits "Finance Manager" and
 * "Super Admin". The DB path (position_policy present) let the same user
 * through, which is why no fixture-based test ever saw it. The same hole made
 * hasPositionCapability fail closed on the fast path.
 *
 * Both halves are pinned here: the round trip carries the two fields, and a
 * pass of the old shape is refused by tryPassAuth (null = fall back to the DB
 * path, which re-mints), so the fix reaches every open session at deploy. */
import { describe, expect, it } from 'vitest';
import {
  issueSessionPass,
  authUserFromPass,
  tryPassAuth,
  SESSION_PASS_CLAIMS_VERSION,
  type SessionPassClaims,
} from '../src/services/session-pass';
import { signSessionToken, verifySessionToken } from '../src/services/session-token';
import { sidFor } from '../src/services/session-revocation';
import { moneyWriteDenial } from '../src/services/positionPolicy';
import { hasPositionCapability } from '../src/services/positionCapabilities';
import type { AuthUser } from '../src/services/auth';

const SECRET = 'test-signing-secret-of-32-chars!!';
const NOW = 1_800_000_000_000;
const TOKEN = 'opaque-session-token-1';
/* No SESSION_CACHE binding: the revocation board answers "not revoked", so the
   only thing that can refuse a pass here is its own shape. */
const ENV = { SESSION_SIGNING_KEY: SECRET } as never;

const PERMS = ['scm.access', 'scm.payment_voucher.post'];
const financeExecutive = (): AuthUser => ({
  id: 155, email: 'c@x', email_alias: null, name: 'Carrie', role_id: 341, role_name: 'Finance Executive',
  position_id: 28, position_name: 'Finance Executive', status: 'active',
  permissions: PERMS, permissions_set: new Set(PERMS), manager_id: 139, scope_to_pic: false,
  department_id: 10, department_name: 'Finance Department', brand_scope: null,
  page_access: { 'scm.finance.accounting': 'full' } as AuthUser['page_access'],
  scm_l2_configured: false,
  position_policy: { position_id: 28, cohort: 'full', profile: null, can_move_money: true, can_write_config: false, is_fleet: false, duty: 'finance' },
  position_capabilities: ['scm.do.load'],
  authz_fingerprint: 'fp-1', session_origin: null,
} as unknown as AuthUser);

async function roundTrip(user: AuthUser): Promise<AuthUser> {
  const pass = await issueSessionPass(user, SECRET, NOW, 'sid-1');
  const r = await verifySessionToken(pass, SECRET, NOW + 1000);
  if (!r.ok) throw new Error('pass did not verify');
  return authUserFromPass(r.claims as SessionPassClaims);
}

describe('a signed pass carries the Title policy and the capability grants', () => {
  it('rebuilds position_policy and position_capabilities from the pass', async () => {
    const u = await roundTrip(financeExecutive());
    expect(u.position_policy).toEqual(financeExecutive().position_policy);
    expect(u.position_capabilities).toEqual(['scm.do.load']);
  });

  it('lets a money-moving full Title post on the fast path, as the DB path does', async () => {
    const fromDb = financeExecutive();
    expect(moneyWriteDenial(fromDb, 'scm.finance.accounting', 'POST')).toBeNull();
    const fromPass = await roundTrip(fromDb);
    expect(moneyWriteDenial(fromPass, 'scm.finance.accounting', 'POST')).toBeNull();
  });

  it('keeps a capability grant usable on the fast path', async () => {
    const fromPass = await roundTrip(financeExecutive());
    expect(hasPositionCapability(fromPass, 'scm.do.load')).toBe(true);
  });

  it('a Title with no policy row still rides as null, not as a missing field', async () => {
    const u = await roundTrip({ ...financeExecutive(), position_policy: null, position_capabilities: [] } as AuthUser);
    expect(u.position_policy).toBeNull();
    expect(u.position_capabilities).toEqual([]);
  });
});

describe('the fast path honours only the current claims shape', () => {
  it('a current pass authorizes with the policy on board', async () => {
    const pass = await issueSessionPass(financeExecutive(), SECRET, NOW, await sidFor(TOKEN));
    const u = await tryPassAuth(ENV, pass, TOKEN, NOW + 1000);
    expect(u?.id).toBe(155);
    expect(u?.position_policy?.can_move_money).toBe(true);
    expect(moneyWriteDenial(u, 'scm.finance.accounting', 'POST')).toBeNull();
  });

  it('a v1 pass (no version, no policy) is refused, so the DB path re-mints it', async () => {
    /* Exactly the shape the old build minted: the current claims minus the
       three v2 fields. Signed with the real secret and bound to the real
       token, so nothing but the version can be what refuses it. */
    const fresh = await issueSessionPass(financeExecutive(), SECRET, NOW, await sidFor(TOKEN));
    const r = await verifySessionToken(fresh, SECRET, NOW);
    if (!r.ok) throw new Error('fresh pass did not verify');
    const { v, position_policy, position_capabilities, iat: _iat, ...v1 } = r.claims as SessionPassClaims;
    expect(v).toBe(SESSION_PASS_CLAIMS_VERSION);
    expect(position_policy).not.toBeNull();
    expect(position_capabilities).toEqual(['scm.do.load']);
    const oldPass = await signSessionToken(v1, SECRET, NOW);
    expect(await tryPassAuth(ENV, oldPass, TOKEN, NOW + 1000)).toBeNull();
  });

  it('a pass claiming a future version is refused too — the build decides the shape, not the pass', async () => {
    const fresh = await issueSessionPass(financeExecutive(), SECRET, NOW, await sidFor(TOKEN));
    const r = await verifySessionToken(fresh, SECRET, NOW);
    if (!r.ok) throw new Error('fresh pass did not verify');
    const { iat: _iat, ...claims } = r.claims as SessionPassClaims;
    const odd = await signSessionToken({ ...claims, v: SESSION_PASS_CLAIMS_VERSION + 1 }, SECRET, NOW);
    expect(await tryPassAuth(ENV, odd, TOKEN, NOW + 1000)).toBeNull();
  });
});
