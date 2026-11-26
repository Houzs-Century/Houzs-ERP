
/**
 * Header values that may arrive as an array, a delimited string, or nothing.
 *
 * RFC headers separate addresses with commas; `References` uses whitespace —
 * hence the character class rather than a plain `split(",")`.
 */
export function toArray(v: string[] | string | undefined | null): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
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

export function safeFilename(name: string | undefined): string {
  const base = (name ?? "").split(/[\\/]/).pop() || "";
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return cleaned || "file";
}
