/* Creating a CONFIRMED order from the catalogue with a SOFFIO (8030-) line asks
 * the operator to check the code first: a fully extend sofa is SOFFIO 2.0
 * (5562-). "Go back" sends nothing; "Yes, it is SOFFIO" creates; no 8030 line,
 * no ask. Drives the real page; faked: the catalogue, the create call, the
 * validate dry-run and the dialogs.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const { ask, createSpy, products } = vi.hoisted(() => ({
  ask: vi.fn(),
  createSpy: vi.fn(async () => ({ docNo: "HC-SO-NEW-1" })),
  products: { current: [] as unknown[] },
}));

vi.mock("../../vendor/scm/lib/authed-fetch", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/lib/authed-fetch")>()),
  authedFetch: vi.fn((path: string) => {
    if (path === "/mfg-sales-orders/validate") return Promise.resolve({ problems: [] });
    return new Promise(() => undefined);
  }),
}));
vi.mock("../../vendor/scm/lib/mfg-products-queries", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/lib/mfg-products-queries")>()),
  useMfgProducts: () => ({ data: products.current, isLoading: false, isFetching: false, isError: false }),
}));
vi.mock("../../vendor/scm/lib/sales-order-queries", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/lib/sales-order-queries")>()),
  useCreateMfgSalesOrder: () => ({ mutateAsync: createSpy, isPending: false }),
  useDebtorSearch: () => ({ data: [] }),
}));
vi.mock("../../vendor/scm/lib/use-so-validate", () => ({ useSoValidate: () => ({ problems: [] }) }));
vi.mock("../../hooks/useBranding", () => ({ useBranding: () => ({ companyCode: "HC" }) }));
vi.mock("../../hooks/useLeaveGuard", () => ({
  useLeaveGuard: () => ({ allowLeave: () => undefined }),
  useFormTouched: () => ({ touched: false, markTouched: () => undefined, resetTouched: () => undefined }),
}));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => vi.fn() }));
vi.mock("../../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => ask }));

import { SalesOrderNewFromProducts } from "./SalesOrderNewFromProducts";

afterEach(() => { cleanup(); ask.mockReset(); createSpy.mockClear(); });

const product = (code: string, name: string, category: string) => ({
  id: code, code, name, category, base_price_sen: 100_000, price1_sen: null, sell_price_sen: 100_000,
  status: "ACTIVE", unit_m3_milli: 0,
});

const fillAndSubmit = async (code: string, name: string, category: string) => {
  products.current = [product(code, name, category)];
  const { container } = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/scm/sales-orders/new/from-products?cat=SOFA"]}>
        <SalesOrderNewFromProducts />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "+ Add" }));
  fireEvent.change(screen.getByPlaceholderText("Customer name *"), { target: { value: "Ada" } });
  fireEvent.change(container.querySelector('input[type="tel"]')!, { target: { value: "123456789" } });
  fireEvent.click(screen.getAllByRole("button", { name: /Create (Sales Order|SO)/ })[0]);
};

describe("desktop New SO from products: SOFFIO code reminder", () => {
  it("asks before creating an order with an 8030 line; Go back sends nothing", async () => {
    ask.mockResolvedValue(false);
    await fillAndSubmit("8030-1A(LHF)", "SOFFIO 1A LHF", "SOFA");
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(ask.mock.calls[0][0]).toMatchObject({ title: "Check the SOFFIO code", confirmLabel: "Yes, it is SOFFIO", cancelLabel: "Go back" });
    expect(String(ask.mock.calls[0][0].body)).toContain("8030-1A(LHF)");
    await new Promise((r) => setTimeout(r, 0));
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("creates the order once the operator says it is SOFFIO", async () => {
    ask.mockResolvedValue(true);
    await fillAndSubmit("8030-1A(LHF)", "SOFFIO 1A LHF", "SOFA");
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("does not ask when the order has no 8030 line", async () => {
    await fillAndSubmit("5562-1B(LHF)", "SOFFIO 2.0 1B LHF", "SOFA");
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    expect(ask).not.toHaveBeenCalled();
  });
});
