/* THE NO-LOGIN SHARE CALENDAR, MOUNTED — contractor and brand modes.
 *
 * Owner 2026-09-08: the same page serves /c/<token> (contractor) and
 * /b/<token> (brand). What each may see is a SERVER decision; these tests pin
 * what each page SHOWS and ASKS FOR, so a regression that made the contractor
 * page fetch money, or the brand export lose its Confidential footer, is red.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ShareCalendar } from "./ShareCalendar";

const TOKEN = "abcdefghijklmnopqrstuvwx012345_-";

const fetchMock = vi.fn();
const sheets: (string | number)[][][] = [];
const written: string[] = [];

vi.mock("../lib/xlsx-runtime", () => ({
  utils: {
    aoa_to_sheet: (aoa: (string | number)[][]) => { sheets.push(aoa); return { aoa }; },
    book_new: () => ({ sheets: [] as unknown[] }),
    book_append_sheet: (wb: { sheets: unknown[] }, ws: unknown) => { wb.sheets.push(ws); },
  },
  writeFileXLSX: (_wb: unknown, name: string) => { written.push(name); },
  writeXLSX: () => new ArrayBuffer(0),
  read: () => ({}),
}));

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  sheets.length = 0;
  written.length = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const event = {
  eventId: 7,
  brand: "AKEMI",
  organizer: "HOMELOVE",
  state: null,
  venue: "MID VALLEY",
  boothNo: "3053-3055",
  startDate: todayIso(),
  endDate: todayIso(),
  name: null,
};

/** A fake of both public routes, keyed on the URL's tail. */
function serve(url: string): Promise<Response> {
  if (url.endsWith("/export")) {
    const brand = url.includes("/brand-calendar/");
    return json({
      ...(brand ? { brand: "AKEMI" } : { contractor: "DREAM ART (M) SDN BHD" }),
      generatedAt: "2026-09-08T10:00:00Z",
      rows: [{ startDate: "2026-09-11", endDate: "2026-09-13", venue: "MID VALLEY", organizer: "HOMELOVE", boothNo: "3053", sizeSqm: 72, ...(brand ? { totalSales: 125000 } : {}) }],
    });
  }
  if (url.endsWith("/events/7/floorplan")) {
    return json({ files: [{ fileId: "t701", fileName: "MV plan.pdf", contentType: "application/pdf", sizeBytes: 2048 }] });
  }
  if (url.endsWith("/events/7")) return json({ sizeSqm: 72, totalSales: 125000 });
  if (url.includes("/brand-calendar/")) return json({ brand: "AKEMI", events: [event] });
  return json({ contractor: "DREAM ART (M) SDN BHD", events: [event] });
}

describe("ShareCalendar", () => {
  it("contractor: tapping an event opens only its unfilled floorplan, never the figures", async () => {
    window.history.pushState({}, "", `/c/${TOKEN}`);
    fetchMock.mockImplementation((input: RequestInfo | URL) => serve(String(input)));
    render(<ShareCalendar mode="contractor" />);
    fireEvent.click(await screen.findByText(/Booth 3053-3055/));
    expect(await screen.findByText("MV plan.pdf")).toBeTruthy();
    expect(screen.getByText("Unfilled floorplan")).toBeTruthy();
    expect(screen.queryByText("Total sales")).toBeNull();
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => /\/contractor-calendar\/.*\/events\/7$/.test(u))).toBe(false);
    expect(screen.getByText("Download").closest("a")?.getAttribute("href")).toMatch(/\/events\/7\/floorplan\/t701\?download=1$/);
  });

  it("brand: the panel shows the display floorplan, size and total sales", async () => {
    window.history.pushState({}, "", `/b/${TOKEN}`);
    fetchMock.mockImplementation((input: RequestInfo | URL) => serve(String(input)));
    render(<ShareCalendar mode="brand" />);
    expect(await screen.findByText("AKEMI")).toBeTruthy();
    fireEvent.click(await screen.findByText(/Booth 3053-3055/));
    expect(await screen.findByText("MV plan.pdf")).toBeTruthy();
    expect(screen.getByText("Display floorplan")).toBeTruthy();
    expect(screen.getByText("72 sqm")).toBeTruthy();
    expect(screen.getByText("RM 125,000")).toBeTruthy();
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.every((u) => u.includes("/brand-calendar/"))).toBe(true);
  });

  it("week view: the toggle switches the grid to one week and the choice lives in the URL", async () => {
    window.history.pushState({}, "", `/c/${TOKEN}`);
    fetchMock.mockImplementation((input: RequestInfo | URL) => serve(String(input)));
    render(<ShareCalendar mode="contractor" />);
    await screen.findByText(/Booth 3053-3055/);
    fireEvent.click(screen.getByText("Week"));
    expect(screen.getByText("Week").getAttribute("aria-pressed")).toBe("true");
    expect(window.location.search).toContain("view=week");
    expect(screen.getByLabelText("Previous week")).toBeTruthy();
    // Today's event is in this week, so it is still on screen.
    expect(screen.getByText(/Booth 3053-3055/)).toBeTruthy();
    fireEvent.click(screen.getByText("Month"));
    expect(window.location.search).not.toContain("view=week");
  });

  it("export: contractor gets five columns; brand adds Total Sales and a Confidential footer", async () => {
    window.history.pushState({}, "", `/c/${TOKEN}`);
    fetchMock.mockImplementation((input: RequestInfo | URL) => serve(String(input)));
    const { unmount } = render(<ShareCalendar mode="contractor" />);
    await screen.findByText(/Booth 3053-3055/);
    fireEvent.click(screen.getByText("Export to Excel"));
    await waitFor(() => expect(written.length).toBe(1));
    expect(sheets[0][0]).toEqual(["Date", "Venue", "Organizer", "Booth", "Size (sqm)"]);
    expect(sheets[0][1]).toEqual(["11/09/2026 – 13/09/2026", "MID VALLEY", "HOMELOVE", "3053", 72]);
    expect(sheets[0].flat()).not.toContain("Confidential");
    expect(written[0]).toMatch(/^DREAM ART \(M\) SDN BHD schedule .*\.xlsx$/);
    unmount();

    window.history.pushState({}, "", `/b/${TOKEN}`);
    render(<ShareCalendar mode="brand" />);
    await screen.findByText(/Booth 3053-3055/);
    fireEvent.click(screen.getByText("Export to Excel"));
    await waitFor(() => expect(written.length).toBe(2));
    const brandSheet = sheets[1];
    expect(brandSheet[0]).toEqual(["Date", "Venue", "Organizer", "Booth", "Size (sqm)", "Total Sales (RM)"]);
    expect(brandSheet[1][5]).toBe(125000);
    expect(brandSheet.slice(-3).map((r) => String(r[0]))).toEqual([
      "Brand: AKEMI",
      expect.stringMatching(/^Generated: /),
      "Confidential",
    ]);
  });

  it("shows a friendly message for an invalid or revoked link", async () => {
    window.history.pushState({}, "", `/b/${TOKEN}`);
    fetchMock.mockImplementation(() => json({ error: "unknown_link" }, 404));
    render(<ShareCalendar mode="brand" />);
    expect(await screen.findByText(/not valid/i)).toBeTruthy();
  });
});
