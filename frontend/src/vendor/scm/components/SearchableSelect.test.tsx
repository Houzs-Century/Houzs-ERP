import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { SearchableSelect, nextOptionWindow } from "./SearchableSelect";

// Unmount is handled by the global afterEach(cleanup) in src/test-setup.ts.
// This file must NOT clear document.body by hand: the menu is portalled to
// body, and racing innerHTML="" against RTL's own node removal throws
// NotFoundError once auto-cleanup is registered.

// A product-catalogue-sized list — the case that made this windowing necessary.
const many = Array.from({ length: 360 }, (_, i) => ({
  value: `P${i}`,
  label: `Product ${i}`,
}));

function openMenu() {
  fireEvent.focus(screen.getByRole("textbox"));
}

/** The portalled <ul> is the only list in the document. */
function menu(): HTMLElement {
  return document.querySelector("ul") as HTMLElement;
}

function renderedOptions(): HTMLElement[] {
  // The footer <li> carries no value; option rows are the ones with text
  // matching an option label.
  return Array.from(menu().querySelectorAll("li")).filter((li) =>
    /^Product \d+$/.test(li.textContent ?? ""),
  ) as HTMLElement[];
}

describe("nextOptionWindow", () => {
  test("extends by one page and stops at the end", () => {
    expect(nextOptionWindow(60, 360)).toBe(120);
    expect(nextOptionWindow(340, 360)).toBe(360);
    expect(nextOptionWindow(360, 360)).toBe(360);
  });

  test("never returns more than the list holds", () => {
    expect(nextOptionWindow(60, 12)).toBe(12);
  });

  test("an empty list windows to nothing", () => {
    expect(nextOptionWindow(60, 0)).toBe(0);
  });

  test("survives nonsense input rather than producing a negative slice", () => {
    expect(nextOptionWindow(-5, 360)).toBe(60);
    expect(nextOptionWindow(60, 360, 0)).toBe(61);
  });
});

describe("SearchableSelect windowing", () => {
  test("opening a 360-option picker renders ONE page, not the whole list", () => {
    render(<SearchableSelect value="" onChange={() => {}} options={many} />);
    openMenu();
    // The regression this guards: all 360 <li> built into a 280px box.
    expect(renderedOptions()).toHaveLength(60);
  });

  test("says how many options are behind the scroll", () => {
    render(<SearchableSelect value="" onChange={() => {}} options={many} />);
    openMenu();
    expect(screen.getByText(/300 more/)).toBeTruthy();
  });

  test("scrolling to the bottom extends the window", () => {
    render(<SearchableSelect value="" onChange={() => {}} options={many} />);
    openMenu();
    const ul = menu();
    // jsdom reports 0 for layout; describe a list scrolled to its end.
    Object.defineProperty(ul, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(ul, "clientHeight", { value: 280, configurable: true });
    Object.defineProperty(ul, "scrollTop", { value: 1720, configurable: true });
    fireEvent.scroll(ul);
    expect(renderedOptions()).toHaveLength(120);
  });

  test("a short list renders whole, with no footer", () => {
    const few = many.slice(0, 12);
    render(<SearchableSelect value="" onChange={() => {}} options={few} />);
    openMenu();
    expect(renderedOptions()).toHaveLength(12);
    expect(screen.queryByText(/more —/)).toBeNull();
  });

  test("FILTERING still runs over the full list, not the rendered page", () => {
    // Product 359 is far past the first page. If filtering were applied to the
    // slice, this would find nothing — the bug that windowing must not cause.
    render(<SearchableSelect value="" onChange={() => {}} options={many} />);
    openMenu();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Product 359" } });
    expect(renderedOptions().map((li) => li.textContent)).toEqual(["Product 359"]);
  });

  test("a new search term rewinds the window instead of inheriting its depth", () => {
    render(<SearchableSelect value="" onChange={() => {}} options={many} />);
    openMenu();
    const ul = menu();
    Object.defineProperty(ul, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(ul, "clientHeight", { value: 280, configurable: true });
    Object.defineProperty(ul, "scrollTop", { value: 1720, configurable: true });
    fireEvent.scroll(ul);
    expect(renderedOptions()).toHaveLength(120);

    // "Product" matches all 360; without the rewind this would still show 120.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Product" } });
    expect(renderedOptions()).toHaveLength(60);
  });

  test("picking an option still reports its value", () => {
    const picked: string[] = [];
    render(<SearchableSelect value="" onChange={(v) => picked.push(v)} options={many} />);
    openMenu();
    fireEvent.mouseDown(renderedOptions()[3]);
    expect(picked).toEqual(["P3"]);
  });
});
