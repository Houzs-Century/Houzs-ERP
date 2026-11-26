// The punch screen's live distance-to-site line (HC-0125): it tells a worker
// whether they are inside a punch site's radius before they tap, now that an
// off-site punch is refused. Distance itself is checkPunchLocation (tested in
// shared); here we prove the screen shows the right line for in / out / no-GPS.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), postForm: vi.fn(), fetchBlobUrl: vi.fn() },
}));
vi.mock("../api/client", () => ({ api }));

import { MobilePunch } from "./MobilePunch";

const SITE = { id: 1, name: "KL WAREHOUSE", lat: 3.026318, lng: 101.733977, radiusM: 100 };
const ME = {
  linked: true,
  employee: { empNo: "HCFW0001", name: "Sagor" },
  today: "2026-11-23",
  shift: { startMin: 540, endMin: 1140 },
  open: null,
  todayDay: null,
  recent: [],
  sitesConfigured: 1,
  sites: [SITE],
};

let geoCoord: { lat: number; lng: number } | null = { lat: SITE.lat, lng: SITE.lng };
let geoFail = false;
beforeEach(() => {
  api.get.mockReset().mockResolvedValue(ME);
  geoCoord = { lat: SITE.lat, lng: SITE.lng };
  geoFail = false;
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      watchPosition: (ok: PositionCallback, err: PositionErrorCallback) => {
        if (geoFail) err({ code: 1, message: "denied" } as GeolocationPositionError);
        else if (geoCoord) ok({ coords: { latitude: geoCoord.lat, longitude: geoCoord.lng, accuracy: 5 } } as GeolocationPosition);
        return 7;
      },
      clearWatch: vi.fn(),
    },
  });
});
afterEach(() => cleanup());

const show = () => render(<QueryClientProvider client={new QueryClient()}><MobilePunch onBack={() => {}} /></QueryClientProvider>);

describe("punch screen — live distance to the site", () => {
  it("inside the radius: shows the site and 'in range'", async () => {
    show();
    await waitFor(() => expect(screen.getByText(/from KL WAREHOUSE/)).toBeTruthy());
    expect(screen.getByText(/in range/)).toBeTruthy();
  });

  it("outside the radius: shows the distance and 'too far'", async () => {
    geoCoord = { lat: 3.05, lng: 101.75 };
    show();
    await waitFor(() => expect(screen.getByText(/too far to clock in/)).toBeTruthy());
    expect(screen.getByText(/from KL WAREHOUSE/)).toBeTruthy();
  });

  it("location off: asks the worker to turn it on", async () => {
    geoFail = true;
    show();
    await waitFor(() => expect(screen.getByText(/Turn on location/)).toBeTruthy());
  });
});

describe("punch screen — multi-punch", () => {
  const side = (clock: string) => ({ clock, geo: "IN" as const, siteName: "KL WAREHOUSE", distanceM: 40, source: "PHONE" });
  const doneDay = { id: 1, workDate: ME.today, status: "PRESENT", in: side("08:00"), out: side("18:00"), open: false, lateMin: 0, otMin: 0, spanMin: 600, notes: null };

  it("done for today: offers a re-clock-in, not a dead 'Done' button", async () => {
    api.get.mockResolvedValue({ ...ME, todayDay: doneDay, recent: [doneDay] });
    show();
    await waitFor(() => expect(screen.getByText(/Clock in again/)).toBeTruthy());
    const btn = screen.getByText(/Clock in again/).closest("button") as HTMLButtonElement | null;
    expect(btn?.disabled).toBe(false);
    expect(screen.queryByText(/Done for today:/)).toBeTruthy();
  });
});
