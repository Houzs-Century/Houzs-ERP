import { describe, expect, it } from "vitest";
import {
  CHAT_FORBIDDEN_SO_COLUMNS,
  CHAT_MESSAGE_STATUS,
  CHAT_WRITABLE_SO_COLUMNS,
  chatRequestFieldChanges,
  chatRequestPatch,
  parseCallbackRefs,
  MAX_CALLBACK_REFS,
} from "./chat-request-patch";

describe("chatRequestPatch — what a WhatsApp tap may write on the SO", () => {
  it("amend: typed DD/MM/YYYY becomes the ISO request date, with reason and status", () => {
    expect(chatRequestPatch("amend", "15/10/2026", "Renovation Delay")).toEqual({
      delivery_message_status: "Pending Reschedule (D)",
      amend_date_from_customer: "2026-10-15",
      amend_reason: "Renovation Delay",
    });
  });

  it("amend: a Flow DatePicker YYYY-MM-DD is accepted as-is", () => {
    expect(chatRequestPatch("amend", "2026-10-20", "Date Unavailable").amend_date_from_customer).toBe("2026-10-20");
  });

  it("amend: an unparseable date is NOT written, the rest still is", () => {
    const p = chatRequestPatch("amend", "next tuesday", "Renovation Delay");
    expect(p.amend_date_from_customer).toBeUndefined();
    expect(p.amend_reason).toBe("Renovation Delay");
    expect(p.delivery_message_status).toBe("Pending Reschedule (D)");
  });

  it("postage events write nothing on the SO — the board has no column for them", () => {
    expect(chatRequestPatch("postage_confirm", null, null)).toEqual({});
    expect(chatRequestPatch("postage_amend", null, null)).toEqual({});
  });

  it("confirm: only the message status moves", () => {
    expect(chatRequestPatch("confirm", null, null)).toEqual({ delivery_message_status: "Done Scheduling" });
  });

  it("never names a schedule or lifecycle column", () => {
    // The board plans trips off customer_delivery_date / amended_delivery_date;
    // a customer tap must not be able to move them. Pin the two lists apart.
    for (const col of CHAT_WRITABLE_SO_COLUMNS) {
      expect(CHAT_FORBIDDEN_SO_COLUMNS as readonly string[]).not.toContain(col);
    }
    const everyPatch = [
      chatRequestPatch("amend", "15/10/2026", "Renovation Delay"),
      chatRequestPatch("confirm", "15/10/2026", "x"),
    ];
    for (const p of everyPatch) {
      for (const key of Object.keys(p)) {
        expect(CHAT_WRITABLE_SO_COLUMNS as readonly string[]).toContain(key);
        expect(CHAT_FORBIDDEN_SO_COLUMNS as readonly string[]).not.toContain(key);
      }
    }
  });

  it("uses the board's own vocabulary for the message status", () => {
    expect(CHAT_MESSAGE_STATUS.confirm).toBe("Done Scheduling");
    expect(CHAT_MESSAGE_STATUS.amend).toBe("Pending Reschedule (D)");
  });
});

describe("chatRequestFieldChanges — the audit trail entry", () => {
  it("records only columns whose value actually changed, under their audit label keys", () => {
    const patch = chatRequestPatch("amend", "15/10/2026", "Renovation Delay");
    const changes = chatRequestFieldChanges(patch, {
      amend_date_from_customer: null,
      amend_reason: "Renovation Delay",
      delivery_message_status: "To Send Delivery Date",
    });
    expect(changes).toEqual([
      { field: "deliveryMessageStatus", from: "To Send Delivery Date", to: "Pending Reschedule (D)" },
      { field: "amendDateFromCustomer", from: null, to: "2026-10-15" },
    ]);
  });
});

describe("parseCallbackRefs — the orders one tap applies to", () => {
  it("primary first, then the bundle, trimmed and de-duplicated", () => {
    expect(parseCallbackRefs("HC-SO-1", "HC-SO-1, HC-SO-2 ,HC-SO-3")).toEqual(["HC-SO-1", "HC-SO-2", "HC-SO-3"]);
    expect(parseCallbackRefs("A", undefined)).toEqual(["A"]);
    expect(parseCallbackRefs("A", ["B", "A"])).toEqual(["A", "B"]);
  });

  it("drops an unresolved Connect placeholder and anything outside the doc-number alphabet", () => {
    // An older ERP send has no refs_all, so Connect interpolates the literal
    // "{refs_all}"; the primary still stands alone.
    expect(parseCallbackRefs("HC-SO-1", "{refs_all}")).toEqual(["HC-SO-1"]);
    expect(parseCallbackRefs("HC-SO-1", "HC-SO-2,x) or (1=1")).toEqual(["HC-SO-1", "HC-SO-2"]);
  });

  it("caps the bundle", () => {
    const many = Array.from({ length: 40 }, (_, i) => `R${i}`).join(",");
    expect(parseCallbackRefs("R0", many)).toHaveLength(MAX_CALLBACK_REFS);
  });
});
