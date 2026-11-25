// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileTitle, printFrameAs, printPageAs } from "./printFrame";

describe("printFrameAs: Save as PDF is named after the document, not the ERP", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("gives the tab the document's title while printing, then restores it", () => {
    document.title = "Houzs Century ERP";
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    let titleWhilePrinting = "";
    frame.contentWindow!.print = () => { titleWhilePrinting = document.title; };
    printFrameAs(frame, "Supplier Service Order — ASSR/2611-072");
    expect(titleWhilePrinting).toBe("Supplier Service Order — ASSR-2611-072");
    frame.contentWindow!.dispatchEvent(new Event("afterprint"));
    expect(document.title).toBe("Houzs Century ERP");
  });

  it("restores after a minute when the browser never says the print ended", () => {
    vi.useFakeTimers();
    document.title = "Houzs Century ERP";
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    frame.contentWindow!.print = () => undefined;
    printFrameAs(frame, "Cash flow");
    expect(document.title).toBe("Cash flow");
    vi.advanceTimersByTime(60_000);
    expect(document.title).toBe("Houzs Century ERP");
  });

  it("leaves a title the page set meanwhile alone", () => {
    document.title = "Houzs Century ERP";
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    frame.contentWindow!.print = () => { document.title = "Run-sheet 2026-11-25"; };
    printFrameAs(frame, "Cash flow");
    window.dispatchEvent(new Event("afterprint"));
    expect(document.title).toBe("Run-sheet 2026-11-25");
  });

  it("names a sheet that prints the page itself", () => {
    document.title = "Houzs Century ERP";
    let titleWhilePrinting = "";
    const spy = vi.spyOn(window, "print").mockImplementation(() => { titleWhilePrinting = document.title; });
    printPageAs("Daily Bank 2026-11-25");
    expect(titleWhilePrinting).toBe("Daily Bank 2026-11-25");
    window.dispatchEvent(new Event("afterprint"));
    expect(document.title).toBe("Houzs Century ERP");
    spy.mockRestore();
  });

  it("makes a safe file name", () => {
    expect(fileTitle(' DO/2611:01  "x"  ')).toBe("DO-2611-01 -x-");
  });
});
