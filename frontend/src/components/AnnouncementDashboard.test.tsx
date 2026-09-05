import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnnouncementBannerStack, TeamPendingCard } from "./AnnouncementDashboard";

/* ────────────────────────────────────────────────────────────────────────────
   Overview pieces (design handoff 2026-09-04, screen 5): the banner stack —
   first notice expanded, the rest collapsed, the overflow row — and the
   supervisor's "My team's pending" card that renders only for a user with
   direct reports.
   ──────────────────────────────────────────────────────────────────────────── */

const { navigate, ack, hookState, apiGet, apiPost, canWrite } = vi.hoisted(() => ({
  navigate: vi.fn(),
  ack: vi.fn(),
  hookState: { notices: [] as unknown[], ackedIds: new Set<string>() },
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  canWrite: { value: true },
}));

vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));
vi.mock("./useAnnouncementBanner", () => ({
  useAnnouncementBanner: () => ({ notices: hookState.notices, ackedIds: hookState.ackedIds, ack }),
}));
vi.mock("../api/client", () => ({ api: { get: apiGet, post: apiPost } }));
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ can: () => canWrite.value }),
}));
vi.mock("../hooks/useToast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock("../hooks/useDialog", () => ({
  useDialog: () => ({ confirm: vi.fn(async () => true) }),
}));
// A minimal useQuery: fetch once on mount, expose reload — enough for the card.
vi.mock("../hooks/useQuery", async () => {
  const React = await import("react");
  return {
    useQuery: (_key: string, fn: () => Promise<unknown>) => {
      const [state, setState] = React.useState<{ data: unknown; loading: boolean }>({ data: null, loading: true });
      const load = React.useCallback(() => void fn().then((d) => setState({ data: d, loading: false })), [fn]);
      React.useEffect(() => {
        load();
      }, []);
      return { ...state, error: null, fetching: false, placeholder: false, reload: load };
    },
  };
});

function notice(id: string, category: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `Title ${id}`,
    body: `Body of ${id}\nsecond line`,
    createdAt: "2026-09-05T08:00:00Z",
    remindedAt: null,
    category,
    createdByName: "Lee Wei",
    ...extra,
  };
}

describe("AnnouncementBannerStack", () => {
  beforeEach(() => {
    navigate.mockReset();
    ack.mockReset();
  });

  it("renders nothing when everything is acknowledged", () => {
    hookState.notices = [notice("a", "WARNING")];
    hookState.ackedIds = new Set(["a"]);
    const { container } = render(<AnnouncementBannerStack />);
    expect(container.innerHTML).toBe("");
  });

  it("expands the first unacknowledged notice, collapses the rest, and folds the overflow", () => {
    hookState.notices = [notice("w", "WARNING"), notice("s", "SOP"), notice("l", "LEARNING"), notice("g", "GENERAL")];
    hookState.ackedIds = new Set();
    render(<AnnouncementBannerStack />);
    // Expanded card: body + the 150px action column with the category CTA.
    expect(screen.getByText("Body of w")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Got it" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "View details" }).length).toBeGreaterThan(0);
    // Collapsed SOP row keeps its own CTA wording and secondary.
    expect(screen.getByRole("button", { name: "Acknowledge" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Read SOP" })).toBeTruthy();
    // Three visible, one folded.
    expect(screen.queryByText("Title g")).toBeNull();
    expect(screen.getByText("1 more notice collapsed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    expect(screen.getByText("Title g")).toBeTruthy();
  });

  it("the CTA acknowledges through the shared hook; the secondary deep-links to the notice", () => {
    hookState.notices = [notice("w", "WARNING"), notice("s", "SOP")];
    hookState.ackedIds = new Set();
    render(<AnnouncementBannerStack />);
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ id: "w" }));
    fireEvent.click(screen.getByRole("button", { name: "Read SOP" }));
    expect(navigate).toHaveBeenCalledWith("/announcements?id=s");
    // Clicking a collapsed title expands it in place.
    fireEvent.click(screen.getByRole("button", { name: "Title s" }));
    expect(screen.getByText("Body of s")).toBeTruthy();
  });
});

describe("TeamPendingCard", () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiPost.mockReset();
    canWrite.value = true;
  });

  it("renders nothing for a user without direct reports", async () => {
    apiGet.mockResolvedValue({ success: true, data: { reports: 0, pending: [] } });
    const { container } = render(<TeamPendingCard />);
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/api/announcements/team-pending"));
    expect(container.innerHTML).toBe("");
  });

  it("lists each report's pending notice with its state and reminds every distinct notice", async () => {
    apiGet.mockResolvedValue({
      success: true,
      data: {
        reports: 6,
        pending: [
          { userId: 1, name: "Ooi Sze Wei", positionName: "HR Admin", announcementId: "w", title: "Shipping marks", category: "WARNING", createdAt: null, state: "overdue" },
          { userId: 2, name: "Sim Yong Han", positionName: "IT Admin", announcementId: "w", title: "Shipping marks", category: "WARNING", createdAt: null, state: "overdue" },
          { userId: 2, name: "Sim Yong Han", positionName: "IT Admin", announcementId: "s", title: "PO Amendment", category: "SOP", createdAt: null, state: "reminded" },
        ],
      },
    });
    apiPost.mockResolvedValue({ success: true, pendingCount: 2 });
    render(<TeamPendingCard />);
    await waitFor(() => expect(screen.getByText("2 of 6")).toBeTruthy());
    expect(screen.getAllByText("overdue").length).toBe(2);
    expect(screen.getByText("reminded")).toBeTruthy();
    expect(screen.getByText("HR Admin · Shipping marks")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remind all 2" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));
    expect(apiPost).toHaveBeenCalledWith("/api/announcements/w/remind", { scope: "unacked" });
    expect(apiPost).toHaveBeenCalledWith("/api/announcements/s/remind", { scope: "unacked" });
  });

  it("a supervisor without announcements.write sees the list but no Remind button", async () => {
    canWrite.value = false;
    apiGet.mockResolvedValue({
      success: true,
      data: {
        reports: 2,
        pending: [
          { userId: 1, name: "Ooi Sze Wei", positionName: null, announcementId: "w", title: "Shipping marks", category: "WARNING", createdAt: null, state: "pending" },
        ],
      },
    });
    render(<TeamPendingCard />);
    await waitFor(() => expect(screen.getByText("1 of 2")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Remind all/ })).toBeNull();
  });
});
