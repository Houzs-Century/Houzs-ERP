/* The POD an "Undo delivered" took off the order stays viewable (owner-approved
 * 2026-11-10): one collapsed section per earlier attempt, with its photos (and
 * the one-PDF download), signature and GPS. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchBlobUrl, fetchBlobWithTime, makePodPhotosPdf, deliverPdfBlob, authedFetch } = vi.hoisted(() => ({
  fetchBlobUrl: vi.fn(async (p: string) => `blob:${p}`),
  fetchBlobWithTime: vi.fn(async () => ({ blob: new Blob(["x"]), storedAt: null })),
  makePodPhotosPdf: vi.fn(async () => ({ blob: new Blob(["%PDF"]), filename: "x.pdf" })),
  deliverPdfBlob: vi.fn(),
  authedFetch: vi.fn(),
}));
vi.mock("../../api/client", () => ({ api: { fetchBlobUrl, fetchBlobWithTime } }));
vi.mock("../../vendor/scm/lib/pod-photos-pdf", () => ({ makePodPhotosPdf }));
vi.mock("../../vendor/scm/lib/pdf-common", () => ({ deliverPdfBlob }));
vi.mock("../../vendor/scm/lib/authed-fetch", () => ({ authedFetch }));

import { DoEarlierPodAttempts, DoEarlierPodAttemptsList, earlierAttemptSummary } from "./DoEarlierPodAttempts";
import type { DoPodAttempt } from "../../vendor/scm/lib/do-pod-attempts";

const attempt = (over: Partial<DoPodAttempt> = {}): DoPodAttempt => ({
  id: "att-1", delivery_order_id: "do-1", attempt_no: 1, undone_at: "2026-11-09T05:00:00Z", undone_by: 42,
  undone_by_name: "Ops Lead", reason: "driver tapped the wrong order", from_status: "DELIVERED",
  departure_at: "2026-11-09T02:00:00Z", arrival_at: "2026-11-09T03:00:00Z", signed_at: null, delivered_at: "2026-11-09T03:10:00Z",
  signature_data: "data:image/png;base64,AAAA", pod_lat: 3.1, pod_lng: 101.6, pod_located_at: null, photo_count: 2,
  ...over,
});

const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("DoEarlierPodAttemptsList", () => {
  it("names when, who and why in the collapsed heading", () => {
    render(<QueryClientProvider client={qc()}><DoEarlierPodAttemptsList attempts={[attempt()]} docNo="HC-DO-1" loadError={null} /></QueryClientProvider>);
    const summary = screen.getByText(/^Earlier delivery attempt \(undone on /);
    expect(summary.textContent).toContain("by Ops Lead: driver tapped the wrong order)");
    expect(summary.closest("details")?.open).toBe(false);
  });

  it("opens to the old photos from the attempt's own photo route, its signature and its location", async () => {
    render(<QueryClientProvider client={qc()}><DoEarlierPodAttemptsList attempts={[attempt()]} docNo="HC-DO-1" loadError={null} /></QueryClientProvider>);
    fireEvent.click(screen.getByText(/^Earlier delivery attempt/));
    expect(screen.getByText("2 photos")).toBeTruthy();
    await waitFor(() => expect(fetchBlobUrl).toHaveBeenCalledTimes(2));
    expect(fetchBlobUrl).toHaveBeenCalledWith("/api/scm/delivery-orders-mfg/do-1/pod-attempts/att-1/photo/0");
    expect(fetchBlobUrl).toHaveBeenCalledWith("/api/scm/delivery-orders-mfg/do-1/pod-attempts/att-1/photo/1");
    expect(screen.getByAltText("Customer signature, earlier attempt 1").getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(screen.getByText("Where that POD was taken").getAttribute("href")).toBe("https://www.google.com/maps?q=3.1,101.6");
  });

  it("the one-PDF download covers the old photos under the attempt's own title", async () => {
    render(<QueryClientProvider client={qc()}><DoEarlierPodAttemptsList attempts={[attempt()]} docNo="HC-DO-1" loadError={null} /></QueryClientProvider>);
    fireEvent.click(screen.getByText("Download PDF"));
    await waitFor(() => expect(makePodPhotosPdf).toHaveBeenCalled());
    expect(makePodPhotosPdf).toHaveBeenCalledWith(expect.objectContaining({
      title: "HC-DO-1 (earlier attempt 1)",
      paths: ["/api/scm/delivery-orders-mfg/do-1/pod-attempts/att-1/photo/0", "/api/scm/delivery-orders-mfg/do-1/pod-attempts/att-1/photo/1"],
    }));
  });

  it("says so when that attempt had no photos", () => {
    render(<QueryClientProvider client={qc()}><DoEarlierPodAttemptsList attempts={[attempt({ photo_count: 0, signature_data: null })]} docNo="HC-DO-1" loadError={null} /></QueryClientProvider>);
    expect(screen.getByText("No photos were taken that time.")).toBeTruthy();
  });

  it("renders nothing when the order was never undone, and says so when the read failed", () => {
    const { container } = render(<DoEarlierPodAttemptsList attempts={[]} docNo="HC-DO-1" loadError={null} />);
    expect(container.innerHTML).toBe("");
    render(<DoEarlierPodAttemptsList attempts={undefined} docNo="HC-DO-1" loadError="boom" />);
    expect(screen.getByRole("alert").textContent).toContain("boom");
  });

  it("falls back to 'unknown user' when no name was recorded", () => {
    expect(earlierAttemptSummary({ undone_at: "2026-11-09T05:00:00Z", undone_by_name: null, reason: "x" })).toContain("by unknown user: x)");
  });
});

describe("DoEarlierPodAttempts", () => {
  it("reads the order's attempts and lists them newest first as the server sent them", async () => {
    authedFetch.mockResolvedValueOnce({ attempts: [attempt({ id: "att-2", attempt_no: 2, reason: "second" }), attempt()] });
    render(<QueryClientProvider client={qc()}><DoEarlierPodAttempts doId="do-1" docNo="HC-DO-1" /></QueryClientProvider>);
    await waitFor(() => expect(screen.getAllByText(/^Earlier delivery attempt/)).toHaveLength(2));
    expect(authedFetch).toHaveBeenCalledWith("/delivery-orders-mfg/do-1/pod-attempts");
    expect(screen.getAllByText(/^Earlier delivery attempt/)[0]!.textContent).toContain(": second)");
  });
});
