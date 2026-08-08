import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import {
  announcementFeedKey,
  type BannerResponse,
  type BannerScope,
} from "../components/useAnnouncementBanner";

// One scope's un-acked count. Shares the query KEY with the MobileAnnouncements
// list / bell and the pop-up (announcementFeedKey), so React Query fetches each
// scope ONCE however many surfaces are mounted; polls 30s (the notifications
// cadence) so the badge stays live app-wide. Fail-soft: any hiccup leaves
// `data` undefined and yields 0 — a failed poll must never invent a number.
function useScopeUnread(scope: BannerScope): number {
  const { user } = useAuth();
  const { data } = useQuery({
    queryKey: announcementFeedKey(scope),
    queryFn: () =>
      api.get<BannerResponse>(`/api/announcements/banner?scope=${scope}`),
    staleTime: 30_000,
    refetchInterval: 30_000,
    enabled: !!user?.id,
  });
  const acked = new Set(data?.ackedIds ?? []);
  return (data?.data ?? []).filter((a) => !acked.has(a.id)).length;
}

// App-wide un-acked announcement count. Drives the GLOBAL unread badge on the
// Announcements entry (the Profile bottom tab + the Profile > Announcements
// row) so a phone user sees something waiting without opening the screen.
//
// It used to count the SYSTEM scope only (scan / service-case per-user
// notices), so a human-written broadcast — the thing the office actually
// publishes — contributed NOTHING: no pop-up, no dot, no way to learn it
// existed short of walking into Profile > Announcements (owner 2026-07-21).
// It now counts BOTH halves of the feed; both are things the user has not read.
//
// Two scoped reads rather than one unscoped read, because these are the SAME
// two queries the Announcements screen and the pop-up already run — the badge
// therefore adds no network of its own. Acking anywhere invalidates the whole
// feed-key namespace, so the badge drops immediately instead of after a poll.
export function useAnnouncementUnread(): number {
  const human = useScopeUnread("human");
  const system = useScopeUnread("system");
  return human + system;
}
