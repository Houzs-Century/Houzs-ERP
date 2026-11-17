/* Postcode / City pickers on Edit Warehouse and the DP drawers drew their chevron
   on its own line under the input: it was a sibling the HOST had to position
   with a wrapper class, and those hosts passed none. It now sits inside the
   picker, positioned by the picker itself. */
import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { SearchableSelect, selectInputStyle } from "./SearchableSelect";

describe("SearchableSelect chevron", () => {
  test("sits absolutely inside the input's own relative wrapper, without any host class", () => {
    const { container } = render(<SearchableSelect chevron value="" onChange={() => {}} options={[{ value: "47000", label: "47000" }]} />);
    const input = container.querySelector("input")!;
    const svg = container.querySelector("svg")!;
    expect(svg.parentElement).toBe(input.parentElement);
    expect((input.parentElement as HTMLElement).style.position).toBe("relative");
    expect(svg.style.position).toBe("absolute");
    expect(svg.style.top).toBe("50%");
    expect(input.style.paddingRight).toBe("30px");
  });

  test("off by default: no chevron, no extra input style", () => {
    const { container } = render(<SearchableSelect value="" onChange={() => {}} options={[]} />);
    expect(container.querySelector("svg")).toBeNull();
    expect(selectInputStyle(false, false)).toBeUndefined();
  });
});
