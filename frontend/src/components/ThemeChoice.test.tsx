import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ThemeChoice from "./ThemeChoice";
import { initTheme } from "../lib/theme";

describe("ThemeChoice", () => {
  beforeEach(() => {
    localStorage.clear();
    initTheme();
  });

  it("switches the page to dark and marks the choice", () => {
    render(<ThemeChoice />);
    expect(screen.getByRole("radio", { name: /Light/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: /Dark/ }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByRole("radio", { name: /Dark/ }).getAttribute("aria-checked")).toBe("true");
  });
});
