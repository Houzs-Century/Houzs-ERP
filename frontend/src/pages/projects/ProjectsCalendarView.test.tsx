/* The Projects calendar renders the month the URL names and lays the events the
 * calendar feed returns onto it. */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: async (path: string) => {
        h.paths.push(path);
        if (path.startsWith("/api/projects/calendar/events")) {
          return {
            projects: [
              {
                id: 7,
                code: "HZ-007",
                name: "Kuala Lumpur [HOUZS] MALL MGMT @ MITEC",
                stage: "setup",
                status: "confirmed",
                brand: "HOUZS",
                organizer: "MALL MGMT",
                start_date: "2026-08-04",
                end_date: "2026-08-06",
                venue: "MITEC",
                state: "Kuala Lumpur",
              },
            ],
            tasks: [],
          };
        }
        return { data: [] };
      },
    },
  };
});
vi.mock("../../hooks/useToast", () => ({
  useToast: () => ({ show: () => {}, success: () => {}, error: () => {}, info: () => {}, warning: () => {} }),
}));

import { ProjectsCalendarView } from "./ProjectsCalendarView";

describe("ProjectsCalendarView", () => {
  it("shows the month from the URL and draws the feed's project on it", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/projects?view=calendar&month=2026-08"]}>
          <ProjectsCalendarView />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("August 2026")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText(/KUALA LUMPUR \[HOUZS\] MALL MGMT @ MITEC/).length).toBeGreaterThan(0));
    expect(h.paths.some((p) => p.startsWith("/api/projects/calendar/events?from=2026-"))).toBe(true);
  });
});
