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
  VP_PORTAL_OUTCOME_LABEL,
  VP_ROW_STATUS_LABEL,
  VP_ROW_STATUS_TONE,
  vpOldestPendingHours,
  vpOutcomeLine,
  vpRowTodo,
  vpScopeLabel,
  vpSecretLine,
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
      ? { set: false, length: 0, tail: "" }
      : { set: true, length: 40, tail: "9f2a" },
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
    expect(stuck.detail).toMatch(/sender having stopped/i);
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

describe("the secret line", () => {
  /* THE WHOLE SECURITY PROPERTY OF THE PAGE, asserted rather than assumed: the
     sentence recognises the secret and cannot reconstruct it. */
  it("describes the secret without being able to reveal it", () => {
    const line = vpSecretLine(status());
    expect(line).toMatch(/40 characters/);
    expect(line).toMatch(/9f2a/);
    expect(line).not.toMatch(/^Set \(.*[a-z]{20}/);
  });

  it("says plainly that deliveries are refused until it is set", () => {
    expect(vpSecretLine(status({ secretSet: false }))).toMatch(/refuse every delivery/i);
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

  /* The four refusals an operator can actually act on, each pointed at the
     person who can act. A 503 is the PORTAL owner's job and saying "re-send"
     there would send somebody round in circles. */
  it("names what to do about each kind of refusal", () => {
    expect(vpRowTodo(row({ status: "failed", last_error: "http 401 — wrong secret" }))).toMatch(/do not match/i);
    expect(vpRowTodo(row({ status: "failed", last_error: "http 503 — no secret yet" }))).toMatch(/portal owner/i);
    expect(vpRowTodo(row({ status: "failed", last_error: "http 422 — docNo missing" }))).toMatch(/could not read/i);
    expect(vpRowTodo(row({ status: "failed", last_error: "http 500 (gave up after 6 attempts)" }))).toMatch(/tried several times/i);
    expect(vpRowTodo(row({ status: "failed", last_error: null }))).toMatch(/re-send/i);
  });
});
