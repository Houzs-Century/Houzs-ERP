// ─────────────────────────────────────────────────────────────────────────
// useAmendmentApprovals — how many amendments are waiting for THIS user to
// sign, for the red counts on the "Sales Order Amendment" and "PO Amendments"
// sidebar entries.
//
// Owner 2026-09-09: "我需要这里有红色 1/2/3/4 根据目前还有多少单需要被审批 —
// 在需要审批人员账号显示, 审批后就根据目前需要的单号改变", then "PO Amendments
// 也一起加".
//
// The bell tells you an amendment ARRIVED; these say how many are still on your
// desk. Different questions, and the second has to be true whenever the sidebar
// is on screen — so it is a poll, not a memory of notices read.
//
// THE COUNT IS THE SERVER'S ANSWER, NOT A CLIENT FILTER. Each endpoint counts
// only what the caller can actually sign — the SO one splits by lane, the PO one
// has a single approver key — so someone without the key gets 0 and the badge
// never renders. A client-side count would need the whole list plus a copy of
// the lane→permission table, and that copy is exactly the thing that drifts.
//
// FRESHNESS. 60s poll, a refetch when the tab regains focus, and explicit
// invalidation from the approve / reject paths (both amendment query modules
// call it) so the number drops the moment you sign rather than up to a minute
// later — the "审批后就根据目前需要的单号改变" half of the ask.
// ─────────────────────────────────────────────────────────────────────────

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";

/** Shared keys so every reader hits one fetch, and any writer can invalidate. */
export const AMENDMENT_APPROVALS_KEY = ["scm", "amendment-approvals"] as const;
export const PO_AMENDMENT_APPROVALS_KEY = ["scm", "po-amendment-approvals"] as const;

interface PendingCountResponse {
  count: number;
}

/** The two badge sources a nav entry can name. Mirrored by NavTab["badge"]. */
export type ApprovalBadgeSource = "amendment-approvals" | "po-amendment-approvals";

/**
 * One poll per source. Returns 0 while loading and 0 on any failure — a
 * decoration on the chrome must never become an error state, and a badge
 * showing a stale-but-plausible number is worse than no badge.
 */
function usePendingCount(
  queryKey: readonly string[],
  path: string,
  enabled: boolean,
): number {
  const { data } = useQuery({
    queryKey,
    queryFn: () => api.get<PendingCountResponse>(path),
    enabled,
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    // Silent by design: a failed poll leaves `data` undefined, which reads as
    // "no badge", not "0 waiting". The sidebar says nothing rather than lying.
    retry: false,
  });
  const n = Number(data?.count);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Counts for every badge source, keyed so a nav entry can look itself up by the
 * name it declares. Returned as a map rather than two numbers because the
 * sidebar renders from a static tree: the entry says WHICH count it wants, and
 * the renderer does not need to know how many sources exist.
 */
export function useApprovalBadgeCounts(): Record<ApprovalBadgeSource, number> {
  const { user } = useAuth();
  const enabled = !!user?.id;
  return {
    "amendment-approvals": usePendingCount(
      AMENDMENT_APPROVALS_KEY,
      "/api/scm/so-amendments/pending-count",
      enabled,
    ),
    "po-amendment-approvals": usePendingCount(
      PO_AMENDMENT_APPROVALS_KEY,
      "/api/scm/po-amendments/pending-count",
      enabled,
    ),
  };
}

/**
 * Drop a count NOW, from wherever an amendment was just signed or refused.
 *
 * Exported so the key lives in one place: a screen that invalidated a key it
 * spelled slightly differently would leave the badge stale and look, from the
 * outside, exactly like the poll being slow.
 */
export function useRefreshApprovalBadges(): () => void {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: AMENDMENT_APPROVALS_KEY });
    void qc.invalidateQueries({ queryKey: PO_AMENDMENT_APPROVALS_KEY });
  };
}
