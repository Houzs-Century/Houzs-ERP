// ── TOTP shared secrets at rest ───────────────────────────────
//
// A two-step sign-in secret is all anyone needs to produce that user's codes,
// and until 2026-11-10 it sat in users.totp_secret as plain base32 — so a copy
// of the database (a backup, a dump, a staging refresh) handed over everyone's
// second factor. Sealed, the column holds `enc:v1:<iv>:<ciphertext>` under
// AES-GCM with a Worker secret (TOTP_ENCRYPTION_KEY) the database never sees.
// The user id is bound in as additional data, so a sealed value copied onto a
// different user does not open.
//
// The key is optional on purpose: unset, nothing is sealed and a plain secret
// reads as itself — exactly the behaviour before this file. A plain row is
// sealed the next time its owner signs in with a code (totpCheck.ts).

const PREFIX = "enc:v1:";

export type TotpKeyEnv = { TOTP_ENCRYPTION_KEY?: string };

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
const aad = (userId: number): Uint8Array => new TextEncoder().encode(`houzs-totp:${userId}`);

async function keyOf(env: TotpKeyEnv): Promise<CryptoKey | null> {
  const raw = env.TOTP_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  let bytes: Uint8Array;
  try {
    bytes = unb64(raw);
  } catch {
    bytes = new Uint8Array(0);
  }
  if (bytes.length !== 32) {
    // eslint-disable-next-line no-console
    console.error("[totp] TOTP_ENCRYPTION_KEY is not base64 of 32 bytes; secrets are NOT being sealed");
    return null;
  }
  return crypto.subtle.importKey("raw", bytes as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export const isSealedTotpSecret = (stored: string): boolean => stored.startsWith(PREFIX);

/** The value to store for `plain`: sealed when the key is set, else `plain`. */
export async function sealTotpSecret(env: TotpKeyEnv, userId: number, plain: string): Promise<string> {
  const key = await keyOf(env);
  if (!key) return plain;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(userId) as BufferSource },
    key,
    new TextEncoder().encode(plain),
  ));
  return `${PREFIX}${b64(iv)}:${b64(cipher)}`;
}

/** The base32 secret behind a stored value, or null when it cannot be opened
 *  (sealed but the key is unset, wrong, or the value belongs to another user). */
export async function openTotpSecret(env: TotpKeyEnv, userId: number, stored: string): Promise<string | null> {
  if (!isSealedTotpSecret(stored)) return stored;
  const key = await keyOf(env);
  if (!key) return null;
  const [ivB64, dataB64] = stored.slice(PREFIX.length).split(":");
  if (!ivB64 || !dataB64) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(ivB64) as BufferSource, additionalData: aad(userId) as BufferSource },
      key,
      unb64(dataB64) as BufferSource,
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
