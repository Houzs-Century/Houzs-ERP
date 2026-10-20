import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ListPager } from "./ListPager";

describe("ListPager", () => {
  it("shows the honesty note beside the count when given one", () => {
    render(<ListPager page={0} pageSize={50} total={3465} onPageChange={() => {}} note="Filter on Status narrows this page only" />);
    expect(screen.getByRole("note").textContent).toBe("Filter on Status narrows this page only");
  });

  it("renders no note by default", () => {
    render(<ListPager page={0} pageSize={50} total={120} onPageChange={() => {}} />);
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByText("120")).toBeTruthy();
  });
});
