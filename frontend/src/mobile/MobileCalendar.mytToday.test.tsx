/* The phone Projects calendar opens on the MALAYSIAN month and badges the
   Malaysian today. At 01:30 on 1 Dec (Malaysia), on a phone whose clock zone
   is UTC, it opened November with the 30th badged. Run with TZ=UTC. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("../api/client", () => ({
  api: {
    get: async (path: string) => {
      h.paths.push(path);
      return { projects: [], tasks: [] };
    },
  },
}));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ pageAccess: () => "full" }) }));
vi.mock("../hooks/useBranding", () => ({ useBranding: () => ({ companyCode: "HOUZS", companyName: "Houzs Century" }) }));

import { MobileCalendar } from "./MobileCalendar";

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MobileCalendar />
    </QueryClientProvider>,
  );

beforeEach(() => {
  h.paths.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-30T17:30:00Z")); // 01:30 on 1 Dec in Malaysia
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("phone Projects calendar judges today by the Malaysian day", () => {
  it("opens on December and fetches December", async () => {
    mount();
    expect(screen.getByText("December 2026")).toBeTruthy();
    await waitFor(() => expect(h.paths).toContain("/api/projects/calendar/events?from=2026-12-01&to=2026-12-31"));
  });

  it("badges the 1st as today", async () => {
    const { container } = mount();
    await waitFor(() => expect(container.querySelector(".cal-today-badge")?.textContent).toBe("1"));
  });

  it("Today returns to December from another month", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /prev|previous|‹|</i }));
    expect(screen.getByText("November 2026")).toBeTruthy();
    fireEvent.click(screen.getByText("Today"));
    expect(screen.getByText("December 2026")).toBeTruthy();
  });
});
