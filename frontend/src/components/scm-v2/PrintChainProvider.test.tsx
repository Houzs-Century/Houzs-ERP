/* ----------------------------------------------------------------------------
   The right-click print STAYS ON THE LIST.

   THE OWNER'S ASK (2026-08-22): 「正常我们 print PDF 都是点进去 print 的吧。那我
   要在这边 right click，可以点 print SalesOrder、print DO」 — the point of the
   change is the ABSENCE of a navigation. So the first assertion here is that
   nothing navigates, because the shipped behaviour it replaces
   (`navigate('/scm/sales-orders/:docNo?print=1')`) is the one that reads like a
   working print and is exactly what he asked to stop doing.

   The rest pins the dialog it opens instead: it is `PrintPreviewModal` — the ONE
   print dialog (owner 2026-08-06, 「全部打印的时候都需要有这个」) — headed by the
   document the operator picked, not by the row he right-clicked.
   ---------------------------------------------------------------------------- */

import { describe, expect, test, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const fetchPrintBundle = vi.fn();
const renderPrintBundle = vi.fn();
vi.mock("../../lib/printDocumentPdf", async (orig) => ({
  ...(await orig<typeof import("../../lib/printDocumentPdf")>()),
  fetchPrintBundle: (...a: unknown[]) => fetchPrintBundle(...a),
  renderPrintBundle: (...a: unknown[]) => renderPrintBundle(...a),
}));

const notify = vi.fn();
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => notify }));
vi.mock("../../hooks/useBranding", () => ({ useBranding: () => ({ companyName: "Houzs Century" }) }));

import { PrintChainProvider, usePrintDocument } from "./PrintChainProvider";
import type { PrintTarget } from "../../lib/printChain";

const DO_TARGET: PrintTarget = { doc: "do", docNo: "HC-DO-2608-003", key: "do-uuid" };

function Harness({ target = DO_TARGET }: { target?: PrintTarget }) {
  const printDocument = usePrintDocument();
  return <button onClick={() => printDocument(target)}>trigger</button>;
}

const mount = (target?: PrintTarget) =>
  render(
    <PrintChainProvider>
      <Harness target={target} />
    </PrintChainProvider>,
  );

beforeEach(() => {
  fetchPrintBundle.mockReset().mockResolvedValue({ header: { debtor_name: "A Customer" }, items: [] });
  renderPrintBundle.mockReset().mockResolvedValue(undefined);
  notify.mockReset();
});

describe("printing a chain document does not leave the page", () => {
  test("no navigation happens — the URL is untouched", async () => {
    const before = window.location.href;
    mount();
    await userEvent.click(screen.getByText("trigger"));
    await screen.findByText("Print preview");
    expect(window.location.href).toBe(before);
  });

  test("the dialog is headed by the document PICKED, not the row it came from", async () => {
    mount();
    await userEvent.click(screen.getByText("trigger"));
    // TRANSFER_DOC's words, and the related document's own number.
    expect(await screen.findByText("Delivery Order")).toBeTruthy();
    expect(screen.getByText("HC-DO-2608-003")).toBeTruthy();
  });

  test("the document is fetched at its own address, once", async () => {
    mount();
    await userEvent.click(screen.getByText("trigger"));
    await screen.findByText("Print preview");
    expect(fetchPrintBundle).toHaveBeenCalledTimes(1);
    expect(fetchPrintBundle).toHaveBeenCalledWith(DO_TARGET);
  });
});

describe("Print now renders the PDF", () => {
  test("clicking Print now hands the generator action 'print', not window.print()", async () => {
    const printSpy = vi.fn();
    vi.stubGlobal("print", printSpy);
    mount();
    await userEvent.click(screen.getByText("trigger"));
    await waitFor(() => expect(fetchPrintBundle).toHaveBeenCalled());
    await userEvent.click(await screen.findByText("Print now"));
    await waitFor(() => expect(renderPrintBundle).toHaveBeenCalled());
    expect(renderPrintBundle.mock.calls[0]![0]).toEqual(DO_TARGET);
    expect(renderPrintBundle.mock.calls[0]![2]).toBe("print");
    expect(printSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  test("Download PDF asks for 'save' and View full PDF for 'preview'", async () => {
    mount();
    await userEvent.click(screen.getByText("trigger"));
    await userEvent.click(await screen.findByText("View full PDF"));
    await waitFor(() => expect(renderPrintBundle).toHaveBeenCalled());
    expect(renderPrintBundle.mock.calls.at(-1)![2]).toBe("preview");
    // A preview leaves the dialog open — the operator looked, now he prints.
    await userEvent.click(screen.getByText("Download PDF"));
    await waitFor(() => expect(renderPrintBundle.mock.calls.length).toBe(2));
    expect(renderPrintBundle.mock.calls.at(-1)![2]).toBe("save");
  });

  /* A dead click is the "failure that reaches nobody" shape this repo keeps
     paying for. Print now clicked while the card still says Loading must WAIT
     for the document, not quietly do nothing. */
  test("Print now clicked before the document has loaded still prints it", async () => {
    let release: (v: unknown) => void = () => {};
    fetchPrintBundle.mockReturnValue(new Promise((res) => { release = res; }));
    mount();
    await userEvent.click(screen.getByText("trigger"));
    await userEvent.click(await screen.findByText("Print now"));
    expect(renderPrintBundle).not.toHaveBeenCalled();
    release({ header: {}, items: [] });
    await waitFor(() => expect(renderPrintBundle).toHaveBeenCalledTimes(1));
    expect(renderPrintBundle.mock.calls[0]![2]).toBe("print");
  });
});

describe("a failure reaches the operator", () => {
  test("a document that cannot be loaded closes the dialog and says so", async () => {
    fetchPrintBundle.mockRejectedValue(new Error("Delivery order not found."));
    mount();
    await userEvent.click(screen.getByText("trigger"));
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify.mock.calls[0]![0]).toMatchObject({ tone: "error", body: "Delivery order not found." });
    // No dialog left open over nothing.
    expect(screen.queryByText("Print preview")).toBeNull();
  });

  test("a generator that throws is reported rather than swallowed", async () => {
    renderPrintBundle.mockRejectedValue(new Error("jspdf blew up"));
    mount();
    await userEvent.click(screen.getByText("trigger"));
    await userEvent.click(await screen.findByText("Print now"));
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify.mock.calls[0]![0]).toMatchObject({ tone: "error", body: "jspdf blew up" });
  });
});

describe("the hook refuses to be used outside the provider", () => {
  test("it throws rather than silently doing nothing", () => {
    /* A context default of `() => {}` would make every right-click Print a dead
       entry on any page that forgot the provider, with no signal at all. */
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Harness />)).toThrow(/PrintChainProvider/);
    spy.mockRestore();
  });
});
