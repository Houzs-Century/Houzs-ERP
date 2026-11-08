/* A print preview belongs to the page it was opened on. The print-chain provider
   lives in the SCM shell, which stays mounted across a move to another SCM page,
   so its card stayed open over the next page (Conts-ERP #756). Leaving the page
   closes it; a change to the query string alone (URL is state) does not. */

import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useNavigate, type NavigateFunction } from "react-router-dom";
import { PrintPreviewModal } from "./PrintPreviewModal";

let go: NavigateFunction = () => undefined;
function Nav() {
  go = useNavigate();
  return null;
}

function renderOpen(onClose: () => void) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/scm/delivery-orders/HC-DO-1"]}>
        <Nav />
        <PrintPreviewModal open onClose={onClose} docTitle="Delivery Order" docNo="HC-DO-1" rows={[]} onPrint={() => undefined} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("print preview and the page it was opened on", () => {
  test("stays open while the page stays, closes when the page changes", () => {
    const onClose = vi.fn();
    renderOpen(onClose);
    expect(onClose).not.toHaveBeenCalled();
    act(() => { go("/scm/delivery-orders/HC-DO-1?tab=items"); });
    expect(onClose).not.toHaveBeenCalled();
    act(() => { go("/scm/sales-orders"); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("renders outside a router without failing", () => {
    expect(() =>
      render(
        <QueryClientProvider client={new QueryClient()}>
          <PrintPreviewModal open onClose={() => undefined} docTitle="Delivery Order" docNo="HC-DO-1" rows={[]} onPrint={() => undefined} />
        </QueryClientProvider>,
      ),
    ).not.toThrow();
  });
});
