import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";


vi.mock("../../vendor/scm/lib/authed-fetch", () => ({
  authedFetch: vi.fn((url: string) =>
    String(url).includes("/delivery-planning")
      ? Promise.resolve({ orders: [], counts: {}, regions: [] })
      : Promise.resolve([]),
  ),
}));

vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({
    user: { id: 1, name: "Test", position_capabilities: [] },
    can: () => true,
    pageAccess: { areas: {}, level: null },
  }),
}));

import { DeliveryPlanningDriver } from "./DeliveryPlanningDriver";
import { ToastProvider } from "../../hooks/useToast";

describe("DeliveryPlanningDriver (desktop host for the driver run-sheet)", () => {
  it("mounts the mobile run-sheet on desktop without the mobile shell", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <MemoryRouter>
            <DeliveryPlanningDriver />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    const today = await screen.findAllByText(/Today/i);
    expect(today.length).toBeGreaterThan(0);
  });
});
