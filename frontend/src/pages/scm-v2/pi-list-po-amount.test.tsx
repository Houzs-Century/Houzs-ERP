import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PoAmountCell } from "./pi-list-line-columns";

afterEach(cleanup);

const summary = { linesDiffering: 0, totalDiffSen: 0, comparableLines: 2, lines: 2, poAmountSen: 150_000 };

describe("PoAmountCell", () => {
  it("shows the amount at PO prices when every line had one", () => {
    render(<PoAmountCell summary={summary} />);
    expect(screen.getByText("RM 1,500.00")).toBeTruthy();
    expect(screen.queryByText(/lines$/)).toBeNull();
  });

  it("says how many lines it counted, so a part is not read as the whole", () => {
    render(<PoAmountCell summary={{ ...summary, comparableLines: 1, lines: 3 }} />);
    expect(screen.getByText("1 of 3 lines")).toBeTruthy();
  });

  it("says so when no line had a PO price, rather than showing RM 0.00", () => {
    render(<PoAmountCell summary={{ ...summary, comparableLines: 0, poAmountSen: 0 }} />);
    expect(screen.getByText("No PO price")).toBeTruthy();
    expect(screen.queryByText("RM 0.00")).toBeNull();
  });
});
