
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseRecipients(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,;]/)) {
    const addr = part.trim();
    if (!addr) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}

export function addRecipients(raw: string, picked: string[]): string {
  const have = new Set(parseRecipients(raw).map((a) => a.toLowerCase()));
  const extra = picked.filter((a) => {
    const key = a.trim().toLowerCase();
    if (!key || have.has(key)) return false;
    have.add(key);
    return true;
  });
  if (extra.length === 0) return raw;
  const kept = raw.trim().replace(/[,;]\s*$/, "");
  return [kept, ...extra].filter(Boolean).join(", ");
}

export function firstInvalid(raw: string): string | null {
  return parseRecipients(raw).find((a) => !EMAIL_RE.test(a)) ?? null;
}
