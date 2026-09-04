/**
 * /projects/:id — Project Detail regression cover.
 *
 * ISSUE 1 (owner 2026-07-19, "点选 edit 也不能 edit"): the "Edit project
 * details" button was reported to need TWO clicks. This test pins the
 * contract — ONE click enters edit mode — so that whatever the production
 * trigger turns out to be, a regression in the component itself is caught
 * here. It drives the REAL page (ProjectDetail -> ProjectDetailContent ->
 * ProjectSpecStrip) through a mocked api layer rather than unit-testing the
 * toggle, because the suspected mechanism is a remount of the component that
 * owns the flag, which a unit test of the toggle cannot see.
 *
 * NOTE ON SCOPE: this reproduces neither the two-click symptom nor the
 * horizontal layout shift — see BUG-HISTORY. Ruled out here: the handler
 * itself, a double-flip of the state, and a remount caused by the sibling
 * lookup queries resolving after the detail query (the second case below).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectDetail } from "./Projects";

const PROJECT = {
  id: 157,
  code: "HZ-157",
  name: "Test Project",
  stage: "confirmed",
  status: "active",
  brand: "HOUZS",
  event_type_id: null,
  start_date: "2026-08-01",
  end_date: "2026-08-05",
  booth_no: "A12",
  venue: "MITEC",
  venue_address: null,
  state: "KL",
  organizer: "Organizer Sdn Bhd",
  size_sqm: 36,
  pic_id: null,
  pic_name: null,
  pic_phone: null,
  archived_at: null,
  progress_pct: 40,
  duration_days: 5,
  payment_status: "not_started",
  setup_crew: null,
  dismantle_crew: null,
  banner_message: null,
  banner_tone: null,
  notes: null,
  notion_url: null,
};

const DETAIL = {
  project: PROJECT,
  checklist: [],
  sections: [],
  section_progress: [],
  activity: [],
  trips: [],
  attachments: [],
  finance_lines: [],
  finance: null,
  sales_attendees: [],
  _access: { level: "full", pms: { canEdit: true, canFinancial: true } },
};

// Lets a test push the lookup queries BEHIND the detail query, which is the
// real-world ordering and the window the owner's first click lands in.
let lookupDelayMs = 0;

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<any>("../api/client");
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    ...actual,
    api: {
      get: vi.fn(async (path: string) => {
        if (/^\/api\/projects\/\d+$/.test(path)) return DETAIL;
        if (lookupDelayMs) await wait(lookupDelayMs);
        if (path.startsWith("/api/projects/brands")) return { data: ["HOUZS", "AKEMI"] };
        if (path.startsWith("/api/projects/event-types")) return { data: [] };
        if (path.startsWith("/api/projects/venues"))
          return { data: [{ id: 1, name: "MITEC", state: "KL" }] };
        if (path.startsWith("/api/projects/sales-rep-options")) return { data: [] };
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
      id: 1,
      name: "Owner",
      email: "owner@example.com",
      permissions: ["*"],
      position_name: "Super Admin",
      department_name: "Management",
      page_access: {},
      project_finance_viewer: true,
      product_cost_viewer: true,
    },
    loading: false,
    hasUsers: true,
    can: () => true,
    canAny: () => true,
    canAll: () => true,
    pageAccess: () => "full",
    reload: async () => {},
    login: async () => ({ kind: "ok" }),
    verifyTotpLogin: async () => {},
    logout: async () => {},
    bootstrap: async () => {},
    acceptInvite: async () => {},
  }),
  AuthProvider: ({ children }: any) => children,
}));

vi.mock("../hooks/useToast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
  ToastProvider: ({ children }: any) => children,
}));

vi.mock("../hooks/useDialog", () => ({
  useDialog: () => ({
    confirm: async () => true,
    prompt: async () => null,
    alert: async () => {},
  }),
  DialogProvider: ({ children }: any) => children,
}));

function renderDetail() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
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

async function clickEditOnce() {
  const user = userEvent.setup();
  const btn = await screen.findByRole("button", { name: /edit/i });
  await user.click(btn);
}

describe("ProjectDetail — Edit project details", () => {
  afterEach(() => {
    cleanup();
    lookupDelayMs = 0;
  });

  it("enters edit mode on the FIRST click", async () => {
    await renderDetail();
    await clickEditOnce();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /done/i })).toBeTruthy();
    });
    // The edit-only cells are what the owner could not reach: Brand is absent
    // in view mode and appears only in edit mode.
    expect(screen.getByText("Brand")).toBeTruthy();
  });

  /* Owner 2026-09-03: "frontend only should have start date / end date /
     rental / size — other details keep hidden behind edit". The resting strip
     had grown to Start, End, Booth, Venue, State, Organizer and Contractor,
     which pushed the two NUMBERS the owner reads at a glance off the row. */
  it("shows only Start, End, Size and Rental until Edit is clicked", async () => {
    await renderDetail();
    // Wait for the strip itself, not just the page shell.
    await screen.findByText("Start");

    for (const shown of ["Start", "End", "Size · sqm", "Rental · RM"]) {
      expect(screen.getByText(shown), `${shown} must be on the resting strip`).toBeTruthy();
    }
    for (const hidden of ["Booth", "Venue *", "State", "Organizer", "Contractor", "Brand"]) {
      expect(screen.queryByText(hidden), `${hidden} must be behind Edit`).toBeNull();
    }

    await clickEditOnce();

    // …and Edit still reveals every one of them.
    await waitFor(() => expect(screen.getByText("Booth")).toBeTruthy());
    for (const revealed of ["Venue *", "State", "Organizer", "Contractor", "Brand"]) {
      expect(screen.getByText(revealed), `${revealed} must appear in edit mode`).toBeTruthy();
    }
    // The four never leave.
    for (const kept of ["Start", "End", "Size · sqm", "Rental · RM"]) {
      expect(screen.getByText(kept), `${kept} must stay in edit mode`).toBeTruthy();
    }
  });

  it("stays in edit mode when the lookup queries resolve after the click", async () => {
    lookupDelayMs = 150;
    await renderDetail();
    await clickEditOnce();

    // The lookups (brands / event types / venues / users) land here. If any of
    // them remounted the spec strip, the edit flag would be thrown away and
    // the button would fall back to "Edit" — the reported symptom.
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByRole("button", { name: /^edit$/i })).toBeNull();
    expect(screen.getByRole("button", { name: /done/i })).toBeTruthy();
  });
});
