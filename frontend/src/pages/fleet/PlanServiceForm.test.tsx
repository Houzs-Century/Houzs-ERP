import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const post = vi.fn(async () => ({}));
vi.mock("../../api/client", () => ({ api: { post: (...a: unknown[]) => post(...(a as [])) } }));

import { PlanServiceForm } from "./PlanServiceForm";

afterEach(() => { vi.useRealTimers(); post.mockClear(); });

describe("PlanServiceForm", () => {
  it("defaults the service date to today in Malaysia", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T17:30:00Z"));
    const onSaved = vi.fn();
    render(<PlanServiceForm planId="p1" componentLabel="Engine oil" currentKm={1000} onCancel={() => {}} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole("button", { name: "Save service" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/api/fleet-maintenance/plans/p1/service", expect.objectContaining({ doneDate: "2026-11-10" }));
  });
});
