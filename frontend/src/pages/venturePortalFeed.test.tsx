// The desktop Venture Portal Feed page, rendered against a mocked API.
//
// What is asserted is the requirement, not the markup:
//   • the SECRET never reaches the screen — the one property that, if it broke,
//     would put a live credential in a screenshot and a browser's network tab;
//   • a read-only holder sees the feed and no buttons, because the page's own
//     `canManage` must agree with the server rather than hoping the server
//     refuses later;
//   • a refusal reaches the operator. CLAUDE.md records "the button does
//     nothing" as worse than a crash, and this page has seven buttons;
//   • the verdict, not the counts, leads;
//   • the filter counts come from the SERVER's aggregate — the list is capped,
//     so counting what loaded would understate a real backlog.
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
/* BRACES, not a concise arrow — vitest treats a value returned from beforeEach
   as that test's teardown, and `mockReset()` returns the mock. The same trap is
   documented in autoCountSync.test.tsx, which paid for it. */
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

/** Route both GETs off one mock, the way the page calls them. */
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

  /* THE SECURITY PROPERTY. GET /status cannot hand the page a key, and there is
     no input box that could hold one — so the only way a key reaches this screen
     is the one-time reveal below. */
  it("never renders a key the server did not hand it", async () => {
    wire(status());
    await mount();
    /* The whole sentence, not just the mask: the mask alone appears twice (the
       field and its hint), which is correct page behaviour and an ambiguous
       query. */
    await screen.findByText(/Key ····e-42 · generated/);
    expect(document.body.textContent).not.toContain(SECRET);
    /* And no box to type one into: the owner fills the key in on the PORTAL. */
    expect(screen.queryByPlaceholderText(/At least 32 characters/)).toBeNull();
  });

  /* THE HAND-SHAKE, end to end on this surface: press Generate, the key is on
     screen exactly once with the instruction that names where it goes, and Done
     takes it away for good — the server will not answer it a second time.
     Asserted rather than assumed because a reveal that does not appear leaves a
     key written to the database that nobody can paste anywhere. */
  it("reveals a generated key once, with where to paste it, and lets it go", async () => {
    wire(status({
      connection: { ...status().connection, secret: { set: false, length: 0, tail: "", setAt: null } },
    }));
    apiPost.mockResolvedValue({ ok: true, secret: SECRET, mask: { set: true, length: 39, tail: "e-42", setAt: null } });
    await mount();
    /* With no key stored the verdict is the not-wired-up one, which outranks the
       failed count — the page's own ordering, asserted here by waiting on it. */
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

  /* A READ-ONLY HOLDER. The server is the boundary; this asserts the page
     agrees with it rather than offering buttons that would 403. */
  it("offers no controls to somebody who may only look", async () => {
    wire(status({ canManage: false }));
    await mount();
    await screen.findByText(/could not be delivered/);
    expect(screen.getByText(/see the feed but not change it/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Turn off/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Test connection/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Send again/i })).toBeNull();
    /* Minting a key is the newest write on this page and the most consequential
       of the small ones — it invalidates the key the portal is holding, so every
       queued delivery starts answering 401 until somebody pastes the new one. */
    expect(screen.queryByRole("button", { name: /Generate/i })).toBeNull();
  });

  it("puts the reason and the next step on the failed row", async () => {
    wire(status());
    await mount();
    expect(await screen.findByText("HC-SO-013403")).toBeTruthy();
    /* The next STEP, not the status code: a 401 is the portal holding a
       different key, and the fix is generate-then-paste. */
    expect(screen.getByText(/different key/i)).toBeTruthy();
    expect(screen.getByText(/http 401/)).toBeTruthy();
  });

  /* A REFUSAL MUST REACH SOMEBODY. This is the class CLAUDE.md calls worse
     than a crash, and the page's whole write surface goes through one `run`. */
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
    expect(await screen.findByText(/refused the secret/i)).toBeTruthy();
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

  /* The list is server-filtered and capped at 100, so a count taken from the
     loaded page would tell somebody 100 when the real backlog is 400. */
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
