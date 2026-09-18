/* New Project panel: the name is derived from state, brand, organizer slot and
 * venue (never typed), the venue carries its state in, and Create posts that
 * derived name. */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { useToast } from "../../hooks/useToast";

const h = vi.hoisted(() => ({
  posts: [] as { path: string; body: unknown }[],
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: async (path: string) => {
        if (path === "/api/projects/venues") return { data: [{ id: 1, name: "MITEC", state: "Kuala Lumpur" }] };
        return { data: [] };
      },
      post: async (path: string, body: unknown) => {
        h.posts.push({ path, body });
        return { id: 157, code: "HZ-157" };
      },
    },
  };
});
vi.mock("../../hooks/useToast", () => ({
  useToast: () => ({ show: () => {}, success: () => {}, error: () => {}, info: () => {}, warning: () => {} }),
}));
vi.mock("../../hooks/useDialog", () => ({
  useDialog: () => ({ confirm: async () => true, prompt: async () => null, alert: async () => {} }),
}));

import { CreateProjectPanel } from "./CreateProjectPanel";

function toastSpy(): ReturnType<typeof useToast> {
  return { show: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
}

describe("CreateProjectPanel", () => {
  it("derives the name from brand, event type and the picked venue's state, and creates with it", async () => {
    const onCreated = vi.fn();
    const toast = toastSpy();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <CreateProjectPanel
          onClose={() => {}}
          onCreated={onCreated}
          toast={toast}
          brands={["HOUZS"]}
          eventTypes={[{ id: 3, slug: "solo", name: "Solo", default_template_id: null }]}
        />
      </QueryClientProvider>,
    );

    const create = screen.getByRole("button", { name: "Create Project" });
    expect((create as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByDisplayValue("— pick a brand —"), { target: { value: "HOUZS" } });
    await screen.findByRole("option", { name: "MITEC · Kuala Lumpur" });
    fireEvent.change(screen.getByDisplayValue("— select venue —"), { target: { value: "MITEC" } });
    expect(screen.getByText("KUALA LUMPUR [HOUZS] @ MITEC")).toBeTruthy();

    fireEvent.change(screen.getByDisplayValue("— none —"), { target: { value: "3" } });
    expect(screen.getByText("KUALA LUMPUR [HOUZS] SOLO @ MITEC")).toBeTruthy();
    expect((create as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(create);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(157));
    expect(h.posts).toEqual([
      {
        path: "/api/projects",
        body: expect.objectContaining({
          name: "KUALA LUMPUR [HOUZS] SOLO @ MITEC",
          brand: "HOUZS",
          venue: "MITEC",
          state: "Kuala Lumpur",
          event_type_id: 3,
        }),
      },
    ]);
    expect(toast.success).toHaveBeenCalledWith("Created HZ-157");
  });
});
