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
  project_start_date: string | null;
  project_end_date: string | null;
}

export interface NotificationsPayload {
  feed: NotificationItem[];
  unread_by_project: Record<number, number>;
  total_unread: number;
  points_balance?: number;
  gifting_balance?: number;
  current_streak?: number;
}

interface Ctx {
  feed: NotificationItem[];
  unreadByProject: Record<number, number>;
  totalUnread: number;
  loadFailed: boolean;
  reload: () => void;
  markAllRead: () => Promise<{ ok: number; failed: number }>;
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

const POLL_INTERVAL_MS = 60_000;
const RETURN_MIN_AGE_MS = 15_000;

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [feed, setFeed] = useState<NotificationItem[]>([]);
  const [unreadByProject, setUnread] = useState<Record<number, number>>({});
  const [totalUnread, setTotal] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [lastTick, setLastTick] = useState(0);
  const [pointsBalance, setPoints] = useState(0);
  const [giftingBalance, setGifting] = useState(0);
  const [currentStreak, setStreak] = useState(0);
  const timerRef = useRef<number | null>(null);
  const lastPayloadSigRef = useRef<string | null>(null);

  const inFlightRef = useRef(false);
  const againRef = useRef(false);
  const lastSettledAtRef = useRef(0);

  const fetchOnce = useCallback(async (afterWrite = false): Promise<void> => {
    if (!user?.id) return;
    if (inFlightRef.current) {
      if (afterWrite) againRef.current = true;
      return;
    }
    inFlightRef.current = true;
    try {
      const r = await api.get<NotificationsPayload>(
        "/api/notifications?unread=1&limit=20"
      );
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
      setLastTick(Date.now());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    } finally {
      inFlightRef.current = false;
      lastSettledAtRef.current = Date.now();
    }
    if (againRef.current) {
      againRef.current = false;
      await fetchOnce(true);
    }
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) {
      setFeed([]);
      setUnread({});
      setTotal(0);
      lastPayloadSigRef.current = null;
      return;
    }
    void fetchOnce();
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
      if (!document.hidden && Date.now() - lastSettledAtRef.current >= RETURN_MIN_AGE_MS) {
        void fetchOnce();
      }
      schedule();
    }
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [user?.id, fetchOnce]);

  const markAllRead = useCallback(async (): Promise<{ ok: number; failed: number }> => {
    const ids = Object.entries(unreadByProject)
      .filter(([, n]) => n > 0)
      .map(([id]) => Number(id));
    if (!ids.length) return { ok: 0, failed: 0 };
    const results = await Promise.allSettled(
      ids.map((id) => api.post(`/api/projects/${id}/read`, {})),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    void fetchOnce(true);
    return { ok: results.length - failed, failed };
  }, [unreadByProject, fetchOnce]);

  const reload = useCallback(() => void fetchOnce(true), [fetchOnce]);

  const value = useMemo<Ctx>(
    () => ({
      feed,
      unreadByProject,
      totalUnread,
      loadFailed,
      reload,
      markAllRead,
      pointsBalance,
      giftingBalance,
      currentStreak,
    }),
    [feed, unreadByProject, totalUnread, loadFailed, reload, markAllRead, pointsBalance, giftingBalance, currentStreak],
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
