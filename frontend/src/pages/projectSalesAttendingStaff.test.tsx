/* PMS Sales Attending — staff not on the Sales Team roster can be picked
   (owner 2026-10-19: 「不需要改部门啊，就让他们可以去 sales attending 不就好了？」).
   Pinned here: the picker lists them under their own heading, and adding one
   sends their LOGIN (user_id) so the server puts them on the roster; a roster
   rep still goes by sales_rep_id. */
import type { ReactNode } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "../api/client";
import { ProjectDetail } from "./Projects";

const DETAIL = {
  project: {
    id: 157, code: "HZ-157", name: "Test Project", stage: "confirmed", status: "active", brand: "AKEMI",
    event_type_id: null, start_date: "2026-10-15", end_date: "2026-10-18", booth_no: "A12", venue: "MID VALLEY",
    venue_address: null, state: "KL", organizer: "HOMELOVE", size_sqm: 36, pic_id: null, pic_name: null,
    pic_phone: null, archived_at: null, progress_pct: 40, duration_days: 4, payment_status: "not_started",
    setup_crew: null, dismantle_crew: null, banner_message: null, banner_tone: null, notes: null, notion_url: null,
  },
  checklist: [], sections: [], section_progress: [], activity: [], trips: [], attachments: [],
  finance_lines: [], finance: null, sales_attendees: [],
  _access: { level: "full", pms: { canEdit: true, canFinancial: true } },
};

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    api: {
      get: vi.fn(async (path: string) => {
        if (/^\/api\/projects\/\d+$/.test(path)) return DETAIL;
        if (path.startsWith("/api/projects/sales-rep-options")) {
          return {
            data: [{ id: 92, code: "SR-092", name: "Jason", phone: null }],
            others: [{ user_id: 4, name: "Lim", email: "lim@example.com" }],
          };
        }
        if (path.startsWith("/api/users")) return { users: [] };
        return { data: [] };
      }),
      post: vi.fn(async () => ({ ok: true })),
      patch: vi.fn(async () => ({ ok: true })),
      del: vi.fn(async () => ({ ok: true })),
      openHtml: vi.fn(async () => {}),
      upload: vi.fn(async () => ({ ok: true })),
    },
  };
});

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    user: {
      id: 1, name: "Owner", email: "owner@example.com", permissions: ["*"], position_name: "Super Admin",
      department_name: "Management", page_access: {}, project_finance_viewer: true, product_cost_viewer: true,
    },
    loading: false, hasUsers: true,
    can: () => true, canAny: () => true, canAll: () => true, pageAccess: () => "full",
    reload: async () => {}, login: async () => ({ kind: "ok" }), verifyTotpLogin: async () => {},
    logout: async () => {}, bootstrap: async () => {}, acceptInvite: async () => {},
  }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("../hooks/useToast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
  ToastProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("../hooks/useDialog", () => ({
  useDialog: () => ({ confirm: async () => true, prompt: async () => null, alert: async () => {} }),
  DialogProvider: ({ children }: { children: ReactNode }) => children,
}));

function renderDetail() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/projects/157"]}>
        <Routes>
          <Route path="/projects/:id" element={<ProjectDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Sales Attending — staff not on the Sales Team roster", () => {
  afterEach(() => {
    cleanup();
    vi.mocked(api.post).mockClear();
  });

  it("lists them under their own heading, beside the roster reps", async () => {
    renderDetail();
    expect(await screen.findByText("Not in the Sales Team yet — adding puts them in it")).toBeTruthy();
    expect(screen.getByText("Lim")).toBeTruthy();
    expect(screen.getByText("Jason")).toBeTruthy();
  });

  it("adds a picked staff member by their login, and a rep by the roster id", async () => {
    renderDetail();
    const lim = (await screen.findByText("Lim")).closest("label") as HTMLElement;
    const jason = screen.getByText("Jason").closest("label") as HTMLElement;
    fireEvent.click(lim.querySelector("input") as HTMLInputElement);
    fireEvent.click(jason.querySelector("input") as HTMLInputElement);
    fireEvent.click(screen.getByRole("button", { name: /Add 2 selected/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(api.post).toHaveBeenCalledWith("/api/projects/157/sales-attendees", { sales_rep_id: 92 });
    expect(api.post).toHaveBeenCalledWith("/api/projects/157/sales-attendees", { user_id: 4 });
  });
});
