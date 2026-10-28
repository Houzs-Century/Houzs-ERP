const DAY_MS = 86_400_000;
const CLOCK_SKEW_MS = 5 * 60_000;

export function shouldShowPwaPrompt(storageKey: string, cooldownDays: number, now = Date.now()): boolean {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw == null) return true;
    const dismissedAt = Number(raw);
    const valid = Number.isFinite(dismissedAt) && dismissedAt > 0 && dismissedAt <= now + CLOCK_SKEW_MS;
    if (!valid) {
      localStorage.removeItem(storageKey);
      return true;
    }
    return now - dismissedAt >= cooldownDays * DAY_MS;
  } catch {
    return true;
  }
}
