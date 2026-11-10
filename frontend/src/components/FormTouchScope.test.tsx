import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { FormTouchScope } from "./FormTouchScope";
import { useFormTouched } from "../hooks/useLeaveGuard";

function Form({ onTouch }: { onTouch?: () => void }) {
  const { touched, markTouched } = useFormTouched();
  const [supplier, setSupplier] = useState("");
  return (
    <FormTouchScope
      onTouch={() => {
        markTouched();
        onTouch?.();
      }}
    >
      <p>{touched ? "touched" : "clean"}</p>
      <label>
        Supplier
        <select value={supplier} onChange={(e) => setSupplier(e.target.value)}>
          <option value="">Pick one</option>
          <option value="sup-1">Ohana</option>
        </select>
      </label>
      <input aria-label="Notes" />
      <ul role="listbox">
        <li role="option" aria-selected={false}>Rack L19</li>
      </ul>
      <button type="button">Plain button</button>
    </FormTouchScope>
  );
}

describe("FormTouchScope", () => {
  it("starts clean, and a plain click is not touching the form", () => {
    render(<Form />);
    fireEvent.click(screen.getByRole("button", { name: "Plain button" }));
    expect(screen.getByText("clean")).toBeTruthy();
  });

  it("typing counts", async () => {
    render(<Form />);
    await userEvent.type(screen.getByLabelText("Notes"), "x");
    expect(screen.getByText("touched")).toBeTruthy();
  });

  it("picking from a list counts", () => {
    render(<Form />);
    fireEvent.mouseDown(screen.getByRole("option", { name: "Rack L19" }));
    expect(screen.getByText("touched")).toBeTruthy();
  });

  it("a select keeps the pick — marking must not re-render between its input and change events", async () => {
    const onTouch = vi.fn();
    render(<Form onTouch={onTouch} />);
    await userEvent.selectOptions(screen.getByLabelText("Supplier"), "sup-1");
    expect((screen.getByLabelText("Supplier") as HTMLSelectElement).value).toBe("sup-1");
    expect(screen.getByText("touched")).toBeTruthy();
  });
});
