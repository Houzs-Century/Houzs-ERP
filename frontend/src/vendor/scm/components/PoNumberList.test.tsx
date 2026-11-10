import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PoNumberList } from "./PoNumberList";

describe("PoNumberList", () => {
  it("shows every PO when the list is short", () => {
    const { container } = render(<PoNumberList poNumbers={["HC-PO-2610-125", "HC-PO-2610-202"]} shown={3} />);
    expect(container.textContent).toBe("HC-PO-2610-125, HC-PO-2610-202");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a long list shows the first few, '+N more' expands it, and the full list is the hover title", () => {
    const pos = ["A-1", "A-2", "A-3", "A-4", "A-5"];
    const { container } = render(<PoNumberList poNumbers={pos} shown={3} />);
    expect(container.textContent).toBe("A-1, A-2, A-3 +2 more");
    expect(container.querySelector("[title]")?.getAttribute("title")).toBe("A-1, A-2, A-3, A-4, A-5");
    fireEvent.click(screen.getByRole("button", { name: "+2 more" }));
    expect(container.textContent).toBe("A-1, A-2, A-3, A-4, A-5 show less");
  });

  it("no PO reads as a dash", () => {
    const { container } = render(<PoNumberList poNumbers={[]} shown={3} />);
    expect(container.textContent).toBe("—");
  });
});
