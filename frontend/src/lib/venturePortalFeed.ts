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
// THE KEY IS MINTED BY THE SERVER AND SHOWN ONCE. Generate returns it in that
// one response body and this layer holds it in component state until the box is
// dismissed. Afterwards the API answers with its length, its last four
// characters and when it was set (backend scm/routes/venture-portal-feed.ts), so
// nothing here can re-render it, log it, or put it in a network tab again.
//
// THE COPY IS PLAIN ENGLISH, matching AutoCount Sync's labels ("Waiting", "Not
// accepted", "Technical detail, for whoever looks after the AutoCount link").
// No jargon and no queue vocabulary on screen: the reader is an operator, not
// the person who wrote the outbox.
// ---------------------------------------------------------------------------

import { useCallback, useState } from "react";
import { api } from "../api/client";
import { useQuery } from "../hooks/useQuery";
/* ONE DATE FORMAT, ONE PLACE THAT WRITES IT (owner 2026-08-18), and the reason
   it is imported into the LOGIC layer rather than each surface: "generated
   13/09/2026 15:40" is a sentence, and every sentence on this page lives here.
   backend/scripts/check-date-formatting.mjs gates the rule. */
import { fmtDateTime } from "../vendor/shared/format";

export const VP_STATUS_PATH = "/api/scm/venture-portal-feed/status";
export const VP_ROWS_PATH = "/api/scm/venture-portal-feed/rows";

/**
 * The receiver, pre-filled so the owner never types a URL.
 *
 * This is the portal's live address (its PRs #117 + #118). It is only an OFFER:
 * the page shows it in the address box when nothing is stored, and PUT
 * /connection is unchanged — nothing is saved until somebody presses Save
 * address, and the server still refuses anything that is not https.
 *
 * Deliberately a constant HERE and not a server default: a default the SERVER
 * applied would be a receiver address nobody chose, which for an endpoint that
 * sends customer names and line costs outward is the wrong direction. Offering
 * it on screen leaves the decision where it belongs and still saves the typing.
 */
export const VP_DEFAULT_RECEIVER_URL =
  "https://venture-portal-chi.vercel.app/api/erp/v1/sales-orders";

/** The one-time reveal's instruction — the exact path on the portal, because
 *  「我这边只需要填那个 API key」 is only true if the page says where. */
export const VP_KEY_PASTE_LINE =
  "Paste this in the Venture Portal › Revenue › Fair › Commission Calculation › Houzs ERP link. "
  + "Not shown again; generate a new one to rotate.";

export type VpRowStatus = "pending" | "sent" | "failed" | "skipped";

export interface VpMaskedSecret {
  set: boolean;
  length: number;
  tail: string;
  /** When the key was last written, from scm.sync_config's own updated_at.
   *  A timestamp, never a credential. */
  setAt: string | null;
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
      /* DESCRIBES THE MECHANISM, not a measured duration. A delivery is sent
         from the save itself, and a sweep every five minutes catches whatever
         that missed — so an hour-old row means BOTH have stopped, which is the
         thing worth saying. Naming a number here would be claiming a latency
         nobody has measured on this account yet. */
      detail: "An order is normally sent from the save itself, and a sweep every five minutes catches anything that missed. Waiting this long means neither is running.",
    };
  }
  if (s.queue.pending > 0) {
    return {
      tone: "wait",
      headline: `${s.queue.pending} waiting to be delivered`,
      detail: "These go out from the save itself; a sweep every five minutes collects anything left over.",
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

/**
 * What the page says about the key, without ever being able to show it.
 *
 * The dots are the point: an operator has to be able to check that the key the
 * portal holds is the key this side generated, and four characters plus a
 * timestamp does that. Nothing here could render the key even if it wanted to —
 * GET /status does not carry it.
 *
 * "GENERATED", not "set": after this change the page has no way to put a key
 * there except Generate. PUT /secret still exists for pasting one through the
 * API, and a key arriving that way would read as generated — a single verb one
 * step off on a screen, in exchange for not adding a fourth config row and a
 * second read to answer it. The timestamp is exact either way.
 */
export function vpKeyLine(s: VpStatus | null): string {
  if (!s) return "";
  const k = s.connection.secret;
  if (!k.set) return "No API key yet. Generate one, then paste it in the Venture Portal.";
  const when = k.setAt ? ` · generated ${fmtDateTime(k.setAt)}` : "";
  return `Key ····${k.tail}${when}`;
}

/**
 * What the address box should hold before anybody has typed anything.
 *
 * `|| ` not `?? ` on purpose: an empty stored string is exactly the not-yet-set
 * case, and `??` would show a blank box and make the owner type the URL — the
 * thing this exists to avoid.
 */
export function vpReceiverDraft(s: VpStatus | null): string {
  return s?.connection.url || VP_DEFAULT_RECEIVER_URL;
}

/**
 * Whether the address on screen is the one in USE, or only the offer.
 *
 * Without this the two states look identical — a pre-filled box reads as saved,
 * and somebody would turn the feed on believing the receiver was configured when
 * `vp.url` is still empty and the drain answers `not_configured`.
 */
export function vpReceiverHint(s: VpStatus | null): string {
  if (!s) return "";
  if (s.connection.url) {
    return "Saved. Must be https — a delivery carries a customer's name and every line's cost.";
  }
  return "The Venture Portal's own address, filled in for you. Not saved yet — press Save address to use it.";
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
  /* 401 and 503 both mean "the keys disagree", and the DIFFERENCE is which side
     is empty — so each names its own next step. Since the portal reads a key
     pasted on its own page (its PRs #117 + #118), both are now fixed from here
     plus one paste, which is what these two sentences say and what they did not
     say before: 503 used to read "nothing to fix on our side". */
  if (/401/.test(e)) return "The portal is holding a different key. Generate a new one here, paste it in the Venture Portal, then re-send.";
  if (/503/.test(e)) return "The portal has no key of its own yet. Generate one here, paste it in the Venture Portal, then re-send.";
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
  /* THE ONE-TIME REVEAL LIVES HERE, not in either page, because "is the key
     still on screen" is a decision and both surfaces must answer it the same
     way. Component state only: it is never written to localStorage, never put in
     the URL, and gone on a reload — the server will not answer it a second
     time, and neither will this. */
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);

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

  /**
   * Mint a key and reveal it once.
   *
   * The reveal is set INSIDE the call, before `run` reports, so a successful
   * generate cannot end with the key written to the database and nothing on
   * screen — which would leave the feed holding a key nobody can paste anywhere,
   * fixable only by generating another.
   */
  const generateKey = useCallback(
    () =>
      run(
        "generate",
        async () => {
          const r = await api.post<{ secret: string }>(
            "/api/scm/venture-portal-feed/secret/generate",
            {},
          );
          setRevealedKey(r.secret);
          setKeyCopied(false);
          return r;
        },
        () => ({
          tone: "good",
          text: "A new API key is ready. Copy it now and paste it in the Venture Portal — it is not shown again. Until the portal holds the same key, deliveries are refused and that costs an order nothing: they go out on their own once the two agree.",
        }),
      ),
    [run],
  );

  /** Dismiss the reveal. Nothing to save — the key is already in the database. */
  const dismissKey = useCallback(() => {
    setRevealedKey(null);
    setKeyCopied(false);
  }, []);

  /**
   * Copy the revealed key.
   *
   * A CLIPBOARD REFUSAL MUST REACH SOMEBODY. navigator.clipboard throws on an
   * insecure origin and on a denied permission, and this is the one moment on
   * the page where silently doing nothing costs real work: the operator walks to
   * the portal with an empty clipboard and the key is gone. CLAUDE.md's "a
   * failure that reaches nobody is worse than a crash", at the exact call site
   * that would have produced it.
   */
  const copyKey = useCallback(async () => {
    const key = revealedKey;
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      setKeyCopied(true);
    } catch {
      setKeyCopied(false);
      setNote({
        tone: "bad",
        text: "Could not reach the clipboard. Select the key above and copy it by hand — it is not shown again.",
      });
    }
  }, [revealedKey]);

  const saveScope = useCallback(
    (enabled: boolean, companies: number[] | "all") =>
      run(
        "scope",
        () => api.put("/api/scm/venture-portal-feed/scope", { enabled, companies }),
        () => ({
          tone: enabled ? "good" : "off",
          text: enabled
            ? "On. From now on a saved order is sent from the save itself, and anything already waiting leaves on the next sweep."
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
    revealedKey,
    keyCopied,
    saveConnection,
    generateKey,
    dismissKey,
    copyKey,
    saveScope,
    probe,
    queueUndelivered,
    sendNow,
    requeueRow,
  };
}
