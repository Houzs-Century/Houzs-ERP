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
// FRESHNESS. One combined read every 60s while the tab is visible (and once on
// return to it), plus explicit invalidation from the approve / reject paths
// (both amendment query modules call it), so the number drops the moment you
// sign rather than up to a minute later.
// ─────────────────────────────────────────────────────────────────────────

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useItSupportConnected } from "./useItSupportConnected";
import { useVisiblePoll } from "../lib/visiblePoll";
import { SO_AMENDMENT_LANE_APPROVE_PERM } from "../vendor/scm/lib/amendment-approver";
import { approveKeysFor } from "../vendor/scm/lib/document-cancel-keys";

/* Who can have a non-zero count. The endpoints answer 0 to anyone else, and the
   area guard in front of them answers 403 to a caller without the SO / PO area
   (production, 7 days: 919 refused po-amendment counts from 18 users), so
   nobody else is asked. Same keys the handlers count by. */
const SO_AMENDMENT_COUNT_KEYS = [
  ...Object.values(SO_AMENDMENT_LANE_APPROVE_PERM),
  "scm.amendment.approve_so",
  ...approveKeysFor("so"),
];
const PO_AMENDMENT_COUNT_KEY = "scm.po_amendment.approve";

/** Shared keys so every reader hits one fetch, and any writer can invalidate. */
export const AMENDMENT_APPROVALS_KEY = ["scm", "amendment-approvals"] as const;
export const PO_AMENDMENT_APPROVALS_KEY = ["scm", "po-amendment-approvals"] as const;
/* Payment backdate requests (owner 2026-09-30: 「sidebar 红点」) — counted for
   the admins who decide them, `*` included (see backdateRequestNotify.ts). */
export const PAYMENT_BACKDATE_APPROVALS_KEY = ["scm", "payment-backdate-approvals"] as const;
/* Payment requests waiting for Finance (owner 2026-10-08: 提醒我有几个payment
   request 还没proceed) — under the request queries' own key, so every request
   write (vendor/scm/lib/payment-request-queries.ts) refreshes it, and so do the
   voucher and AP invoice writes that answer or re-open a request. */
export const PAYMENT_REQUESTS_WAITING_KEY = ["payment-requests", "waiting-count"] as const;
const PAYMENT_REQUESTS_WAITING_PATH = "/api/scm/payment-requests/waiting-count";
/* IT Support: the person's requests IT has answered since they last opened them.
   Opening one marks it seen on the hub, so the request screens refresh this key. */
export const IT_SUPPORT_UNREAD_KEY = ["it-support", "unread-count"] as const;
/* Orders with no fair link (owner 2026-10-19: 「先做 Fair links to settle 菜单」).
   Under the page's own query key prefix ['fair-pending'], so settling an order
   there (vendor/scm/lib/fair-options-queries.ts useAssignFair) moves the badge. */
export const FAIR_LINKS_TO_SETTLE_KEY = ["fair-pending", "count"] as const;
const FAIR_LINKS_TO_SETTLE_PATH = "/api/scm/mfg-sales-orders/fair-pending/count";
/** Finance's To do (the Claude Design redesign, 2026-11-02): jobs waiting on the viewer. */
export const FINANCE_TODO_COUNT_KEY = ["finance-todo", "count"] as const;
const FINANCE_TODO_COUNT_PATH = "/api/scm/accounting/todo/count";
/* Product requests waiting for the Purchaser (HC-0136: 「same like SO amendment」).
   Under the request queries' own prefix ['product-requests'], so every request
   write (vendor/scm/lib/product-request-queries.ts) moves the badge. */
export const PRODUCT_REQUEST_APPROVALS_KEY = ["product-requests", "pending-count"] as const;
const IT_SUPPORT_UNREAD_PATH = "/api/it-support/unread-count";

interface PendingCountResponse {
  count: number;
}

/** The badge sources a nav entry can name. Mirrored by NavTab["badge"]. */
export type ApprovalBadgeSource =
  | "amendment-approvals" | "po-amendment-approvals" | "payment-backdate-approvals" | "payment-requests-waiting" | "it-support-replies"
  | "fair-links-to-settle" | "product-request-approvals" | "finance-todo";

/** What the count is, in the entry's tooltip ("Payment Requests · 3 waiting for Finance"). */
export const BADGE_MEANING: Record<ApprovalBadgeSource, string> = {
  "amendment-approvals": "awaiting your approval",
  "po-amendment-approvals": "awaiting your approval",
  "payment-backdate-approvals": "awaiting your approval",
  "payment-requests-waiting": "waiting for Finance",
  "it-support-replies": "with a new reply from IT",
  "fair-links-to-settle": "orders with no fair",
  "product-request-approvals": "awaiting your approval",
  "finance-todo": "waiting on you",
};

/** How often the sidebar counts are re-read while the tab is visible. */
export const BADGE_POLL_MS = 60_000;
/** The combined read — GET /api/badge-counts (backend routes/badgeCounts.ts). */
export const BADGE_COUNTS_KEY = ["badge-counts"] as const;

/** Each source's own key and endpoint. The key is what writers invalidate. */
const SOURCES: Record<ApprovalBadgeSource, { key: readonly string[]; path: string }> = {
  "amendment-approvals": { key: AMENDMENT_APPROVALS_KEY, path: "/api/scm/so-amendments/pending-count" },
  "po-amendment-approvals": { key: PO_AMENDMENT_APPROVALS_KEY, path: "/api/scm/po-amendments/pending-count" },
  "payment-backdate-approvals": {
    key: PAYMENT_BACKDATE_APPROVALS_KEY,
    path: "/api/scm/payment-backdate-requests/pending-count",
  },
  "payment-requests-waiting": { key: PAYMENT_REQUESTS_WAITING_KEY, path: PAYMENT_REQUESTS_WAITING_PATH },
  "it-support-replies": { key: IT_SUPPORT_UNREAD_KEY, path: IT_SUPPORT_UNREAD_PATH },
  "fair-links-to-settle": { key: FAIR_LINKS_TO_SETTLE_KEY, path: FAIR_LINKS_TO_SETTLE_PATH },
  "product-request-approvals": { key: PRODUCT_REQUEST_APPROVALS_KEY, path: "/api/scm/product-requests/pending-count" },
  "finance-todo": { key: FINANCE_TODO_COUNT_KEY, path: FINANCE_TODO_COUNT_PATH },
};

/** Sidebar order; also the order of the combined request's `sources`. */
const SOURCE_ORDER = Object.keys(SOURCES) as ApprovalBadgeSource[];

interface BadgeCountsResponse {
  counts?: Partial<Record<ApprovalBadgeSource, number | null>>;
}

/**
 * One count, under its own key. Returns 0 while loading and 0 on any failure —
 * a decoration on the chrome must never become an error state, and a badge
 * showing a stale-but-plausible number is worse than no badge.
 *
 * `pollMs`: this key's own visible-only poll, or `false` when the sidebar's
 * combined read keeps it fresh. Either way the key stays a live query, so a
 * writer that invalidates it re-reads just this count at once.
 */
function usePendingCount(
  source: ApprovalBadgeSource,
  enabled: boolean,
  pollMs: number | false,
  /** A page that reminds about the count reads it fresh on arrival (0 = on every mount). */
  staleTime: number = 2 * BADGE_POLL_MS,
): number {
  const { key, path } = SOURCES[source];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api.get<PendingCountResponse>(path),
    enabled,
    staleTime,
    // Silent by design: a failed poll leaves `data` undefined, which reads as
    // "no badge", not "0 waiting". The sidebar says nothing rather than lying.
    retry: false,
  });
  useVisiblePoll(key, pollMs, enabled);
  const n = Number(data?.count);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Counts for every badge source, keyed so a nav entry can look itself up by the
 * name it declares. Returned as a map rather than two numbers because the
 * sidebar renders from a static tree: the entry says WHICH count it wants, and
 * the renderer does not need to know how many sources exist.
 *
 * ONE REQUEST A MINUTE (2026-11-10). Every count used to poll its own endpoint
 * every minute from every open page. Now one combined read
 * (GET /api/badge-counts) answers them all, while the tab is visible, and
 * writes each answer into that count's own key. The per-count queries wait
 * for that first answer, so a page load costs one request, not eight.
 *
 * Correctness is unchanged: the server runs each count through its own
 * endpoint and gates, and a writer invalidating a count's key still re-reads
 * that count alone the moment it changes. If the combined read fails (a
 * backend that does not have it yet), each count falls back to its own minute
 * poll — the old behaviour.
 */
export function useApprovalBadgeCounts(): Record<ApprovalBadgeSource, number> {
  const { user, can } = useAuth();
  const qc = useQueryClient();
  const enabled = !!user?.id;
  const itConnected = useItSupportConnected();

  /* Who is polled for what. Each gate is the one the count had on its own. */
  const wanted: Record<ApprovalBadgeSource, boolean> = {
    "amendment-approvals": enabled && SO_AMENDMENT_COUNT_KEYS.some((k) => can(k)),
    "po-amendment-approvals": enabled && can(PO_AMENDMENT_COUNT_KEY),
    /* Only an admin can have a non-zero count, so nobody else is polled. */
    "payment-backdate-approvals":
      enabled && (can("scm.payment.backdate") || can("scm.payment.backdate.approve")),
    /* Finance answers requests; nobody else is polled (the server says 0 to them anyway). */
    "payment-requests-waiting": enabled && can("scm.payment_voucher.create"),
    /* Everyone reports to IT; nobody is polled where the hub is not connected. */
    "it-support-replies": enabled && itConnected,
    /* SCM staff only — the same permission the entry asks for. The count is the
       page's own list, company-scoped by the server. */
    "fair-links-to-settle": enabled && can("scm.access"),
    "product-request-approvals": enabled && can("scm.product_request.approve"),
    /* Finance only — the people who work its To do. */
    "finance-todo": enabled && (can("scm.payment_voucher.create") || can("scm.payment_voucher.post")),
  };
  const sources = SOURCE_ORDER.filter((s) => wanted[s]);
  const sourcesParam = sources.join(",");
  const batchKey = [...BADGE_COUNTS_KEY, sourcesParam];

  const batch = useQuery({
    queryKey: batchKey,
    queryFn: async () => {
      const startedAt = Date.now();
      const res = await api.get<BadgeCountsResponse>(`/api/badge-counts?sources=${sourcesParam}`);
      for (const s of sources) {
        const n = res.counts?.[s];
        /* That count failed (its own gate refused, most often). Record "no badge"
           so the per-count query below does not re-ask the same endpoint directly
           on every page load and collect the same refusal. */
        if (typeof n !== "number") {
          if (qc.getQueryData(SOURCES[s].key) === undefined) qc.setQueryData(SOURCES[s].key, { count: 0 });
          continue;
        }
        /* A count re-read on its own after this request left (a writer's
           invalidation) is newer than this answer; do not put the old number back. */
        const own = qc.getQueryState(SOURCES[s].key);
        if (own && own.dataUpdatedAt > startedAt) continue;
        qc.setQueryData(SOURCES[s].key, { count: n });
      }
      return res;
    },
    enabled: sources.length > 0,
    staleTime: BADGE_POLL_MS,
    retry: false,
  });
  useVisiblePoll(batchKey, BADGE_POLL_MS, sources.length > 0);

  const batchSettled = batch.data !== undefined || batch.isError;
  const ownPoll = batch.isError ? BADGE_POLL_MS : false;

  return {
    "amendment-approvals": usePendingCount("amendment-approvals", wanted["amendment-approvals"] && batchSettled, ownPoll),
    "po-amendment-approvals": usePendingCount(
      "po-amendment-approvals",
      wanted["po-amendment-approvals"] && batchSettled,
      ownPoll,
    ),
    "payment-backdate-approvals": usePendingCount(
      "payment-backdate-approvals",
      wanted["payment-backdate-approvals"] && batchSettled,
      ownPoll,
    ),
    "payment-requests-waiting": usePendingCount(
      "payment-requests-waiting",
      wanted["payment-requests-waiting"] && batchSettled,
      ownPoll,
    ),
    "it-support-replies": usePendingCount("it-support-replies", wanted["it-support-replies"] && batchSettled, ownPoll),
    "fair-links-to-settle": usePendingCount(
      "fair-links-to-settle",
      wanted["fair-links-to-settle"] && batchSettled,
      ownPoll,
    ),
    "product-request-approvals": usePendingCount(
      "product-request-approvals",
      wanted["product-request-approvals"] && batchSettled,
      ownPoll,
    ),
    "finance-todo": usePendingCount("finance-todo", wanted["finance-todo"] && batchSettled, ownPoll),
  };
}

/** The IT Support count alone, for the phone, which has no sidebar. Shares the sidebar's query. */
export function useItSupportUnread(): number {
  const { user } = useAuth();
  const connected = useItSupportConnected();
  return usePendingCount("it-support-replies", !!user?.id && connected, BADGE_POLL_MS);
}

/** Re-read the IT Support count now: a request was just opened, which marks it seen on the hub. */
export function useRefreshItSupportUnread(): () => void {
  const qc = useQueryClient();
  return useCallback(() => void qc.invalidateQueries({ queryKey: IT_SUPPORT_UNREAD_KEY }), [qc]);
}

/** The requests waiting for Finance, read fresh — the Payment Vouchers page's
    reminder (owner 2026-10-08). Shares the sidebar badge's query, so reading it
    here moves the badge too. 0 for anyone but Finance. */
export function usePaymentRequestsWaiting(): number {
  const { user, can } = useAuth();
  /* No poll of its own: the sidebar beside this page keeps the key fresh. */
  return usePendingCount("payment-requests-waiting", !!user?.id && can("scm.payment_voucher.create"), false, 0);
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
    void qc.invalidateQueries({ queryKey: PAYMENT_BACKDATE_APPROVALS_KEY });
    void qc.invalidateQueries({ queryKey: PAYMENT_REQUESTS_WAITING_KEY });
  };
}
