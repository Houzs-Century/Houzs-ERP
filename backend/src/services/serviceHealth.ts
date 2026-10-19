// Verdict and error scrubbing for GET /api/admin/health/services (DEV-35).
// Pure: the route reads the numbers, this decides what they mean.

export type ServiceVerdict = "ok" | "warning" | "critical";

export type ServiceStats = {
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  attempts24h: number;
  failures24h: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const ms = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

export function serviceVerdict(
  s: ServiceStats,
  nowMs: number,
): { verdict: ServiceVerdict; note: string | null } {
  const ok = ms(s.lastSuccessAt);
  const failed = ms(s.lastFailureAt);
  if (failed !== null && (ok === null || failed > ok)) {
    return { verdict: "critical", note: "last attempt failed" };
  }
  if (s.attempts24h > 0 && (ok === null || ok < nowMs - DAY_MS)) {
    return { verdict: "critical", note: "no success in 24 h" };
  }
  if (s.attempts24h === 0) return { verdict: "ok", note: "idle" };
  if (s.failures24h / s.attempts24h > 0.2) {
    return { verdict: "warning", note: `${s.failures24h} of ${s.attempts24h} attempts failed in 24 h` };
  }
  return { verdict: "ok", note: null };
}

/** An upstream error as shown on the IT page: no query strings (keys ride in
 *  them), no credential-shaped values, at most 200 characters. */
export function scrubError(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  const s = String(raw)
    .replace(/(https?:\/\/[^\s?#"']+)[?#][^\s"']*/gi, "$1?[redacted]")
    .replace(/\bbearer\s+[^\s"',]+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|key|token|secret|password|passwd|authorization)(["']?\s*[=:]\s*["']?)[^\s"',&]+/gi, "$1$2[redacted]")
    .replace(/\b(sk-ant-|sk-|re_|pk_|rk_)[A-Za-z0-9_-]{8,}/g, "[redacted]");
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}
