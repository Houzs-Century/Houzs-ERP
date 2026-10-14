/* Offline PIN verification. The ERP stores a cashier's PIN as "salt$hash"
 * (PBKDF2-SHA256, 100,000 iterations, 256-bit key, both halves base64 —
 * backend/src/services/auth.ts hashPassword). The bundle carries that hash,
 * so the device proves a PIN with WebCrypto and never needs the network. */
const ITERATIONS = 100_000;
const HASH = "SHA-256";
const KEY_BITS = 256;

const b64ToBytes = (b64: string): Uint8Array => {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

export function parsePinHash(stored: string): { salt: Uint8Array; hash: Uint8Array } | null {
  if (!stored || !stored.includes("$")) return null;
  const [saltB64, hashB64] = stored.split("$");
  if (!saltB64 || !hashB64) return null;
  try {
    return { salt: b64ToBytes(saltB64), hash: b64ToBytes(hashB64) };
  } catch {
    return null;
  }
}

export async function derivePin(pin: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: salt as BufferSource, iterations: ITERATIONS, hash: HASH }, key, KEY_BITS);
  return new Uint8Array(bits);
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const parsed = parsePinHash(stored);
  if (!parsed) return false;
  const got = await derivePin(pin, parsed.salt);
  if (got.length !== parsed.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= (got[i] ?? 0) ^ (parsed.hash[i] ?? 0);
  return diff === 0;
}

/** Test helper and the ERP's own format: salt$hash from a PIN. */
export async function hashPin(pin: string, salt?: Uint8Array): Promise<string> {
  const s = salt ?? crypto.getRandomValues(new Uint8Array(16));
  const bytesToB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
  return `${bytesToB64(s)}$${bytesToB64(await derivePin(pin, s))}`;
}
