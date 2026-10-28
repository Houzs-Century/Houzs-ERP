// ── TOTP (RFC 6238) + recovery codes ──────────────────────────
//
// Pure Web Crypto (HMAC-SHA1) — no WASM, no deps — so it runs in the Worker
// runtime exactly like the PBKDF2 password hashing in auth.ts. The shared
// secret is base32 (what authenticator apps expect in the otpauth:// URI).
//
// Verification accepts a ±1 step (30s) window to tolerate clock drift between
// the phone and the edge. Codes are compared in (near) constant time.

const STEP_SECONDS = 30;
const DIGITS = 6;
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function bytesToB32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function b32ToBytes(b32: string): Uint8Array {
  const clean = b32.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) continue; // skip stray chars defensively
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** Random 20-byte (160-bit) base32 secret — the authenticator-standard length. */
export function generateSecret(): string {
  return bytesToB32(crypto.getRandomValues(new Uint8Array(20)));
}

async function hmacSha1(keyBytes: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, msg);
  return new Uint8Array(sig);
}

function counterBytes(counter: number): Uint8Array {
  const buf = new Uint8Array(8);
  // 64-bit big-endian. JS bit ops are 32-bit, so fill the low 4 bytes from the
  // counter and the high 4 from counter/2^32 (TOTP counters never exceed 2^53).
  let lo = counter >>> 0;
  let hi = Math.floor(counter / 0x100000000) >>> 0;
  for (let i = 7; i >= 4; i--) {
    buf[i] = lo & 0xff;
    lo >>>= 8;
  }
  for (let i = 3; i >= 0; i--) {
    buf[i] = hi & 0xff;
    hi >>>= 8;
  }
  return buf;
}

async function hotp(secretBytes: Uint8Array, counter: number): Promise<string> {
  const mac = await hmacSha1(secretBytes, counterBytes(counter));
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return (bin % 10 ** DIGITS).toString().padStart(DIGITS, "0");
}

function constEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The valid 6-digit code for `secret` right now. Used by the enrollment client
 *  preview and by tests; the server never needs to generate, only verify. */
export async function currentTotp(secret: string, nowMs = Date.now()): Promise<string> {
  const step = Math.floor(nowMs / 1000 / STEP_SECONDS);
  return hotp(b32ToBytes(secret), step);
}

/**
 * Verify a 6-digit code against the secret, allowing ±`window` steps of drift.
 * `nowMs` is injectable for tests; defaults to the wall clock.
 */
export async function verifyTotp(
  secret: string,
  code: string,
  window = 1,
  nowMs = Date.now(),
): Promise<boolean> {
  const clean = (code || "").replace(/\D/g, "");
  if (clean.length !== DIGITS) return false;
  const secretBytes = b32ToBytes(secret);
  const step = Math.floor(nowMs / 1000 / STEP_SECONDS);
  for (let w = -window; w <= window; w++) {
    if (constEq(await hotp(secretBytes, step + w), clean)) return true;
  }
  return false;
}

/** The otpauth:// URI an authenticator app scans / imports. */
export function otpauthUri(secret: string, account: string, issuer = "Houzs ERP"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ── Backup / recovery codes ───────────────────────────────────
// 10 single-use codes shown ONCE at enrollment. Stored as SHA-256 hashes so a
// DB read never reveals usable codes; entries are removed from the JSON array
// as they're spent. High entropy (40 bits) → fast hash is fine, no PBKDF2.

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomCode(): string {
  // 8 chars from a digit+uppercase set, grouped "XXXX-XXXX" for readability.
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // no I/L/O/U to avoid confusion
  const r = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (let i = 0; i < 8; i++) s += alphabet[r[i] % alphabet.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export async function generateBackupCodes(
  n = 10,
): Promise<{ plain: string[]; hashes: string[] }> {
  const plain: string[] = [];
  for (let i = 0; i < n; i++) plain.push(randomCode());
  const hashes = await Promise.all(plain.map((p) => sha256Hex(normalizeBackupCode(p))));
  return { plain, hashes };
}

function normalizeBackupCode(code: string): string {
  return (code || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
}

/**
 * If `code` matches a stored backup-code hash, return the remaining hashes
 * (the spent one removed) so the caller can persist them. Returns null on no
 * match. Single-use is enforced by writing back the trimmed array.
 */
export async function consumeBackupCode(
  code: string,
  storedHashes: string[],
): Promise<string[] | null> {
  const h = await sha256Hex(normalizeBackupCode(code));
  const idx = storedHashes.indexOf(h);
  if (idx === -1) return null;
  return storedHashes.filter((_, i) => i !== idx);
}
