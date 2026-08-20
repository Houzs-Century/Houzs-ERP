import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* MobileServiceCase — the phone's ASSR surface.
 *
 * Two rules pinned here, both of them "the phone and the desktop must send the
 * same thing to the same endpoint":
 *
 *  1. A case raised on a phone must carry `customer_email`. `assr.ts` picks the
 *     CSAT survey recipient as `email_for_survey || customer_email`, so a
 *     phone-raised case had no survey address and somebody had to fill one in
 *     afterwards.
 *  2. `service_category` is a MAINTAINED list (assr_product_categories, mig
 *     0112) that desktop edits with chips and sends as an ARRAY. Mobile bound
 *     the same column as free text and sent a STRING, so a typed value became
 *     its own bucket in desktop's filter and — because resolveCategories only
 *     writes assr_case_categories rows for tokens it RECOGNISES — the case was
 *     left uncategorised for reporting. */

const { apiGet, apiPost, apiPatch, apiDel, authUser } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDel: vi.fn(),
  authUser: {
    current: { id: 9, name: "Zoe", position_name: "Operation Executive" } as {
      id: number;
      name: string;
      position_name: string;
    },
  },
}));

vi.mock("../api/client", () => ({
  api: { get: apiGet, post: apiPost, patch: apiPatch, del: apiDel, put: vi.fn(), fetchBlobUrl: vi.fn() },
}));
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ user: authUser.current, can: () => true, pageAccess: {} }),
}));
vi.mock("../auth/salesAccess", () => ({
  isSalesStaff: () => false,
  isSalesNonDirector: () => false,
}));
vi.mock("../auth/capabilities", () => ({ capability: () => true }));
vi.mock("../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => async () => true }));
vi.mock("../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => async () => {} }));
vi.mock("../vendor/scm/components/ChoiceDialog", () => ({ useChoice: () => async () => null }));
vi.mock("../lib/assrAttachmentUpload", () => ({ uploadAssrAttachment: vi.fn() }));
vi.mock("../lib/imagePipeline", () => ({ loadThumbFirst: vi.fn() }));
type Row = { id?: number | string };
vi.mock("./MobileVirtualList", () => ({
  MobileVirtualList: ({
    items,
    renderItem,
  }: {
    items: Row[];
    renderItem: (row: Row, index: number) => unknown;
  }) => (
    <div>
      {items.map((it, i) => (
        <div key={it.id ?? i}>{renderItem(it, i) as React.ReactNode}</div>
      ))}
    </div>
  ),
}));

import { MobileServiceCase } from "./MobileServiceCase";

/** The request body of a recorded api.post / api.patch call. */
const body = (call: unknown[] | undefined): Record<string, unknown> =>
  (call?.[1] ?? {}) as Record<string, unknown>;

const CASE_ROW = {
  id: 41,
  assr_no: "ASSR-2608-004",
  doc_no: "SO-2608-001",
  customer_name: "Acme Sdn Bhd",
  complaint_issue: "Bedframe joint cracked",
  issue_category: "Damage",
  service_category: "Bedframe",
  stage: "new",
  status: "open",
  priority: "normal",
  created_at: "2026-08-14T02:00:00Z",
  complained_date: "2026-08-14",
};

const PRODUCT_CATEGORIES = [
  { id: 1, slug: "mattress", name: "Mattress", sort_order: 1, active: 1 },
  { id: 2, slug: "bedframe", name: "Bedframe", sort_order: 2, active: 1 },
  { id: 3, slug: "sofa", name: "Sofa", sort_order: 3, active: 1 },
];

function mount(startNew: boolean) {
  apiGet.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/assr/lookups/product-categories")) return { data: PRODUCT_CATEGORIES };
    if (url.startsWith("/api/assr/lookups/issue-categories")) {
      return { data: [{ id: 1, slug: "damage", name: "Damage", sort_order: 1, active: 1 }] };
    }
    if (url.startsWith("/api/assr/lookups/")) return { data: [] };
    if (url.startsWith("/api/assr/lookup-items/")) return { items: [] };
    if (url.startsWith("/api/assr/so-cases/")) return { cases: [] };
    if (url.startsWith("/api/assr/search-so")) {
      return { results: [{ doc_no: "SO-2608-001", debtor_name: "Acme Sdn Bhd", case_count: 0 }] };
    }
    if (url.startsWith("/api/assr/41")) {
      return {
        case: CASE_ROW,
        items: [],
        attachments: [],
        activity: [],
        logistics: null,
        related_pos: [],
        stage_history: [],
        service_categories: ["Bedframe"],
      };
    }
    if (url.startsWith("/api/assr?")) {
      return { data: [CASE_ROW], page: 1, per_page: 20, total: 1 };
    }
    if (url.startsWith("/api/users")) return { users: [] };
    return {};
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MobileServiceCase onBack={() => {}} startNew={startNew} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiPatch.mockReset();
  apiDel.mockReset();
  apiPost.mockResolvedValue({ id: 99, assr_no: "ASSR-2608-005" });
  apiPatch.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

async function fillIntake() {
  // The SO is PICKED from the live search, never typed — `soPicked` is what
  // gates the Create button.
  fireEvent.change(screen.getByPlaceholderText(/SO #/i), { target: { value: "SO-2608" } });
  await waitFor(() => expect(screen.getByText("SO-2608-001")).toBeTruthy());
  await act(async () => {
    fireEvent.click(screen.getByText("SO-2608-001"));
  });
  fireEvent.change(screen.getByPlaceholderText(/Describe the issue/i), {
    target: { value: "Bedframe joint cracked" },
  });
  await waitFor(() => expect(screen.getByRole("option", { name: "Damage" })).toBeTruthy());
  fireEvent.change(screen.getByLabelText(/Issue category/i), { target: { value: "Damage" } });
}

describe("MobileServiceCase intake carries the survey address", () => {
  it("offers a customer email field on the phone's intake sheet", async () => {
    mount(true);
    await waitFor(() => expect(screen.getByText(/Issue description/)).toBeTruthy());
    expect(screen.getByLabelText(/Customer email/i)).toBeTruthy();
  });

  it("sends customer_email in the create payload", async () => {
    mount(true);
    await waitFor(() => expect(screen.getByText(/Issue description/)).toBeTruthy());

    await fillIntake();
    fireEvent.change(screen.getByLabelText(/Customer email/i), {
      target: { value: "ops@acme.test" },
    });

    await act(async () => {
      fireEvent.click(screen.getByText(/Create service case/i));
    });

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    const call = apiPost.mock.calls.find((c) => c[0] === "/api/assr");
    expect(call).toBeTruthy();
    expect(body(call).customer_email).toBe("ops@acme.test");
  });

  it("sends null rather than an empty string when no email was given", async () => {
    mount(true);
    await waitFor(() => expect(screen.getByText(/Issue description/)).toBeTruthy());
    await fillIntake();

    await act(async () => {
      fireEvent.click(screen.getByText(/Create service case/i));
    });

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    const call = apiPost.mock.calls.find((c) => c[0] === "/api/assr");
    expect(body(call).customer_email).toBeNull();
  });
});

async function openProductInfoEditor() {
  mount(false);
  await waitFor(() => expect(screen.getByText("ASSR-2608-004")).toBeTruthy());
  fireEvent.click(screen.getByText("ASSR-2608-004"));
  await waitFor(() => expect(screen.getAllByText("Product info").length).toBeGreaterThan(0));
  // Fields render in the accordion's EDIT view (the phone's Edit / Save
  // pattern), so open it the way an operator would.
  const panel = screen.getAllByText("Product info")[0].closest("details");
  expect(panel).toBeTruthy();
  const edit = Array.from(panel!.querySelectorAll("span")).find(
    (el) => el.textContent === "Edit",
  );
  expect(edit).toBeTruthy();
  await act(async () => {
    fireEvent.click(edit!);
  });
  return panel!;
}

describe("MobileServiceCase product category is the maintained list, not free text", () => {
  it("reads the same lookup desktop reads", async () => {
    await openProductInfoEditor();
    await waitFor(() =>
      expect(
        apiGet.mock.calls.some((c) => String(c[0]).includes("/api/assr/lookups/product-categories")),
      ).toBe(true),
    );
  });

  it("offers the lookup's names as chips, not a text box", async () => {
    await openProductInfoEditor();
    await waitFor(() => expect(screen.getByText("Mattress")).toBeTruthy());
    expect(screen.getByText("Sofa")).toBeTruthy();
    // The current value must be shown as selected, not as typed text.
    const bedframe = screen.getByText("Bedframe").closest("button");
    expect(bedframe).toBeTruthy();
    expect(bedframe!.getAttribute("aria-pressed")).toBe("true");
  });

  it("PATCHes service_category as an ARRAY, exactly like desktop", async () => {
    await openProductInfoEditor();
    await waitFor(() => expect(screen.getByText("Mattress")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByText("Mattress"));
    });
    // The phone saves on Save, not per toggle (desktop's accordion-free layout
    // saves per toggle); what must match is the WIRE SHAPE, not the moment.
    await act(async () => {
      fireEvent.click(screen.getAllByText("Save")[0]);
    });

    await waitFor(() => expect(apiPatch).toHaveBeenCalled());
    const call = apiPatch.mock.calls.find(
      (c) => String(c[0]).includes("/api/assr/41") && body(c).service_category !== undefined,
    );
    expect(call).toBeTruthy();
    const sent = body(call).service_category;
    expect(Array.isArray(sent)).toBe(true);
    expect(sent).toEqual(["Bedframe", "Mattress"]);
  });
});
