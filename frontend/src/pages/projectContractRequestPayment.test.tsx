/**
 * /projects/:id — 「Request payment」 on the event's CONTRACT row (owner
 * 2026-10-08: 我的bd 会upload rental invoice 在这里 … 就在这里加request payment).
 * Drives the REAL page (ProjectDetail → TasklistSections → DocumentTable →
 * DocRow) through a mocked api layer, the way projectDetailEdit.test.tsx does:
 *   • the CONTRACT row of a requester (or Finance) carries the button — a row
 *     in any other section does not, nor a CONTRACT row marked N/A;
 *   • the row's requests are read for the CONTRACT rows only, and show under
 *     their row with Finance's 欠正式单 remark;
 *   • without the request key there is no button and nothing is read.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const PROJECT = {
  id: 348, code: "2026-10-ZANOTTI-REX", name: "Kuala Lumpur [ZANOTTI] REX @ MITEC", stage: "confirmed", status: "active",
  brand: "ZANOTTI", event_type_id: 1, start_date: "2026-10-13", end_date: "2026-10-19", booth_no: "B7", venue: "MITEC",
  venue_address: null, state: "KL", organizer: "REX", size_sqm: 72, pic_id: null, pic_name: null, pic_phone: null,
  archived_at: null, progress_pct: 10, duration_days: 7, payment_status: "not_started", setup_crew: null, dismantle_crew: null,
  banner_message: null, banner_tone: null, notes: null, notion_url: null,
};
const item = (id: number, title: string, section_id: number, status = "pending") => ({
  id, seq: id, title, description: null, required_perm: null, role_label: "BD", crew_visible: 0, due_date: null,
  owner_user_id: null, owner_name: null, status, review_status: null, rejection_reason: null, completed_by: null,
  completed_by_name: null, completed_at: null, notes: null, section_id, pill_kind: null, pill_value: null,
});
const DETAIL = {
  project: PROJECT,
  checklist: [item(5001, "Agreement / Quotation", 70), item(5003, "Rental receipt", 70, "na"), item(5002, "Booth drawing", 71)],
  sections: [
    { id: 70, name: "CONTRACT", sort_order: 1, display_mode: "documents" },
    { id: 71, name: "BOOTH SETUP", sort_order: 2, display_mode: "documents" },
  ],
  section_progress: [],
  checklist_attachments: [
    { id: 811, item_id: 5001, r2_key: "projects/348/811.pdf", file_name: "MITEC rental invoice.pdf", content_type: "application/pdf", size_bytes: 1000, uploaded_by: 31, uploader_name: "Wei Ling", uploaded_at: "2026-10-07T03:00:00Z", caption: null },
    { id: 812, item_id: 5002, r2_key: "projects/348/812.pdf", file_name: "Booth.pdf", content_type: "application/pdf", size_bytes: 1000, uploaded_by: 31, uploader_name: "Wei Ling", uploaded_at: "2026-10-07T03:00:00Z", caption: null },
  ],
  checklist_comments: [],
  activity: [], trips: [], attachments: [], finance_lines: [], finance: null, sales_attendees: [],
  _access: { level: "full", pms: { canEdit: true, canFinancial: true } },
};

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    api: {
      get: vi.fn(async (path: string) => {
        if (/^\/api\/projects\/\d+$/.test(path)) return DETAIL;
        if (path.startsWith("/api/users")) return { users: [] };
        return { data: [] };
      }),
      post: vi.fn(async () => ({ ok: true })),
      patch: vi.fn(async () => ({ ok: true })),
      put: vi.fn(async () => ({ ok: true })),
      del: vi.fn(async () => ({ ok: true })),
      openHtml: vi.fn(async () => {}),
      upload: vi.fn(async () => ({ ok: true })),
      fetchBlobUrl: vi.fn(async () => "blob:x"),
    },
  };
});

/* Whether the caller holds a request key — everything else they hold. */
let mayRequest = true;
const REQUEST_KEYS = ["*", "scm.payment_request.create", "scm.payment_voucher.create"];
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    user: { id: 31, name: "Wei Ling", email: "bd@example.com", permissions: [], position_name: "BD Exec", role_name: "BD Exec", department_name: "BD", page_access: {}, project_finance_viewer: true, product_cost_viewer: true },
    loading: false, hasUsers: true,
    can: (k: string) => mayRequest || !REQUEST_KEYS.includes(k),
    canAny: () => true, canAll: () => true, pageAccess: () => "full",
    reload: async () => {}, login: async () => ({ kind: "ok" }), verifyTotpLogin: async () => {}, logout: async () => {}, bootstrap: async () => {}, acceptInvite: async () => {},
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../hooks/useToast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }), ToastProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../hooks/useDialog", () => ({ useDialog: () => ({ confirm: async () => true, prompt: async () => null, alert: async () => {} }), DialogProvider: ({ children }: { children: React.ReactNode }) => children }));

const asked: Array<{ ids: number[]; enabled: boolean }> = [];
vi.mock("../vendor/scm/lib/payment-request-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../vendor/scm/lib/payment-request-queries")>()),
  useChecklistPaymentRequests: (ids: number[], enabled: boolean) => {
    asked.push({ ids: [...ids], enabled });
    return {
      data: enabled ? {
        finance: false,
        requests: [{
          id: "r1", request_no: "HC-PRQ-2610-002", requested_by: 31, requested_by_name: "Wei Ling", payee_name: "MITEC SDN BHD", amount_sen: 1_272_000,
          due_date: null, purpose: "Booth rental", project_id: 348, bank_name: null, bank_account_no: null, bank_account_name: null, status: "VOUCHERED",
          pv_id: "pv-4", finance_note: null, decided_by: null, decided_at: null, created_at: "2026-10-08T02:00:00Z", updated_at: "2026-10-08T02:00:00Z",
          stage: "PROCESSING", voucher: { id: "pv-4", pvNumber: "HC-HPV-2610-004", status: "DRAFT", approvedAt: null, postedAt: null, bankConfirmed: false },
          officialDoc: { state: "OWED", note: "Proforma only — follow up the actual invoice" }, checklist_item_id: 5001,
        }],
      } : undefined,
    };
  },
}));

const { ProjectDetail } = await import("./Projects");

function renderDetail() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/projects/348"]}>
        <Routes>
          <Route path="/projects/:id" element={<ProjectDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const rowOf = (title: string) => screen.getByText(title).closest("tr") as HTMLElement;

describe("ProjectDetail — Request payment on the CONTRACT row", () => {
  afterEach(() => {
    cleanup();
    mayRequest = true;
    asked.length = 0;
  });

  it("only the CONTRACT row that is not N/A carries the button; its requests show under it", async () => {
    renderDetail();
    await screen.findByText("Agreement / Quotation");
    expect(within(rowOf("Agreement / Quotation")).getByRole("button", { name: /Request payment/ })).toBeTruthy();
    expect(within(rowOf("Rental receipt")).queryByRole("button", { name: /Request payment/ })).toBeNull();
    expect(within(rowOf("Booth drawing")).queryByRole("button", { name: /Request payment/ })).toBeNull();
    /* Read for the CONTRACT rows only. */
    expect(asked.some((a) => a.enabled && a.ids.join(",") === "5001,5003")).toBe(true);
    expect(asked.some((a) => a.ids.includes(5002))).toBe(false);
    const box = screen.getByLabelText("Payment requests from this row");
    expect(box.textContent).toContain("HC-PRQ-2610-002");
    expect(box.textContent).toContain("Proforma only — follow up the actual invoice");
    expect(within(box).getByRole("button", { name: "Send the actual invoice · 补正式单" })).toBeTruthy();
  });

  it("without the request key: no button, nothing read", async () => {
    mayRequest = false;
    renderDetail();
    await screen.findByText("Agreement / Quotation");
    expect(screen.queryByRole("button", { name: /Request payment/ })).toBeNull();
    expect(screen.queryByLabelText("Payment requests from this row")).toBeNull();
    expect(asked.every((a) => !a.enabled && a.ids.length === 0)).toBe(true);
  });
});
