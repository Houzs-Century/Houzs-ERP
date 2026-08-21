import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }));
vi.mock("../api/client", () => ({ api: { get: vi.fn(), post: apiPost } }));

import {
  AC_DEFAULT_FILTERS,
  AC_DEFAULT_STATE,
  AC_DOC_TYPES,
  AC_DOC_TYPE_LABEL,
  AC_DOC_TYPE_PLURAL,
  AC_FAILED_COPY,
  AC_FILTER_STATES,
  AC_FILTER_STATE_LABEL,
  AC_EARLIER_SENDS_NOTE,
  AC_ONLY_REPLACED_LINE,
  AC_REASON_COPY,
  AC_REPLACED_GROUP_NOTE,
  AC_REPLACED_LINE,
  AC_REPLACED_NOTE,
  AC_REPLY_LABEL,
  AC_REQUEUE_TODO,
  AC_SEND_AGAIN_LABEL,
  AC_STATE_LABEL,
  AC_STATE_PLAIN_MEANING,
  AC_TECHNICAL_LABEL,
  AC_UNRECOGNISED_COPY,
  acAge,
  acDocTypeCounts,
  acDocTypePlural,
  acDocumentKey,
  acEarlierSendsHeading,
  acEmptyLine,
  acGroupByDocument,
  acGroupsOfType,
  acHeadline,
  acListCountLine,
  acListTitle,
  acOpLabel,
  acOpensItself,
  acReasonCopy,
  acReplacedHeading,
  acReplySource,
  acRequeueTodo,
  acRowDetail,
  acRowKind,
  acRowStandsAt,
  acRowStatusLine,
  acSplitMachineText,
  acSplitReplaced,
  acStateCount,
  acStateLabel,
  acStateTone,
  acWhatWasSaid,
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
  counts_complete: true,
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
  can_send_now: false,
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

  /* NO EMPTY STATE MAY CLAIM THE WORK IS DONE (owner 2026-08-17). The server
     already tells us when its count scan gave up — `counts_complete: false` —
     and both screens render a banner for it. The headline used to ignore the
     flag and print the green "Everything is in AutoCount" beside that banner.
     A count that is a FLOOR cannot support a verdict of "nothing was refused". */
  it("will not say everything arrived when the server says it could not finish counting", () => {
    const h = acHeadline(payload({
      counts_complete: false,
      counts: { pending: 0, sent: 900, failed: 0, skipped: 0, requeued: 0, attention: 0, total: 900 },
    }));
    expect(h.text).not.toContain("Everything is in AutoCount");
    expect(h.tone).not.toBe("good");
    expect(h.text).toMatch(/cannot say whether everything reached AutoCount/i);
    /* And it must not simply repeat AC_COUNTS_PARTIAL_LINE, which sits directly
       under it on both screens — two copies of one sentence teach the reader to
       skip both. */
    expect(h.text).not.toContain("at least this many");
  });

  /* The guard must not swallow the alarm. A partial count that ALREADY shows
     refused documents is still showing refused documents — a floor above zero
     is above zero — so `attention` keeps winning. */
  it("still raises the alarm when a partial count already found refusals", () => {
    const h = acHeadline(payload({
      counts_complete: false,
      counts: { pending: 0, sent: 5, failed: 2, skipped: 0, requeued: 0, attention: 2, total: 7 },
    }));
    expect(h.tone).toBe("bad");
    expect(h.text).toContain("need your attention");
  });

  /* The empty-queue line is a claim too: "nothing has ever been queued" is a
     fact about the world, and a scan that stopped early cannot establish it. */
  it("does not report an unfinished count as an empty queue", () => {
    const h = acHeadline(payload({ counts_complete: false }));
    expect(h.text).not.toContain("nothing has ever been queued");
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

  /* OFF FOR THIS COMPANY IS NOT OFF ALTOGETHER — the switch is a company
     ALLOW-LIST, and until 2026-08-18 the server published "is it on for
     anybody" under the name `on`. A reader in the company NOT on the list was
     told sending was switched on FOR HIS COMPANY, and that saving a document
     would queue it. Neither was true, his queue is company-scoped and stays
     empty, and nothing errors. Same screen, same build, two organisations, and
     one of them was reading a false sentence.

     The old off-branch would have been just as wrong in the other direction: it
     would have called a perfectly well-formed value a typo that "does not read
     as on". Name the real situation instead. */
  it("says on for ANOTHER company, not that the value is a typo", () => {
    const line = acWritebackLine(payload({ writeback: { value: "1", on: false, scope: "1" } }));
    expect(line).toContain("switched off for this company");
    expect(line).toContain("another company");
    expect(line).not.toContain("does not read as on");
  });

  it("pluralises when the allow-list names several companies", () => {
    expect(acWritebackLine(payload({ writeback: { value: "1,3", on: false, scope: "1,3" } })))
      .toContain("other companies");
  });

  /* NULL IS ITS OWN STATE. The server could not resolve which company the
     reader is in, so it declines rather than guessing — and the page must
     decline too. Rendering that as "switched off" would state as fact the very
     thing that could not be established. */
  it("declines to answer when the company could not be resolved", () => {
    const line = acWritebackLine(payload({ writeback: { value: "1", on: null, scope: "1" } }));
    expect(line).toContain("could not be checked");
    expect(line).not.toContain("switched off");
    const h = acHeadline(payload({ writeback: { value: "1", on: null, scope: "1" } }));
    expect(h.text).toContain("could not be established");
    expect(h.text).not.toContain("queues nothing");
  });
});

describe("the refusal, in three parts", () => {
  it("gives a held-back document a headline, an explanation and a To fix", () => {
    const c = acReasonCopy("skipped", "missing-location", null);
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
      "mixed-source-lines",
      "unrecognised",
    ]) {
      expect(AC_REASON_COPY[kind], kind).toBeTruthy();
    }
  });

  it("says it has no words yet rather than guessing at a lookalike", () => {
    expect(acReasonCopy("skipped", "a-class-written-next-month", null)).toBe(AC_UNRECOGNISED_COPY);
  });

  it("gives a refused document the AutoCount copy, since the server does not classify those", () => {
    expect(acReasonCopy("failed", null, null)).toBe(AC_FAILED_COPY);
  });

  /* A To fix line on a row that has already been sent again would send somebody
     to fix what is already fixed — the whole reason `requeued` exists. */
  it("gives a re-queued row no To fix, even though it still carries a kind", () => {
    expect(acReasonCopy("requeued", "item-code", null)).toBeNull();
  });

  it("says nothing about a waiting or an arrived document", () => {
    expect(acReasonCopy("pending", null, null)).toBeNull();
    expect(acReasonCopy("sent", null, null)).toBeNull();
  });
});

describe("what to do about each Send again answer", () => {
  /* Every outcome docs/autocount-sync-reasons.md §1 catalogues, which is the
     RequeueOutcome union in backend/src/scm/lib/autocount-requeue.ts. The codes
     are the join between the server's "what happened" sentence and this side's
     "what to do next" — a code with neither would reach the owner as a bare
     hyphenated key, which is what the shared header warns against. */
  const OUTCOMES = [
    "would-requeue", "requeued", "requeued-as-recorded", "still-refused", "not-recoverable",
    "already-in-autocount", "already-queued", "already-requeued", "already-sent",
    "row-pending", "row-not-found", "document-gone", "switch-off", "declined",
    "read-failed",
  ];

  it("has a follow-up line for every outcome the server can answer with", () => {
    for (const code of OUTCOMES) expect(acRequeueTodo(code), code).toBeTruthy();
  });

  it("says NOTHING rather than a bare key for an outcome nobody has written yet", () => {
    expect(acRequeueTodo("an-outcome-added-next-month")).toBeNull();
  });

  it("does not tell anybody to work round a document AutoCount already accepted", () => {
    expect(AC_REQUEUE_TODO["already-sent"]).toMatch(/do not look for a way round it/i);
  });

  it("carries no coding words of its own", () => {
    for (const [code, text] of Object.entries(AC_REQUEUE_TODO)) {
      expect(text, code).not.toMatch(/autocount_writeback|linked_ac|\bcron\b|§/);
    }
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
  const groups = acGroupByDocument([
    row({ id: "1", doc_type: "SO", doc_no: "SO-1" }),
    row({ id: "2", doc_type: "SO", doc_no: "SO-2" }),
    row({ id: "3", doc_type: "DO", doc_no: "DO-1" }),
    row({ id: "4", doc_type: "GR", doc_no: "GR-1" }),
  ]);

  it("counts every type it offers, including the ones at zero", () => {
    const c = acDocTypeCounts(groups);
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
    expect(acGroupsOfType(groups, "SO")).toHaveLength(2);
    expect(acGroupsOfType(groups, "")).toHaveLength(4);
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
    expect(acRowStatusLine(row({ state: "requeued" }), 6)).toMatch(/Replaced by a newer send/);
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

/* ───────────────────────────────────────────────────────────────────────────
   HOW MUCH OF A ROW IS ON SCREEN BEFORE ANYBODY CLICKS.

   Owner, 2026-08-16, on the page rebuilt that morning: "这一个东西下面的地方太复杂
   了，你尽量简单化一点。一个 sales order 那么宽，那如果我有一千个 sales order 的时
   候，我不是完蛋？" These are the rules that shortened it, and the two that must
   NOT be shortened away with them — the headline is never hidden, and who was
   asked is never flattened.
   ─────────────────────────────────────────────────────────────────────────── */
describe("the page opens on what is stuck", () => {
  it("defaults to the attention filter rather than to everything", () => {
    expect(AC_DEFAULT_STATE).toBe("attention");
    expect(AC_DEFAULT_FILTERS.state).toBe(AC_DEFAULT_STATE);
  });

  it("is one of the filters the server accepts", () => {
    expect(AC_FILTER_STATES).toContain(AC_DEFAULT_STATE);
  });

  it("says nothing is stuck rather than telling a healthy company to try another filter", () => {
    const healthy = payload({
      counts: { pending: 0, sent: 900, failed: 0, skipped: 0, requeued: 0, attention: 0, total: 900 },
    });
    expect(acEmptyLine(healthy, "attention")).toMatch(/Nothing needs your attention/);
    /* Same company, a filter the reader CHOSE: "try another" is the right
       answer there and the wrong one on arrival. */
    expect(acEmptyLine(healthy, "failed")).toMatch(/Try another status/);
    expect(acEmptyLine(payload(), "attention")).toMatch(/Nothing has ever been queued/);
  });
});

describe("acRowStandsAt — one line, not five fragments", () => {
  it("puts the kind first and the timestamp last, so clipping loses the least", () => {
    const line = acRowStandsAt(
      row({ op: "so_to_do", doc_type: "DO", state: "sent", ac_doc_no: "DO-9",
        sent_at: "2026-08-15T01:00:00.000Z" }),
      6,
    );
    expect(line.startsWith("Delivery order from a sales order · ")).toBe(true);
    expect(line).toContain("In the account book as DO-9");
    expect(line).toMatch(/arrived .+$/);
  });

  it("says how long a waiting document has waited, and queued-at for everything else", () => {
    expect(acRowStandsAt(row({ state: "pending", attempts: 2 }), 6)).toMatch(/waiting/);
    expect(acRowStandsAt(row({ state: "failed", attempts: 6 }), 6)).toMatch(/queued/);
    expect(acRowStandsAt(row({ state: "failed", attempts: 6 }), 6)).not.toMatch(/waiting/);
  });
});

describe("acRowDetail — the headline stays, the rest goes behind the opener", () => {
  it("gives a document already in the account book nothing to open", () => {
    const d = acRowDetail(row({ state: "sent", ac_doc_no: "SO-9", reason: null }), false);
    expect(d).toEqual({
      line: null, copy: null, said: null, showRequeuedNote: false, expandable: false,
    });
  });

  /* Even a `sent` row that carries a note has nothing to open: it ARRIVED, and
     a warning on a document that is in the book is noise on the majority row. */
  it("keeps a sent row quiet even when the server left a note on it", () => {
    expect(acRowDetail(row({ state: "sent", reason: "a stale note" }), false).expandable).toBe(false);
  });

  it("keeps the plain-language headline visible on a held-back document", () => {
    const d = acRowDetail(
      row({ state: "skipped", reason_kind: "missing-location", reason: "MissingLocationError" }),
      false,
    );
    expect(d.line).toBe(AC_REASON_COPY["missing-location"]!.headline);
    /* The sentence and the To fix line are reachable, not printed. */
    expect(d.copy).toBe(AC_REASON_COPY["missing-location"]);
    expect(d.said?.label).toBe(AC_REPLY_LABEL.erp);
    expect(d.expandable).toBe(true);
  });

  it("labels a refusal AutoCount answered, and one it was never asked about", () => {
    const failed = acRowDetail(row({ state: "failed", reason: "FK_SO_SalesAgent" }), false);
    expect(failed.line).toBe(AC_FAILED_COPY.headline);
    expect(acReplySource("failed", "FK_SO_SalesAgent")).toBe("autocount");
    expect(acReplySource("skipped", "MissingLocationError")).toBe("erp");
  });

  /* No copy exists for this one — a waiting row carrying its last attempt's
     note — so the line says WHO spoke rather than inventing a headline. */
  it("falls back to who spoke when there is no plain wording for the row", () => {
    const d = acRowDetail(row({ state: "pending", attempts: 2, reason: "timeout" }), false);
    expect(d.line).toBe(AC_REPLY_LABEL.attempt);
    expect(d.copy).toBeNull();
    expect(d.expandable).toBe(true);
  });

  it("marks a replaced refusal as a record and keeps the why-not out of the way", () => {
    const d = acRowDetail(row({ state: "requeued", reason: "[re-queued …] ItemCodeError" }), false);
    expect(d.line).toBe(AC_REPLACED_LINE);
    expect(d.copy).toBeNull();
    expect(d.showRequeuedNote).toBe(true);
    expect(AC_REPLACED_NOTE).toMatch(/record of the first refusal/);
  });

  /* An accepted re-send takes the WHOLE reason off, opener included: "To fix:
     go and change it in AutoCount" on a document that has just gone back into
     the queue is a false instruction. */
  it("takes the reason off a document that has just been accepted back", () => {
    const d = acRowDetail(
      row({ state: "failed", reason: "FK_SO_SalesAgent", reason_kind: null }),
      true,
    );
    expect(d.line).toBeNull();
    expect(d.expandable).toBe(false);
  });

  it("opens by itself only for a refusal nobody has words for yet", () => {
    expect(acOpensItself(row({ reason_kind: "unrecognised" }))).toBe(true);
    expect(acOpensItself(row({ reason_kind: "missing-location" }))).toBe(false);
    expect(acOpensItself(row({ reason_kind: null }))).toBe(false);
  });
});

/* ───────────────────────────────────────────────────────────────────────────
   NOTHING THE SERVER WROTE IS THE PAGE'S OWN VOICE.

   Owner, 2026-08-16, reading the LIVE page: a held-back invoice was printing
   "AutoCount builds a DO / GRN / Invoice only by transferring a source
   document's lines (AddPartialTransferDetail is the SDK's only primitive)…",
   and a not-accepted delivery order was printing AutoCount's eleven-word
   refusal followed by four lines of the account book's own numbers.

   Both arrived from the SERVER, which is why the earlier rule — "no coding
   words in the strings this file writes" — was green while the screen was not.
   The rule below is about the MECHANISM instead, so it holds for a refusal
   class nobody has written yet.
   ─────────────────────────────────────────────────────────────────────────── */
describe("what the server wrote never reaches the page as prose", () => {
  /* VERBATIM PRODUCTION STRINGS, each with the writer that produces it. They
     are literals rather than imports on purpose: this is the frontend suite and
     it cannot import backend modules, and a paraphrase would test the
     paraphrase. Re-derive with, from the repo root:

       grep -n "last_error:\|reason:$\|reason:" backend/src/scm/lib/autocount-outbox.ts

     and AcSyncService.cs for the `||` half. */
  const LIVE_NOTES: Array<{ what: string; row: AcOutboxRow }> = [
    {
      /* recordParentlessCreate, backend/src/scm/lib/autocount-outbox.ts — AS THE
         QUEUE STILL HOLDS IT. The writer stopped producing this sentence in the
         same change as this test, and that alone fixes nothing the owner is
         looking at: scm.autocount_outbox is append-only and `last_error` is
         never rewritten (the re-queue marker is PREPENDED, isRequeuedNote), so
         every row already written keeps these exact words for good. */
      what: "the parentless invoice, as production wrote it",
      row: row({
        id: "hist", doc_no: "HC-IV-2608-004", doc_type: "IV", op: "do_to_iv",
        status: "skipped", state: "skipped", needs_attention: true,
        reason_kind: "no-source-document",
        reason:
          "created with no source delivery order, so there is no source document to transfer from. "
          + "AutoCount builds a DO / GRN / Invoice only by transferring a source document's lines "
          + "(AddPartialTransferDetail is the SDK's only primitive), so this document cannot be "
          + "created in the account book at all and will stay ERP-only.",
      }),
    },
    {
      /* noteReadFailure writes `refused, nothing sent (${e.name}): …` for eight
         error classes. The class name is the CLASSIFIER's needle and has to stay
         in the column; it must not be on the screen. */
      what: "a refusal class name in the ERP's own note",
      row: row({
        id: "kl", doc_no: "HC-SO-2608-009", status: "skipped", state: "skipped",
        needs_attention: true, reason_kind: "keyless-line",
        reason: "refused, nothing sent (KeylessLineError): line 3 carries no linked_ac_dtlkey",
      }),
    },
    {
      /* AcSyncService.cs's transfer arm, added 2026-08-16, reaching the ERP
         through `Gave up after N attempts. Last error: …`. This is the wall. */
      what: "AutoCount's refusal plus the account book, line by line",
      row: row({
        id: "dump", doc_no: "HC-DO-2608-002", doc_type: "DO", op: "so_to_do",
        status: "failed", state: "failed", attempts: 6, needs_attention: true,
        can_requeue: true,
        reason:
          "Gave up after 6 attempts. Last error: Invalid transfer item. || source SO lines as the "
          + "book holds them: 905348 on SO HC-SO-2608-002 [AK-ULTIMATE MATT (K)] Qty=1.00000000 "
          + "TransferedQty=0.00000000 Transferable=T docCancelled=F outstanding=1.00000000; "
          + "905349 on SO HC-SO-2608-002 [HOK-1013 (K)] Qty=1.00000000 TransferedQty=0.00000000 "
          + "Transferable=T docCancelled=F outstanding=1.00000000",
      }),
    },
  ];

  /** Everything a reader sees WITHOUT opening the technical disclosure. */
  const plainSideOf = (r: AcOutboxRow): string => {
    const d = acRowDetail(r, false);
    return [d.line, d.copy?.explain, d.copy?.toFix, d.said?.label, d.said?.said]
      .filter((s) => s != null).join(" \n ");
  };

  const MACHINERY = [
    /AddPartialTransferDetail/,
    /\bSDK\b/,
    /linked_ac_dtlkey/i,
    /[A-Za-z]+Error\)/,
    /TransferedQty|docCancelled|Transferable=|Qty=/,
  ];

  it("keeps every one of these off the plain-language side of the row", () => {
    for (const { what, row: r } of LIVE_NOTES) {
      const plain = plainSideOf(r);
      for (const bad of MACHINERY) expect(plain, `${what}: ${plain}`).not.toMatch(bad);
    }
  });

  /* THE OTHER HALF, AND IT MATTERS AS MUCH. Hiding the evidence would be a
     different bug: the per-line dump is what refuted the standing diagnosis for
     these two delivery orders (docs/autocount-sync-reasons.md §4). It moves; it
     does not go. */
  it("keeps every one of them REACHABLE, behind the technical disclosure", () => {
    for (const { what, row: r } of LIVE_NOTES) {
      const said = acRowDetail(r, false).said;
      expect(said?.technical, what).toBeTruthy();
      /* Whatever was taken off the plain side is in there, whole. */
      expect(`${said?.said ?? ""}${said?.technical ?? ""}`, what).toContain(
        r.reason!.slice(-40),
      );
    }
  });

  it("still says WHO spoke on each of them — the distinction is not the machinery", () => {
    expect(acRowDetail(LIVE_NOTES[0]!.row, false).said?.label).toBe("AutoCount was not asked");
    expect(acRowDetail(LIVE_NOTES[2]!.row, false).said?.label).toBe("AutoCount replied");
  });

  /* THE HEADLINE IS NOT MACHINERY AND DOES NOT MOVE. He rejected a design where
     the reason sat behind a click; this change moves only what is under it. */
  it("leaves the plain-language headline on the row, unclicked, for all of them", () => {
    for (const { what, row: r } of LIVE_NOTES) {
      expect(acRowDetail(r, false).line, what).toBeTruthy();
    }
    expect(acRowDetail(LIVE_NOTES[0]!.row, false).line)
      .toBe(AC_REASON_COPY["no-source-document"]!.headline);
    expect(acRowDetail(LIVE_NOTES[2]!.row, false).line).toBe(AC_FAILED_COPY.headline);
  });
});

describe("acSplitMachineText — the separator the AutoCount service itself writes", () => {
  it("keeps the sentence and hands the evidence over", () => {
    const s = acSplitMachineText("Invalid transfer item. || source SO lines: 905348 Qty=1");
    expect(s.said).toBe("Invalid transfer item.");
    expect(s.detail).toBe("source SO lines: 905348 Qty=1");
  });

  it("leaves a message that carries no evidence exactly as it is", () => {
    expect(acSplitMachineText("Invalid Debtor Code."))
      .toEqual({ said: "Invalid Debtor Code.", detail: null });
  });

  /* Only the FIRST separator splits. The dump itself is semicolon-separated and
     a second `||` inside it belongs to the evidence, not to a third section. */
  it("splits once, at the first mark", () => {
    expect(acSplitMachineText("a || b || c").detail).toBe("b || c");
  });
});

describe("acWhatWasSaid — who spoke, and how much of it is on screen", () => {
  const erp = row({
    state: "skipped", reason_kind: "missing-location",
    reason: "refused, nothing sent (MissingLocationError): line 2",
  });

  it("folds the ERP's own note away entirely once this file has plain words for it", () => {
    const said = acWhatWasSaid(erp, true);
    expect(said.said).toBeNull();
    expect(said.technical).toBe(erp.reason);
    expect(said.notAsked).toBe(true);
    expect(said.label).toBe("AutoCount was not asked");
  });

  /* A refusal nobody has copy for yet: the quote IS the answer, and taking it
     off the screen would leave the row saying only that nobody has words. */
  it("shows the ERP's note when this file has NO words for the row", () => {
    expect(acWhatWasSaid(erp, false).said).toBe(erp.reason);
  });

  /* THIS USED TO ASSERT "never folds AutoCount's own sentence away, plain words
     or not", by calling acWhatWasSaid directly with hasWords=true. That flag
     said "who spoke" when it was written, because the only notes this file had
     words for were the ERP's — so for an AutoCount answer the true branch was
     unreachable and asserting it pinned a case the page could not produce.

     `AC_AUTOCOUNT_SAID` made it reachable, and the PROPERTY worth protecting is
     unchanged: an AutoCount refusal this file cannot explain must keep its words
     ON THE ROW, because there the machine's sentence is the entire diagnosis.
     What changed is that the property is now asserted through `acRowDetail`, the
     caller that actually decides the flag — a test that hand-feeds an argument
     its only caller would never pass proves nothing about the screen. */
  it("never folds an AutoCount sentence this file cannot explain", () => {
    const failed = row({
      state: "failed",
      reason: "Invalid transfer item. || source SO lines as the book holds them: 905348 Qty=1",
    });
    /* Through the real caller: no translation exists for this string, so the
       generic failed copy is used and the quote stays in view. */
    const detail = acRowDetail(failed, false);
    expect(detail.said!.said).toBe("Invalid transfer item.");
    expect(detail.said!.technical).toBe("source SO lines as the book holds them: 905348 Qty=1");
    /* And directly, on the branch acRowDetail computes for it. */
    const said = acWhatWasSaid(failed, false);
    expect(said.said).toBe("Invalid transfer item.");
  });

  /* The other half of the same rule, and the reason the flag stopped being about
     who spoke: where this file DOES say what the note says, the raw text is
     duplication on the face of the row and belongs in the disclosure — exactly
     where the ERP's own notes already go. */
  it("folds an AutoCount sentence away once this file has plain words for it", () => {
    const refused = row({
      state: "failed",
      reason: "Gave up after 6 attempts. Last error: Primary Key Error",
    });
    const detail = acRowDetail(refused, false);
    expect(detail.line).toBe("AutoCount already has a document with this number");
    expect(detail.said!.said).toBeNull();
    expect(detail.said!.technical).toContain("Primary Key Error");
  });

  it("says nothing came back, rather than inventing a speaker", () => {
    const said = acWhatWasSaid(row({ state: "failed", reason: null }), false);
    expect(said.silent).toBe(true);
    expect(said.said).toBeNull();
    expect(said.label).toBe("AutoCount said nothing");
  });

  it("names who the collapsed block is for, so nobody opens it expecting an answer", () => {
    expect(AC_TECHNICAL_LABEL).toMatch(/AutoCount link/);
  });
});

/* ───────────────────────────────────────────────────────────────────────────
   AN ORDER TO FIX SOMETHING THAT IS NOT BROKEN.

   Owner, 2026-08-16, on a delivery order whose entire refusal was `Invalid
   transfer item.` — eleven words naming no field, no line and no document, over
   lines that had been measured against the live book that same day and were
   correct on every count the book keeps.
   ─────────────────────────────────────────────────────────────────────────── */
describe("the To fix line for a refusal AutoCount did not explain", () => {
  it("no longer orders anybody to go and put right whatever AutoCount named", () => {
    expect(AC_FAILED_COPY.toFix).not.toMatch(/Put right whatever AutoCount named/);
  });

  it("says plainly that the refusal may name nothing to act on", () => {
    expect(AC_FAILED_COPY.toFix).toMatch(/name nothing you can act on/i);
    expect(AC_FAILED_COPY.toFix).toMatch(/nothing on this document for you to change/i);
  });

  it("says WHO to tell, since the reader cannot fix it himself", () => {
    expect(AC_FAILED_COPY.toFix).toMatch(/whoever looks after the AutoCount link/i);
    expect(AC_FAILED_COPY.toFix).toMatch(/document number/i);
  });

  /* The other half stays: plenty of AutoCount refusals DO name a master, and
     "we cannot help you" would be as wrong in that direction. */
  it("still tells somebody what to do when AutoCount did name something", () => {
    expect(AC_FAILED_COPY.toFix).toMatch(/salesperson|warehouse|customer/);
    expect(AC_FAILED_COPY.toFix).toMatch(/save the document here again/i);
  });
});

/* ───────────────────────────────────────────────────────────────────────────
   ONE ROW PER DOCUMENT, NOT ONE ROW PER SEND.

   Owner, 2026-08-16, reading the live page: "为什么在 AutoCount 里面一张 Sales
   Order 会出现两次呢?" Under In AutoCount / Sales orders, HC-SO-2608-002 took FOUR
   of the six rows — three changes at 16/08 4:30-4:31pm and the create at 15/08
   1:25am — while AED_HOUZS holds exactly one of it, verified by direct SQL.

   Nothing was duplicated. scm.autocount_outbox is append-only and writes one row
   per intended operation (migration 0277), so a document that is created and
   then edited three times IS four rows, for good. The list was the wrong unit.
   ─────────────────────────────────────────────────────────────────────────── */
describe("one row per document", () => {
  /** His four rows, in the order the route returns them: newest first. */
  const HC_SO_2608_002: AcOutboxRow[] = [
    row({ id: "s4", op: "edit", doc_no: "HC-SO-2608-002", state: "sent", status: "sent",
      ac_doc_no: "SO-00002", created_at: "2026-08-16T08:31:40.000Z" }),
    row({ id: "s3", op: "edit", doc_no: "HC-SO-2608-002", state: "sent", status: "sent",
      ac_doc_no: "SO-00002", created_at: "2026-08-16T08:31:05.000Z" }),
    row({ id: "s2", op: "edit", doc_no: "HC-SO-2608-002", state: "sent", status: "sent",
      ac_doc_no: "SO-00002", created_at: "2026-08-16T08:30:12.000Z" }),
    row({ id: "s1", op: "create_so", doc_no: "HC-SO-2608-002", state: "sent", status: "sent",
      ac_doc_no: "SO-00002", created_at: "2026-08-14T17:25:00.000Z" }),
  ];

  /** The other two sales orders that made up his six rows. */
  const others: AcOutboxRow[] = [
    row({ id: "o1", doc_no: "HC-SO-2608-003", state: "sent", status: "sent",
      ac_doc_no: "SO-00003", created_at: "2026-08-16T02:00:00.000Z" }),
    row({ id: "o2", doc_no: "HC-SO-2608-004", state: "sent", status: "sent",
      ac_doc_no: "SO-00004", created_at: "2026-08-16T01:00:00.000Z" }),
  ];

  /* THE DEFECT, AS A NUMBER. Six rows, three documents. */
  it("renders one sales order once, however many times it was sent", () => {
    const rows = [...HC_SO_2608_002, ...others];
    expect(rows).toHaveLength(6);
    const groups = acGroupByDocument(rows);
    expect(groups).toHaveLength(3);
    expect(groups.filter((g) => g.docNo === "HC-SO-2608-002")).toHaveLength(1);
  });

  /* AND THE COUNT UNDER THE STRIPS AGREES WITH THE LIST. "6 of 17 documents"
     over six rows for three documents was the other half of what he read. */
  it("counts the documents on screen, not the sends", () => {
    const groups = acGroupByDocument([...HC_SO_2608_002, ...others]);
    expect(acDocTypeCounts(groups).SO).toBe(3);
    expect(acDocTypeCounts(groups).all).toBe(3);
    expect(acListCountLine(groups.length, 3)).toBe("3 of 3 documents");
    expect(acListCountLine(1, 1)).toBe("1 of 1 document");
  });

  it("draws the row from the NEWEST send, whatever order they arrive in", () => {
    /* Shuffled on purpose: the route orders created_at descending and this must
       not depend on it, because `current` is what the whole row is drawn from. */
    const shuffled = [HC_SO_2608_002[2]!, HC_SO_2608_002[0]!, HC_SO_2608_002[3]!, HC_SO_2608_002[1]!];
    const g = acGroupByDocument(shuffled)[0]!;
    expect(g.current.id).toBe("s4");
    expect(g.sends.map((r) => r.id)).toEqual(["s4", "s3", "s2", "s1"]);
    expect(g.earlier.map((r) => r.id)).toEqual(["s3", "s2", "s1"]);
  });

  /* THE SEND HISTORY IS THE AUDIT TRAIL AND NOTHING IS DROPPED. A year later
     "what did we tell AutoCount, when, and what did it answer" has to still be
     answerable — 0277's own reason for existing. */
  it("keeps every send, behind the document", () => {
    const g = acGroupByDocument(HC_SO_2608_002)[0]!;
    expect(g.sends).toHaveLength(4);
    expect(g.earlier).toHaveLength(3);
    expect(new Set(g.sends.map((r) => r.id)).size).toBe(4);
  });

  it("names the fold in both forms, written out", () => {
    expect(acEarlierSendsHeading(1)).toBe("1 earlier send for this document");
    expect(acEarlierSendsHeading(3)).toBe("3 earlier sends for this document");
    expect(acEarlierSendsHeading(1)).not.toContain("sends");
    expect(AC_EARLIER_SENDS_NOTE).toMatch(/record of what/i);
  });

  /* A DOCUMENT NUMBER IS NOT A DOCUMENT. The six types are independent
     sequences and the same number can legitimately belong to two of them;
     folding those together would LOSE a document, which is worse than showing
     one twice. This is why the key is the pair, matching the table's own
     autocount_outbox_doc_idx (company_id, doc_type, doc_no). */
  it("keeps two types carrying one number apart", () => {
    const groups = acGroupByDocument([
      row({ id: "so", doc_type: "SO", doc_no: "2608-002" }),
      row({ id: "do", doc_type: "DO", doc_no: "2608-002" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(acDocumentKey(groups[0]!.current)).not.toBe(acDocumentKey(groups[1]!.current));
  });

  /* A document carries several OPS — 0277 admits eight — and they are the same
     document. Grouping on the op as well would put the create and its edits on
     separate rows, which is the defect with an extra step. */
  it("folds a create and its edits into one document", () => {
    const groups = acGroupByDocument([
      row({ id: "e", op: "edit", doc_no: "HC-SO-2608-002" }),
      row({ id: "c", op: "create_so", doc_no: "HC-SO-2608-002" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.sends).toHaveLength(2);
  });

  it("keeps the server's order — the newest document first", () => {
    const groups = acGroupByDocument([
      row({ id: "b", doc_no: "SO-B", created_at: "2026-08-16T00:00:00.000Z" }),
      row({ id: "a", doc_no: "SO-A", created_at: "2026-08-15T00:00:00.000Z" }),
    ]);
    expect(groups.map((g) => g.docNo)).toEqual(["SO-B", "SO-A"]);
  });

  /* A send with no timestamp still has to land somewhere, and the safe place is
     LAST: a null created_at must never take over the row and decide what the
     document's state is. */
  it("does not let an undated send draw the row", () => {
    const g = acGroupByDocument([
      row({ id: "undated", state: "skipped", created_at: null }),
      row({ id: "dated", state: "sent", created_at: "2026-08-15T00:00:00.000Z" }),
    ])[0]!;
    expect(g.current.id).toBe("dated");
  });

  it("has nothing to fold for a document sent once", () => {
    const g = acGroupByDocument([row({ id: "only" })])[0]!;
    expect(g.earlier).toEqual([]);
    expect(g.current.id).toBe("only");
  });

  it("answers an empty queue with no documents rather than one empty one", () => {
    expect(acGroupByDocument([])).toEqual([]);
  });
});

/* ───────────────────────────────────────────────────────────────────────────
   "SENT AGAIN" WAS AN INSTRUCTION, AND THE ROW MEANT THE OPPOSITE.

   Owner, 2026-08-16: "你写 Send Again，明明都已经进去了，为什么还要 Send Again？"
   The badge carried the same two words as the BUTTON on the same screen, on
   seven of seventeen rows — exactly the rows where pressing it is the one thing
   a reader must not do. The state is not an action; it is something that has
   already happened to the record.
   ─────────────────────────────────────────────────────────────────────────── */
describe("the replaced state does not read as an instruction", () => {
  it("no longer wears the button's words", () => {
    expect(AC_STATE_LABEL.requeued).toBe("Replaced");
    expect(AC_FILTER_STATE_LABEL.requeued).toBe("Replaced");
    /* The button is unchanged and still says Send again — which is the whole
       reason the badge may not. */
    expect(AC_SEND_AGAIN_LABEL).toBe("Send again");
    for (const s of [AC_STATE_LABEL.requeued, AC_FILTER_STATE_LABEL.requeued]) {
      expect(s.toLowerCase()).not.toContain("send again");
    }
  });

  /* THE ROW'S OWN BODY HAS TO AGREE WITH THE BADGE. It said "Already sent
     again ... this row is history" under a badge saying "Sent again", which is
     the same instruction twice. */
  it("says the same thing on the badge, the line and the status", () => {
    const replaced = row({ state: "requeued", reason: "[re-queued …] refused" });
    expect(acRowStatusLine(replaced, 6)).toBe("Replaced by a newer send");
    expect(acRowDetail(replaced, false).line).toBe(AC_REPLACED_LINE);
    expect(AC_REPLACED_LINE).toMatch(/^Replaced by a newer send/);
    for (const s of [AC_REPLACED_LINE, AC_REPLACED_NOTE, acRowStatusLine(replaced, 6)]) {
      expect(s.toLowerCase()).not.toContain("send again");
    }
  });

  /* It has to say what to DO, and the answer is nothing. "This row is history"
     left the reader to work that out. */
  it("says there is nothing to do rather than leaving it to be inferred", () => {
    expect(AC_REPLACED_LINE).toMatch(/nothing to do/i);
    expect(AC_REPLACED_NOTE).toMatch(/not something to act on/i);
    expect(AC_STATE_PLAIN_MEANING.requeued).toMatch(/nothing to do here/i);
  });

  /* No coding vocabulary, which is the display contract in
     docs/autocount-sync-reasons.md §0 — "requeued", "re-queue" and the marker
     are the server's words and stay there. */
  it("uses none of the machinery's words for it", () => {
    for (const s of [
      AC_STATE_LABEL.requeued, AC_FILTER_STATE_LABEL.requeued, AC_REPLACED_LINE,
      AC_REPLACED_NOTE, AC_REPLACED_GROUP_NOTE, AC_ONLY_REPLACED_LINE,
      AC_STATE_PLAIN_MEANING.requeued, acReplacedHeading(2),
    ]) {
      expect(s).not.toMatch(/re-?queue/i);
      expect(s).not.toMatch(/supersede/i);
      expect(s).not.toMatch(/\brow\b/i);
    }
  });
});

/* ───────────────────────────────────────────────────────────────────────────
   HALF THE LIST WAS HISTORY. Fifteen rows on the live page, SIX of them
   replaced refusals, with two delivery orders appearing twice. A replaced
   document is a record, not a task.
   ─────────────────────────────────────────────────────────────────────────── */
describe("replaced documents are a record, not the list", () => {
  const live = row({ id: "a", doc_no: "HC-DO-2608-001", doc_type: "DO", state: "failed",
    needs_attention: true, created_at: "2026-08-16T05:00:00.000Z" });
  const old1 = row({ id: "b", doc_no: "HC-DO-2608-001", doc_type: "DO", state: "requeued",
    created_at: "2026-08-16T01:00:00.000Z" });
  const old2 = row({ id: "c", doc_no: "HC-DO-2608-002", doc_type: "DO", state: "requeued",
    created_at: "2026-08-16T02:00:00.000Z" });
  const mixed = acGroupByDocument([old1, live, old2]);

  /* GROUPING ALONE FIXES HALF OF THIS. HC-DO-2608-001's refusal and the row it
     was replaced by are ONE document, so the record is folded under the live row
     rather than beside it, and only HC-DO-2608-002 — which has nothing newer —
     is a record in its own right. */
  it("puts a replaced send under its own document rather than beside it", () => {
    expect(mixed).toHaveLength(2);
    const first = mixed[0]!;
    expect(first.docNo).toBe("HC-DO-2608-001");
    expect(first.current.id).toBe("a");
    expect(first.earlier.map((r) => r.id)).toEqual(["b"]);
  });

  it("takes the records out of the list under every filter except their own", () => {
    for (const s of ["all", "attention", "pending", "sent", "failed", "skipped"] as const) {
      const split = acSplitReplaced(mixed, s);
      expect(split.live.map((g) => g.docNo), s).toEqual(["HC-DO-2608-001"]);
      expect(split.replaced.map((g) => g.docNo), s).toEqual(["HC-DO-2608-002"]);
    }
  });

  /* The Replaced chip exists to show exactly these. Folding them there would
     answer the chip with an empty page. */
  it("leaves them as the list when the reader asked for them by name", () => {
    const split = acSplitReplaced(mixed, "requeued");
    expect(split.live).toEqual(mixed);
    expect(split.replaced).toEqual([]);
  });

  it("loses nothing — every document is on exactly one side", () => {
    const split = acSplitReplaced(mixed, "all");
    expect(split.live.length + split.replaced.length).toBe(mixed.length);
  });

  it("counts them in words, both forms written out", () => {
    expect(acReplacedHeading(1)).toBe("1 replaced document, kept as a record");
    expect(acReplacedHeading(6)).toBe("6 replaced documents, kept as a record");
    /* Not `document` + "s" — the same shortcut that produced "GOODS RECEIVEDS". */
    expect(acReplacedHeading(1)).not.toContain("documents");
  });

  it("says why they are kept rather than implying they were missed", () => {
    expect(AC_REPLACED_GROUP_NOTE).toMatch(/nothing here to do/i);
    expect(AC_ONLY_REPLACED_LINE).toMatch(/Nothing live here/i);
  });
});
