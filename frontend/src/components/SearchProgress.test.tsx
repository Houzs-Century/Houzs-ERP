import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SearchProgress } from "./SearchProgress";

describe("SearchProgress", () => {
  it("announces an active search and stays absent when idle", () => {
    const { rerender } = render(<SearchProgress active label="Searching for A1…" />);
    expect(screen.getByRole("status").textContent).toContain("Searching for A1…");

    rerender(<SearchProgress active={false} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
