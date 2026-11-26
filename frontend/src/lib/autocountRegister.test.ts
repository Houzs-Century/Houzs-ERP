import { describe, expect, it } from "vitest";

import type { AcDocGroup, AcOutboxRow } from "./autocountOutbox";
import { acGroupByDocument } from "./autocountOutbox";
import {
  AC_BOOK_DIFFERENT_FLAG,
  AC_DATE_RANGES,
  AC_DEFAULT_DATE_RANGE,
  AC_DEFAULT_SORT,
  AC_NO_DAY_LABEL,
  AC_NO_VALUE,
  AC_REGISTER_COLUMNS,
  AC_SORTED_BY_LINE,
  acBookDifferentNote,
  acBookNumber,
  acDayKey,
  acDayLabel,
  acGroupsInRange,
  acRegisterItems,
  acSendsMark,
  acShowingLine,
  acSortGroups,
  acWhenIso,
  acWhenText,
} from "./autocountRegister";

const row = (over: Partial<AcOutboxRow> = {}): AcOutboxRow => ({
  id: "ob-1",
  op: "create_so",
  doc_type: "SO",
  doc_no: "HC-SO-2608-001",
  doc_id: null,
  status: "sent",
  state: "sent",
  attempts: 0,
  reason: null,
  reason_kind: null,
  remedy: null,
  needs_attention: false,
  can_requeue: false,
  can_send_now: false,
  ac_doc_no: null,
  archived_at: null,
  created_at: "2026-08-15T00:00:00.000Z",
  updated_at: "2026-08-15T00:00:00.000Z",
  sent_at: null,
  ...over,
});

const groupOf = (...rows: AcOutboxRow[]): AcDocGroup => acGroupByDocument(rows)[0]!;

const NOW = Date.parse("2026-08-21T04:00:00.000Z");

describe("the eight columns", () => {
  it("are the eight the owner approved, in the order he approved them", () => {
    expect(AC_REGISTER_COLUMNS.map((c) => c.key)).toEqual([
      "status", "document", "type", "op", "book", "sends", "when", "action",
    ]);
  });

  it("name themselves in the operator's words, and the action column not at all", () => {
    expect(AC_REGISTER_COLUMNS.map((c) => c.label)).toEqual([
      "Status", "Document", "Type", "What was sent", "In the book as", "Sends", "When", "",
    ]);
  });

  it("carries no column for the try count, the reason, the raw keys or the company", () => {
    const keys = AC_REGISTER_COLUMNS.map((c) => c.key);
    for (const absent of ["attempts", "tries", "reason", "reason_kind", "remedy", "company"]) {
      expect(keys, absent).not.toContain(absent);
    }
  });
});

describe("what the account book answered with", () => {
  it("is LOUD when AutoCount filed the document under a number of its own", () => {
    const v = acBookNumber(row({ doc_no: "HC-PO-2608-001", ac_doc_no: "PO-009968" }));
    expect(v).toEqual({ verdict: "different", number: "PO-009968", flagged: true });
  });

  it("is SILENT when the book used the number on the paperwork", () => {
    const v = acBookNumber(row({ doc_no: "HC-SO-2608-009", ac_doc_no: "HC-SO-2608-009" }));
    expect(v).toEqual({ verdict: "same", number: "HC-SO-2608-009", flagged: false });
  });

  it("does not invent a mismatch out of case or whitespace", () => {
    expect(acBookNumber(row({ doc_no: "HC-SO-2608-009", ac_doc_no: " hc-so-2608-009 " })).flagged)
      .toBe(false);
  });

  it("tells a document not in the book apart from one in it under no recorded number", () => {
    expect(acBookNumber(row({ state: "pending", ac_doc_no: null })).verdict).toBe("not-yet");
    expect(acBookNumber(row({ state: "sent", ac_doc_no: null })).verdict).toBe("not-recorded");
    expect(acBookNumber(row({ state: "sent", ac_doc_no: "   " })).verdict).toBe("not-recorded");
  });

  it("does not cry mismatch when the book number is the ERP number without its company prefix", () => {
    const v = acBookNumber(row({ doc_no: "HC-SO-013361", ac_doc_no: "SO-013361" }));
    expect(v.verdict).toBe("prefixed");
    expect(v.flagged).toBe(false);
    expect(v.number).toBe("SO-013361");
  });

  it("recognises the other company's prefix too, without either being written down", () => {
    expect(acBookNumber(row({ doc_no: "2990-SO-000123", ac_doc_no: "SO-000123" })).flagged)
      .toBe(false);
  });

  it("still shouts about the incident it was built for", () => {
    expect(acBookNumber(row({ doc_no: "HC-PO-2608-001", ac_doc_no: "PO-009968" })).flagged)
      .toBe(true);
  });

  it("does not accept a bare suffix as a prefix match", () => {
    expect(acBookNumber(row({ doc_no: "HC-SO-013361", ac_doc_no: "13361" })).flagged)
      .toBe(true);
  });

  it("never flags a row it has no answer for", () => {
    for (const state of ["pending", "sent", "failed", "skipped", "requeued"]) {
      expect(acBookNumber(row({ state, ac_doc_no: null })).flagged, state).toBe(false);
    }
  });

  it("names both numbers in the sentence beside the flag", () => {
    const note = acBookDifferentNote("HC-PO-2608-001", "PO-009968");
    expect(note).toContain("HC-PO-2608-001");
    expect(note).toContain("PO-009968");
    expect(AC_BOOK_DIFFERENT_FLAG).toBe("Different number");
  });
});

describe("how many times a document was sent", () => {
  it("says nothing at all when it went once", () => {
    expect(acSendsMark(1)).toBeNull();
    expect(acSendsMark(0)).toBeNull();
  });

  it("says how many when it went more than once", () => {
    expect(acSendsMark(4)).toBe("×4");
  });
});

describe("when a document landed", () => {
  it("reads ARRIVED where the book took it, and last tried where it did not", () => {
    expect(acWhenIso(row({ sent_at: "2026-08-16T01:00:00.000Z" })))
      .toBe("2026-08-16T01:00:00.000Z");
    expect(acWhenIso(row({ sent_at: null, created_at: "2026-08-15T00:00:00.000Z" })))
      .toBe("2026-08-15T00:00:00.000Z");
  });

  it("prints the day and the time, without the year", () => {
    expect(acWhenText(row({ sent_at: "2026-08-16T08:31:00.000Z" }))).toBe("08/16 16:31");
  });

  it("says so rather than guessing when there is no timestamp to read", () => {
    expect(acWhenText(row({ sent_at: null, created_at: null }))).toBe(AC_NO_VALUE);
    expect(acDayLabel(acDayKey(row({ sent_at: null, created_at: null })))).toBe(AC_NO_DAY_LABEL);
  });
});

describe("the day a run of rows happened on", () => {
  it("names today and yesterday, and dates everything else", () => {
    expect(acDayLabel("2026/08/21", NOW)).toBe("Today · 2026/08/21");
    expect(acDayLabel("2026/08/20", NOW)).toBe("Yesterday · 2026/08/20");
    expect(acDayLabel("2026/08/19", NOW)).toBe("2026/08/19");
  });

  it("dates a day from another year the same way as any other", () => {
    expect(acDayLabel("2025/08/19", NOW)).toBe("2025/08/19");
  });

  it("files a row under the day its own When cell shows", () => {
    const r = row({ sent_at: "2026-08-20T20:00:00.000Z" });
    expect(acWhenText(r)).toBe("08/21 04:00");
    expect(acDayLabel(acDayKey(r), NOW)).toBe("Today · 2026/08/21");
  });
});

describe("the flat list of separators and documents", () => {
  const at = (id: string, docNo: string, iso: string): AcOutboxRow =>
    row({ id, doc_no: docNo, created_at: iso, sent_at: iso });

  const three = [
    groupOf(at("a", "SO-A", "2026-08-21T02:00:00.000Z")),
    groupOf(at("b", "SO-B", "2026-08-21T01:00:00.000Z")),
    groupOf(at("c", "SO-C", "2026-08-19T01:00:00.000Z")),
  ];

  it("opens a day once, not once per document", () => {
    const items = acRegisterItems(three, NOW);
    expect(items.map((i) => i.kind))
      .toEqual(["day", "document", "document", "day", "document"]);
    expect(items.filter((i) => i.kind === "day").length).toBe(2);
  });

  it("labels the days from the same buckets it split on", () => {
    const days = acRegisterItems(three, NOW).filter((i) => i.kind === "day");
    expect(days.map((d) => (d as { label: string }).label))
      .toEqual(["Today · 2026/08/21", "2026/08/19"]);
  });

  it("gives every item a key of its own", () => {
    const keys = acRegisterItems(three, NOW).map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is empty when there is nothing to introduce", () => {
    expect(acRegisterItems([], NOW)).toEqual([]);
  });
});

describe("the order of the register", () => {
  const at = (id: string, docNo: string, iso: string): AcDocGroup =>
    groupOf(row({ id, doc_no: docNo, created_at: iso, sent_at: iso }));

  const groups = [
    at("b", "SO-B", "2026-08-19T01:00:00.000Z"),
    at("a", "SO-A", "2026-08-21T01:00:00.000Z"),
    at("c", "SO-C", "2026-08-20T01:00:00.000Z"),
  ];

  it("defaults to newest first, which is what the footer says it is doing", () => {
    expect(AC_DEFAULT_SORT).toBe("newest");
    expect(acSortGroups(groups, "newest").map((g) => g.docNo)).toEqual(["SO-A", "SO-C", "SO-B"]);
    expect(AC_SORTED_BY_LINE.newest).toContain("newest first");
  });

  it("turns round", () => {
    expect(acSortGroups(groups, "oldest").map((g) => g.docNo)).toEqual(["SO-B", "SO-C", "SO-A"]);
  });

  it("leaves what it was given alone", () => {
    const before = groups.map((g) => g.docNo);
    acSortGroups(groups, "oldest");
    expect(groups.map((g) => g.docNo)).toEqual(before);
  });

  it("puts a row it cannot date at the old end rather than dropping it", () => {
    const undated = at("z", "SO-Z", "");
    const all = [...groups, undated];
    expect(acSortGroups(all, "newest").map((g) => g.docNo).at(-1)).toBe("SO-Z");
    expect(acSortGroups(all, "oldest").map((g) => g.docNo)[0]).toBe("SO-Z");
  });
});

describe("the date lens", () => {
  const at = (id: string, docNo: string, iso: string): AcDocGroup =>
    groupOf(row({ id, doc_no: docNo, created_at: iso, sent_at: iso }));

  const groups = [
    at("t", "SO-TODAY", "2026-08-21T02:00:00.000Z"),
    at("w", "SO-WEEK", "2026-08-17T02:00:00.000Z"),
    at("m", "SO-MONTH", "2026-08-02T02:00:00.000Z"),
    at("o", "SO-OLD", "2026-07-02T02:00:00.000Z"),
  ];

  const shown = (range: (typeof AC_DATE_RANGES)[number]) =>
    acGroupsInRange(groups, range, NOW).map((g) => g.docNo);

  it("opens on all time and hides nothing", () => {
    expect(AC_DEFAULT_DATE_RANGE).toBe("all");
    expect(shown("all")).toEqual(["SO-TODAY", "SO-WEEK", "SO-MONTH", "SO-OLD"]);
  });

  it("narrows to today, to the last seven days, and to this month", () => {
    expect(shown("today")).toEqual(["SO-TODAY"]);
    expect(shown("week")).toEqual(["SO-TODAY", "SO-WEEK"]);
    expect(shown("month")).toEqual(["SO-TODAY", "SO-WEEK", "SO-MONTH"]);
  });

  it("counts the last seven days inclusive of today", () => {
    const edge = [
      at("in", "SO-IN", "2026-08-15T02:00:00.000Z"),
      at("out", "SO-OUT", "2026-08-14T02:00:00.000Z"),
    ];
    expect(acGroupsInRange(edge, "week", NOW).map((g) => g.docNo)).toEqual(["SO-IN"]);
  });

  it("drops a row it cannot date from every window except all time", () => {
    const undated = [at("z", "SO-Z", "")];
    expect(acGroupsInRange(undated, "all", NOW).length).toBe(1);
    for (const r of ["today", "week", "month"] as const) {
      expect(acGroupsInRange(undated, r, NOW).length, r).toBe(0);
    }
  });
});

describe("the line that closes the register", () => {
  it("says how much of the company is on screen, in documents", () => {
    expect(acShowingLine(14, 3412)).toBe("Showing 1–14 of 3412 documents");
  });

  it("says document, singular, when there is one", () => {
    expect(acShowingLine(1, 1)).toBe("Showing 1–1 of 1 document");
  });

  it("does not count from one when there is nothing to count", () => {
    expect(acShowingLine(0, 3412)).toBe("Showing none of 3412 documents");
  });
});
