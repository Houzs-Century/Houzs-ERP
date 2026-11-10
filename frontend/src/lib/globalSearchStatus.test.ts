import { describe, expect, test } from "vitest";
import { loadSearchStatusVocabulary, searchHitStatus, type SearchHit } from "./globalSearch";

const hit = (type: SearchHit["type"], status: string | null): SearchHit => ({ type, id: "1", title: "X", status, link: "/x" });

describe("searchHitStatus", () => {
  test("before the vocabulary loads, no pill — never a raw stored value", () => {
    expect(searchHitStatus(hit("payment_voucher", "POSTED"), null)).toBeNull();
  });

  test("a mapped document says its list's own word; the rest are humanised; no status, no pill", async () => {
    const v = await loadSearchStatusVocabulary();
    expect(searchHitStatus(hit("payment_voucher", "POSTED"), v)?.label).toBe("Approved");
    expect(searchHitStatus(hit("grn", "POSTED"), v)?.label).toBe("Submitted");
    expect(searchHitStatus(hit("credit_note", "POSTED"), v)?.label).toBe("Posted");
    expect(searchHitStatus(hit("customer", "INACTIVE"), v)?.label).toBe("Inactive");
    expect(searchHitStatus(hit("supplier", null), v)).toBeNull();
  });
});
