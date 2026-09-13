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

  it("never renders a key the server did not hand it", async () => {
    wire(status());
    await mount();
    /* The whole sentence — the mask alone appears twice (the field and its
       hint), which is correct and an ambiguous query. */
    await screen.findByText(/Key ····e-42 · generated/);
    expect(document.body.textContent).not.toContain(SECRET);
    /* No box to type a key into on this surface either — the phone must not be
       the one place the old free-text field survived. */
    expect(screen.queryByPlaceholderText(/At least 32 characters/)).toBeNull();
  });

  /* GENERATE MUST WORK FROM A PHONE, and this is where it is most likely to be
     used: standing in front of the portal on a laptop with the ERP on a phone is
     exactly the shape of the hand-shake. Same reveal, same instruction, same
     Done, from the same shared state the desktop reads. */
  it("reveals a generated key once and lets it go, as the desktop does", async () => {
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

    await userEvent.click(screen.getByRole("button", { name: /^Done$/ }));
    expect(screen.queryByText(SECRET)).toBeNull();
  });

  /* A phone keyboard is the worst place to type a URL, so the offer matters more
     here than anywhere — and so does saying it is only an offer. */
  it("offers the portal's own address, and says it is not saved yet", async () => {
    wire(status({ connection: { ...status().connection, url: "" } }));
    await mount();
    expect(
      await screen.findByDisplayValue("https://venture-portal-chi.vercel.app/api/erp/v1/sales-orders"),
    ).toBeTruthy();
    expect(screen.getByText(/Not saved yet/i)).toBeTruthy();
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
    /* A 503 is the portal holding NO key. Since it now takes one pasted on its
       own page, the next step is on this screen — generate, paste, re-send — and
       both surfaces render the shared layer's sentence for it.

       MATCHED ON A PHRASE UNIQUE TO THAT SENTENCE. It used to match "portal
       owner", which also appeared in the receiver-address hint, so the looser
       assertion would have read as a double render; that hint no longer says it,
       but the lesson stands and the phrase below appears exactly once. */
    expect(screen.getByText(/no key of its own yet/i)).toBeTruthy();
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
