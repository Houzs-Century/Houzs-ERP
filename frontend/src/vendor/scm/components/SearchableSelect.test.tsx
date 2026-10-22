import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { SearchableSelect, enterPick, nextOptionWindow } from "./SearchableSelect";

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

// Sim, 2026-10-20 (HC-GRN-2610-155): racks typed and Enter'd on the GRN edit
// page showed the text but were never picked, so Save stored 1 rack of 11.
describe("Enter picks the typed option", () => {
  const racks = ["Rack L1.9", "Rack L19.1", "Rack L19.2", "Rack R7.2", "Rack R17.2"].map((label, i) => ({ value: `r${i}`, label }));

  test("a term naming one option exactly, or matching only one, is picked", () => {
    expect(enterPick("L19.2", racks)?.label).toBe("Rack L19.2");
    expect(enterPick("r7.2", racks)?.label).toBe("Rack R7.2");
    expect(enterPick("17.2", racks.filter((r) => r.label.includes("17.2")))?.label).toBe("Rack R17.2");
  });

  test("several matches with none exact pick nothing", () => {
    expect(enterPick("L19", racks.filter((r) => r.label.toLowerCase().includes("l19")))).toBeNull();
    expect(enterPick("", racks)).toBeNull();
  });

  test("typing then Enter commits the value, like a click", () => {
    const onChange = vi.fn();
    render(<SearchableSelect value="" onChange={onChange} options={racks} ariaLabel="Rack" />);
    const box = screen.getByRole("textbox");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "L19.2" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("r2");
  });

  test("Enter on an unclear term leaves the list open and changes nothing", () => {
    const onChange = vi.fn();
    render(<SearchableSelect value="" onChange={onChange} options={racks} ariaLabel="Rack" />);
    const box = screen.getByRole("textbox");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "L19" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    expect(menu()).toBeTruthy();
  });
});

describe("SearchableSelect clearing", () => {
  const cities = [
    { value: "Kangar", label: "Kangar" },
    { value: "Arau", label: "Arau" },
  ];
  function renderCity() {
    const picked: string[] = [];
    render(<SearchableSelect value="Kangar" onChange={(v) => picked.push(v)} options={cities} />);
    return picked;
  }

  test("deleting the text and leaving the field clears the value", () => {
    const picked = renderCity();
    openMenu();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    fireEvent.blur(screen.getByRole("textbox"));
    expect(picked).toEqual([""]);
  });

  test("tapping in and out without editing keeps the value", () => {
    const picked = renderCity();
    openMenu();
    fireEvent.blur(screen.getByRole("textbox"));
    expect(picked).toEqual([]);
  });

  test("leaving after a pick keeps the pick", () => {
    const picked = renderCity();
    openMenu();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    fireEvent.mouseDown(screen.getByText("Arau"));
    fireEvent.blur(screen.getByRole("textbox"));
    expect(picked).toEqual(["Arau"]);
  });
});

/* Grouped options (Fair Links, owner 2026-10-21: every fair, the order's own
   place first): a small heading over each run, kept only where a match is. */
describe("SearchableSelect groups", () => {
  const fairs = [
    { value: "340", label: "AKEMI — MID VALLEY — REX (09/11 - 09/13)", group: "At this place" },
    { value: "300", label: "AKEMI — MID VALLEY — BIGHOME (08/28 - 08/31)", group: "At this place — other dates" },
    { value: "2235", label: "AKEMI — SETIA SPICE CONVENTION CENTRE — HOMEDEC (10/02 - 10/04)", group: "Other places" },
  ];
  const headings = () => Array.from(menu().querySelectorAll('li[role="presentation"]')).map((li) => li.textContent);
  const options = () => Array.from(menu().querySelectorAll('li[role="option"]')).map((li) => li.textContent);

  test("each run of a group carries its heading, in the order given", () => {
    render(<SearchableSelect value="" onChange={() => {}} options={fairs} />);
    openMenu();
    expect(headings()).toEqual(["At this place", "At this place — other dates", "Other places"]);
    expect(options()).toHaveLength(3);
  });

  test("a search keeps only the headings that still have a match, and a heading is not a pick", () => {
    const picked: string[] = [];
    render(<SearchableSelect value="" onChange={(v) => picked.push(v)} options={fairs} />);
    openMenu();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "setia" } });
    expect(headings()).toEqual(["Other places"]);
    fireEvent.mouseDown(screen.getByText("Other places"));
    expect(picked).toEqual([]);
    fireEvent.mouseDown(screen.getByText("AKEMI — SETIA SPICE CONVENTION CENTRE — HOMEDEC (10/02 - 10/04)"));
    expect(picked).toEqual(["2235"]);
  });
});
