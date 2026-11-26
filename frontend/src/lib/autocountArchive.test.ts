import { describe, expect, it } from "vitest";
import {
  AC_ARCHIVED_TAB_NOTE,
  acDocCanArchive,
  acListTotal,
  acDocCanRestore,
  acShelfDone,
  acShelfFailedNote,
  acShelfNote,
  type AcArchiveResult,
} from "./autocountArchive";
import { acGroupByDocument, type AcOutboxResponse, type AcOutboxRow } from "./autocountOutbox";
import { acShowingLine } from "./autocountRegister";

const row = (over: Partial<AcOutboxRow> = {}): AcOutboxRow => ({
  id: "ob-1",
  op: "edit",
  doc_type: "SO",
  doc_no: "HC-SO-013393",
  doc_id: null,
  status: "sent",
  state: "sent",
  attempts: 1,
  reason: null,
  reason_kind: null,
  remedy: null,
  needs_attention: false,
  can_requeue: false,
  can_send_now: false,
  ac_doc_no: null,
  archived_at: null,
  created_at: "2026-08-31T05:53:19.949Z",
  updated_at: "2026-08-31T05:53:19.949Z",
  sent_at: "2026-08-31T05:55:08.683Z",
  ...over,
});

const groupOf = (rows: AcOutboxRow[]) => {
  const g = acGroupByDocument(rows).at(0);
  if (!g) throw new Error("no group");
  return g;
};

describe("whether the page offers Clear", () => {
  it("offers it on a document whose every send arrived", () => {
    expect(acDocCanArchive(groupOf([row({ id: "a" }), row({ id: "b" })]))).toBe(true);
  });

  it("offers it on a document whose refusals were replaced by a later send", () => {
    const g = groupOf([
      row({ id: "a", created_at: "2026-09-04T06:51:29.479Z" }),
      row({ id: "b", status: "failed", state: "requeued", needs_attention: false, reason: "[re-queued …] Gave up after 6 attempts." }),
    ]);
    expect(acDocCanArchive(g)).toBe(true);
  });

  it("does not offer it when an older send is still an open refusal", () => {
    const g = groupOf([
      row({ id: "new", created_at: "2026-09-05T00:00:00.000Z" }),
      row({ id: "old", status: "skipped", state: "skipped", needs_attention: true, created_at: "2026-09-01T00:00:00.000Z" }),
    ]);
    expect(g.current.id).toBe("new");
    expect(acDocCanArchive(g)).toBe(false);
  });

  it("does not offer it while a send is still on its way", () => {
    expect(acDocCanArchive(groupOf([row({ status: "pending", state: "pending" })]))).toBe(false);
  });

  it("does not offer it twice — a cleared document offers Put back instead", () => {
    const g = groupOf([row({ archived_at: "2026-09-08T02:00:00.000Z" })]);
    expect(acDocCanArchive(g)).toBe(false);
    expect(acDocCanRestore(g)).toBe(true);
  });

  it("a live document offers no Put back", () => {
    expect(acDocCanRestore(groupOf([row()]))).toBe(false);
  });
});

describe("what the row says afterwards", () => {
  const result = (over: Partial<AcArchiveResult> = {}): AcArchiveResult => ({
    archived: true, code: "ok", message: "Cleared from the list.", rows: 3, blocked: 0, ...over,
  });

  it("reads a clear and a put-back as the same kind of success", () => {
    expect(acShelfDone(result())).toBe(true);
    expect(acShelfDone(result({ archived: undefined, restored: true }))).toBe(true);
    expect(acShelfDone(result({ archived: false }))).toBe(false);
  });

  it("renders the server's own words on a refusal, and does not shout", () => {
    const n = acShelfNote(result({
      archived: false,
      code: "needs-attention",
      message: "This document is in the ERP and not in the account book, so it still needs somebody.",
      rows: 0,
      blocked: 1,
    }));
    expect(n.text).toContain("still needs somebody");
    expect(n.tone).toBe("wait");
    expect(n.clearsReason).toBe(false);
  });

  it("marks a success good, still without touching the reason", () => {
    const n = acShelfNote(result());
    expect(n.tone).toBe("good");
    expect(n.clearsReason).toBe(false);
  });

  it("keeps a thrown call apart from a refusal", () => {
    const n = acShelfFailedNote("Nothing was cleared — the request never got through.", new Error("HTTP 500 /api/scm/…"));
    expect(n.tone).toBe("bad");
    expect(n.text).toContain("never got through");
    expect(n.quote).toContain("HTTP 500");
  });
});

describe("the Cleared tab explains itself", () => {
  it("says nothing was deleted, and that it can be undone", () => {
    expect(AC_ARCHIVED_TAB_NOTE).toContain("nothing here was deleted");
    expect(AC_ARCHIVED_TAB_NOTE).toContain("Put back");
  });
});

describe("the denominator both count lines divide by", () => {
  const resp = (total: number, archived: number): AcOutboxResponse =>
    ({ counts: { pending: 0, sent: 0, failed: 0, skipped: 0, requeued: 0,
                 attention: 0, archived, total } }) as AcOutboxResponse;

  it("counts the Cleared tab against the cleared shelf", () => {
    expect(acListTotal(resp(1, 3), "archived")).toBe(3);
  });

  it("counts every other tab against the live total", () => {
    for (const s of ["all", "pending", "attention", "sent"] as const) {
      expect(acListTotal(resp(1, 3), s), s).toBe(1);
    }
  });

  it("no longer closes the register with three of one", () => {
    expect(acShowingLine(3, acListTotal(resp(1, 3), "archived"))).toBe(
      "Showing 1–3 of 3 documents",
    );
  });

  it("says none of zero on a Cleared tab nobody has used", () => {
    expect(acShowingLine(0, acListTotal(resp(9, 0), "archived"))).toBe(
      "Showing none of 0 documents",
    );
  });
});
