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
// The floorplan PDF: what jsPDF was told to draw and what it was asked to save as.
const pdf = vi.hoisted(() => ({ pages: [] as { orientation: string; texts: string[]; images: string[] }[], saved: [] as string[] }));

vi.mock("jspdf", () => ({
  jsPDF: class {
    internal = { pageSize: { getWidth: () => 297, getHeight: () => 210 } };
    constructor(opts: { orientation: string }) { pdf.pages.push({ orientation: opts.orientation, texts: [], images: [] }); }
    addPage(_f: string, orientation: string) { pdf.pages.push({ orientation, texts: [], images: [] }); }
    setFont() {}
    setFontSize() {}
    text(s: string) { pdf.pages[pdf.pages.length - 1].texts.push(s); }
    addImage(_d: string, format: string) { pdf.pages[pdf.pages.length - 1].images.push(format); }
    save(name: string) { pdf.saved.push(name); }
  },
}));

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
  // jsdom cannot decode images; the page falls back to a 4:3 landscape page
  // without this, so give it a real size to prove the orientation is read.
  vi.stubGlobal("createImageBitmap", async () => ({ width: 600, height: 900, close() {} }));
  sheets.length = 0;
  written.length = 0;
  pdf.pages.length = 0;
  pdf.saved.length = 0;
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
  if (/\/export\?month=\d{4}-\d{2}$/.test(url)) {
    const brand = url.includes("/brand-calendar/");
    return json({
      ...(brand ? { brand: "AKEMI" } : { contractor: "DREAM ART (M) SDN BHD" }),
      generatedAt: "2026-09-08T10:00:00Z",
      rows: [{ startDate: "2026-09-11", endDate: "2026-09-13", venue: "MID VALLEY", state: "SELANGOR", organizer: "HOMELOVE", brand: "AKEMI", eventType: "ROADSHOW", boothNo: "3053", sizeSqm: 72, ...(brand ? { totalSales: 125000 } : {}) }],
    });
  }
  if (/\/floorplans\?month=\d{4}-\d{2}$/.test(url)) {
    return json({
      brand: "AKEMI",
      generatedAt: "2026-09-08T10:00:00Z",
      events: [
        { eventId: 7, name: null, venue: "MID VALLEY", boothNo: "3053-3055", startDate: "2026-09-11", endDate: "2026-09-13", files: [{ fileId: "t701", fileName: "MV plan.pdf", contentType: "application/pdf", sizeBytes: 2048 }, { fileId: "t702", fileName: "MV plan.jpg", contentType: "image/jpeg", sizeBytes: 4096 }] },
        { eventId: 9, name: "Spice Fair", venue: "SETIA SPICE", boothNo: null, startDate: "2026-09-20", endDate: "2026-09-21", files: [{ fileId: "t901", fileName: "spice.png", contentType: "image/png", sizeBytes: 4096 }] },
      ],
    });
  }
  if (/\/events\/\d+\/floorplan\/t\d+$/.test(url)) {
    const png = url.endsWith("t901");
    return Promise.resolve(new Response(new Blob([new Uint8Array([1, 2, 3])], { type: png ? "image/png" : "image/jpeg" }), { status: 200 }));
  }
  if (url.endsWith("/events/7/floorplan")) {
    return json({ files: [{ fileId: "t701", fileName: "MV plan.pdf", contentType: "application/pdf", sizeBytes: 2048 }] });
  }
  if (url.endsWith("/events/7")) return json(url.includes("/brand-calendar/") ? { sizeSqm: 72, totalSales: 125000 } : { sizeSqm: 72 });
  if (url.includes("/brand-calendar/")) return json({ brand: "AKEMI", events: [event] });
  return json({ contractor: "DREAM ART (M) SDN BHD", events: [event] });
}

describe("ShareCalendar", () => {
  it("contractor: tapping an event opens its unfilled floorplan and its size, never money", async () => {
    window.history.pushState({}, "", `/c/${TOKEN}`);
    fetchMock.mockImplementation((input: RequestInfo | URL) => serve(String(input)));
    render(<ShareCalendar mode="contractor" />);
    fireEvent.click(await screen.findByText(/Booth 3053-3055/));
    expect(await screen.findByText("MV plan.pdf")).toBeTruthy();
    expect(screen.getByText("Unfilled floorplan")).toBeTruthy();
    expect(await screen.findByText("72 sqm")).toBeTruthy();
    expect(screen.queryByText("Total sales")).toBeNull();
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.every((u) => u.includes("/contractor-calendar/"))).toBe(true);
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

  it("export: asks for the month on screen; contractor gets eight columns; brand adds Total Sales and a Confidential footer", async () => {
    window.history.pushState({}, "", `/c/${TOKEN}`);
    fetchMock.mockImplementation((input: RequestInfo | URL) => serve(String(input)));
    const { unmount } = render(<ShareCalendar mode="contractor" />);
    await screen.findByText(/Booth 3053-3055/);
    fireEvent.click(screen.getByText("Export to Excel"));
    await waitFor(() => expect(written.length).toBe(1));
    const d = new Date();
    const thisMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    expect(fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/export"))).toEqual([
      expect.stringMatching(new RegExp(`/contractor-calendar/.*/export\\?month=${thisMonth}$`)),
    ]);
    expect(sheets[0][0]).toEqual(["Date", "Venue", "State", "Organizer", "Brand", "Type", "Booth", "Size (sqm)"]);
    expect(sheets[0][1]).toEqual(["11/09/2026 – 13/09/2026", "MID VALLEY", "SELANGOR", "HOMELOVE", "AKEMI", "ROADSHOW", "3053", 72]);
    expect(sheets[0].flat()).not.toContain("Confidential");
    expect(written[0]).toMatch(/^DREAM ART \(M\) SDN BHD schedule .*\.xlsx$/);
    unmount();

    window.history.pushState({}, "", `/b/${TOKEN}`);
    render(<ShareCalendar mode="brand" />);
    await screen.findByText(/Booth 3053-3055/);
    // A brand link's Export is a menu; the contractor's (above) is one button.
    expect(screen.queryByText("Export to Excel")).toBeNull();
    fireEvent.click(screen.getByText("Export"));
    fireEvent.click(screen.getByText("Event List"));
    await waitFor(() => expect(written.length).toBe(2));
    const brandSheet = sheets[1];
    expect(brandSheet[0]).toEqual(["Date", "Venue", "State", "Organizer", "Brand", "Type", "Booth", "Size (sqm)", "Total Sales (RM)"]);
    expect(brandSheet[1][8]).toBe(125000);
    expect(brandSheet.slice(-3).map((r) => String(r[0]))).toEqual([
      "Brand: AKEMI",
      expect.stringMatching(/^Generated: /),
      "Confidential",
    ]);
  });

  it("brand: Display Floorplan builds a PDF with one page per IMAGE, headed by the event, oldest first; PDF uploads are skipped", async () => {
    window.history.pushState({}, "", `/b/${TOKEN}`);
    fetchMock.mockImplementation((input: RequestInfo | URL) => serve(String(input)));
    render(<ShareCalendar mode="brand" />);
    await screen.findByText(/Booth 3053-3055/);
    fireEvent.click(screen.getByText("Export"));
    fireEvent.click(screen.getByText("Display Floorplan"));
    await waitFor(() => expect(pdf.saved.length).toBe(1));
    expect(pdf.saved[0]).toMatch(/^AKEMI display floorplans .+\.pdf$/);
    // Two image pages (the .pdf upload on event 7 is skipped), event 7 first.
    expect(pdf.pages.map((p) => p.images)).toEqual([["JPEG"], ["PNG"]]);
    expect(pdf.pages.map((p) => p.orientation)).toEqual(["portrait", "portrait"]);
    expect(pdf.pages[0].texts).toEqual(["MID VALLEY", "11/09/2026 – 13/09/2026  ·  Booth 3053-3055"]);
    expect(pdf.pages[1].texts).toEqual(["Spice Fair", "20/09/2026 – 21/09/2026  ·  SETIA SPICE"]);
    // Only image files were fetched, and the .pdf upload never was.
    const fetched = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => /\/floorplan\/t\d+$/.test(u));
    expect(fetched.map((u) => u.slice(u.lastIndexOf("/") + 1))).toEqual(["t702", "t901"]);
    // Nothing from the event list went into the PDF.
    expect(pdf.pages.flatMap((p) => p.texts).join(" ")).not.toContain("Total");
  });

  it("contractor: no Display Floorplan option — the export is Excel only", async () => {
    window.history.pushState({}, "", `/c/${TOKEN}`);
    fetchMock.mockImplementation((input: RequestInfo | URL) => serve(String(input)));
    render(<ShareCalendar mode="contractor" />);
    await screen.findByText(/Booth 3053-3055/);
    expect(screen.getByText("Export to Excel")).toBeTruthy();
    expect(screen.queryByText("Display Floorplan")).toBeNull();
    expect(screen.queryByText("Event List")).toBeNull();
  });

  it("shows a friendly message for an invalid or revoked link", async () => {
    window.history.pushState({}, "", `/b/${TOKEN}`);
    fetchMock.mockImplementation(() => json({ error: "unknown_link" }, 404));
    render(<ShareCalendar mode="brand" />);
    expect(await screen.findByText(/not valid/i)).toBeTruthy();
  });
});
