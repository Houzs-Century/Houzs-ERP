import { describe, it, expect } from "vitest";
import {
  buildChangeLogQs,
  clActionLabel,
  clFieldLabel,
  clWhen,
  clTruncationNote,
  clValueLabel,
  clVerdict,
  clWhoLabel,
  CL_DEFAULT_FILTERS,
  type ChangeLogChange,
  type ChangeLogResponse,
} from "./changeLog";

function response(over: Partial<ChangeLogResponse["totals"]> = {}, hours = 168): ChangeLogResponse {
  return {
    window: { since: "2026-09-01T00:00:00.000Z", until: "2026-09-08T00:00:00.000Z", hours },
    filters: { author: "person", docTypes: ["SO", "PO", "DO", "GRN"] },
    totals: {
      changesByPerson: 4,
      changesBySystem: 550,
      documents: 3,
      documentsShown: 3,
      people: 2,
      truncated: false,
      ...over,
    },
    documents: [],
  };
}

describe("the verdict line", () => {
  /* THE SENTENCE THAT MATTERS. A check written before this one reported "50
     staff actions on migrated orders" and all fifty were the allocation cron.
     The owner must never read a system count as a staff count, so the two
     numbers are always both on screen and the system half is always named. */
  it("says nobody changed anything, and still reports the system's own count", () => {
    const s = clVerdict(response({ changesByPerson: 0, changesBySystem: 550, documents: 0, people: 0 }));
    expect(s).toContain("Nobody changed anything");
    expect(s).toContain("550");
    expect(s).toContain("not staff edits");
  });

  it("carries every number with its denominator when people HAVE changed things", () => {
    const s = clVerdict(response());
    expect(s).toContain("4 change(s)");
    expect(s).toContain("2 person/people");
    expect(s).toContain("3 document(s)");
    expect(s).toContain("another 550");
  });

  it("says the window in days", () => {
    expect(clVerdict(response({}, 24))).toContain("last 1 day");
    expect(clVerdict(response({}, 72))).toContain("last 3 days");
  });

  it("is empty rather than fabricated when there is no response yet", () => {
    expect(clVerdict(null)).toBe("");
  });
});

describe("truncation is never silent", () => {
  it("says nothing when the read covered the window", () => {
    expect(clTruncationNote(response())).toBeNull();
    expect(clTruncationNote(null)).toBeNull();
  });

  it("says the counts are floors when the read hit its ceiling", () => {
    const note = clTruncationNote(response({ truncated: true }));
    expect(note).toContain("floor, not a total");
  });
});

describe("labels", () => {
  it("puts the audit vocabulary into words", () => {
    expect(clActionLabel("UPDATE_LINE")).toBe("Changed a line");
    expect(clActionLabel("ADD_PAYMENT")).toBe("Added a payment");
    expect(clFieldLabel("delivery_address")).toBe("Delivery address");
  });

  /* A verb or a field this page has never met renders as ITSELF. Swallowing it
     would make a new kind of change invisible on the one page that exists to
     show changes. */
  it("renders an unknown verb and an unknown field as themselves, never blank", () => {
    expect(clActionLabel("SOME_NEW_VERB")).toBe("SOME_NEW_VERB");
    expect(clFieldLabel("brand_new_column")).toBe("brand_new_column");
  });

  it("names the machine and does not invent a person", () => {
    const machine: ChangeLogChange = {
      id: "1", at: "2026-09-08T06:00:00Z", author: "machine",
      who: "system (auto-allocate)", action: "UPDATE_LINE", source: "auto-allocation",
      status: null, fields: [],
    };
    expect(clWhoLabel(machine)).toBe("system (auto-allocate)");
    expect(clWhoLabel({ ...machine, who: null })).toBe("System");
  });

  it("shows an unattributed PERSON row as unknown rather than hiding it", () => {
    const person: ChangeLogChange = {
      id: "2", at: "2026-09-08T06:00:00Z", author: "person",
      who: null, action: "UPDATE_DETAILS", source: "web", status: null, fields: [],
    };
    expect(clWhoLabel(person)).toBe("Unknown user");
  });

  it("renders an empty value as a word, not as a blank that reads like a bug", () => {
    expect(clValueLabel(null)).toBe("(empty)");
    expect(clValueLabel("")).toBe("(empty)");
    expect(clValueLabel("   ")).toBe("(empty)");
    expect(clValueLabel(0)).toBe("0");
    expect(clValueLabel(false)).toBe("false");
    expect(clValueLabel({ a: 1 })).toBe('{"a":1}');
  });
});

describe("times are Malaysia local, in the repo's ONE date format", () => {
  /* The page must never make the owner do timezone arithmetic, and it must
     never introduce a second date format to avoid it — fmtDateTime already
     converts to MYT (vendor/shared/format.ts, mytParts). */
  it("renders 06:00 UTC as 14:00 on the same day, dd/mm/yyyy", () => {
    expect(clWhen("2026-09-08T06:00:00.000Z")).toBe("08/09/2026 14:00");
  });

  it("crosses the day boundary the way MYT does, not the way UTC does", () => {
    expect(clWhen("2026-09-07T17:00:00.000Z")).toBe("08/09/2026 01:00");
  });

  it("does not print Invalid Date for an unparseable stamp", () => {
    expect(clWhen("not-a-date")).not.toContain("Invalid");
  });
});

describe("the query string", () => {
  it("always carries the two parameters that decide the answer", () => {
    expect(buildChangeLogQs(CL_DEFAULT_FILTERS)).toBe("?hours=168&author=person");
  });

  it("adds the document type only when one is chosen", () => {
    expect(buildChangeLogQs({ hours: 24, author: "all", docType: "DO" }))
      .toBe("?hours=24&author=all&docType=DO");
  });
});
