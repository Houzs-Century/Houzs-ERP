/* The Houzs POS backup file's cipher (layouts P14 / E8), shared by the device
 * that writes it and the ERP that imports it: AES-GCM under a key derived by
 * PBKDF2 from the SHA-256 of the device token. The device holds the token;
 * the ERP holds only that hash (pos_terminals.token_hash), which is exactly
 * enough to read the file and nothing more. WebCrypto on both sides.
 *
 * ONE home. backend/src/scm/shared/pos-backup-crypto.ts is the original and
 * frontend/src/vendor/shared/pos-backup-crypto.ts its byte-identical copy
 * (check-shared-mirrors.mjs); the POS app imports the vendored copy.
 */

const SALT = "houzs-pos-backup";

export const bytesToHex = (b: ArrayBuffer | Uint8Array): string => Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
export const bytesToB64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
export const b64ToBytes = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function sha256Hex(text: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export async function backupKey(tokenHashHex: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(tokenHashHex), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: new TextEncoder().encode(SALT), iterations: 100_000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export type PosBackupFile = {
  format: "houzs-pos-backup/1";
  terminal: string;
  project_id: number;
  exported_at: string;
  count: number;
  total_sen: number;
  receipt_counter: number;
  iv: string;
  data: string;
};

export function isPosBackupFile(v: unknown): v is PosBackupFile {
  if (!v || typeof v !== "object") return false;
  const f = v as Record<string, unknown>;
  return f.format === "houzs-pos-backup/1" && typeof f.terminal === "string" && typeof f.iv === "string" && typeof f.data === "string" && typeof f.exported_at === "string";
}

export async function encryptBackupPayload(payloadJson: string, tokenHashHex: string): Promise<{ iv: string; data: string }> {
  const key = await backupKey(tokenHashHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(payloadJson)));
  return { iv: bytesToB64(iv), data: bytesToB64(cipher) };
}

export async function decryptBackupPayload(file: Pick<PosBackupFile, "iv" | "data">, tokenHashHex: string): Promise<string> {
  const key = await backupKey(tokenHashHex);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(file.iv) as BufferSource }, key, b64ToBytes(file.data) as BufferSource);
  return new TextDecoder().decode(plain);
}

export const posBackupFileName = (terminal: string): string => `houzs_pos_${terminal}_backup.json`;
