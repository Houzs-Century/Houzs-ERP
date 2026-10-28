// ----------------------------------------------------------------------------
// session-token — the "staff pass" primitive: sign a claim set at login, verify
// it on a request with NO database read.
//
// WHY THIS EXISTS. Today every /api request re-reads the whole RBAC envelope
// (role + permissions + page access + brand scope) from Postgres, on one
// serialized connection, and fails CLOSED (401 → logout) when the DB blips.
// That is the root cause of both the random logouts and the 7–13s latency tail
// (measured 2026-08-18: the same lightweight endpoint returned 0.36/7/13.6/2s).
// The durable fix, and what mainstream ERPs do, is to authorize ONCE at login
// into a cryptographically signed token the request can verify locally.
//
// THIS MODULE IS STAGE 1 — THE FOUNDATION ONLY. It is a pure sign/verify pair
// and is wired into NOTHING yet: no login path issues these, no middleware
// reads them. Zero blast radius by construction. Later stages issue it beside
// the existing opaque token (stage 2), verify it before the DB path with a
// fallback (stage 3), and add the revocation list (stage 4).
//
// SHAPE. A token is three dot-joined parts, all URL-safe base64:
//     hst1.<payloadB64>.<sigB64>
// `hst1.` is a VERSION PREFIX and it is load-bearing: a value that does not
// start with it is a legacy opaque token, so verify() returns `not-signed`
// rather than an error, and the caller falls back to the DB path unchanged.
// That is what lets the two token kinds coexist during the migration.
//
// SECURITY NOTES.
//   • HMAC-SHA256 over the EXACT wire bytes `hst1.<payloadB64>`, so the prefix
//     is signed too and a token cannot be downgraded to another version.
//   • `crypto.subtle.verify` is constant-time; we never compare signatures by
//     hand (the string-compare timing leak this repo already fixed once in the
//     AutoCount host key lives here as a risk too).
//   • The secret NEVER appears in a token and never leaves the Worker. It is an
//     env secret set by the owner (stage 3), not a constant in this file.
//   • `exp` is REQUIRED. A token with no expiry is refused at sign time — an
//     un-expiring bearer credential is exactly what the revocation list cannot
//     fully contain.
// ----------------------------------------------------------------------------

/** Version prefix. Signed as part of the payload, and the discriminator that
 *  tells a signed token from a legacy opaque one. Bump to `hst2.` only with a
 *  verify() that still accepts the old prefix during a migration. */
export const SESSION_TOKEN_PREFIX = 'hst1.';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** The claims a signed token carries. Deliberately open (`Record`) at this
 *  stage — WHICH fields of AuthUser go in is a stage-2 decision. Only `exp` is
 *  mandated here, because verify() enforces it. `iat` (issued-at) is stamped by
 *  sign() so the revocation list can say "everything for this user issued
 *  before T is void" without needing per-token ids. */
export interface SessionClaims {
  /** Expiry, epoch milliseconds. REQUIRED. */
  exp: number;
  /** Issued-at, epoch milliseconds. Stamped by sign(). */
  iat?: number;
  [k: string]: unknown;
}

export type VerifyResult =
  | { ok: true; claims: SessionClaims }
  /** `not-signed`: not one of ours — a legacy opaque token. The caller MUST
   *  fall back to the existing DB session path, not treat this as a failure. */
  | { ok: false; reason: 'not-signed' | 'malformed' | 'bad-signature' | 'expired' };

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array | null {
  try {
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error('session-token: empty signing secret');
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * Sign a claim set into a staff pass. `exp` must be present and in the future;
 * `iat` is stamped from `nowMs`. `nowMs` is a parameter (not a `Date.now()`
 * call) so the same function is deterministic in tests.
 */
export async function signSessionToken(
  claims: SessionClaims,
  secret: string,
  nowMs: number,
): Promise<string> {
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
    throw new Error('session-token: exp is required and must be a number');
  }
  if (claims.exp <= nowMs) {
    throw new Error('session-token: exp is already in the past');
  }
  const withIat: SessionClaims = { ...claims, iat: nowMs };
  const payloadB64 = b64urlEncode(enc.encode(JSON.stringify(withIat)));
  const signingInput = SESSION_TOKEN_PREFIX + payloadB64;
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(signingInput)));
  return `${signingInput}.${b64urlEncode(sig)}`;
}

/**
 * Verify a token. NEVER throws — every failure is a typed `reason` so the
 * middleware can branch cleanly. `not-signed` specifically means "hand this to
 * the legacy DB path", which is how a legacy opaque token flows through
 * unchanged while this is being rolled out.
 */
export async function verifySessionToken(
  token: string,
  secret: string,
  nowMs: number,
): Promise<VerifyResult> {
  if (!token || !token.startsWith(SESSION_TOKEN_PREFIX)) {
    return { ok: false, reason: 'not-signed' };
  }
  const rest = token.slice(SESSION_TOKEN_PREFIX.length);
  const dot = rest.lastIndexOf('.');
  if (dot <= 0 || dot === rest.length - 1) return { ok: false, reason: 'malformed' };
  const payloadB64 = rest.slice(0, dot);
  const sigB64 = rest.slice(dot + 1);
  const sig = b64urlDecode(sigB64);
  const payloadBytes = b64urlDecode(payloadB64);
  if (!sig || !payloadBytes) return { ok: false, reason: 'malformed' };

  const signingInput = SESSION_TOKEN_PREFIX + payloadB64;
  let valid: boolean;
  try {
    const key = await hmacKey(secret);
    valid = await crypto.subtle.verify('HMAC', key, sig, enc.encode(signingInput));
  } catch {
    return { ok: false, reason: 'bad-signature' };
  }
  if (!valid) return { ok: false, reason: 'bad-signature' };

  // JSON.parse can yield null (a signed "null" payload), so the type says so
  // and the `?.` below is a real guard, not decoration.
  let claims: SessionClaims | null;
  try {
    claims = JSON.parse(dec.decode(payloadBytes)) as SessionClaims | null;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof claims?.exp !== 'number' || !Number.isFinite(claims.exp)) {
    return { ok: false, reason: 'malformed' };
  }
  if (nowMs >= claims.exp) return { ok: false, reason: 'expired' };

  return { ok: true, claims };
}
