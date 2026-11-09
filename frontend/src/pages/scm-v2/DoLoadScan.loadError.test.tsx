/* Regression: the warehouse DO scan said "Delivery order not found ... re-print
   the DO" on ANY load error, so a weak dock signal sent staff to re-print a good
   DO. Now only a 404 says that; a timeout or 500 says it could not load and
   offers Retry. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const { detail, updateStatus } = vi.hoisted(() => ({ detail: vi.fn(), updateStatus: vi.fn() }));

vi.mock("../../vendor/scm/lib/delivery-order-queries", () => ({
  useMfgDeliveryOrderDetail: detail,
  useUpdateMfgDeliveryOrderStatus: updateStatus,
}));

import { DoLoadScan } from "./DoLoadScan";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const failWith = (error: Error) => {
  const refetch = vi.fn();
  detail.mockReturnValue({ data: undefined, isLoading: false, isError: true, isFetching: false, error, refetch });
  updateStatus.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false, error: null });
  render(
    <MemoryRouter initialEntries={["/scm/do-load?id=do-1"]}>
      <DoLoadScan />
    </MemoryRouter>,
  );
  return refetch;
};

describe("DO scan load failure", () => {
  it("a timeout does not say not found and does not tell staff to re-print", () => {
    const refetch = failWith(Object.assign(new Error("The server took too long to answer."), { status: 504 }));
    expect(screen.queryByText("Delivery order not found")).toBeNull();
    expect(screen.getByText("Could not load the delivery order")).toBeTruthy();
    expect(screen.getByText(/took too long/).textContent).toMatch(/do not re-print/);
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("a network failure with no status is also a load failure", () => {
    failWith(new TypeError("Failed to fetch"));
    expect(screen.getByText("Could not load the delivery order")).toBeTruthy();
  });

  it("a real 404 still says not found, with no Retry", () => {
    failWith(Object.assign(new Error("gone"), { status: 404 }));
    expect(screen.getByText("Delivery order not found")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });
});
