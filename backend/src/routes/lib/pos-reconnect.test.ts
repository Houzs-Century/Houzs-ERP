import { describe, expect, test } from "vitest";
import { reconnectPhase } from "./pos-reconnect";

const now = Date.parse("2026-11-12T03:00:00.000Z");

describe("reconnectPhase", () => {
  test("no request, or one older than a day, is none", () => {
    expect(reconnectPhase({ reconnect_requested_at: null, reconnect_approved_at: null }, now)).toBe("none");
    expect(reconnectPhase({ reconnect_requested_at: "2026-11-11 02:59:00+00", reconnect_approved_at: null }, now)).toBe("none");
  });
  test("a fresh request waits, in the Postgres spelling as well as ISO", () => {
    expect(reconnectPhase({ reconnect_requested_at: "2026-11-12 02:50:00.123+00", reconnect_approved_at: null }, now)).toBe("waiting");
    expect(reconnectPhase({ reconnect_requested_at: "2026-11-12T02:50:00.123Z", reconnect_approved_at: null }, now)).toBe("waiting");
  });
  test("an approval counts only for the request it answered", () => {
    expect(reconnectPhase({ reconnect_requested_at: "2026-11-12 02:50:00+00", reconnect_approved_at: "2026-11-12 02:55:00+00" }, now)).toBe("approved");
    /* approved yesterday, asked again today: the old approval does not carry over */
    expect(reconnectPhase({ reconnect_requested_at: "2026-11-12 02:50:00+00", reconnect_approved_at: "2026-11-11 09:00:00+00" }, now)).toBe("waiting");
  });
  test("an approval nobody claimed for a day lapses with its request", () => {
    expect(reconnectPhase({ reconnect_requested_at: "2026-11-10 02:50:00+00", reconnect_approved_at: "2026-11-10 02:55:00+00" }, now)).toBe("none");
  });
});
