// WHICH DOCUMENTS the amendment requeue must NOT queue again.
//
// The defect pinned here (2026-09-14): the requeue counted an edit row as
// carrying an amendment only when it was created strictly AFTER the approval.
// But the approve routes run enqueueEdit inside the same transaction that
// stamps the approval, and scm.autocount_outbox.created_at is DEFAULT now() —
// the TRANSACTION START — while approved_at / so_approved_at is a JS timestamp
// taken later in that transaction. So the edit an approval queued for itself is
// always a few seconds OLDER than the approval, and the requeue planned a
// second edit for every document approved after the #3833 fix (probe run
// 34826419283: HC-SO-012714, HC-PO-2609-068 and 12 more, window_edit=1 each,
// listed as "would queue" by the full plan).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { coveringEdit, SAME_TRANSACTION_WINDOW_MS, keylessAddedLineIds } from "../scripts/lib/amendment-requeue-coverage.mjs";

const at = (s) => new Date(s);
const target = (over = {}) => ({
  docType: "SO", docNo: "HC-SO-012714", docId: null, lastApprovedAt: at("2026-09-14T08:49:12.400Z"), ...over,
});
const edit = (over = {}) => ({
  doc_type: "SO", doc_no: "HC-SO-012714", doc_id: null, op: "edit", status: "pending",
  created_at: at("2026-09-14T08:49:09.100Z"), ...over,
});

describe("coveringEdit", () => {
  it("counts the edit the approval queued in its own transaction (created_at = transaction start, BEFORE approved_at)", () => {
    expect(coveringEdit(target(), [edit()])).not.toBeNull();
  });

  it("counts it for a PO addressed by id as well as by number", () => {
    const t = target({ docType: "PO", docNo: "HC-PO-2609-068", docId: "po-uuid" });
    expect(coveringEdit(t, [edit({ doc_type: "PO", doc_no: "HC-PO-2609-068", doc_id: "po-uuid" })])).not.toBeNull();
    expect(coveringEdit(t, [edit({ doc_type: "PO", doc_no: null, doc_id: "po-uuid" })])).not.toBeNull();
  });

  it("counts a pending or sent edit created after the approval", () => {
    expect(coveringEdit(target(), [edit({ created_at: at("2026-09-14T09:30:00Z"), status: "sent" })])).not.toBeNull();
  });

  it("does NOT count a failed or skipped edit, however recent", () => {
    expect(coveringEdit(target(), [edit({ status: "skipped" }), edit({ status: "failed", created_at: at("2026-09-14T09:30:00Z") })])).toBeNull();
  });

  it("does NOT count an edit from before the approval transaction could have started", () => {
    const old = new Date(target().lastApprovedAt.getTime() - SAME_TRANSACTION_WINDOW_MS - 1000);
    expect(coveringEdit(target(), [edit({ created_at: old })])).toBeNull();
  });

  it("does NOT count another document's edit, or a create", () => {
    expect(coveringEdit(target(), [edit({ doc_no: "HC-SO-012713" }), edit({ op: "create_so" })])).toBeNull();
  });
});

describe("the requeue script decides coverage through this module", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../scripts/requeue-amendment-ac-edits.mjs"), "utf8");
  it("imports coveringEdit and no longer filters on created_at > last_approved_at in SQL", () => {
    expect(src).toMatch(/import \{[^}]*coveringEdit[^}]*\} from "\.\/lib\/amendment-requeue-coverage\.mjs"/);
    expect(src).not.toMatch(/o\.created_at > d\.last_approved_at/);
  });
  it("declares amendment-added keyless lines new through keylessAddedLineIds -> newLineIds", () => {
    expect(src).toMatch(/import \{[^}]*keylessAddedLineIds[^}]*\} from "\.\/lib\/amendment-requeue-coverage\.mjs"/);
    expect(src).toMatch(/newLineIds/);
  });
});

describe("keylessAddedLineIds", () => {
  const line = (id, code) => ({ id, item_code: code });
  it("returns only keyless lines whose code an ADD amendment introduced (docs/bugs/0942 case)", () => {
    // HC-SO-012757: lines 1-5 keyed (excluded by the caller's query), line 6 keyless.
    const keyless = [line("row-6", "TRANSPORTATION CHARGES")];
    expect(keylessAddedLineIds(keyless, ["TRANSPORTATION CHARGES"])).toEqual(["row-6"]);
  });
  it("never declares a keyless line new when no ADD amendment names its code (a backfill gap)", () => {
    const keyless = [line("row-x", "AK-NOBILITY MATT (K)")];
    expect(keylessAddedLineIds(keyless, ["TRANSPORTATION CHARGES"])).toEqual([]);
    expect(keylessAddedLineIds(keyless, [])).toEqual([]);
  });
  it("trims and ignores blank codes on both sides", () => {
    const keyless = [line("a", " DISPOSE "), line("b", null)];
    expect(keylessAddedLineIds(keyless, [" DISPOSE ", null, ""])).toEqual(["a"]);
  });
});
