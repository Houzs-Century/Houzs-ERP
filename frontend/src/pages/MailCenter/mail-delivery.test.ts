import { describe, expect, it } from "vitest";
import { deliveryLabel, deliveryTone, sentToast } from "./mail-delivery";

describe("mail delivery copy", () => {
  it("labels a queued and a failed send, and nothing before the provider has answered", () => {
    expect(deliveryLabel("queued")).toBe("Queued, retrying");
    expect(deliveryLabel("failed")).toBe("Not delivered");
    expect(deliveryLabel(null)).toBeNull();
    expect(deliveryLabel(undefined)).toBeNull();
  });

  it("says a bounce is bad and a delivery is good", () => {
    expect(deliveryLabel("bounced")).toBe("Bounced: check the address");
    expect(deliveryTone("bounced")).toBe("bad");
    expect(deliveryLabel("delivered")).toBe("Delivered");
    expect(deliveryTone("delivered")).toBe("good");
    expect(deliveryTone("queued")).toBe("waiting");
  });

  it("does not say sent when the server only queued it", () => {
    expect(sentToast(true, "Reply sent.")).toMatch(/^Not sent yet/);
    expect(sentToast(false, "Reply sent.")).toBe("Reply sent.");
    expect(sentToast(undefined, "Email sent.")).toBe("Email sent.");
  });
});
