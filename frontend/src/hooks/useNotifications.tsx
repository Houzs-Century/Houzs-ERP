import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";

// ── Types ────────────────────────────────────────────────────

export interface NotificationItem {
  id: number;
  project_id: number;
  project_code: string | null;
  project_name: string | null;
  brand: string | null;
  action: string;
  from_value: string | null;
  to_value: string | null;
  note: string | null;
  user_id: number | null;
  user_name: string | null;
  user_email: string | null;
  user_profile_pic_r2_key: string | null;
  created_at: string;
  /** Project's event start date — joined in by the notifications
   *  query so the floating chat list can show the event date next to
   *  the project code. ISO yyyy-mm-dd or null for unscheduled. */
  project_start_date: string | null;
  project_end_date: string | null;
}

export interface NotificationsPayload {
  feed: NotificationItem[];
  unread_by_project: Record<number, number>;
  total_unread: number;
  // Houzs Points (mig 055) snapshot — piggybacks the same poll
  // cadence so the topbar chip + gamification page header don't need
  // a second round-trip.
  points_balance?: number;
  gifting_balance?: number;
  current_streak?: number;
}

interface Ctx {
  feed: NotificationItem[];
  unreadByProject: Record<number, number>;
  totalUnread: number;
  /* True once a poll has failed and we have never successfully loaded, i.e.
     `feed: []` means "we don't know", not "there is nothing". Consumers MUST
     consult this before rendering a reassuring empty state: the inbox used to
     tell people "You're all caught up." on a failed read, which is the single
     most misleading thing this app can say — it is the screen operators use to
     decide whether anything needs their attention. */
  loadFailed: boolean;
  reload: () => void;
  /**
   * Mark every project carrying unread activity as read, then refresh.
   *
   * WHY IT LIVES HERE rather than on a screen. This action existed only on the
   * phone: `MobileInbox` looped the endpoint itself, and the desktop
   * Notifications page — the one the bell's "view all" lands on — had no write
   * at all. Both surfaces already consume this provider, so putting the loop on
   * the desktop page too would have made two copies of one rule. One
   * implementation, one error contract, two callers.
   *
   * It RETURNS COUNTS, and that is the part that is not a tidy-up. The mobile
   * version ended each request with `.catch(() => {})`, so a bulk mark-read
   * that failed for every project was indistinguishable from one that worked —
   * the spinner stopped, the feed reloaded, the badge stayed up, and nothing
   * was said. A failure that reaches nobody is worse than a crash. Callers get
   * `{ ok, failed }` and are expected to render `failed > 0`.
   */
  markAllRead: () => Promise<{ ok: number; failed: number }>;
  // Houzs Points — present once the first poll lands.
  pointsBalance: number;
  giftingBalance: number;
  currentStreak: number;
}

const NotificationsContext = createContext<Ctx>({
  feed: [],
  unreadByProject: {},
  totalUnread: 0,
  loadFailed: false,
  reload: () => {},
  markAllRead: async () => ({ ok: 0, failed: 0 }),
  pointsBalance: 0,
  giftingBalance: 0,
  currentStreak: 0,
});

/* lastTick lives in its OWN context (2026-07-19 perf).
   -------------------------------------------------------------------------
   It is a POLL HEARTBEAT: it changes every 30s by definition, whether or not
   anything about the notifications actually changed. While it sat in the main
   context value, that value was a new object every 30 seconds, so all EIGHT
   consumers of useNotifications() re-rendered on a fixed timer — forever, on
   every page. Two of those consumers are the heaviest trees in the app
   (pages/Projects.tsx and the Layout's MobileTabBar), and the provider is
   mounted at the App root, so the whole screen paid a re-render every half
   minute regardless of what the user was doing. That is a timer-driven 卡顿
   with no data behind it.

   Exactly ONE consumer needs the heartbeat — components/BrowserPushSink.tsx,
   which renders null and uses it to decide whether to fire an OS banner. Giving
   it a dedicated context means the tick re-renders that one null-rendering
   component and nothing else.

   The heartbeat is deliberately still set on EVERY poll, even when the payload
   is unchanged. BrowserPushSink's priming step (`!primed && lastTick > 0`)
   depends on the tick advancing after the first successful poll, and a first
   poll that legitimately returns an empty feed must still prime — otherwise the
   next poll's items would be silently marked seen instead of notified. */
const NotificationsTickContext = createContext<number>(0);

// ── Provider ─────────────────────────────────────────────────
// One poller per app, driven by the signed-in user's session.
// Backs off when the tab is hidden (Page Visibility API) so
// background tabs don't burn requests. Polls every 30s by default.

const POLL_INTERVAL_MS = 30_000;

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [feed, setFeed] = useState<NotificationItem[]>([]);
  const [unreadByProject, setUnread] = useState<Record<number, number>>({});
  const [totalUnread, setTotal] = useState(0);
  /* Sticky until a poll succeeds. A later poll clearing it is exactly right:
     once we have real data the feed is authoritative again. */
  const [loadFailed, setLoadFailed] = useState(false);
  const [lastTick, setLastTick] = useState(0);
  const [pointsBalance, setPoints] = useState(0);
  const [giftingBalance, setGifting] = useState(0);
  const [currentStreak, setStreak] = useState(0);
  const timerRef = useRef<number | null>(null);
  /* Signature of the last payload we committed to state, so an unchanged poll
     is a no-op instead of a new object identity. A ref, not state — writing it
     must not itself cause a render. */
  const lastPayloadSigRef = useRef<string | null>(null);

  const fetchOnce = useCallback(async () => {
    if (!user?.id) return;
    try {
      // Bell shows unread-only. /notifications page fetches its own
      // unfiltered feed separately; the unread_by_project map returned
      // here is the same either way and still drives the list dots.
      const r = await api.get<NotificationsPayload>(
        "/api/notifications?unread=1&limit=20"
      );
      /* Only push state when the payload ACTUALLY changed (2026-07-19 perf).
         `setFeed(r.feed)` stored a brand-new array every 30 seconds even when
         the server returned byte-identical rows, and a new array identity is a
         new context value, which re-rendered every consumer on a timer. The
         common case by far is "nothing happened since the last poll", so a
         cheap identity check on a ≤20-row payload buys back an app-wide render
         every half minute for the cost of one JSON.stringify.
         Note this compares the RAW payload, not derived state, so it cannot
         drift from what the setters below write. */
      const sig = JSON.stringify([
        r.feed,
        r.unread_by_project,
        r.total_unread,
        r.points_balance,
        r.gifting_balance,
        r.current_streak,
      ]);
      if (sig !== lastPayloadSigRef.current) {
        lastPayloadSigRef.current = sig;
        setFeed(r.feed);
        setUnread(r.unread_by_project);
        setTotal(r.total_unread);
        if (typeof r.points_balance === "number") setPoints(r.points_balance);
        if (typeof r.gifting_balance === "number") setGifting(r.gifting_balance);
        if (typeof r.current_streak === "number") setStreak(r.current_streak);
      }
      /* Heartbeat advances on EVERY successful poll regardless — see the comment
         on NotificationsTickContext for why BrowserPushSink needs that. It is in
         its own context, so this line no longer re-renders the app. */
      setLastTick(Date.now());
      setLoadFailed(false);
    } catch {
      /* Still swallowed as far as toasts go — a background poll must not throw
         noise at the user every 30s. But it is no longer invisible: the flag
         lets the inbox say "we couldn't load this" instead of asserting that
         there is nothing waiting. Silence and emptiness are different answers. */
      setLoadFailed(true);
    }
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) {
      setFeed([]);
      setUnread({});
      setTotal(0);
      /* Clear the signature too, or the next user to sign in on this tab whose
         first payload happens to equal the previous user's would be skipped and
         see the cleared-out empty state. */
      lastPayloadSigRef.current = null;
      return;
    }
    fetchOnce();
    function schedule() {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      if (document.hidden) return;
      timerRef.current = window.setTimeout(async () => {
        await fetchOnce();
        schedule();
      }, POLL_INTERVAL_MS);
    }
    schedule();
    function onVis() {
      if (!document.hidden) {
        fetchOnce();
      }
      schedule();
    }
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [user?.id, fetchOnce]);

  /* Memoised so the value's identity changes only when the DATA changes. An
     inline object literal here was a new value on every render of this provider
     — and the provider sits at the App root, so it re-renders whenever anything
     above it does. Together with the unchanged-payload skip above, a consumer
     now re-renders only when its notifications genuinely moved.
     `fetchOnce` is already a useCallback keyed on user?.id, so it is stable. */
  /* One request per project that ACTUALLY has unread items. Projects sitting at
     zero are skipped — posting for them is a round-trip that changes nothing,
     and on a busy roster that is most of the list.

     `allSettled`, not `all`: one project refusing (a permission the caller lost
     since the feed was fetched) must not abandon the rest half-done. The
     rejected count is returned rather than swallowed — see the Ctx doc. */
  const markAllRead = useCallback(async (): Promise<{ ok: number; failed: number }> => {
    const ids = Object.entries(unreadByProject)
      /* No `?? 0` — `unreadByProject` is Record<number, number>, so the guard
         was unreachable and the linter is right. A null slipping through from a
         malformed payload compares false here either way. */
      .filter(([, n]) => n > 0)
      .map(([id]) => Number(id));
    if (!ids.length) return { ok: 0, failed: 0 };
    const results = await Promise.allSettled(
      ids.map((id) => api.post(`/api/projects/${id}/read`, {})),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    /* Refresh even on a partial failure — the ones that DID succeed are read
       now, and leaving the badge stale would misreport them as unread.
       `void`: the refresh is fire-and-forget on purpose. Its own failure path
       is `loadFailed`, which the feed already renders; making the caller wait
       on it would tie the mark-read result to an unrelated poll. */
    void fetchOnce();
    return { ok: results.length - failed, failed };
  }, [unreadByProject, fetchOnce]);

  const value = useMemo<Ctx>(
    () => ({
      feed,
      unreadByProject,
      totalUnread,
      loadFailed,
      reload: fetchOnce,
      markAllRead,
      pointsBalance,
      giftingBalance,
      currentStreak,
    }),
    [feed, unreadByProject, totalUnread, loadFailed, fetchOnce, markAllRead, pointsBalance, giftingBalance, currentStreak],
  );

  return (
    <NotificationsContext.Provider value={value}>
      <NotificationsTickContext.Provider value={lastTick}>
        {children}
      </NotificationsTickContext.Provider>
    </NotificationsContext.Provider>
  );
}

export function useNotifications(): Ctx {
  return useContext(NotificationsContext);
}

/** The poll heartbeat — advances on every successful poll. Subscribe ONLY if you
 *  need to react to "a poll happened" rather than to the data itself; it changes
 *  every 30s by design, so any component reading it re-renders on that timer.
 *  Today that is BrowserPushSink alone, which renders null. */
export function useNotificationsTick(): number {
  return useContext(NotificationsTickContext);
}
