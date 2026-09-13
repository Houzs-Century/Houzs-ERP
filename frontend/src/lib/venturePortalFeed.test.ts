// The Venture Portal feed's SHARED LAYER — the verdicts and sentences both
// surfaces render.
//
// This file is where the page's judgement lives, so it is where the judgement
// is tested. Two properties matter more than the rest and each has a reason
// somebody already paid for:
//
//   • A COUNT IS NOT A VERDICT. "12 waiting" is a busy queue and "1 waiting
//     since Tuesday" is a feed that stopped, and a status board that renders
//     both as a number tells the owner nothing. The staleness branch is the
//     whole point of vpVerdict and is asserted directly.
//   • A DELIVERED-BUT-NOT-APPLIED ROW MUST NOT READ AS COUNTED. The portal's
//     contract warns against conflating "we delivered it" with "the portal
//     applied it" twice; a `held` month is delivered and NOT counted, and a
//     bare tick there would tell somebody their commission is in when it is not.
import { describe, expect, it } from "vitest";

import {
  VP_DEFAULT_RECEIVER_URL,
  VP_KEY_PASTE_LINE,
  VP_PORTAL_OUTCOME_LABEL,
  VP_ROW_STATUS_LABEL,
  VP_ROW_STATUS_TONE,
  vpKeyLine,
  vpOldestPendingHours,
  vpOutcomeLine,
  vpReceiverDraft,
  vpReceiverHint,
  vpRowTodo,
  vpScopeLabel,
  vpVerdict,
  type VpRow,
  type VpStatus,
} from "./venturePortalFeed";

const status = (over: {
  enabled?: boolean;
  scope?: "off" | "all" | number[];
  url?: string;
  secretSet?: boolean;
  pending?: number;
  sent?: number;
  failed?: number;
  oldestPendingAt?: string | null;
  secretSetAt?: string | null;
} = {}): VpStatus => ({
  feed: {
    enabled: over.enabled ?? true,
    scope: over.scope ?? [1],
    configKey: "scm.venture_portal_feed",
  },
  connection: {
    url: over.url ?? "https://portal.example/api/erp/v1/sales-orders",
    since: "",
    secret: over.secretSet === false
      ? { set: false, length: 0, tail: "", setAt: null }
      : {
          set: true,
          length: 48,
          tail: "9f2a",
          setAt: over.secretSetAt === undefined ? "2026-09-13T07:40:00.000Z" : over.secretSetAt,
        },
    ready: true,
  },
  queue: {
    pending: over.pending ?? 0,
    sent: over.sent ?? 0,
    failed: over.failed ?? 0,
    skipped: 0,
    maxAttempts: 6,
    batch: 25,
    lastSent: null,
    lastError: null,
    oldestPending:
      over.oldestPendingAt === undefined || over.oldestPendingAt === null
        ? null
        : { doc_no: "HC-SO-1", created_at: over.oldestPendingAt, attempts: 1, last_error: null },
  },
  canManage: true,
});

const row = (over: Partial<VpRow> = {}): VpRow => ({
  id: "vp-1",
  doc_no: "HC-SO-013403",
  op: "UPDATE",
  status: "sent",
  attempts: 1,
  last_error: null,
  portal_outcome: "applied",
  created_at: "2026-09-12T01:00:00.000Z",
  updated_at: "2026-09-12T01:00:05.000Z",
  sent_at: "2026-09-12T01:00:05.000Z",
  ...over,
});

describe("the verdict", () => {
  it("says nothing is being sent when the feed is off, and says that first", () => {
    /* Off outranks everything, including a backlog: an operator looking at a
       queue of 40 while the switch is off needs to be told the switch, not the
       40. */
    const v = vpVerdict(status({ enabled: false, scope: "off", pending: 40, failed: 3 }));
    expect(v.tone).toBe("off");
    expect(v.headline).toMatch(/off/i);
    expect(v.detail).toMatch(/no sales order leaves/i);
  });

  it("says it is on but not wired up when the secret is missing", () => {
    const v = vpVerdict(status({ secretSet: false }));
    expect(v.tone).toBe("wait");
    expect(v.headline).toMatch(/not wired up/i);
    /* The reassurance matters: somebody mid-setup must know the queue is not
       losing orders while they finish. */
    expect(v.detail).toMatch(/nothing is lost/i);
  });

  it("says it is on but not wired up when the address is missing", () => {
    expect(vpVerdict(status({ url: "" })).headline).toMatch(/not wired up/i);
  });

  it("leads with undelivered orders and says what that costs", () => {
    const v = vpVerdict(status({ failed: 2, pending: 9 }));
    expect(v.tone).toBe("bad");
    expect(v.headline).toBe("2 orders could not be delivered");
    expect(v.detail).toMatch(/commission/i);
  });

  it("counts one undelivered order in the singular", () => {
    expect(vpVerdict(status({ failed: 1 })).headline).toBe("1 order could not be delivered");
  });

  /* THE PROPERTY A COUNT CANNOT EXPRESS. Same pending number, opposite verdict,
     decided only by how long the oldest one has waited. */
  it("distinguishes a busy queue from a feed that stopped", () => {
    const fresh = vpVerdict(status({ pending: 8, oldestPendingAt: new Date(Date.now() - 60_000).toISOString() }));
    expect(fresh.tone).toBe("wait");
    expect(fresh.headline).toBe("8 waiting to be delivered");

    const stuck = vpVerdict(status({ pending: 8, oldestPendingAt: new Date(Date.now() - 5 * 3_600_000).toISOString() }));
    expect(stuck.tone).toBe("bad");
    expect(stuck.headline).toMatch(/waiting 5h/);
    /* Names BOTH senders, because there are two now: the save's own kick and the
       five-minute sweep. An hour-old row means neither ran, and saying only "the
       sender stopped" would leave somebody looking for one thing. */
    expect(stuck.detail).toMatch(/neither is running/i);
    expect(stuck.detail).toMatch(/from the save itself/i);
  });

  it("is quiet when there is nothing to do", () => {
    const v = vpVerdict(status({ sent: 493 }));
    expect(v.tone).toBe("good");
    expect(v.headline).toMatch(/nothing waiting/i);
    expect(v.detail).toBe("493 delivered so far.");
  });

  it("does not claim health before the first read answers", () => {
    expect(vpVerdict(null).tone).toBe("wait");
  });
});

describe("vpOldestPendingHours", () => {
  it("is null when nothing is waiting", () => {
    expect(vpOldestPendingHours(status())).toBeNull();
  });

  it("refuses an unparseable timestamp rather than reporting a wrong age", () => {
    expect(vpOldestPendingHours(status({ oldestPendingAt: "not a date" }))).toBeNull();
  });
});

describe("the scope, as a sentence", () => {
  it("reads Off when the feed is off, whatever the stored list says", () => {
    expect(vpScopeLabel(status({ enabled: false, scope: [1, 2] }))).toBe("Off");
  });

  it("names the companies, and says so when none is chosen", () => {
    expect(vpScopeLabel(status({ scope: [1, 2] }))).toBe("Company 1, 2");
    expect(vpScopeLabel(status({ scope: [] }))).toBe("No company chosen");
    expect(vpScopeLabel(status({ scope: "all" }))).toBe("Every company");
  });
});

describe("the key line", () => {
  /* THE WHOLE SECURITY PROPERTY OF THE PAGE, asserted rather than assumed: the
     sentence lets an operator RECOGNISE the key without carrying enough of it to
     reconstruct one. Four characters and a timestamp answer "is the portal
     holding the key I generated on Sunday?" and nothing else. */
  it("recognises the key without being able to reveal it", () => {
    const line = vpKeyLine(status());
    expect(line).toMatch(/····9f2a/);
    expect(line).toMatch(/generated 13\/09\/2026 /);
    /* Nothing that could be a key: no run of key-shaped characters. The status
       payload cannot carry one, and this pins that the sentence would not print
       it if a future endpoint change ever did. */
    expect(line).not.toMatch(/[A-Za-z0-9_-]{12}/);
  });

  it("still names the key when the server did not say when it was set", () => {
    const line = vpKeyLine(status({ secretSetAt: null }));
    expect(line).toBe("Key ····9f2a");
  });

  /* NOT "the portal will refuse every delivery" any more — true, but not an
     instruction. The operator has one button to press and the sentence names it. */
  it("tells somebody with no key what to do about it", () => {
    const line = vpKeyLine(status({ secretSet: false }));
    expect(line).toMatch(/Generate one/i);
    expect(line).toMatch(/Venture Portal/);
  });
});

describe("the receiver address", () => {
  /* 「我这边只需要填那个 API key」 — the owner fills in ONE thing, and a URL is
     not it. The portal's own address is offered so it never has to be typed. */
  it("offers the portal's own address when nothing is stored", () => {
    expect(vpReceiverDraft(status({ url: "" }))).toBe(VP_DEFAULT_RECEIVER_URL);
    expect(VP_DEFAULT_RECEIVER_URL.startsWith("https://")).toBe(true);
    expect(VP_DEFAULT_RECEIVER_URL.endsWith("/api/erp/v1/sales-orders")).toBe(true);
  });

  it("never overrides an address somebody already saved", () => {
    expect(vpReceiverDraft(status({ url: "https://elsewhere.example/erp" }))).toBe(
      "https://elsewhere.example/erp",
    );
  });

  /* THE TRAP THIS HINT EXISTS FOR: a pre-filled box looks exactly like a saved
     one, so without a sentence somebody would turn the feed on believing the
     receiver was configured while vp.url is still empty and the drain answers
     not_configured. */
  it("says plainly that the offered address is not saved yet", () => {
    expect(vpReceiverHint(status({ url: "" }))).toMatch(/Not saved yet/i);
    expect(vpReceiverHint(status({ url: "" }))).toMatch(/Save address/);
    expect(vpReceiverHint(status())).toMatch(/^Saved\./);
  });
});

describe("the one-time reveal's instruction", () => {
  /* The whole hand-shake is one paste, and it fails silently if the operator
     cannot find the page. So the sentence names the path, and says the key does
     not come back. */
  it("names where the key goes and that it is shown once", () => {
    expect(VP_KEY_PASTE_LINE).toMatch(/Venture Portal/);
    expect(VP_KEY_PASTE_LINE).toMatch(/Commission Calculation/);
    expect(VP_KEY_PASTE_LINE).toMatch(/Houzs ERP link/);
    expect(VP_KEY_PASTE_LINE).toMatch(/Not shown again/);
    expect(VP_KEY_PASTE_LINE).toMatch(/rotate/);
  });
});

describe("a row", () => {
  it("labels every state in an operator's words, with no queue vocabulary", () => {
    expect(VP_ROW_STATUS_LABEL).toEqual({
      pending: "Waiting",
      sent: "Delivered",
      failed: "Not delivered",
      skipped: "Out of scope",
    });
    expect(VP_ROW_STATUS_TONE.failed).toBe("bad");
    expect(VP_ROW_STATUS_TONE.sent).toBe("good");
  });

  /* DELIVERED IS NOT COUNTED. Both halves asserted, because rendering only the
     state would silently claim a held month is in the commission run. */
  it("keeps `delivered` and `counted` as separate facts", () => {
    expect(vpOutcomeLine(row({ portal_outcome: "applied" }))).toBe("Counted");
    expect(vpOutcomeLine(row({ portal_outcome: "held" }))).toBe("Delivered, but that month is locked");
    expect(VP_PORTAL_OUTCOME_LABEL.held).not.toMatch(/counted/i);
  });

  it("shows an outcome only on a delivered row", () => {
    expect(vpOutcomeLine(row({ status: "pending", portal_outcome: null }))).toBeNull();
    expect(vpOutcomeLine(row({ status: "failed", portal_outcome: "applied" }))).toBeNull();
  });

  it("passes an unknown outcome through rather than inventing a label", () => {
    expect(vpOutcomeLine(row({ portal_outcome: "some_new_thing" }))).toBe("some_new_thing");
  });

  it("asks for nothing on a row nobody has to act on", () => {
    expect(vpRowTodo(row({ status: "sent" }))).toBeNull();
    expect(vpRowTodo(row({ status: "pending" }))).toBeNull();
    expect(vpRowTodo(row({ status: "skipped" }))).toBeNull();
  });

  /* The four refusals an operator can actually act on, each pointed at the next
     step rather than at a status code. */
  it("names what to do about each kind of refusal", () => {
    /* BOTH KEY REFUSALS END IN THE SAME ACTION and each says which side is
       empty: 401 is the portal holding a DIFFERENT key, 503 is it holding NONE.
       Since the portal takes a key pasted on its own page, neither needs
       anybody else any more — which is why 503 no longer reads "ask the portal
       owner", a sentence that was true when only a Vercel env var could fix it. */
    expect(vpRowTodo(row({ status: "failed", last_error: "http 401 — wrong secret" }))).toMatch(/different key/i);
    expect(vpRowTodo(row({ status: "failed", last_error: "http 401 — wrong secret" }))).toMatch(/paste it in the Venture Portal/i);
    expect(vpRowTodo(row({ status: "failed", last_error: "http 503 — no secret yet" }))).toMatch(/no key of its own/i);
    expect(vpRowTodo(row({ status: "failed", last_error: "http 503 — no secret yet" }))).toMatch(/paste it in the Venture Portal/i);
    expect(vpRowTodo(row({ status: "failed", last_error: "http 422 — docNo missing" }))).toMatch(/could not read/i);
    expect(vpRowTodo(row({ status: "failed", last_error: "http 500 (gave up after 6 attempts)" }))).toMatch(/tried several times/i);
    expect(vpRowTodo(row({ status: "failed", last_error: null }))).toMatch(/re-send/i);
  });
});
