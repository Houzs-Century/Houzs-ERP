import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SaveFailedBanner } from "./SaveFailedBanner";
import rawDetailEditor from "./SalesOrderDetail.tsx?raw";

const scrollIntoView = vi.fn();
beforeEach(() => {
  scrollIntoView.mockReset();
  Element.prototype.scrollIntoView = scrollIntoView;
});
afterEach(cleanup);

describe("SaveFailedBanner", () => {
  it("shows the failure and scrolls itself into view, centred clear of the sticky header", () => {
    render(<SaveFailedBanner message="Customer phone is required." />);
    expect(screen.getByRole("alert").textContent).toBe("Save failed.Customer phone is required.");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
  });

  it("scrolls again when a new failure replaces the old one, not on an unrelated re-render", () => {
    const { rerender } = render(<SaveFailedBanner message="First." />);
    rerender(<SaveFailedBanner message="First." className="x" />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    rerender(<SaveFailedBanner message="Second." className="x" />);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });
});

/* A source pin: the editor page is too large to mount for one banner, and the
   defect was the page rendering a plain div that never scrolled. */
describe("the Sales Order editor renders its Save failure through SaveFailedBanner", () => {
  it("uses the banner, and no longer renders the bare 'Save failed.' div", () => {
    expect(rawDetailEditor).toMatch(/<SaveFailedBanner message=\{saveError\}/);
    expect(rawDetailEditor).not.toContain("<strong>Save failed.</strong>");
  });
});
