import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { identityStorageKey } from "../lib/storageIdentity";
import { useVisiblePoll } from "../lib/visiblePoll";
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
  bodyHtml?: string | null;
  createdAt: string | null;
  remindedAt: string | null;
  category?: AnnouncementCategory;
  requireAck?: boolean | null;
  createdByName?: string | null;
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

export const ANNOUNCEMENT_FEED_KEY = ["announcements-feed"] as const;
export function announcementFeedKey(scope: BannerScope): string[] {
  return [...ANNOUNCEMENT_FEED_KEY, scope];
}

const POLL_MS = 180_000;

const LOCAL_ACKS_KEY = "announcements:localAcks";

const localAcksStorageKey = () => identityStorageKey(LOCAL_ACKS_KEY);

// Skip counter (owner 2026-08-08): a notice may be waved away at most
// MAX_ANNOUNCEMENT_SKIPS times; from then on both shells drop every dismiss
// affordance and only the acknowledge action remains. Stored like the ack memo
// — the backend records acks, never dismissals — so the allowance is per
// browser+identity, not per account across devices.
const LOCAL_SKIPS_KEY = "announcements:localSkips";
const localSkipsStorageKey = () => identityStorageKey(LOCAL_SKIPS_KEY);

const dismissedThisSession = new Set<string>();

const instances = new Set<() => void>();
function notifyInstances(): void {
  for (const refresh of instances) refresh();
}

function localAckAt(acks: AnnouncementAcks, id: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(acks, id) ? acks[id] : undefined;
}

function isRemindedSince(
  remindedAt: string | null | undefined,
  ackedAtMs: number | undefined,
): boolean {
  if (!remindedAt || !ackedAtMs) return false;
  const r = Date.parse(remindedAt);
  if (Number.isNaN(r)) return false;
  return r > ackedAtMs;
}

export function bannerSecondaryKind(
  category: AnnouncementCategory,
): "view" | "dismiss" {
  return category === "WARNING" || category === "SOP" ? "view" : "dismiss";
}

export type UseAnnouncementBanner = {
  current: BannerAnnouncement | null;
  pendingCount: number;
  pendingIndex: number;
  mustAcknowledge: boolean;
  canPostpone: (a: BannerAnnouncement) => boolean;
  notices: BannerAnnouncement[];
  addressedIds: ReadonlySet<string>;
  ackedIds: ReadonlySet<string>;
  postponedIds: ReadonlySet<string>;
  ack: (a: BannerAnnouncement) => Promise<void>;
  dismissSession: (a: BannerAnnouncement) => void;
  hideForNavigation: (a: BannerAnnouncement) => void;
};

export function useAnnouncementBanner(options?: {
  /** Feed slice to pop. Default `human` — machine-generated notices never pop
   *  a banner (owner 2026-08-08); they live in the notification bell. */
  scope?: BannerScope;
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
  const [dismissed, setDismissed] = useState<Set<string>>(
    () => new Set(dismissedThisSession),
  );

  const { data } = useQuery({
    queryKey: announcementFeedKey(scope),
    queryFn: () =>
      api.get<BannerResponse>(`/api/announcements/banner?scope=${scope}`),
    staleTime: pollMs,
    enabled: !!user?.id,
  });
  useVisiblePoll(announcementFeedKey(scope), pollMs, !!user?.id);

  const rows = useMemo(() => data?.data ?? [], [data]);
  const serverAcked = useMemo(() => data?.ackedIds ?? [], [data]);

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

  const pending = useMemo(
    () =>
      rows.filter((a) => {
        if (!requiresAcknowledgement(a)) return false;
        const localAt = localAckAt(localAcks, a.id);
        if (localAt === undefined) return true;
        return isRemindedSince(a.remindedAt, localAt);
      }),
    [rows, localAcks],
  );
  const current = useMemo(
    () => pending.find((a) => !dismissed.has(a.id)) ?? null,
    [pending, dismissed],
  );
  const pendingIndex = current ? pending.indexOf(current) + 1 : 0;

  const addressedIds = useMemo(() => new Set(rows.map((a) => a.id)), [rows]);
  const ackedIds = useMemo(() => {
    const out = new Set<string>();
    for (const a of rows) {
      const localAt = localAckAt(localAcks, a.id);
      if (localAt !== undefined && !isRemindedSince(a.remindedAt, localAt)) out.add(a.id);
    }
    return out;
  }, [rows, localAcks]);

  const hideForNavigation = useCallback((a: BannerAnnouncement) => {
    dismissedThisSession.add(a.id);
    setDismissed(new Set(dismissedThisSession));
    notifyInstances();
  }, []);

  const dismissSession = useCallback(
    (a: BannerAnnouncement) => {
      if (skipLimitReached(skips, a.id)) return;
      setSkips(
        writeAnnouncementSkips(
          localSkipsStorageKey(),
          recordAnnouncementSkip(skips, a.id),
        ),
      );
      hideForNavigation(a);
    },
    [skips, hideForNavigation],
  );

  const ack = useCallback(
    async (a: BannerAnnouncement) => {
      const now = Date.now();
      const merged = mergeAndWriteAnnouncementAcks(localAcksStorageKey(), {
        [a.id]: now,
      });
      setLocalAcks((prev) => ({ ...prev, ...merged }));
      setSkips(
        writeAnnouncementSkips(
          localSkipsStorageKey(),
          clearAnnouncementSkip(skips, a.id),
        ),
      );
      hideForNavigation(a);
      try {
        await api.post(`/api/announcements/${a.id}/ack`);
      } catch {
        // silent-write-ok: OPTIMISTIC WITH RECONCILE — the same trade as
        // NotificationBell.markRead, and the same caveat. The local stamp keeps
        // the banner dismissed so a failing server cannot hard-lock the reader,
        // and the next reload reconciles the BANNER. It does not reconcile the
        // publisher's read-receipt list, which is the actual record.
      }
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
