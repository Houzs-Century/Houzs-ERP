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

// watchPosition stub: call the success handler once with a fixed coordinate, or
// the error handler when `fail` is set.
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
    geoCoord = { lat: 3.05, lng: 101.75 }; // ~3 km away
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
