/* The Houzs POS pairing code: what POS Admin > Terminals > Pair device hands
 * out and what the device types (or receives in the ?pair= link). Eight
 * characters from an alphabet without 0/O/1/I, shown as XXXX-XXXX; the ERP
 * stores only its SHA-256 and it expires in minutes.
 *
 * ONE home. backend/src/scm/shared/pos-pairing.ts is the original and
 * frontend/src/vendor/shared/pos-pairing.ts its byte-identical copy
 * (check-shared-mirrors.mjs); the POS app imports the vendored copy.
 */

export const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PAIRING_LENGTH = 8;
export const PAIRING_MINUTES = 15;

/** Upper-case, keep only alphabet characters: "h7k2-9qpd " -> "H7K29QPD". */
export function normalizePairingCode(raw: string): string {
  return raw.toUpperCase().split("").filter((ch) => PAIRING_ALPHABET.includes(ch)).join("");
}

export const isPairingCode = (raw: string): boolean => normalizePairingCode(raw).length === PAIRING_LENGTH;

/** "H7K29QPD" -> "H7K2-9QPD" for the screen. */
export const formatPairingCode = (code: string): string => {
  const n = normalizePairingCode(code);
  return n.length > 4 ? `${n.slice(0, 4)}-${n.slice(4)}` : n;
};

export function mintPairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(PAIRING_LENGTH));
  return Array.from(bytes, (b) => PAIRING_ALPHABET[b % PAIRING_ALPHABET.length]).join("");
}

export async function pairingCodeHash(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`pos-pair:${normalizePairingCode(raw)}`));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The ?pair= code in a POS app link, if any. */
export function pairingCodeFromUrl(href: string): string | null {
  try {
    const v = new URL(href).searchParams.get("pair");
    return v && isPairingCode(v) ? normalizePairingCode(v) : null;
  } catch {
    return null;
  }
}
