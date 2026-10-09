import { describe, expect, it } from "vitest";
import { deliveryLabel, sentToast } from "./mail-delivery";

describe("mail delivery copy", () => {
  it("labels a queued and a failed send, and nothing for a delivered one", () => {
    expect(deliveryLabel("queued")).toBe("Queued, retrying");
    expect(deliveryLabel("failed")).toBe("Not delivered");
    expect(deliveryLabel(null)).toBeNull();
    expect(deliveryLabel(undefined)).toBeNull();
  });

  it("does not say sent when the server only queued it", () => {
    expect(sentToast(true, "Reply sent.")).toMatch(/^Not sent yet/);
    expect(sentToast(false, "Reply sent.")).toBe("Reply sent.");
    expect(sentToast(undefined, "Email sent.")).toBe("Email sent.");
  });
});
