import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiPost, apiPut } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
}));
vi.mock("../api/client", () => ({ api: { get: apiGet, post: apiPost, put: apiPut } }));

import { VenturePortalFeed } from "./VenturePortalFeed";
import type { VpRow, VpStatus } from "../lib/venturePortalFeed";

afterEach(cleanup);
beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiPut.mockReset();
});

const SECRET = "super-secret-value-nobody-should-see-42";

const status = (over: Partial<VpStatus> = {}): VpStatus => ({
  feed: { enabled: true, scope: [1], configKey: "scm.venture_portal_feed" },
  connection: {
    url: "https://portal.example/api/erp/v1/sales-orders",
    since: "2026-08-01",
    secret: { set: true, length: 48, tail: "e-42", setAt: "2026-09-13T07:40:00.000Z" },
    ready: true,
  },
  queue: {
    pending: 3,
    sent: 490,
    failed: 1,
    skipped: 2,
    maxAttempts: 6,
    batch: 25,
    lastSent: { doc_no: "HC-SO-013400", sent_at: "2026-09-12T01:00:00.000Z", portal_outcome: "applied" },
    lastError: null,
    oldestPending: null,
  },
  canManage: true,
  ...over,
});

const failedRow: VpRow = {
  id: "vp-9",
  doc_no: "HC-SO-013403",
  op: "UPDATE",
  status: "failed",
  attempts: 6,
  last_error: "http 401 — wrong or missing shared secret",
  portal_outcome: null,
  created_at: "2026-09-12T01:00:00.000Z",
  updated_at: "2026-09-12T01:05:00.000Z",
  sent_at: null,
};

function wire(s: VpStatus | Error, rows: VpRow[] = [failedRow]) {
  apiGet.mockImplementation((path: string) => {
    if (path.startsWith("/api/scm/venture-portal-feed/status")) {
      return s instanceof Error ? Promise.reject(s) : Promise.resolve(s);
    }
    return Promise.resolve({ rows });
  });
}

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/venture-portal-feed"]}>
        <VenturePortalFeed />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return screen.findByText("Venture Portal Feed");
}

describe("the desktop page", () => {
  it("leads with the verdict, in words", async () => {
    wire(status());
    await mount();
    expect(await screen.findByText("1 order could not be delivered")).toBeTruthy();
  });

  it("never renders a key the server did not hand it", async () => {
    wire(status());
    await mount();
    await screen.findByText(/Key ····e-42 · generated/);
    expect(document.body.textContent).not.toContain(SECRET);
    expect(screen.queryByPlaceholderText(/At least 32 characters/)).toBeNull();
  });

  it("reveals a generated key once, with where to paste it, and lets it go", async () => {
    wire(status({
      connection: { ...status().connection, secret: { set: false, length: 0, tail: "", setAt: null } },
    }));
    apiPost.mockResolvedValue({ ok: true, secret: SECRET, mask: { set: true, length: 39, tail: "e-42", setAt: null } });
    await mount();
    await screen.findByText(/not wired up yet/i);

    await userEvent.click(screen.getByRole("button", { name: /Generate API key/i }));

    expect(await screen.findByText(SECRET)).toBeTruthy();
    expect(apiPost).toHaveBeenCalledWith("/api/scm/venture-portal-feed/secret/generate", {});
    expect(screen.getByText(/Commission Calculation/)).toBeTruthy();
    expect(screen.getByText(/Not shown again/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /^Done$/ }));
    expect(screen.queryByText(SECRET)).toBeNull();
  });

  it("shows the address and the start date the server holds", async () => {
    wire(status());
    await mount();
    const url = await screen.findByDisplayValue("https://portal.example/api/erp/v1/sales-orders");
    expect(url).toBeTruthy();
    expect(screen.getByDisplayValue("2026-08-01")).toBeTruthy();
  });

  /* 「我这边只需要填那个 API key」 — so a URL is not a thing the owner types. The
     box arrives holding the portal's own address, and the hint says out loud
     that it is only an offer: a pre-filled box otherwise reads as saved, and
     somebody would turn the feed on while vp.url is still empty. */
  it("offers the portal's own address, and says it is not saved yet", async () => {
    wire(status({ connection: { ...status().connection, url: "" } }));
    await mount();
    expect(
      await screen.findByDisplayValue("https://venture-portal-chi.vercel.app/api/erp/v1/sales-orders"),
    ).toBeTruthy();
    expect(screen.getByText(/Not saved yet/i)).toBeTruthy();
  });

  it("offers no controls to somebody who may only look", async () => {
    wire(status({ canManage: false }));
    await mount();
    await screen.findByText(/could not be delivered/);
    expect(screen.getByText(/see the feed but not change it/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Turn off/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Test connection/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Send again/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Generate/i })).toBeNull();
  });

  it("puts the reason and the next step on the failed row", async () => {
    wire(status());
    await mount();
    expect(await screen.findByText("HC-SO-013403")).toBeTruthy();
    expect(screen.getByText(/different key/i)).toBeTruthy();
    expect(screen.getByText(/http 401/)).toBeTruthy();
  });

  it("says out loud when a save is refused", async () => {
    wire(status());
    apiPut.mockRejectedValue(new Error("secret_too_short"));
    await mount();
    await screen.findByText(/could not be delivered/);

    await userEvent.click(screen.getByRole("button", { name: /Save address/i }));
    expect(await screen.findByText(/Not saved: secret_too_short/)).toBeTruthy();
  });

  it("reports what a connection test actually found", async () => {
    wire(status());
    apiPost.mockResolvedValue({ ok: false, status: 401, body: "", reason: undefined });
    await mount();
    await screen.findByText(/could not be delivered/);

    await userEvent.click(screen.getByRole("button", { name: /Test connection/i }));
    expect(await screen.findByText(/different key.*then test again/i)).toBeTruthy();
  });

  it("turns the feed off through the scope endpoint, not a separate switch", async () => {
    wire(status());
    apiPut.mockResolvedValue({ ok: true, value: "off" });
    await mount();
    await screen.findByText(/could not be delivered/);

    await userEvent.click(screen.getByRole("button", { name: /Turn off/i }));
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith("/api/scm/venture-portal-feed/scope", {
        enabled: false,
        companies: [],
      }),
    );
    expect(await screen.findByText(/Nothing more is sent/i)).toBeTruthy();
  });

  it("refuses to enable with no company chosen rather than sending an empty scope", async () => {
    wire(status({ feed: { enabled: false, scope: "off", configKey: "scm.venture_portal_feed" } }));
    await mount();
    await screen.findByText(/Off — nothing is being sent/);

    const turnOn = screen.getByRole("button", { name: /Turn on/i });
    expect(turnOn.hasAttribute("disabled")).toBe(true);
    expect(apiPut).not.toHaveBeenCalled();
  });

  it("counts the filter chips from the server's totals, not the loaded page", async () => {
    wire(status({
      queue: { ...status().queue, pending: 412, failed: 1 },
    }), [failedRow]);
    await mount();
    await screen.findByText("HC-SO-013403");
    expect(screen.getByRole("button", { name: /Waiting\s*412/ })).toBeTruthy();
  });

  it("says the queue is clean rather than rendering an empty box", async () => {
    wire(status({ queue: { ...status().queue, failed: 0, pending: 0 } }), []);
    await mount();
    expect(await screen.findByText(/Nothing has failed to deliver/i)).toBeTruthy();
  });
});
