import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TripStatePicker } from "./TripStatePicker";

afterEach(cleanup);

describe("TripStatePicker", () => {
  it("lists only the free states and adds the ticked ones", () => {
    const onChange = vi.fn();
    render(<TripStatePicker states={["Johor"]} free={["Kedah", "Perlis", "Sabah"]} disabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Add states/ }));
    expect(screen.queryByLabelText("Johor")).toBeNull();
    fireEvent.click(screen.getByLabelText("Kedah"));
    fireEvent.click(screen.getByLabelText("Sabah"));
    fireEvent.click(screen.getByRole("button", { name: "Add 2" }));
    expect(onChange).toHaveBeenCalledWith(["Johor", "Kedah", "Sabah"]);
  });

  it("removes a state by its x; read-only shows no controls", () => {
    const onChange = vi.fn();
    const { rerender } = render(<TripStatePicker states={["Johor", "Pulau Pinang"]} free={[]} disabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Johor" }));
    expect(onChange).toHaveBeenCalledWith(["Pulau Pinang"]);
    rerender(<TripStatePicker states={["Johor"]} free={["Kedah"]} disabled={true} onChange={onChange} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
