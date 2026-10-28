/* Pure parsing helpers for inbound email. No env, no database, no R2 — which is
 * why they could be lifted out of routes/mail-center.ts without changing
 * behaviour, and why they are worth testing on their own.
 *
 * They were inline in a 2,329-line route file that sits over its file-size
 * ceiling. Moving them is the first payment on that debt: the file-size ratchet
 * exists to stop the big files growing, and the only way to clear a file that is
 * already over is to take something out of it.
 *
 * Moved VERBATIM. Every body below is byte-identical to what it replaced, and
 * backend/tests/mailParse.test.ts pins the behaviour that was previously
 * untested — so "behaviour-preserving" is a checked claim rather than an
 * assurance.
 */

/**
 * Header values that may arrive as an array, a delimited string, or nothing.
 *
 * RFC headers separate addresses with commas; `References` uses whitespace —
 * hence the character class rather than a plain `split(",")`.
 */
export function toArray(v: string[] | string | undefined | null): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  // RFC headers separate addresses with commas; References uses whitespace.
  return String(v)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** HTML body -> a single line of readable text, for previews and search. */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A date header is attacker-controlled and frequently malformed. An unparseable
 * one must not become `Invalid Date` in a timestamp column, so it falls back.
 */
export function safeIso(input: string | undefined, fallback: string): string {
  if (!input) return fallback;
  const t = Date.parse(input);
  if (Number.isNaN(t)) return fallback;
  return new Date(t).toISOString();
}

// Decode standard base64 into raw bytes. Tolerant of base64url and stray
// whitespace/newlines. Returns null on anything that doesn't decode so a single
// bad attachment never aborts the whole email.
export function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const clean = b64.replace(/[\r\n\s]+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// Sanitise a filename for use inside an R2 object key: strip any path segments
// (no traversal), keep a readable ASCII-ish basename, bound the length.
export function safeFilename(name: string | undefined): string {
  const base = (name ?? "").split(/[\\/]/).pop() || "";
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return cleaned || "file";
}
