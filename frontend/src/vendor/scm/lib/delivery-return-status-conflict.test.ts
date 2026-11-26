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
