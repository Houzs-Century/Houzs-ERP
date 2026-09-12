// ---------------------------------------------------------------------------
// Venture Portal feed — the ONE logic layer behind both surfaces.
//
// The desktop page (pages/VenturePortalFeed.tsx) and the mobile screen
// (mobile/MobileVenturePortalFeed.tsx) render differently and decide nothing.
// Every verdict, every sentence and every call lives here, because the owner's
// standing rule is one shared logic layer with the two surfaces differing only
// in presentation — and "a rule fixed on one surface and not the other" is a
// recurring bug class in this repo.
//
// WHAT THE PAGE IS FOR. The portal pays Revenue Department commission out of
// our sales orders, and this feed replaced a monthly xlsx. The page exists
// because the portal's hand-off contract wanted the URL, the shared secret, the
// company scope, the start date and the backfill to be SQL somebody pastes into
// a console, and CLAUDE.md forbids that shape: 「一个功能如果上线后的日常操作还需
// 要开 Terminal、跑 SQL、或找 IT 帮忙，就等于没做完」.
//
// THE SECRET IS NEVER READ BACK. The API answers with its length and last four
// characters only (backend scm/routes/venture-portal-feed.ts), so nothing here
// can render it, log it, or put it in a browser's network tab.
//
// THE COPY IS PLAIN ENGLISH, matching AutoCount Sync's labels ("Waiting", "Not
// accepted", "Technical detail, for whoever looks after the AutoCount link").
// No jargon and no queue vocabulary on screen: the reader is an operator, not
// the person who wrote the outbox.
// ---------------------------------------------------------------------------

import { useCallback, useState } from "react";
import { api } from "../api/client";
import { useQuery } from "../hooks/useQuery";

export const VP_STATUS_PATH = "/api/scm/venture-portal-feed/status";
export const VP_ROWS_PATH = "/api/scm/venture-portal-feed/rows";

/** The contract's floor, mirrored so the form can refuse before the round trip.
 *  The SERVER is still the boundary — this only saves a wasted request. */
export const VP_MIN_SECRET_LEN = 32;

export type VpRowStatus = "pending" | "sent" | "failed" | "skipped";

export interface VpMaskedSecret {
  set: boolean;
  length: number;
  tail: string;
}

export interface VpStatus {
  feed: { enabled: boolean; scope: "off" | "all" | number[]; configKey: string };
  connection: {
    url: string;
    since: string;
    secret: VpMaskedSecret;
    ready: boolean;
  };
  queue: {
    pending: number;
    sent: number;
    failed: number;
    skipped: number;
    maxAttempts: number;
    batch: number;
    lastSent: { doc_no: string; sent_at: string; portal_outcome: string | null } | null;
    lastError: { doc_no: string; last_error: string; attempts: number; updated_at: string } | null;
    oldestPending: { doc_no: string; created_at: string; attempts: number; last_error: string | null } | null;
  };
  canManage: boolean;
}

export interface VpRow {
  id: string;
  doc_no: string;
  op: string;
  status: VpRowStatus;
  attempts: number;
  last_error: string | null;
  portal_outcome: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}

export type VpTone = "good" | "wait" | "bad" | "off";

export interface VpVerdict {
  tone: VpTone;
  headline: string;
  detail: string;
}

/**
 * The verdict, in an operator's words rather than the queue's.
 *
 * ORDER MATTERS, and it is the order of the question somebody arrives with: is
 * it on, is it wired up, is anything stuck, is anything STALE. A count answers
 * none of those on its own — a large waiting number is a busy queue, and one
 * order waiting since Tuesday is a feed that stopped, and those two are the
 * same number.
 */
export function vpVerdict(s: VpStatus | null): VpVerdict {
  if (!s) return { tone: "wait", headline: "Checking", detail: "" };

  if (!s.feed.enabled) {
    return {
      tone: "off",
      headline: "Off — nothing is being sent",
      detail: "Until this is switched on, no sales order leaves this system and nothing piles up waiting.",
    };
  }
  if (!s.connection.url || !s.connection.secret.set) {
    return {
      tone: "wait",
      headline: "On, but not wired up yet",
      detail: "Deliveries start once the receiver address and the shared secret are both set. Anything already queued waits; nothing is lost.",
    };
  }
  if (s.queue.failed > 0) {
    return {
      tone: "bad",
      headline: `${s.queue.failed} ${s.queue.failed === 1 ? "order" : "orders"} could not be delivered`,
      detail: "These exist here and the portal has not got them, so commission is being worked out without them. Every row below says why.",
    };
  }
  const stale = vpOldestPendingHours(s);
  if (stale != null && stale >= 1) {
    return {
      tone: "bad",
      headline: `An order has been waiting ${Math.floor(stale)}h to be delivered`,
      detail: "A delivery normally takes under five minutes. This is the sender having stopped, not a busy queue.",
    };
  }
  if (s.queue.pending > 0) {
    return {
      tone: "wait",
      headline: `${s.queue.pending} waiting to be delivered`,
      detail: "A batch goes out every five minutes.",
    };
  }
  return {
    tone: "good",
    headline: "Working — nothing waiting",
    detail: s.queue.sent > 0 ? `${s.queue.sent} delivered so far.` : "No order has needed delivering yet.",
  };
}

/** How long the oldest waiting document has been waiting, in hours. */
export function vpOldestPendingHours(s: VpStatus): number | null {
  const oldest = s.queue.oldestPending;
  if (!oldest) return null;
  const t = Date.parse(oldest.created_at);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 3_600_000;
}

/** The scope as a sentence rather than a config value. */
export function vpScopeLabel(s: VpStatus | null): string {
  if (!s || !s.feed.enabled) return "Off";
  if (s.feed.scope === "all") return "Every company";
  if (Array.isArray(s.feed.scope)) {
    return s.feed.scope.length ? `Company ${s.feed.scope.join(", ")}` : "No company chosen";
  }
  return "Off";
}

/** What the secret field should say without ever showing the secret. */
export function vpSecretLine(s: VpStatus | null): string {
  if (!s) return "";
  const k = s.connection.secret;
  if (!k.set) return "Not set — the portal will refuse every delivery until it is.";
  return `Set (${k.length} characters, ending ${k.tail}). Entering a new one replaces it.`;
}

/** What a row's state means to somebody who did not write the queue. */
export const VP_ROW_STATUS_LABEL: Record<VpRowStatus, string> = {
  pending: "Waiting",
  sent: "Delivered",
  failed: "Not delivered",
  skipped: "Out of scope",
};

export const VP_ROW_STATUS_TONE: Record<VpRowStatus, VpTone> = {
  pending: "wait",
  sent: "good",
  failed: "bad",
  skipped: "off",
};

/** The portal's own word for what it did with a delivery it accepted. */
export const VP_PORTAL_OUTCOME_LABEL: Record<string, string> = {
  applied: "Counted",
  duplicate: "Already had this version",
  stale: "Older than what it holds",
  held: "Delivered, but that month is locked",
  skipped: "Portal decided it needs nothing",
};

/**
 * A delivered row the portal did NOT apply is still delivered.
 *
 * The contract warns against conflating the two twice, and this is where a page
 * would do it: a bare tick on a `held` row would say the commission is counted
 * when it is not. So the outcome is rendered BESIDE the state, never instead
 * of it.
 */
export function vpOutcomeLine(row: VpRow): string | null {
  if (row.status !== "sent" || !row.portal_outcome) return null;
  return VP_PORTAL_OUTCOME_LABEL[row.portal_outcome] ?? row.portal_outcome;
}

/** What the operator is being asked to do about a row, when there is anything. */
export function vpRowTodo(row: VpRow): string | null {
  if (row.status !== "failed") return null;
  const e = row.last_error ?? "";
  if (/401/.test(e)) return "The two secrets do not match. Set the same value here and on the portal, then re-send.";
  if (/503/.test(e)) return "The portal has no secret configured. Ask the portal owner to set it; then re-send.";
  if (/4(00|22)/.test(e)) return "The portal could not read this delivery. Whoever looks after the feed needs to see this one.";
  if (/gave up/.test(e)) return "It was tried several times and never got through. Re-send once the cause is fixed.";
  return "Re-send once the cause is fixed.";
}

/** Polled: this is a status board and the sender runs every five minutes. */
export function useVpStatus(enabled = true) {
  return useQuery<VpStatus>(
    VP_STATUS_PATH,
    () => api.get<VpStatus>(VP_STATUS_PATH),
    [],
    { staleTime: 15_000, keepPreviousData: true, enabled },
  );
}

export function useVpRows(status: VpRowStatus | "all", enabled = true) {
  const qs = status === "all" ? "?limit=100" : `?status=${status}&limit=100`;
  return useQuery<{ rows: VpRow[] }>(
    VP_ROWS_PATH,
    () => api.get<{ rows: VpRow[] }>(`${VP_ROWS_PATH}${qs}`),
    [qs],
    { staleTime: 15_000, keepPreviousData: true, enabled },
  );
}

export interface VpNote {
  tone: VpTone;
  text: string;
}

/**
 * Every write on the page, through one path.
 *
 * ONE `run`, NOT seven hooks. The busy flag, the note and — the part that
 * matters — the CATCH are shared, so no button here can refuse silently.
 * CLAUDE.md records that class as worse than a crash: thirty-five write paths
 * in this repo refused correctly and told nobody, and the owner reported it as
 * "the button does nothing". `frontend/scripts/check-silent-mutations.mjs`
 * exists because of it.
 */
export function useVpActions(onChanged: () => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<VpNote | null>(null);

  const run = useCallback(
    async (key: string, call: () => Promise<unknown>, say: (result: unknown) => VpNote) => {
      setBusy(key);
      setNote(null);
      try {
        const r = await call();
        setNote(say(r));
        onChanged();
      } catch (e) {
        /* The server's own sentence, when it sent one. Never swallowed and
           never replaced with a generic apology that hides which field was
           wrong — "secret_too_short" tells the operator what to do next. */
        const msg = (e as { message?: string } | undefined)?.message ?? String(e);
        setNote({ tone: "bad", text: `Not saved: ${msg}` });
      } finally {
        setBusy(null);
      }
    },
    [onChanged],
  );

  const saveConnection = useCallback(
    (url: string, since: string) =>
      run(
        "connection",
        () => api.put("/api/scm/venture-portal-feed/connection", { url, since }),
        () => ({ tone: "good", text: "Receiver address saved." }),
      ),
    [run],
  );

  const saveSecret = useCallback(
    (secret: string) =>
      run(
        "secret",
        () => api.put("/api/scm/venture-portal-feed/secret", { secret }),
        () => ({
          tone: "good",
          text: "Secret saved. Set the same value on the portal — until it matches, deliveries are refused, and a refusal costs an order nothing: they go out on their own once the two agree.",
        }),
      ),
    [run],
  );

  const saveScope = useCallback(
    (enabled: boolean, companies: number[] | "all") =>
      run(
        "scope",
        () => api.put("/api/scm/venture-portal-feed/scope", { enabled, companies }),
        () => ({
          tone: enabled ? "good" : "off",
          text: enabled
            ? "On. The next batch goes out within five minutes."
            : "Off. Nothing more is sent; anything already waiting stays waiting.",
        }),
      ),
    [run],
  );

  const probe = useCallback(
    () =>
      run(
        "probe",
        () =>
          api.post<{ ok: boolean; status: number; body: string; reason?: string }>(
            "/api/scm/venture-portal-feed/probe",
            {},
          ),
        (r) => {
          const res = r as { ok: boolean; status: number; body: string; reason?: string };
          if (res.ok) return { tone: "good", text: `Reached the portal. It answered: ${res.body.slice(0, 160)}` };
          if (res.reason === "not_configured") return { tone: "wait", text: "The address or the secret is still empty." };
          if (res.status === 401) return { tone: "bad", text: "The portal refused the secret — the two values are not the same." };
          if (res.status === 503) return { tone: "wait", text: "The portal has no secret of its own set yet. Ask the portal owner to set it." };
          return { tone: "bad", text: `Could not reach the portal (HTTP ${res.status})${res.reason ? `: ${res.reason}` : ""}` };
        },
      ),
    [run],
  );

  const queueUndelivered = useCallback(
    (includeFailed: boolean) =>
      run(
        "queue",
        () =>
          api.post<{ requeued: number; skipped?: string }>(
            "/api/scm/venture-portal-feed/queue-undelivered",
            { includeFailed },
          ),
        (r) => {
          const res = r as { requeued: number; skipped?: string };
          if (res.skipped === "feed_off") return { tone: "off", text: "The feed is off, so nothing was queued." };
          if (res.skipped === "not_configured") return { tone: "wait", text: "The address or the secret is still empty." };
          /* NOT "everything in scope has been delivered" — that sentence was
             here and it was WRONG, and check-empty-state-claims is what found
             it. `requeued: 0` means the sweep INSERTED nothing, which is also
             true when undelivered orders are already queued, and true again
             when they are parked as failed and this call was told to leave
             those alone. Reporting a completion from a zero is the exact
             mistake the gate exists to catch; the counts and the verdict above
             are what actually say where things stand. */
          if (!res.requeued) return { tone: "good", text: "Nothing new to queue. Whatever is already waiting or parked stays as it is — the counts above say where things stand." };
          return { tone: "good", text: `${res.requeued} undelivered ${res.requeued === 1 ? "order" : "orders"} queued.` };
        },
      ),
    [run],
  );

  const sendNow = useCallback(
    (limit: number) =>
      run(
        "drain",
        () =>
          api.post<{ sent: number; failed: number; retried: number; outOfScope: number; skipped?: string }>(
            "/api/scm/venture-portal-feed/drain",
            { limit },
          ),
        (r) => {
          const res = r as { sent: number; failed: number; retried: number; outOfScope: number; skipped?: string };
          if (res.skipped === "feed_off") return { tone: "off", text: "The feed is off." };
          if (res.skipped === "not_configured") return { tone: "wait", text: "The address or the secret is still empty." };
          const bits = [
            `${res.sent} delivered`,
            res.failed ? `${res.failed} could not be` : null,
            res.retried ? `${res.retried} will be tried again` : null,
            res.outOfScope ? `${res.outOfScope} out of scope` : null,
          ].filter(Boolean);
          return { tone: res.failed ? "bad" : "good", text: bits.join(", ") };
        },
      ),
    [run],
  );

  const requeueRow = useCallback(
    (id: string, docNo: string) =>
      run(
        `row:${id}`,
        () => api.post(`/api/scm/venture-portal-feed/rows/${id}/requeue`, {}),
        () => ({ tone: "good", text: `${docNo} is queued again.` }),
      ),
    [run],
  );

  return {
    busy,
    note,
    setNote,
    saveConnection,
    saveSecret,
    saveScope,
    probe,
    queueUndelivered,
    sendNow,
    requeueRow,
  };
}
