import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DataTableConditionSection } from "./DataTableConditionSection";

/* The 236px-wide filter popover used to lay From and To side by side, which
   pushed the To field (and its calendar button) off the right edge where
   overflow-hidden clipped it — the end date could not be entered at all
   (owner 2026-11-05: "to 后面的日期选不到"). The fields now stack vertically.
   jsdom has no layout, so the clip itself is verified in-browser; this pins the
   behavioural half: a date range must be buildable from BOTH fields, so the To
   field stays present and wired. */
describe("DataTableConditionSection — date range", () => {
  it("emits a dateRange built from BOTH the From and the To field", () => {
    const onChange = vi.fn();
    render(<DataTableConditionSection filterType="date" current={null} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026/09/01" } });
    fireEvent.change(screen.getByLabelText("To date"), { target: { value: "2026/11/30" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply Range" }));

    expect(onChange).toHaveBeenCalledWith({ kind: "dateRange", from: "2026-09-01", to: "2026-11-30" });
  });

  it("still applies a one-sided range when only the To field is set", () => {
    const onChange = vi.fn();
    render(<DataTableConditionSection filterType="date" current={null} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("To date"), { target: { value: "2026/11/30" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply Range" }));

    expect(onChange).toHaveBeenCalledWith({ kind: "dateRange", from: null, to: "2026-11-30" });
  });
});
