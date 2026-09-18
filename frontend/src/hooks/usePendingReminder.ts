import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { identityStorageKey } from "../lib/storageIdentity";
import { booleanPreference, useIdentityPreference } from "./useIdentityPreference";
import { buildDigest, localToday, seenKey, type PendingDigest, type PendingRow } from "./pendingDigest";

/** Daily "you still owe work" reminder (owner 2026-09-09).
 *
 *  Deliberately NOT a cron and NOT a stored notification: it asks the SAME
 *  endpoint the My Pending list asks, so the popup can never disagree with the
 *  screen it sends you to, there is no job that can silently stop, and a user
 *  who is away for three days still gets it the moment they return. See
 *  pendingDigest.ts for why the thirteen role lanes are not re-implemented.
 */
const PAGE = 100;

export type PendingReminder = {
  digest: PendingDigest | null;
  /** Show the modal? False once acknowledged today, or when nothing is due. */
  open: boolean;
  /** "Got it" — quiet until tomorrow. */
  acknowledge: () => void;
  /** "Remind later" — quiet for THIS tab only; returns on the next login. */
  postpone: () => void;
  /** Turn the list's My-Pending filter on, so the destination matches. */
  armMyPendingFilter: () => void;
};

export function usePendingReminder(): PendingReminder {
  const { user } = useAuth();
  const today = localToday();
  const base = identityStorageKey("pending-reminder");
  const key = seenKey(base, today);

  const [acked, setAcked] = useState<boolean>(() => {
    try {
      return !!key && localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  const [postponed, setPostponed] = useState(false);

  // Only ask once the user is known — an anonymous call would 401 and, worse,
  // could not be scoped to anyone. `enabled` also keeps it off the login screen.
  const q = useQuery<{ data: PendingRow[]; total: number }>({
    queryKey: ["pending-reminder", user?.id ?? 0, today],
    queryFn: () => api.get(`/api/projects?my_pending=1&per_page=${PAGE}&page=1`),
    enabled: !!user?.id && !acked,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const digest = useMemo(
    () => (q.data?.data ? buildDigest(q.data.data, today) : null),
    [q.data, today],
  );

  const acknowledge = useCallback(() => {
    setAcked(true);
    try {
      if (key) localStorage.setItem(key, "1");
    } catch {
      // Storage unavailable (private window): the reminder simply returns on
      // the next load rather than being lost — the safer direction.
    }
  }, [key]);

  const postpone = useCallback(() => setPostponed(true), []);

  // Set through the SAME hook the Project List reads, not by poking localStorage:
  // the key shape and the same-tab wake-up event are that hook's private
  // business, and a hand-copied constant here is how two surfaces drift.
  const [, setMyPending] = useIdentityPreference("projects:myPending", false, booleanPreference);
  const armMyPendingFilter = useCallback(() => setMyPending(true), [setMyPending]);

  return {
    digest,
    open: !acked && !postponed && !!digest && digest.total > 0,
    acknowledge,
    postpone,
    armMyPendingFilter,
  };
}
