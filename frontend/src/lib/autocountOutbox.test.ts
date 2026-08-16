import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }));
vi.mock("../api/client", () => ({ api: { get: vi.fn(), post: apiPost } }));

import {
  AC_DOC_TYPES,
  AC_DOC_TYPE_LABEL,
  AC_DOC_TYPE_PLURAL,
  AC_FAILED_COPY,
  AC_FILTER_STATES,
  AC_FILTER_STATE_LABEL,
  AC_REASON_COPY,
  AC_REPLY_LABEL,
  AC_STATE_PLAIN_MEANING,
  AC_UNRECOGNISED_COPY,
  acAge,
  acDocTypeCounts,
  acDocTypePlural,
  acHeadline,
  acListTitle,
  acOpLabel,
  acReasonCopy,
  acReplySource,
  acRowKind,
  acRowStatusLine,
  acRowsOfType,
  acStateCount,
  acStateLabel,
  acStateTone,
  acWritebackLine,
  buildAcOutboxQs,
  requeueAcOutboxRow,
  type AcOutboxResponse,
  type AcOutboxRow,
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

const row = (over: Partial<AcOutboxRow> = {}): AcOutboxRow => ({
  id: "ob-1",
  op: "create_so",
  doc_type: "SO",
  doc_no: "HC-SO-2608-001",
  doc_id: null,
  status: "pending",
  state: "pending",
  attempts: 0,
  reason: null,
  reason_kind: null,
  remedy: null,
  needs_attention: false,
  can_requeue: false,
  ac_doc_no: null,
  created_at: "2026-08-15T00:00:00.000Z",
  updated_at: "2026-08-15T00:00:00.000Z",
  sent_at: null,
  ...over,
});

describe("buildAcOutboxQs", () => {
  it("sends nothing when nothing is filtered, so both surfaces share one cache key", () => {
    expect(buildAcOutboxQs({ state: "all", docNo: "" })).toBe("");
  });

  it("sends only what was chosen, and trims a hand-typed document number", () => {
    expect(buildAcOutboxQs({ state: "attention", docNo: "  HC-SO-1 " }))
      .toBe("?state=attention&docNo=HC-SO-1");
  });

  /* The type strip has to count EVERY type. A server already narrowed to one
     would make every other chip read zero, so the type never goes on the wire. */
  it("never sends the document type — the type is a lens on this side", () => {
    expect(buildAcOutboxQs({ state: "failed", docNo: "" })).not.toContain("docType");
  });
});

describe("the document type words", () => {
  it("spells the plural out instead of appending an s", () => {
    /* "GOODS RECEIVEDS" and "Invoice invoice" both shipped on the first mockup
       from exactly that shortcut. */
    expect(AC_DOC_TYPE_PLURAL.GR).toBe("Goods received");
    expect(AC_DOC_TYPE_PLURAL.GR).not.toBe(`${AC_DOC_TYPE_LABEL.GR}s`);
    for (const t of AC_DOC_TYPES) expect(AC_DOC_TYPE_PLURAL[t]).not.toMatch(/receiveds/i);
  });

  it("offers the six types in the order the owner asked for", () => {
    expect([...AC_DOC_TYPES]).toEqual(["SO", "DO", "IV", "PO", "GR", "PI"]);
  });

  it("passes an unknown type through rather than showing a blank", () => {
    expect(acDocTypePlural("ZZ")).toBe("ZZ");
  });

  it("never doubles the noun when it names a row", () => {
    expect(acRowKind("IV", "do_to_iv")).toBe("Invoice from a delivery order");
    expect(acRowKind("IV", "do_to_iv")).not.toMatch(/invoice invoice/i);
    expect(acRowKind("GR", "edit")).toBe("Change to the goods received");
    expect(acRowKind("SO", "cancel")).toBe("Cancellation of the sales order");
  });
});

describe("no coding words on this screen", () => {
  const forbidden = [
    /autocount_writeback/i,
    /AddPartialTransferDetail/,
    /linked_ac_dtlkey/i,
    /autocount_item_bindings/i,
    /nvarchar/i,
    /\bcron\b/i,
    /Error\)/,
    /create_so|so_to_do|gr_to_pi|do_to_iv|po_to_gr|create_po/,
  ];

  const everyString = [
    ...Object.values(AC_FILTER_STATE_LABEL),
    ...Object.values(AC_STATE_PLAIN_MEANING),
    ...Object.values(AC_DOC_TYPE_LABEL),
    ...Object.values(AC_DOC_TYPE_PLURAL),
    ...Object.values(AC_REPLY_LABEL),
    ...Object.values(AC_REASON_COPY).flatMap((c) => [c.headline, c.explain, c.toFix]),
    AC_FAILED_COPY.headline, AC_FAILED_COPY.explain, AC_FAILED_COPY.toFix,
    ...AC_FILTER_STATES.map((s) => acListTitle(s, "")),
    ...["create_so", "create_po", "so_to_do", "po_to_gr", "do_to_iv", "gr_to_pi", "cancel", "edit"]
      .map((op) => acOpLabel(op)),
    acWritebackLine(payload()),
    acWritebackLine(payload({ writeback: { value: "off", on: false, scope: "off" } })),
    acHeadline(payload()).text,
    acHeadline(payload({ writeback: { value: null, on: false, scope: "off" } })).text,
  ];

  it("holds not one word of the machinery in any string it can produce", () => {
    for (const s of everyString) {
      for (const bad of forbidden) expect(s).not.toMatch(bad);
    }
  });

  it("names the operation in words, and passes an unknown one through untranslated", () => {
    expect(acOpLabel("so_to_do")).toBe("Delivery order from a sales order");
    expect(acOpLabel("create_so")).toBe("New sales order");
    /* An op nobody has words for reads as itself. Inventing a label for a value
       this build has never seen would be a guess printed as a fact. */
    expect(acOpLabel("brand_new_op")).toBe("brand_new_op");
  });
});

describe("acHeadline — the owner's question, answered in one line", () => {
  it("says sending is switched off rather than reporting a stopped sync as healthy", () => {
    const h = acHeadline(payload({ writeback: { value: "off", on: false, scope: "off" } }));
    expect(h.tone).toBe("muted");
    expect(h.text).toContain("switched off");
    expect(h.text).not.toContain("Everything is in AutoCount");
  });

  it("distinguishes an empty queue from a healthy one", () => {
    expect(acHeadline(payload()).text).toContain("nothing has ever been queued");
  });

  it("counts the not-accepted and the held-back together and names both", () => {
    const h = acHeadline(payload({
      counts: { pending: 0, sent: 3, failed: 1, skipped: 2, requeued: 4, attention: 3, total: 10 },
    }));
    expect(h.tone).toBe("bad");
    expect(h.text).toContain("3 documents need your attention");
    expect(h.text).toContain("1 was not accepted");
    expect(h.text).toContain("2 held back");
  });

  it("agrees with itself about one document", () => {
    const h = acHeadline(payload({
      counts: { pending: 0, sent: 0, failed: 1, skipped: 0, requeued: 0, attention: 1, total: 1 },
    }));
    expect(h.text).toContain("1 document needs your attention");
  });

  /* A re-queued skip is history. If it leaked into `attention` the owner would
     see a permanent phantom failure. */
  it("re-queued rows alone do not make the page red", () => {
    const h = acHeadline(payload({
      counts: { pending: 0, sent: 1, failed: 0, skipped: 0, requeued: 5, attention: 0, total: 6 },
    }));
    expect(h.tone).toBe("good");
    expect(h.text).toContain("Everything is in AutoCount");
  });

  it("a waiting backlog is good news, not an alarm", () => {
    const h = acHeadline(payload({
      counts: { pending: 2, sent: 0, failed: 0, skipped: 0, requeued: 0, attention: 0, total: 2 },
    }));
    expect(h.tone).toBe("good");
    expect(h.text).toContain("2 still on the way");
  });

  it("says something while the queue is still loading", () => {
    expect(acHeadline(null).tone).toBe("muted");
  });
});

describe("acWritebackLine — the switch, without the setting it lives in", () => {
  it("says on, and for whom", () => {
    expect(acWritebackLine(payload())).toBe("Sending to AutoCount is switched on for this company.");
    expect(acWritebackLine(payload({ writeback: { value: "all", on: true, scope: "all" } })))
      .toContain("every company");
  });

  /* A typo like 'On ' is OFF. The page used to print the config key to make it
     visible; it prints the VALUE now, which is the half that helps. */
  it("shows a value that does not read as on, without naming the setting", () => {
    const line = acWritebackLine(payload({ writeback: { value: "On ", on: false, scope: "off" } }));
    expect(line).toContain('"On "');
    expect(line).toContain("does not read as on");
    expect(line).not.toMatch(/autocount_writeback/);
  });

  it("distinguishes never-set from set-to-something-wrong", () => {
    expect(acWritebackLine(payload({ writeback: { value: null, on: false, scope: "off" } })))
      .toContain("never been set");
  });
});

describe("the refusal, in three parts", () => {
  it("gives a held-back document a headline, an explanation and a To fix", () => {
    const c = acReasonCopy("skipped", "missing-location");
    expect(c?.headline).toMatch(/warehouse/i);
    expect(c?.explain.length).toBeGreaterThan(20);
    expect(c?.toFix).toMatch(/Send again/);
  });

  it("has copy for every skip kind the server can classify", () => {
    /* Every kind in AC_SKIP_KINDS (backend/src/scm/lib/autocount-outbox-status.ts,
       catalogued in docs/autocount-sync-reasons.md §2), plus the key the server
       uses when it recognises nothing. A kind with no copy here falls through to
       the unrecognised text and quietly loses its remedy — which is what
       happened on the server side to three refusal classes until 2026-08-16. */
    for (const kind of [
      "keyless-line", "sofa-collapse", "item-code", "desc2-too-long", "missing-location",
      "missing-agent", "missing-sales-location", "missing-creditor",
      "compose-failed", "masters-not-opened", "no-source-document", "no-autocount-shape",
      "dtlkey-subset", "cancelled-before-send", "edit-before-counterpart", "grn-mislinked",
      "unrecognised",
    ]) {
      expect(AC_REASON_COPY[kind], kind).toBeTruthy();
    }
  });

  it("says it has no words yet rather than guessing at a lookalike", () => {
    expect(acReasonCopy("skipped", "a-class-written-next-month")).toBe(AC_UNRECOGNISED_COPY);
  });

  it("gives a refused document the AutoCount copy, since the server does not classify those", () => {
    expect(acReasonCopy("failed", null)).toBe(AC_FAILED_COPY);
  });

  /* A To fix line on a row that has already been sent again would send somebody
     to fix what is already fixed — the whole reason `requeued` exists. */
  it("gives a re-queued row no To fix, even though it still carries a kind", () => {
    expect(acReasonCopy("requeued", "item-code")).toBeNull();
  });

  it("says nothing about a waiting or an arrived document", () => {
    expect(acReasonCopy("pending", null)).toBeNull();
    expect(acReasonCopy("sent", null)).toBeNull();
  });
});

describe("who said it", () => {
  it("a held-back document was never offered to AutoCount", () => {
    expect(acReplySource("skipped", "refused, nothing sent (ItemCodeError): x")).toBe("erp");
    expect(acReplySource("requeued", "[re-queued ...] refused")).toBe("erp");
    expect(AC_REPLY_LABEL.erp).toBe("AutoCount was not asked");
  });

  it("a refused document carries AutoCount's own answer", () => {
    expect(acReplySource("failed", "Invalid Debtor Code.")).toBe("autocount");
    expect(AC_REPLY_LABEL.autocount).toBe("AutoCount replied");
  });

  /* A waiting row's note may be AutoCount's answer OR the ERP saying it is still
     waiting on a parent, and nothing the server sends tells the two apart.
     Claiming either would be a guess. */
  it("claims neither for a row still being retried", () => {
    expect(acReplySource("pending", "waiting: parent has no AutoCount document yet")).toBe("attempt");
  });

  it("does not invent a speaker when nothing was written down", () => {
    expect(acReplySource("failed", null)).toBe("none");
  });
});

describe("the type strip counts", () => {
  const rows = [
    row({ id: "1", doc_type: "SO" }),
    row({ id: "2", doc_type: "SO" }),
    row({ id: "3", doc_type: "DO" }),
    row({ id: "4", doc_type: "GR" }),
  ];

  it("counts every type it offers, including the ones at zero", () => {
    const c = acDocTypeCounts(rows);
    expect(c.all).toBe(4);
    expect(c.SO).toBe(2);
    expect(c.DO).toBe(1);
    expect(c.GR).toBe(1);
    expect(c.IV).toBe(0);
    expect(c.PI).toBe(0);
  });

  it("counts nothing as zero rather than as absent", () => {
    expect(acDocTypeCounts([]).SO).toBe(0);
  });

  it("filters to a type, and an empty type means every type", () => {
    expect(acRowsOfType(rows, "SO")).toHaveLength(2);
    expect(acRowsOfType(rows, "")).toHaveLength(4);
  });

  /* The status chips take the SERVER's numbers, which are exact and cover the
     whole company — a different kind of number from the type counts above, and
     the reason the two strips are fed from two different helpers. */
  it("takes the status count from the server, with Everything meaning the total", () => {
    const d = payload({
      counts: { pending: 1, sent: 2, failed: 3, skipped: 4, requeued: 5, attention: 7, total: 15 },
    });
    expect(acStateCount(d, "all")).toBe(15);
    expect(acStateCount(d, "attention")).toBe(7);
    expect(acStateCount(d, "failed")).toBe(3);
    expect(acStateCount(null, "failed")).toBe(0);
  });

  it("names the two filters in force over the list", () => {
    expect(acListTitle("all", "")).toBe("All documents");
    expect(acListTitle("failed", "")).toBe("Not accepted");
    expect(acListTitle("failed", "GR")).toBe("Not accepted · Goods received");
  });
});

describe("the words", () => {
  it("held back is as loud as not accepted — both mean the document is not in the book", () => {
    expect(acStateTone("failed")).toBe("bad");
    expect(acStateTone("skipped")).toBe("bad");
    expect(acStateTone("requeued")).toBe("muted");
    expect(acStateTone("sent")).toBe("good");
  });

  it("labels a state in the owner's vocabulary, and passes an unknown one through", () => {
    expect(acStateLabel("sent")).toBe("In AutoCount");
    expect(acStateLabel("skipped")).toBe("Held back");
    expect(acStateLabel("something-new")).toBe("something-new");
  });

  it("uses ONE set of five labels for the badge and the chip", () => {
    for (const s of ["pending", "sent", "failed", "skipped", "requeued"] as const) {
      expect(AC_FILTER_STATE_LABEL[s]).toBe(acStateLabel(s));
    }
  });

  it("says where a row stands, per state", () => {
    expect(acRowStatusLine(row({ state: "sent", ac_doc_no: "SO-00123" }), 6))
      .toBe("In the account book as SO-00123");
    expect(acRowStatusLine(row({ state: "pending", attempts: 2 }), 6))
      .toBe("Tried 2 times, will keep trying up to 6");
    expect(acRowStatusLine(row({ state: "pending", attempts: 0 }), 6)).toMatch(/Not tried yet/);
    expect(acRowStatusLine(row({ state: "failed", attempts: 1 }), 6)).toBe("Tried 1 time, then stopped");
    expect(acRowStatusLine(row({ state: "skipped" }), 6)).toBe("Held back on purpose");
    expect(acRowStatusLine(row({ state: "requeued" }), 6)).toMatch(/Already sent again/);
    expect(acRowStatusLine(row({ state: "something-new" }), 6)).toBe("");
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
