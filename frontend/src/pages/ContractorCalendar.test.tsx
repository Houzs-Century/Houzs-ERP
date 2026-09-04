/* THE NO-LOGIN CONTRACTOR CALENDAR, MOUNTED.
 *
 * A booth contractor opens /c/<token> with no Houzs account and sees only their
 * confirmed events + booth numbers. The token in the URL is the only credential;
 * a killed or unknown link gets the same "not valid" screen. These mount the
 * REAL page and assert what the contractor SEES — and that an invalid link says
 * so rather than leaking that it once worked.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContractorCalendar } from "./ContractorCalendar";

const TOKEN = "abcdefghijklmnopqrstuvwx012345_-"; // 32 chars, matches the token shape

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  window.history.pushState({}, "", `/c/${TOKEN}`);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

describe("ContractorCalendar (public, no-login)", () => {
  it("shows the contractor's confirmed events with booth numbers", async () => {
    fetchMock.mockImplementation(() =>
      json({
        contractor: "DREAM ART (M) SDN BHD",
        events: [
          {
            brand: "AKEMI",
            organizer: "HOMELOVE",
            state: "Kuala Lumpur",
            venue: "MID VALLEY",
            boothNo: "3053-3055",
            startDate: todayIso(),
            endDate: todayIso(),
            name: "KL [AKEMI] HOMELOVE @ MID VALLEY",
          },
        ],
      }),
    );
    render(<ContractorCalendar />);
    expect(await screen.findByText("DREAM ART (M) SDN BHD")).toBeTruthy();
    expect(await screen.findByText(/Booth 3053-3055/)).toBeTruthy();
  });

  it("shows a friendly message for an invalid or revoked link", async () => {
    fetchMock.mockImplementation(() => json({ error: "unknown_link" }, 404));
    render(<ContractorCalendar />);
    expect(await screen.findByText(/not valid/i)).toBeTruthy();
  });
});
