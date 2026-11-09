import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/* B31 (sister: Hookka #675). The outbox preview rendered the sent email in an
   iframe with sandbox="", which forbids popups, and no new-tab base target, so
   every link in a sent customer email did nothing when clicked. */
vi.mock("./mail-actions", async (orig) => {
  const real = await orig<typeof import("./mail-actions")>();
  return {
    ...real,
    fetchOutboxDetail: vi.fn(async () => ({
      id: "o1",
      kind: "quotation",
      toAddress: "customer@example.com",
      subject: "Your quotation",
      status: "SENT",
      attempts: 1,
      lastError: null,
      createdAt: "2026-11-09T08:00:00Z",
      sentAt: "2026-11-09T08:00:01Z",
      attachmentNames: [],
      bodyHtml: '<!doctype html><html><head><title>q</title></head><body><a href="https://example.com/q/1">View quotation</a><script>alert(1)</script></body></html>',
      bodyText: null,
    })),
  };
});

afterEach(cleanup);

describe("Outbox preview — links in a sent email open", () => {
  it("lets links open in a new tab while keeping scripts off", async () => {
    const { OutboxReaderModal } = await import("./Inbox");
    render(<OutboxReaderModal id="o1" onClose={vi.fn()} />);
    const frame = await waitFor(() => {
      const f = screen.getByTitle("email body") as HTMLIFrameElement;
      expect(f).toBeTruthy();
      return f;
    });
    const sandbox = (frame.getAttribute("sandbox") ?? "").split(/\s+/);
    expect(sandbox).toContain("allow-popups");
    expect(sandbox).toContain("allow-popups-to-escape-sandbox");
    expect(sandbox).not.toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    const doc = frame.getAttribute("srcdoc") ?? "";
    expect(doc).toMatch(/<head[^>]*><base target="_blank">/);
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain('href="https://example.com/q/1"');
  });
});
