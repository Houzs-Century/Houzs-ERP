// The AutoCount Sync register's shared logic — the part both surfaces read.
//
// Everything here is PURE, and that is why it is worth its own file: the column
// set, the account book's verdict on a document number, the day a row belongs
// to, the two lenses and the footer sentence are all decisions the desktop
// register and the phone cards have to make IDENTICALLY. A defect in any of
// them shows up as the two surfaces disagreeing about one row, which is the
// recurring bug class CLAUDE.md names, and it is far cheaper to catch here than
// in two rendering tests that both pass.
//
// TIMEZONE. Every date below goes through `fmtDate`, which renders a zoned
// instant in MYT (UTC+8). `2026-08-20T20:00:00Z` is therefore 21/08 in this
// app's own words, and the fixtures are written to say so out loud rather than
// to look tidy in UTC.
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
  created_at: "2026-08-15T00:00:00.000Z",
  updated_at: "2026-08-15T00:00:00.000Z",
  sent_at: null,
  ...over,
});

const groupOf = (...rows: AcOutboxRow[]): AcDocGroup => acGroupByDocument(rows)[0]!;

/** MYT noon on 21 August 2026 — so "today" is unambiguously 21/08/2026. */
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

  /* THE FOUR THAT ARE DELIBERATELY NOT COLUMNS. Named here so a later tidy-up
     that "restores" one has to delete an assertion and read why. */
  it("carries no column for the try count, the reason, the raw keys or the company", () => {
    const keys = AC_REGISTER_COLUMNS.map((c) => c.key);
    for (const absent of ["attempts", "tries", "reason", "reason_kind", "remedy", "company"]) {
      expect(keys, absent).not.toContain(absent);
    }
  });
});

describe("what the account book answered with", () => {
  /* THE INCIDENT THIS COLUMN EXISTS FOR. HC-PO-2608-001 is in AED_HOUZS as
     PO-009968 and nobody saw it for three days. */
  it("is LOUD when AutoCount filed the document under a number of its own", () => {
    const v = acBookNumber(row({ doc_no: "HC-PO-2608-001", ac_doc_no: "PO-009968" }));
    expect(v).toEqual({ verdict: "different", number: "PO-009968", flagged: true });
  });

  it("is SILENT when the book used the number on the paperwork", () => {
    const v = acBookNumber(row({ doc_no: "HC-SO-2608-009", ac_doc_no: "HC-SO-2608-009" }));
    expect(v).toEqual({ verdict: "same", number: "HC-SO-2608-009", flagged: false });
  });

  /* A FLAG THAT CRIES WOLF IS A FLAG NOBODY READS. Case and surrounding space
     are not a different document, and treating them as one would light up
     every row in the register. */
  it("does not invent a mismatch out of case or whitespace", () => {
    expect(acBookNumber(row({ doc_no: "HC-SO-2608-009", ac_doc_no: " hc-so-2608-009 " })).flagged)
      .toBe(false);
  });

  it("tells a document not in the book apart from one in it under no recorded number", () => {
    expect(acBookNumber(row({ state: "pending", ac_doc_no: null })).verdict).toBe("not-yet");
    expect(acBookNumber(row({ state: "sent", ac_doc_no: null })).verdict).toBe("not-recorded");
    expect(acBookNumber(row({ state: "sent", ac_doc_no: "   " })).verdict).toBe("not-recorded");
  });

  it("never flags a row it has no answer for", () => {
    for (const state of ["pending", "sent", "failed", "skipped", "requeued"]) {
      expect(acBookNumber(row({ state, ac_doc_no: null })).flagged, state).toBe(false);
    }
  });

  /* The sentence has to name BOTH numbers: one to look up, one that will not be
     found. Half of it is not an answer. */
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

  /* The day separator above the row carries the year, so the cell does not. */
  it("prints the day and the time, without the year", () => {
    expect(acWhenText(row({ sent_at: "2026-08-16T08:31:00.000Z" }))).toBe("16/08 16:31");
  });

  it("says so rather than guessing when there is no timestamp to read", () => {
    expect(acWhenText(row({ sent_at: null, created_at: null }))).toBe(AC_NO_VALUE);
    expect(acDayLabel(acDayKey(row({ sent_at: null, created_at: null })))).toBe(AC_NO_DAY_LABEL);
  });
});

describe("the day a run of rows happened on", () => {
  it("names today and yesterday, and dates everything else", () => {
    expect(acDayLabel("21/08/2026", NOW)).toBe("Today · 21 Aug");
    expect(acDayLabel("20/08/2026", NOW)).toBe("Yesterday · 20 Aug");
    expect(acDayLabel("19/08/2026", NOW)).toBe("19 Aug");
  });

  /* A year that is not this one is worth four more characters — a register goes
     back as far as the queue does, and the queue is append-only. */
  it("carries the year when the day is not in this one", () => {
    expect(acDayLabel("19/08/2025", NOW)).toBe("19 Aug 2025");
  });

  /* THE SEPARATOR AND THE CELL ARE ONE RULE. Both come off `fmtDate`, so a row
     can never be filed under a day the cell beside it does not print. */
  it("files a row under the day its own When cell shows", () => {
    const r = row({ sent_at: "2026-08-20T20:00:00.000Z" });
    expect(acWhenText(r)).toBe("21/08 04:00");
    expect(acDayLabel(acDayKey(r), NOW)).toBe("Today · 21 Aug");
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
      .toEqual(["Today · 21 Aug", "19 Aug"]);
  });

  /* A separator sharing a key with a document unmounts one of them, and a
     windowed list is exactly where that would be invisible. */
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

  /* The caller renders the array it was handed; mutating the input would sort
     the loaded page underneath whatever else is reading it. */
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

  /* ALL TIME IS THE DEFAULT ON PURPOSE. A register that opened on This month
     would hide a document stuck since July from the one screen whose job is
     finding it. */
  it("opens on all time and hides nothing", () => {
    expect(AC_DEFAULT_DATE_RANGE).toBe("all");
    expect(shown("all")).toEqual(["SO-TODAY", "SO-WEEK", "SO-MONTH", "SO-OLD"]);
  });

  it("narrows to today, to the last seven days, and to this month", () => {
    expect(shown("today")).toEqual(["SO-TODAY"]);
    expect(shown("week")).toEqual(["SO-TODAY", "SO-WEEK"]);
    expect(shown("month")).toEqual(["SO-TODAY", "SO-WEEK", "SO-MONTH"]);
  });

  /* The seventh day back is IN the window and the eighth is not — an off-by-one
     here silently drops a day's documents and nothing else would say so. */
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

  /* Never "Showing 1–0". An empty register is a sentence, not arithmetic. */
  it("does not count from one when there is nothing to count", () => {
    expect(acShowingLine(0, 3412)).toBe("Showing none of 3412 documents");
  });
});
