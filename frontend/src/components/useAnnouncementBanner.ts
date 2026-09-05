import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { identityStorageKey } from "../lib/storageIdentity";
import {
  clearAnnouncementSkip,
  mergeAndWriteAnnouncementAcks,
  readAnnouncementAcks,
  readAnnouncementSkips,
  recordAnnouncementSkip,
  skipLimitReached,
  writeAnnouncementSkips,
  type AnnouncementAcks,
  type AnnouncementSkips,
} from "./announcementLocalAcks";
import type { AnnAttachment, AnnMediaLayout } from "./AnnouncementMedia";
import {
  requiresAcknowledgement,
  type AnnouncementCategory,
} from "./announcementCategory";

// ────────────────────────────────────────────────────────────────────────────
// useAnnouncementBanner — the pop-up notice LOGIC, shared by both shells.
//
// It used to live inside components/AnnouncementBanner.tsx, which is mounted
// only in the DESKTOP shell (App.tsx) — so a phone user got no pop-up and no
// alert of any kind for a new announcement (owner 2026-07-21). Rather than
// copy the fetch/ack/dismiss rules into the mobile shell (two divergent
// definitions of "have I seen this?"), everything that is not markup lives
// here and both surfaces render it their own way: desktop keeps its centred
// Tailwind card, mobile draws the .hz-m bottom sheet.
//
// Backend: GET /api/announcements/banner -> { data: Announcement[], ackedIds }
// Ack:     POST /api/announcements/:id/ack
// Neither is gated on announcements.read — ordinary sales staff lack that
// permission and must still receive their own notices.
// ────────────────────────────────────────────────────────────────────────────

export type { AnnouncementCategory };

// Machine translations of the notice, as stored on the row and returned by the
// banner endpoint. Spelled out here rather than imported from mobile/mobileI18n
// so this desktop-side module keeps no dependency on the phone shell; the shape
// is what localizeAnnouncement() consumes. Absent for pre-translation rows and
// for any row whose translate call failed — that helper falls back to the
// author's original words.
export type BannerTranslationPair = { title: string; body: string; bodyHtml?: string };
export type BannerTranslations = {
  en?: BannerTranslationPair | null;
  ms?: BannerTranslationPair | null;
  zh?: BannerTranslationPair | null;
  bn?: BannerTranslationPair | null;
} | null;

export type BannerAnnouncement = {
  id: string;
  title: string;
  body: string;
  /** Canonical rich fragment (lib/announcementRichText.ts) or null = plain. */
  bodyHtml?: string | null;
  createdAt: string | null;
  remindedAt: string | null;
  category?: AnnouncementCategory;
  /** Per-notice "must acknowledge" flag (mig 2026-09). Absent = the category
   *  rule (WARNING / SOP block) — see announcementCategory.ts. */
  requireAck?: boolean | null;
  /** Author's display name, resolved server-side (mig 2026-09). */
  createdByName?: string | null;
  /** System-notice tag (scan, service_case, so_amendment, po_amendment,
   *  ack_escalation); null for a human post. */
  source?: string | null;
  attachments?: AnnAttachment[];
  mediaLayout?: AnnMediaLayout;
  translations?: BannerTranslations;
};

export type BannerResponse = {
  success?: boolean;
  data?: BannerAnnouncement[];
  ackedIds?: string[];
};

// Which slice of the feed a surface wants. The backend splits the SAME endpoint
// (routes/announcements.ts /banner): `human` = human-written posts, `system` =
// the machine-generated per-user scan / service-case notices. There is no
// "both" slice any more (owner 2026-08-08): machine notices must never pop a
// banner — they are bell material (NotificationBell on desktop, the
// Announcements-screen bell on the phone) — so the pop-up hook only ever asks
// for `human` and the backend's unscoped default IS the human slice.
export type BannerScope = "human" | "system";

// ONE React Query key namespace for every /api/announcements/banner read, so
// the desktop pop-up, the mobile pop-up, the mobile Announcements list and the
// mobile unread badge share one cache entry PER SCOPE instead of each fetching
// its own copy. Invalidate the bare prefix to refresh every scope at once.
export const ANNOUNCEMENT_FEED_KEY = ["announcements-feed"] as const;
export function announcementFeedKey(scope: BannerScope): string[] {
  return [...ANNOUNCEMENT_FEED_KEY, scope];
}

// 3 min, not 60s: announcements are not time-critical, and the backend caches
// the banner per-user for 5 min (CONFIG_CACHE_TTL_SECONDS.banner), so a 3-min
// poll lands mostly on cache hits and cuts the /banner call volume ~3x. Measured
// on prod 2026-08-20: each poll is ~360ms on a hit, ~950ms on a miss, and it was
// firing every 60s from every page.
const POLL_MS = 180_000;

// Local ack memo so the banner stays dismissed across reloads even before
// the next poll picks up the server's ackedIds.
const LOCAL_ACKS_KEY = "announcements:localAcks";

// Scoped by the bound user+company: on a shared browser an ack by one user must
// not silently hide an office notice from the next one. No identity bound yet
// (pre-/auth/me) → no key → the memo is simply empty, never cross-user.
// Parsing, capping and clock-skew rejection live in announcementLocalAcks so
// this hook and its tests share one definition of a valid ack map.
const localAcksStorageKey = () => identityStorageKey(LOCAL_ACKS_KEY);

// Skip counter (owner 2026-08-08): a notice may be waved away at most
// MAX_ANNOUNCEMENT_SKIPS times; from then on both shells drop every dismiss
// affordance and only the acknowledge action remains. Stored like the ack memo
// — the backend records acks, never dismissals — so the allowance is per
// browser+identity, not per account across devices.
const LOCAL_SKIPS_KEY = "announcements:localSkips";
const localSkipsStorageKey = () => identityStorageKey(LOCAL_SKIPS_KEY);

// "Waved away for now" ids. MODULE-level, not component state: the phone
// unmounts its pop-up whenever the shell navigates, and a notice the user has
// just dismissed must not spring straight back on the next mount. Page-lifetime
// only — nothing is persisted, so it re-surfaces on the next visit exactly as
// the desktop banner always has.
const dismissedThisSession = new Set<string>();

// Every mounted instance of this hook (the root modal, the Announcements
// page, the phone pop-up) must agree the moment ONE of them acks or postpones.
// They share localStorage and the dismiss set above, but a same-tab write
// fires no `storage` event, so the writer pings the others to re-read.
const instances = new Set<() => void>();
function notifyInstances(): void {
  for (const refresh of instances) refresh();
}

// The local ack stamp for a notice, or undefined when this device never
// acked it. A helper (not an index read) so the absent case is a real type —
// AnnouncementAcks is a Record, and a bare index reads as always-present.
function localAckAt(acks: AnnouncementAcks, id: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(acks, id) ? acks[id] : undefined;
}

// True when the office reminded the notice AFTER the local ack — i.e. the
// banner should re-surface even though we have a local ack stamp.
function isRemindedSince(
  remindedAt: string | null | undefined,
  ackedAtMs: number | undefined,
): boolean {
  if (!remindedAt || !ackedAtMs) return false;
  const r = Date.parse(remindedAt);
  if (Number.isNaN(r)) return false;
  return r > ackedAtMs;
}

// What the SECONDARY button means for a category. Only the meaning is shared —
// "view" navigates to the announcements surface, which is a different journey
// on each shell (a desktop route vs. pushing the mobile screen), so each
// surface performs it itself.
export function bannerSecondaryKind(
  category: AnnouncementCategory,
): "view" | "dismiss" {
  return category === "WARNING" || category === "SOP" ? "view" : "dismiss";
}

export type UseAnnouncementBanner = {
  /** The notice to pop right now, or null when there is nothing to show. Only
   *  a notice that REQUIRES acknowledgement ever pops (redesign 2026-09-04:
   *  WARNING / SOP, or the per-notice flag); GENERAL and LEARNING are read and
   *  acknowledged inline — in the inbox, the dashboard stack and the bell. */
  current: BannerAnnouncement | null;
  /** How many mandatory notices are still waiting on this reader (including
   *  `current` and any postponed this session) — the modal's "n of m pending". */
  pendingCount: number;
  /** 1-based position of `current` within that pending set, 0 when none. */
  pendingIndex: number;
  /** True when `current` has used its postponement — the surface must drop
   *  every dismiss affordance (secondary button, backdrop, close X) and offer
   *  only `ack`. `dismissSession` refuses anyway, so a missed call site cannot
   *  grant another skip. */
  mustAcknowledge: boolean;
  /** Whether a given notice may still be postponed (skip not yet spent). Lets
   *  the inbox's bottom bar show / hide its own "Remind later". */
  canPostpone: (a: BannerAnnouncement) => boolean;
  /** The feed slice itself — every deliverable notice ADDRESSED to this
   *  reader, newest first (the dashboard stack and the bell render it). */
  notices: BannerAnnouncement[];
  /** Ids of every notice in the feed slice — i.e. ADDRESSED to this reader.
   *  The Announcements page uses it to tell "pending for me" from "a notice I
   *  can read as a manager but never have to acknowledge". */
  addressedIds: ReadonlySet<string>;
  /** Ids this reader has acknowledged (local memo ∪ server), minus any the
   *  office has reminded since — the same answer `current` is computed from. */
  ackedIds: ReadonlySet<string>;
  /** Ids postponed this session (no ack recorded; back next visit). */
  postponedIds: ReadonlySet<string>;
  /** Record the acknowledgement (server + local memo) and hide the notice. */
  ack: (a: BannerAnnouncement) => Promise<void>;
  /** Postpone: hide for THIS session (no ack, re-surfaces next visit) and spend
   *  the single allowed skip. No-op once the limit is reached. */
  dismissSession: (a: BannerAnnouncement) => void;
  /** Hide for this session WITHOUT spending a skip — only for stepping aside
   *  while navigating the reader to the notice itself. */
  hideForNavigation: (a: BannerAnnouncement) => void;
};

export function useAnnouncementBanner(options?: {
  /** Feed slice to pop. Default `human` — machine-generated notices never pop
   *  a banner (owner 2026-08-08); they live in the notification bell. */
  scope?: BannerScope;
  /** Poll cadence. Default 60s (the desktop banner's original interval). */
  pollMs?: number;
}): UseAnnouncementBanner {
  const scope = options?.scope ?? "human";
  const pollMs = options?.pollMs ?? POLL_MS;
  const { user } = useAuth();
  const qc = useQueryClient();
  const [localAcks, setLocalAcks] = useState<AnnouncementAcks>(() =>
    readAnnouncementAcks(localAcksStorageKey()),
  );
  const [skips, setSkips] = useState<AnnouncementSkips>(() =>
    readAnnouncementSkips(localSkipsStorageKey()),
  );
  // Render-visible mirror of the module-level dismiss set, SEEDED from it so a
  // remount (the phone unmounting its pop-up on navigation) doesn't forget what
  // the user already waved away.
  const [dismissed, setDismissed] = useState<Set<string>>(
    () => new Set(dismissedThisSession),
  );

  // Silent by design — the banner is best-effort and must never bubble a fetch
  // error into the page (it is mounted at the app root). Any hiccup simply
  // leaves `data` undefined, i.e. no pop-up.
  const { data } = useQuery({
    queryKey: announcementFeedKey(scope),
    queryFn: () =>
      api.get<BannerResponse>(`/api/announcements/banner?scope=${scope}`),
    staleTime: pollMs,
    refetchInterval: pollMs,
    // The desktop banner polled with a plain setInterval, which kept ticking
    // while the tab was hidden; React Query pauses its interval on a hidden tab
    // unless told otherwise. Keeping it on preserves the old behaviour exactly
    // (an operator who leaves the ERP tab open all day still gets the notice).
    refetchIntervalInBackground: true,
    enabled: !!user?.id,
  });

  const rows = useMemo(() => data?.data ?? [], [data]);
  const serverAcked = useMemo(() => data?.ackedIds ?? [], [data]);

  // Reconcile server ackedIds INTO the local map (additive). Never delete a
  // local entry — the server is the lagging side; a flaky ack POST must not
  // cause an endless re-pop loop.
  useEffect(() => {
    if (serverAcked.length === 0) return;
    setLocalAcks((prev) => {
      let changed = false;
      const next = { ...prev };
      const now = Date.now();
      for (const id of serverAcked) {
        if (next[id] == null) {
          next[id] = now;
          changed = true;
        }
      }
      return changed
        ? mergeAndWriteAnnouncementAcks(localAcksStorageKey(), next)
        : prev;
    });
  }, [serverAcked]);

  // Another tab under the SAME identity acking or skipping a notice must not
  // leave this tab disagreeing about it. Only this identity's keys are watched.
  useEffect(() => {
    const ackKey = localAcksStorageKey();
    const skipKey = localSkipsStorageKey();
    if (!ackKey || !skipKey) return;
    const sync = (event: StorageEvent) => {
      if (event.storageArea !== localStorage) return;
      if (event.key === ackKey) setLocalAcks(readAnnouncementAcks(ackKey));
      if (event.key === skipKey) setSkips(readAnnouncementSkips(skipKey));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [user?.id]);

  // Same-tab sibling instances (see `instances`): re-read what another
  // instance just wrote. Guarded on the key — with no identity bound there is
  // nothing persisted to re-read, and reading "" would wipe in-memory state.
  useEffect(() => {
    const refresh = () => {
      const ackKey = localAcksStorageKey();
      const skipKey = localSkipsStorageKey();
      if (ackKey) setLocalAcks(readAnnouncementAcks(ackKey));
      if (skipKey) setSkips(readAnnouncementSkips(skipKey));
      setDismissed(new Set(dismissedThisSession));
    };
    instances.add(refresh);
    return () => {
      instances.delete(refresh);
    };
  }, []);

  // Everything still waiting on this reader: MANDATORY notices this device
  // hasn't acked (or that the office has reminded since the local ack). Newest
  // first per the server response. Postponed ones stay IN this list (they are
  // still pending — the counter must say so) but are skipped for `current`.
  const pending = useMemo(
    () =>
      rows.filter((a) => {
        if (!requiresAcknowledgement(a)) return false;
        const localAt = localAckAt(localAcks, a.id);
        if (localAt === undefined) return true; // never acked here
        return isRemindedSince(a.remindedAt, localAt); // re-pop
      }),
    [rows, localAcks],
  );
  const current = useMemo(
    () => pending.find((a) => !dismissed.has(a.id)) ?? null,
    [pending, dismissed],
  );
  const pendingIndex = current ? pending.indexOf(current) + 1 : 0;

  // The page-facing sets. `ackedIds` applies the SAME reminded-since rule as
  // `pending` above, so the inbox never badges Confirmed on a notice the modal
  // is about to re-pop.
  const addressedIds = useMemo(() => new Set(rows.map((a) => a.id)), [rows]);
  const ackedIds = useMemo(() => {
    const out = new Set<string>();
    for (const a of rows) {
      const localAt = localAckAt(localAcks, a.id);
      if (localAt !== undefined && !isRemindedSince(a.remindedAt, localAt)) out.add(a.id);
    }
    return out;
  }, [rows, localAcks]);

  // Hide for this session WITHOUT touching the skip counter — used by ack (the
  // notice is settled, not skipped) and by the mobile "View details" step-aside
  // (the reader is being sent TO the notice; the desktop twin of that button
  // counts nothing either, and the shells must agree on what a skip is).
  const hideForNavigation = useCallback((a: BannerAnnouncement) => {
    dismissedThisSession.add(a.id);
    setDismissed(new Set(dismissedThisSession));
    notifyInstances();
  }, []);

  const dismissSession = useCallback(
    (a: BannerAnnouncement) => {
      // Refused at the limit even if a surface still renders the control — the
      // rule lives here so neither shell can drift.
      if (skipLimitReached(skips, a.id)) return;
      setSkips(
        writeAnnouncementSkips(
          localSkipsStorageKey(),
          recordAnnouncementSkip(skips, a.id),
        ),
      );
      hideForNavigation(a); // also pings sibling instances
    },
    [skips, hideForNavigation],
  );

  const ack = useCallback(
    async (a: BannerAnnouncement) => {
      const now = Date.now();
      // Written to storage NOW (not inside a lazy state updater) so the
      // sibling instances pinged by hideForNavigation below re-read the ack
      // rather than the state before it. The helper merges with what is
      // already stored; the in-memory map keeps any entry it holds on top.
      const merged = mergeAndWriteAnnouncementAcks(localAcksStorageKey(), {
        [a.id]: now,
      });
      setLocalAcks((prev) => ({ ...prev, ...merged }));
      // Acknowledging settles the skip debt: a later office Remind re-pops the
      // notice with a fresh allowance instead of an instant hard-lock.
      setSkips(
        writeAnnouncementSkips(
          localSkipsStorageKey(),
          clearAnnouncementSkip(skips, a.id),
        ),
      );
      hideForNavigation(a); // also pings sibling instances
      try {
        await api.post(`/api/announcements/${a.id}/ack`);
      } catch {
        // silent-write-ok: OPTIMISTIC WITH RECONCILE — the same trade as
        // NotificationBell.markRead, and the same caveat. The local stamp keeps
        // the banner dismissed so a failing server cannot hard-lock the reader,
        // and the next reload reconciles the BANNER. It does not reconcile the
        // publisher's read-receipt list, which is the actual record.
      }
      // Every scope's ackedIds just changed, so refresh the whole namespace —
      // that is what drops the mobile unread badge immediately instead of
      // leaving a stale count up for a whole poll interval.
      void qc.invalidateQueries({ queryKey: ANNOUNCEMENT_FEED_KEY });
    },
    [skips, hideForNavigation, qc],
  );

  const mustAcknowledge = current != null && skipLimitReached(skips, current.id);
  const canPostpone = useCallback(
    (a: BannerAnnouncement) => !skipLimitReached(skips, a.id),
    [skips],
  );

  return {
    current,
    pendingCount: pending.length,
    pendingIndex,
    mustAcknowledge,
    canPostpone,
    notices: rows,
    addressedIds,
    ackedIds,
    postponedIds: dismissed,
    ack,
    dismissSession,
    hideForNavigation,
  };
}
