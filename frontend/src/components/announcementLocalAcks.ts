const MAX_ACKS = 200;
const CLOCK_SKEW_MS = 5 * 60_000;

export type AnnouncementAcks = Record<string, number>;

export function sanitizeAnnouncementAcks(value: unknown, now = Date.now()): AnnouncementAcks {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([id, timestamp]) =>
        id.length > 0 &&
        typeof timestamp === "number" &&
        Number.isFinite(timestamp) &&
        timestamp > 0 &&
        timestamp <= now + CLOCK_SKEW_MS,
      )
      .sort((a, b) => (b[1] as number) - (a[1] as number))
      .slice(0, MAX_ACKS),
  ) as AnnouncementAcks;
}

export function readAnnouncementAcks(storageKey: string | null): AnnouncementAcks {
  if (!storageKey) return {};
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? sanitizeAnnouncementAcks(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

export function mergeAndWriteAnnouncementAcks(
  storageKey: string | null,
  next: AnnouncementAcks,
): AnnouncementAcks {
  const merged = sanitizeAnnouncementAcks({
    ...readAnnouncementAcks(storageKey),
    ...next,
  });
  if (!storageKey) return merged;
  try {
    localStorage.setItem(storageKey, JSON.stringify(merged));
  } catch {
    // Persistence is best-effort; keep the in-memory result.
  }
  return merged;
}

// ── Skip counter (owner 2026-08-08: skips, then acknowledgement only) ──────
// Same guarantees as the ack memo above: identity-scoped key, size cap,
// clock-skew rejection. Local like the acks because the backend records acks,
// never dismissals — so the allowance is per browser+identity, not per account
// across devices.
//
// ONE postponement (Announcements redesign 2026-09-04, superseding #1728's two):
// the mandatory modal offers "Remind later" exactly once, with the note "You
// can postpone once"; on its next appearance only the acknowledge action
// remains. The modal now pops only for notices that require acknowledgement
// (WARNING / SOP, or the per-notice flag), so a single postponement is enough
// slack — the reader is never blocked from opening the page to read it first.

export const MAX_ANNOUNCEMENT_SKIPS = 1;
// Bound against a corrupted blob claiming an absurd count; well above anything
// a user can reach through the UI (dismiss controls disappear at the limit).
const MAX_SKIP_COUNT = 99;

export type AnnouncementSkip = { n: number; at: number };
export type AnnouncementSkips = Record<string, AnnouncementSkip>;

export function sanitizeAnnouncementSkips(value: unknown, now = Date.now()): AnnouncementSkips {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries: Array<[string, AnnouncementSkip]> = [];
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!id || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const { n, at } = raw as { n?: unknown; at?: unknown };
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) continue;
    if (typeof at !== "number" || !Number.isFinite(at) || at <= 0 || at > now + CLOCK_SKEW_MS) {
      continue;
    }
    entries.push([id, { n: Math.min(n, MAX_SKIP_COUNT), at }]);
  }
  entries.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(entries.slice(0, MAX_ACKS));
}

export function readAnnouncementSkips(storageKey: string | null): AnnouncementSkips {
  if (!storageKey) return {};
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? sanitizeAnnouncementSkips(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

// Plain overwrite, unlike the additive ack merge: an ack CLEARS the notice's
// entry, and a read-merge would resurrect it from the stored copy. A racing
// tab's lost increment only grants one extra skip — benign, and the storage
// event re-syncs both tabs.
export function writeAnnouncementSkips(
  storageKey: string | null,
  next: AnnouncementSkips,
): AnnouncementSkips {
  const sane = sanitizeAnnouncementSkips(next);
  if (!storageKey) return sane;
  try {
    localStorage.setItem(storageKey, JSON.stringify(sane));
  } catch {
    // Persistence is best-effort; keep the in-memory result.
  }
  return sane;
}

export function recordAnnouncementSkip(
  skips: AnnouncementSkips,
  id: string,
  now = Date.now(),
): AnnouncementSkips {
  const n = Math.min((skips[id]?.n ?? 0) + 1, MAX_SKIP_COUNT);
  return { ...skips, [id]: { n, at: now } };
}

export function clearAnnouncementSkip(
  skips: AnnouncementSkips,
  id: string,
): AnnouncementSkips {
  if (skips[id] == null) return skips;
  const next = { ...skips };
  delete next[id];
  return next;
}

export function skipLimitReached(skips: AnnouncementSkips, id: string): boolean {
  return (skips[id]?.n ?? 0) >= MAX_ANNOUNCEMENT_SKIPS;
}
