// A delivery return status move that lost a race answers 409 `status_changed`
// (backend delivery-returns.ts patchDeliveryReturnStatusHandler). Both callers
// — the desktop useUpdateDeliveryReturnStatus toast and the mobile action
// line — show `err.message`, which authedFetch builds with humanApiError. The
// code is not in the curated map, so the server's own sentence must win over
// the generic "That clashes with something already in the system".
import { describe, expect, test } from "vitest";
import { humanApiError } from "./authed-fetch";

describe("delivery return status_changed 409 reaches the operator", () => {
  test("the server's sentence is shown, naming what the return is now", () => {
    const message =
      "This return was changed by someone else just now (it is now CANCELLED, it was INSPECTED when you started). Nothing was saved. Refresh and check before trying again.";
    const msg = humanApiError(
      409,
      JSON.stringify({ error: "status_changed", message, reason: message, currentStatus: "CANCELLED" }),
    );
    expect(msg).toBe(message);
  });
});
