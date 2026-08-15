import { describe, expect, it } from "vitest";
import {
  acAge,
  acHeadline,
  acOpLabel,
  acStateLabel,
  acStateTone,
  buildAcOutboxQs,
  type AcOutboxResponse,
} from "./autocountOutbox";

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
