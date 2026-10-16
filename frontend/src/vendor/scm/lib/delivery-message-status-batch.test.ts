// POST /delivery-messages/statuses refuses more than 1000 doc numbers (zod .max(1000)).
// Prod board had 2097 rows on 2026-10-15 (HC-0031): one POST got 400 and the Message
// column was blank for every row. The hook now splits the list.
import { describe, it, expect } from "vitest";
import { batchDocNos, STATUS_BATCH } from "./delivery-planning-queries";

describe("batchDocNos", () => {
  it("keeps every batch within the server cap and loses no doc", () => {
    const docs = Array.from({ length: 2097 }, (_, i) => `SO-${i}`);
    const batches = batchDocNos(docs);
    expect(STATUS_BATCH).toBeLessThanOrEqual(1000);
    expect(batches.every((b) => b.length > 0 && b.length <= STATUS_BATCH)).toBe(true);
    expect(batches.flat()).toEqual(docs);
  });

  it("returns no batch for an empty list", () => {
    expect(batchDocNos([])).toEqual([]);
  });
});
