import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }));
vi.mock("../api/client", () => ({ api: { get: vi.fn(), post: apiPost } }));

import {
  acAge,
  acHeadline,
  acOpLabel,
  acStateLabel,
  acStateTone,
  buildAcOutboxQs,
  requeueAcOutboxRow,
  type AcOutboxResponse,
} from "./autocountOutbox";

/* Braces, not a concise arrow — a returned mock becomes vitest's teardown and
   fires api.post after every test. Same trap as the two page suites. */
beforeEach(() => { apiPost.mockReset(); });

const payload = (over: Partial<AcOutboxResponse> = {}): AcOutboxResponse => ({
  writeback: { value: "1", on: true, scope: "1" },
  counts: { pending: 0, sent: 0, failed: 0, skipped: 0, requeued: 0, attention: 0, total: 0 },
  oldest_pending: null,
  rows: [],
  truncated: false,
  meta: { max_attempts: 6, state_meaning: {}, skip_kinds: [] },
  ...over,
});

describe("buildAcOutboxQs", () => {
  it("sends nothing when nothing is filtered, so both surfaces share one cache key", () => {
    expect(buildAcOutboxQs({ state: "all", docType: "", docNo: "" })).toBe("");
  });

  it("sends only what was chosen, and trims a hand-typed document number", () => {
    expect(buildAcOutboxQs({ state: "attention", docType: "SO", docNo: "  HC-SO-1 " }))
      .toBe("?state=attention&docType=SO&docNo=HC-SO-1");
  });
});

describe("acHeadline — the owner's question, answered in one line", () => {
  /* The three situations are NOT interchangeable, and collapsing the first into
     the second is the sentence the health check had to be corrected for. */
  it("says the switch is off rather than reporting a stopped sync as healthy", () => {
    const h = acHeadline(payload({ writeback: { value: "off", on: false, scope: "off" } }));
    expect(h.tone).toBe("muted");
    expect(h.text).toContain("OFF");
    expect(h.text).not.toContain("Nothing is stuck");
  });

  it("distinguishes an empty queue from a healthy one", () => {
    const h = acHeadline(payload());
    expect(h.text).toContain("nothing has ever been queued");
  });

  it("counts failed and skipped together and names both", () => {
    const h = acHeadline(payload({
      counts: { pending: 0, sent: 3, failed: 1, skipped: 2, requeued: 4, attention: 3, total: 10 },
    }));
    expect(h.tone).toBe("bad");
    expect(h.text).toContain("3 documents need attention");
    expect(h.text).toContain("1 failed");
    expect(h.text).toContain("2 skipped");
  });

  /* A re-queued skip is history. If it leaked into `attention` the owner would
     see a permanent phantom failure. */
  it("re-queued rows alone do not make the page red", () => {
    const h = acHeadline(payload({
      counts: { pending: 0, sent: 1, failed: 0, skipped: 0, requeued: 5, attention: 0, total: 6 },
    }));
    expect(h.tone).toBe("good");
    expect(h.text).toContain("Nothing is stuck");
  });

  it("a queued backlog is good news, not an alarm", () => {
    const h = acHeadline(payload({
      counts: { pending: 2, sent: 0, failed: 0, skipped: 0, requeued: 0, attention: 0, total: 2 },
    }));
    expect(h.tone).toBe("good");
    expect(h.text).toContain("2 queued");
  });
});

describe("the words", () => {
  it("skipped is as loud as failed — both mean the document is not in the book", () => {
    expect(acStateTone("failed")).toBe("bad");
    expect(acStateTone("skipped")).toBe("bad");
    expect(acStateTone("requeued")).toBe("muted");
    expect(acStateTone("sent")).toBe("good");
  });

  it("labels a state in the operator's vocabulary, and passes an unknown one through", () => {
    expect(acStateLabel("sent")).toBe("In AutoCount");
    expect(acStateLabel("requeued")).toBe("Re-queued");
    expect(acStateLabel("something-new")).toBe("something-new");
  });

  it("names the operation rather than printing its column value", () => {
    expect(acOpLabel("so_to_do")).toBe("SO to delivery order");
    expect(acOpLabel("create_so")).toBe("Create sales order");
    expect(acOpLabel("brand_new_op")).toBe("brand_new_op");
  });
});

describe("acAge", () => {
  const now = Date.parse("2026-08-15T12:00:00.000Z");
  it("reads coarsely, because the question is whether it is climbing", () => {
    expect(acAge("2026-08-15T11:59:40.000Z", now)).toBe("just now");
    expect(acAge("2026-08-15T11:36:00.000Z", now)).toBe("24 minutes");
    expect(acAge("2026-08-15T11:00:00.000Z", now)).toBe("1 hour");
    expect(acAge("2026-08-13T12:00:00.000Z", now)).toBe("2 days");
  });

  it("does not invent an age it does not have", () => {
    expect(acAge(null, now)).toBe("—");
    expect(acAge("not a date", now)).toBe("—");
  });
});

describe("requeueAcOutboxRow", () => {
  it("POSTs the row id and no body — the company is the header, never a parameter", async () => {
    /* Passing a company would be inventing a second, weaker boundary beside the
       route's own predicate. Same argument as useAutoCountOutbox above. */
    const answer = {
      accepted: true,
      code: "requeued",
      message: "Sent back to the queue.",
      row_id: "ob-1",
      doc_type: "SO",
      doc_no: "HC-SO-2608-001",
      op: "create_so",
      new_row_id: "ob-9",
      reason: null,
    };
    apiPost.mockResolvedValueOnce(answer);
    await expect(requeueAcOutboxRow("ob-1")).resolves.toEqual(answer);
    expect(apiPost).toHaveBeenCalledWith("/api/scm/autocount-outbox/ob-1/requeue");
  });

  it("escapes the id rather than pasting it into the path", async () => {
    apiPost.mockResolvedValueOnce({});
    await requeueAcOutboxRow("ob 1/../2");
    expect(apiPost).toHaveBeenCalledWith("/api/scm/autocount-outbox/ob%201%2F..%2F2/requeue");
  });

  it("RESOLVES on a refusal — it is the server answering, not the call failing", async () => {
    /* The distinction a caller must render: a refusal has a code and a sentence
       to show, a throw has neither. A component that only handled the throw
       would leave the owner pressing a button that does nothing visible, which
       is the silent-mutation shape check-silent-mutations.mjs exists to catch. */
    apiPost.mockResolvedValueOnce({
      accepted: false,
      code: "already-sent",
      message: "AutoCount already accepted this one.",
      row_id: "ob-2",
      doc_type: "SO",
      doc_no: "HC-SO-2608-003",
      op: "create_so",
      new_row_id: null,
      reason: null,
    });
    const r = await requeueAcOutboxRow("ob-2");
    expect(r.accepted).toBe(false);
    expect(r.code).toBe("already-sent");
  });
});
