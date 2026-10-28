/* ----------------------------------------------------------------------------
   auth-fastpath-probe — IS THE FAST PATH ACTUALLY FIRING, AND ARE THE CACHES
   ACTUALLY HITTING?

   Owner, 2026-09-02, after being shown that /api/presence and
   /api/announcements/banner account for ~90% of every slow request in
   production (697 of 761 occurrences over three days, from the read-only
   client-error dump): 「B」 — build the check rather than guess.

   WHAT WAS ALREADY THERE, AND WHY IT IS NOT ENOUGH. `/api/admin/health/live`
   already reports `sessionSigning.configured`, rendered On/Off on the System
   Health page. Configured is NOT the same fact as firing: the key can be set
   while every request still pays the two joined authorization reads, because a
   pass can be absent, expired, or never sent by the client. `docs/bugs/0593` is
   exactly that gap — the feature shipped, read as working from the source, and
   was inert for ~95% of every session's life. So this reports the OBSERVED path
   of the request in hand, not a property of the configuration.

   And the second half has never been measured at all. Both slow endpoints cache,
   and both carry a note about a cache that silently never hits: the banner's TTL
   once equalled the frontend poll, so every poll missed and rebuilt the feed at
   ~874-984ms (configCache.ts). Nothing reports whether either is hitting NOW.

   READ-ONLY. It reads the request it is already serving and does ONE cache
   lookup per family — no write, no DB, no put, no TTL change.

   IT NEVER TOUCHES THE SECRET. `configured` comes from `sessionSigningSecret`,
   which also rejects a key under 16 characters, so a placeholder reads OFF here
   exactly as it behaves at runtime. The value itself never leaves the worker,
   and nothing here returns a prefix, a length or a hash of it.
   -------------------------------------------------------------------------- */

export type AuthFastPath = "pass" | "session-db" | "unknown";

export type CacheFamilyReading = {
  /** The TTL the entry is written with. */
  ttl_seconds: number;
  /** How often the browser asks for it. A TTL at or below this means a lone
   *  user misses EVERY time — the failure the banner already paid for. */
  client_poll_seconds: number;
  /** hit / miss for THIS request; `bypass` when no key could be built. */
  state: "hit" | "miss" | "bypass";
  /** True when the TTL cannot outlive the poll, so misses are structural rather
   *  than incidental. A reader should fix this before reading the hit rate. */
  ttl_shorter_than_poll: boolean;
};

export type AuthFastPathReading = {
  session_pass: {
    configured: boolean;
    /** What THIS request actually did. `unknown` means the middleware did not
     *  record it — never read that as either answer. */
    this_request: AuthFastPath;
    /** Did the BROWSER send a pass at all? Observed off the request headers, so
     *  `unknown` above stops being a dead end: no header means the client has
     *  none to send (it expired, or was never absorbed) and the DB path is the
     *  only thing that could have run; a header present with `unknown` means we
     *  lost the record, which is a different bug entirely.
     *
     *  Presence ONLY — never the value, never a prefix, never a length. */
    client_sent_pass: boolean;
  };
  config_cache: Record<string, CacheFamilyReading>;
  /** One plain sentence naming what to do, for a reader who is not an engineer
   *  (CLAUDE.md: 用白话文跟老板讲). */
  reading: string;
};

/** The one sentence, derived from the numbers rather than written beside them,
 *  so it cannot drift away from what the probe measured. */
export function readingFor(
  configured: boolean,
  thisRequest: AuthFastPath,
  families: Record<string, CacheFamilyReading>,
  clientSentPass: boolean,
): string {
  const structural = Object.entries(families)
    .filter(([, f]) => f.ttl_shorter_than_poll)
    .map(([n]) => n);
  if (!configured) {
    return "Signed sessions are OFF, so every request re-reads who you are and what you may do. "
      + "That is the first thing to change; the cache readings below matter less until it is on.";
  }
  if (thisRequest === "session-db") {
    return "Signed sessions are ON but THIS request still went to the database for authorization — "
      + "so the fast path is configured and not being taken. That is the thing to chase, not the caches.";
  }
  /* UNKNOWN IS CHECKED BEFORE THE CACHES, and the order is the whole fix. It
     used to sit BELOW, so `unknown` + a short TTL printed "Authorization took
     the fast path" — a claim about the one thing the probe had just said it
     could not see. The owner read the card saying "Not reported" beside a
     sentence saying "took the fast path" (2026-09-02) and the probe built to
     stop unevidenced claims had made one.

     My own test missed it because it exercised `unknown` with a HEALTHY cache,
     so this combination never ran: a branch covered on one arm only. Both arms
     are asserted now. */
  if (thisRequest === "unknown") {
    const tail = structural.length
      ? ` Separately, ${structural.join(" and ")} keep(s) its cached copy for less time `
        + "than the browser waits before asking again — that part is a setting, and it holds "
        + "whatever authorization turns out to be doing."
      : "";
    const why = clientSentPass
      ? " The browser DID send a pass, so the record was lost rather than never made."
      : " The browser sent no pass, so it has none to send — it expired, or it was never stored.";
    return "Authorization did not report which path it took, so this reading cannot say. "
      + "Do not read that as either answer." + why + tail;
  }
  if (structural.length) {
    return `Authorization took the fast path. But ${structural.join(" and ")} keep(s) its cached copy for `
      + "less time than the browser waits before asking again, so a single user misses every time. "
      + "That is a setting, not a defect.";
  }
  return "Authorization took the fast path and every cache is set to outlive the browser's poll. "
    + "If pages are still slow, the cause is not on this page.";
}

/** Build one family's reading. Kept pure so the sentence above can be tested
 *  against every combination without a Worker, a request or a cache. */
export function cacheFamilyReading(
  ttlSeconds: number,
  clientPollSeconds: number,
  state: "hit" | "miss" | "bypass",
): CacheFamilyReading {
  return {
    ttl_seconds: ttlSeconds,
    client_poll_seconds: clientPollSeconds,
    state,
    /* `<=`, not `<`: a TTL EQUAL to the poll expires exactly as the next poll
       arrives, which is the measured 874-984ms case, not a near miss. */
    ttl_shorter_than_poll: ttlSeconds <= clientPollSeconds,
  };
}

/* THE BROWSER'S POLL INTERVALS, in the one place a reader compares them with a
   TTL. They are frontend constants, so they are MIRRORED here and pinned by
   `backend/tests/authFastPathProbe.test.ts`, which reads the hooks' source and
   fails when either moves. That test is the point: `configCache.ts` still says
   the banner poll is 60s and reasons "300s (5 polls)" from it, while
   useAnnouncementBanner.ts has carried 180_000 for some time — 300/180 is 1.67
   polls, not 5. CLAUDE.md: a number in a comment is a fact with an expiry date,
   so this one is made self-checking instead of re-typed. */
export const CLIENT_POLL_SECONDS = {
  /** usePresence.ts HEARTBEAT_MS */
  presence: 60,
  /** components/useAnnouncementBanner.ts POLL_MS */
  banner: 180,
} as const;
