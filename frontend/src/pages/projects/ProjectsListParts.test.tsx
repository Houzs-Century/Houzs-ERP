/* The project list's filter controls: the multi-select popover, the date-range
 * chip and the per-project task badges under the Status (section) filter. */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DateRangeFilter, MultiSelectFilter, SectionTaskBadges } from "./ProjectsListParts";

const BRANDS = [{ name: null, options: [{ value: "houzs", label: "HOUZS", count: 4 }, { value: "akemi", label: "AKEMI" }] }];

describe("MultiSelectFilter", () => {
  it("shows the placeholder, ticks into the selection, and unticks all", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <MultiSelectFilter placeholder="All brands" groups={BRANDS} selected={[]} onChange={onChange} summary={(n) => `${n} brands`} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "All brands" }));
    expect((screen.getByRole("button", { name: "Untick all" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "AKEMI" }));
    expect(onChange).toHaveBeenLastCalledWith(["akemi"]);

    rerender(
      <MultiSelectFilter placeholder="All brands" groups={BRANDS} selected={["akemi"]} onChange={onChange} summary={(n) => `${n} brands`} />,
    );
    expect(screen.getByTitle("All brands").textContent).toBe("AKEMI");

    rerender(
      <MultiSelectFilter placeholder="All brands" groups={BRANDS} selected={["akemi", "houzs"]} onChange={onChange} summary={(n) => `${n} brands`} />,
    );
    expect(screen.getByTitle("All brands").textContent).toBe("2 brands");
    fireEvent.click(screen.getByRole("button", { name: "Untick all (2)" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});

describe("DateRangeFilter", () => {
  it("reads All dates until a window is set, and Clear empties both ends", () => {
    const onChange = vi.fn();
    const { rerender } = render(<DateRangeFilter from="" to="" onChange={onChange} />);
    expect(screen.getByRole("button", { name: "All dates" })).toBeTruthy();

    rerender(<DateRangeFilter from="2026-08-01" to="2026-08-31" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "01/08/2026 – 31/08/2026" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenCalledWith("", "");
  });
});

describe("SectionTaskBadges", () => {
  it("renders nothing without a section map", () => {
    const { container } = render(<SectionTaskBadges map={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("orders overdue, then pending, then done, and marks days late", () => {
    const { container } = render(
      <SectionTaskBadges map="Setup Image=done=2000-01-01|Driver Info=pending=|Floorplan=pending=2000-01-01" />,
    );
    const titles = [...container.querySelectorAll("span[title]")].map((el) => el.getAttribute("title"));
    expect(titles).toEqual(["Floorplan", "Driver Info", "Setup Image"]);
    expect(screen.getByTitle("Floorplan").textContent).toMatch(/^Floorplan\d+d$/);
  });
});
