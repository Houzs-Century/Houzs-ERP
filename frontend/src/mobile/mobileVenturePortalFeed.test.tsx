// The Venture Portal Feed on a phone.
//
// WHAT THIS FILE IS REALLY FOR: proving the two surfaces agree. The owner's
// standing rule is one shared logic layer with the surfaces differing only in
// presentation, and "fixed on the desktop, missed on mobile" is a bug class
// this repo keeps paying for. So the assertions here are deliberately the SAME
// requirements venturePortalFeed.test.tsx asserts — same verdict sentence, same
// secret property, same read-only behaviour, same refusal surfacing — because a
// divergence between the surfaces should fail HERE rather than be noticed by
// somebody holding a phone.
//
// Plus the one thing only this surface can get wrong: nothing may be missing
// from the phone that the desktop offers, and turning the feed OFF is the
// control most plausibly needed away from a desk.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiPost, apiPut } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
}));
vi.mock("../api/client", () => ({ api: { get: apiGet, post: apiPost, put: apiPut } }));

import { MobileVenturePortalFeed } from "./MobileVenturePortalFeed";
import type { VpRow, VpStatus } from "../lib/venturePortalFeed";

afterEach(cleanup);
/* BRACES, not a concise arrow — see the note in the desktop suite. */
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
    secret: { set: true, length: 40, tail: "e-42" },
    ready: true,
  },
  queue: {
    pending: 3,
    sent: 490,
    failed: 1,
    skipped: 2,
    maxAttempts: 6,
    batch: 25,
    lastSent: null,
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
  last_error: "http 503 — the portal has no ERP_SYNC_SECRET set yet",
  portal_outcome: null,
  created_at: "2026-09-12T01:00:00.000Z",
  updated_at: "2026-09-12T01:05:00.000Z",
  sent_at: null,
};

function wire(s: VpStatus, rows: VpRow[] = [failedRow]) {
  apiGet.mockImplementation((path: string) => {
    if (path.startsWith("/api/scm/venture-portal-feed/status")) return Promise.resolve(s);
    return Promise.resolve({ rows });
  });
}

async function mount(onBack = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MobileVenturePortalFeed onBack={onBack} />
    </QueryClientProvider>,
  );
  await screen.findByText("Venture Portal Feed");
  return onBack;
}

describe("the phone screen", () => {
  it("leads with the same verdict sentence the desktop shows", async () => {
    wire(status());
    await mount();
    expect(await screen.findByText("1 order could not be delivered")).toBeTruthy();
  });

  it("never renders the shared secret", async () => {
    wire(status());
    await mount();
    await screen.findByText(/40 characters/);
    expect(document.body.textContent).not.toContain(SECRET);
    expect(screen.getByPlaceholderText(/At least 32 characters/).getAttribute("type")).toBe("password");
  });

  it("goes back when asked", async () => {
    wire(status());
    const onBack = await mount();
    await userEvent.click(screen.getByRole("button", { name: /Back/i }));
    expect(onBack).toHaveBeenCalled();
  });

  /* THE CONTROL THAT MUST NOT BE DESKTOP-ONLY. Somebody realising the feed is
     sending the wrong company's orders is not necessarily at a desk. */
  it("can turn the feed off from a phone", async () => {
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

  it("offers no controls to somebody who may only look", async () => {
    wire(status({ canManage: false }));
    await mount();
    await screen.findByText(/could not be delivered/);
    expect(screen.getByText(/see the feed but not change it/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Turn off/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Send now/i })).toBeNull();
  });

  it("puts the reason and the next step on the row, as the desktop does", async () => {
    wire(status());
    await mount();
    expect(await screen.findByText("HC-SO-013403")).toBeTruthy();
    /* A 503 is the PORTAL owner's job. Telling somebody to re-send would send
       them round in circles, so the shared layer points at the right person and
       both surfaces render its answer.

       MATCHED ON THE WHOLE SENTENCE, not on "portal owner": the receiver-address
       hint says "The portal owner provides this", so the short phrase matches
       twice and the looser assertion would have read as a double render. */
    expect(screen.getByText(/Ask the portal owner to set it/i)).toBeTruthy();
  });

  it("says out loud when a save is refused", async () => {
    wire(status());
    apiPut.mockRejectedValue(new Error("url_must_be_https"));
    await mount();
    await screen.findByText(/could not be delivered/);

    await userEvent.click(screen.getByRole("button", { name: /Save address/i }));
    expect(await screen.findByText(/Not saved: url_must_be_https/)).toBeTruthy();
  });

  it("counts the filter chips from the server's totals", async () => {
    wire(status({ queue: { ...status().queue, pending: 412 } }));
    await mount();
    await screen.findByText("HC-SO-013403");
    expect(screen.getByRole("button", { name: /Waiting\s*412/ })).toBeTruthy();
  });
});
