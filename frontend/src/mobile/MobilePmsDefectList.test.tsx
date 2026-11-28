import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { get, post, fetchBlobUrl, notify } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  fetchBlobUrl: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>();
  return { ...actual, api: { get, post, fetchBlobUrl } };
});
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ user: adminUser }) }));
vi.mock("../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => notify }));

const adminUser = { permissions: ["*"], position_name: "Super Admin", role_name: "Super Admin" };

import { MobilePmsDefectList } from "./MobilePmsDefectList";

const freshRow = {
  attachment_id: 1,
  r2_key: "k1",
  file_name: "defect.pdf",
  content_type: null,
  caption: "Model: AKEMI Elevation\nReason: Dented corner",
  uploaded_at: null,
  uploader_name: "Ali",
  item_id: 1,
  item_title: "Defect item 1",
  item_status: "open",
  project_id: 10,
  code: "P10",
  name: "Penang Fair",
  brand: "AKEMI",
  organizer: null,
  state: "Selangor",
  venue: "SPICE",
  booth_no: "A1",
  start_date: "2026-11-01",
  end_date: "2026-11-03",
  latest_status: null,
  latest_remark: null,
  latest_at: null,
  latest_user_name: null,
};

afterEach(cleanup);
beforeEach(() => {
  get.mockReset();
  post.mockReset();
  notify.mockReset();
  notify.mockResolvedValue(undefined);
  get.mockResolvedValue({ rows: [freshRow] });
  post.mockResolvedValue({});
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MobilePmsDefectList onBack={() => {}} onOpenProject={() => {}} />
    </QueryClientProvider>,
  );
}

describe("mobile Defect List", () => {
  test("groups the feed by project and shows the uploader's Model/Reason", async () => {
    mount();
    expect(await screen.findByText("Penang Fair")).toBeDefined();
    expect(screen.getByText(/AKEMI Elevation/)).toBeDefined();
    expect(screen.getByText(/Dented corner/)).toBeDefined();
  });

  test("a FRESH defect offers the reviewer's live buttons, not Done/Replace", async () => {
    mount();
    await screen.findByText("Penang Fair");
    expect(screen.getByRole("button", { name: "Done Clean" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Service" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Exchange" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
  });

  test("picking an action and saving posts that status to the shared route", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("Penang Fair");

    await user.click(screen.getByRole("button", { name: "Done Clean" }));
    await user.type(screen.getByPlaceholderText(/Add a remark/i), "cleaned on site");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/api/projects/checklist/attachments/1/actions",
        { status: "done_clean", remark: "cleaned on site" },
      ),
    );
  });

  test("the Semua toggle re-fetches the full feed (all=1)", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("Penang Fair");
    expect(get.mock.calls.every(([url]) => !String(url).includes("all=1"))).toBe(true);

    await user.click(screen.getByRole("button", { name: "Semua" }));

    await waitFor(() =>
      expect(get.mock.calls.some(([url]) => String(url).includes("all=1"))).toBe(true),
    );
  });

  test("a server refusal is surfaced, not swallowed", async () => {
    const user = userEvent.setup();
    post.mockRejectedValueOnce(new Error("You don't have permission."));
    mount();
    await screen.findByText("Penang Fair");

    const row = screen.getByText("Penang Fair").closest(".card") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Done Clean" }));
    await user.click(within(row).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify.mock.calls[0][0]).toMatchObject({ tone: "error" });
  });
});
