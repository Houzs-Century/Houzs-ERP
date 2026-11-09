/* Regression: detail pages showed "X not found" when the request merely failed
   (timeout, 500, offline), so operators re-keyed documents that existed. Only a
   real 404 or an empty answer says "not found"; anything else says it could not
   load, shows the reason and offers Retry. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyLoadFailure, isNotFoundError } from "../../lib/loadFailure";
import { DetailLoadFailure } from "./DetailLoadFailure";

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

afterEach(cleanup);

describe("classifyLoadFailure", () => {
  it("a 404 is not found", () => {
    expect(isNotFoundError(httpError(404, "gone"))).toBe(true);
    expect(classifyLoadFailure(httpError(404, "gone"))).toEqual({ kind: "not-found", reason: "gone" });
  });

  it("a successful answer with no record is not found", () => {
    expect(classifyLoadFailure(null)).toEqual({ kind: "not-found", reason: null });
  });

  it("a 500, a 503, a 403 or a network failure is a load failure, never not found", () => {
    for (const e of [httpError(500, "Server error"), httpError(503, "Busy"), httpError(403, "No access"), new TypeError("Failed to fetch")]) {
      expect(classifyLoadFailure(e).kind).toBe("load-failed");
    }
    expect(classifyLoadFailure(new Error(""))).toEqual({ kind: "load-failed", reason: "The request did not finish." });
  });
});

describe("DetailLoadFailure", () => {
  it("says not found on a 404 and offers no Retry", () => {
    render(<DetailLoadFailure noun="Purchase order" error={httpError(404, "")} onRetry={vi.fn()} retrying={false} />);
    expect(screen.getByText("Purchase order not found.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("on a timeout says it could not load, shows the reason, and Retry refetches", () => {
    const onRetry = vi.fn();
    render(<DetailLoadFailure noun="Purchase order" error={httpError(504, "The server took too long to answer.")} onRetry={onRetry} retrying={false} />);
    expect(screen.queryByText(/not found/i)).toBeNull();
    expect(screen.getByText("Could not load this purchase order.")).toBeTruthy();
    expect(screen.getByText("The server took too long to answer.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("disables Retry while the refetch runs", () => {
    render(<DetailLoadFailure noun="Consignment note" error={new TypeError("Failed to fetch")} onRetry={vi.fn()} retrying />);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });
});
