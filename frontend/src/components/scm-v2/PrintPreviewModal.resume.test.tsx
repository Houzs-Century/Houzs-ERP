/* ----------------------------------------------------------------------------
   The detail-page half of the stale-build print recovery.

   Incident 2026-09-14: HC-SO-012016's Print preview failed with "Failed to fetch
   dynamically imported module: …/assets3/sales-order-pdf-C9QaiR37.js" after a
   deploy deleted that file, and pressing Print again failed identically. The
   hooks every print button already uses must (1) mark the click as a print in
   flight, so chunkActionRecovery may reload for it, and (2) register the page as
   able to reopen its preview, and reopen it on the load after that reload.
   ---------------------------------------------------------------------------- */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { usePrintPreview, useOpenPrintPreviewFromUrl } from "./PrintPreviewModal";
import { installActionChunkRecovery } from "../../lib/chunkActionRecovery";

vi.mock("../../lib/errorReporter", () => ({ reportClientError: vi.fn() }));

const RESUME_KEY = "chunk-print-resume";
const PATH = "/scm/sales-orders/HC-SO-012016";

function staleChunkFailure() {
  const event = new Event("vite:preloadError", { cancelable: true });
  (event as Event & { payload?: unknown }).payload = new Error(
    `Failed to fetch dynamically imported module: ${window.location.origin}/assets3/sales-order-pdf-C9QaiR37.js`,
  );
  window.dispatchEvent(event);
}

function Detail({ deliver, consumesUrl = true }: { deliver: () => Promise<void>; consumesUrl?: boolean }) {
  const print = usePrintPreview(deliver);
  return (
    <>
      {consumesUrl && <UrlConsumer open={print.openPreview} />}
      <span>{print.open ? "preview-open" : "preview-closed"}</span>
      <button onClick={() => void print.handlers.onPrint()}>print</button>
    </>
  );
}
function UrlConsumer({ open }: { open: () => void }) {
  useOpenPrintPreviewFromUrl(open, true);
  return null;
}

const mount = (deliver: () => Promise<void>, consumesUrl = true) =>
  render(
    <MemoryRouter initialEntries={[PATH]}>
      <Detail deliver={deliver} consumesUrl={consumesUrl} />
    </MemoryRouter>,
  );

describe("detail-page print survives a stale-build reload", () => {
  const reload = vi.fn();
  let dispose = () => {};

  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState({}, "", PATH);
    reload.mockReset();
    dispose = installActionChunkRecovery({
      reload,
      probe: async () => "absent",
      now: () => Date.now(),
      get location() {
        return window.location;
      },
    });
  });
  afterEach(() => {
    dispose();
    window.history.replaceState({}, "", "/");
  });

  test("a stale chunk during Print reloads once and remembers to reopen the preview", async () => {
    mount(() => {
      staleChunkFailure();
      return Promise.reject(new Error("PDF generation failed")).catch(() => undefined);
    });
    await act(async () => {
      screen.getByText("print").click();
    });
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(JSON.parse(sessionStorage.getItem(RESUME_KEY) ?? "null")).toMatchObject({ kind: "preview", path: PATH });
  });

  test("the load after that reload opens the preview by itself, once", async () => {
    sessionStorage.setItem(RESUME_KEY, JSON.stringify({ kind: "preview", path: PATH, at: Date.now() }));
    mount(() => Promise.resolve());
    expect(await screen.findByText("preview-open")).toBeTruthy();
    expect(sessionStorage.getItem(RESUME_KEY)).toBeNull();
  });

  test("a page that cannot reopen its preview is left to the banner — no reload", async () => {
    mount(() => {
      staleChunkFailure();
      return Promise.resolve();
    }, false);
    await act(async () => {
      screen.getByText("print").click();
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(reload).not.toHaveBeenCalled();
  });
});
