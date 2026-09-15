/* Logistics pickers on the project detail page: the split date + time field,
 * the helper select with its contact card, and the Grab two-helper box. */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { GrabHelperBox, HelperSelect, LogisticsDateTimeField, type CrewMember } from "./logisticsParts";

const CREW: CrewMember[] = [
  { id: 11, name: "Ali", phone: "0123456789", user_type: "helper", role_name: null },
  { id: 12, name: "Muthu", phone: null, user_type: "helper", role_name: null },
];

describe("LogisticsDateTimeField", () => {
  it("shows the stored time and saves the edited date-time on blur", () => {
    const onSave = vi.fn();
    const { container } = render(<LogisticsDateTimeField label="Setup start" value="2026-08-25T23:00:00.000Z" onSave={onSave} />);
    const time = container.querySelector('input[type="time"]') as HTMLInputElement;
    expect(time.value).toBe("23:00");

    fireEvent.change(time, { target: { value: "09:30" } });
    fireEvent.blur(time);
    expect(onSave).toHaveBeenCalledWith("2026-08-25T09:30");
  });

  it("does not save when nothing changed, and is disabled read-only", () => {
    const onSave = vi.fn();
    const { container } = render(<LogisticsDateTimeField label="Setup start" value="2026-08-25T23:00" onSave={onSave} readOnly />);
    const time = container.querySelector('input[type="time"]') as HTMLInputElement;
    expect(time.disabled).toBe(true);
    fireEvent.blur(time);
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("HelperSelect", () => {
  it("reports the picked helper and shows the picked one's phone as a tel: link", () => {
    const onChange = vi.fn();
    const { rerender } = render(<HelperSelect label="Helper 1" value={null} helpers={CREW} onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "11" } });
    expect(onChange).toHaveBeenCalledWith(11);

    rerender(<HelperSelect label="Helper 1" value={11} helpers={CREW} onChange={onChange} />);
    expect(screen.getByRole("link").getAttribute("href")).toBe("tel:0123456789");

    rerender(<HelperSelect label="Helper 1" value={12} helpers={CREW} onChange={onChange} />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("GrabHelperBox", () => {
  it("adds the two picked helpers and ignores an empty add", () => {
    const onAdd = vi.fn();
    render(<GrabHelperBox helpers={CREW} onAdd={onAdd} />);
    const add = screen.getByRole("button", { name: "+ Add" });
    fireEvent.click(add);
    expect(onAdd).not.toHaveBeenCalled();

    // Each select is re-created on every render, so query it again after a change.
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "Ali" } });
    fireEvent.change(screen.getAllByRole("combobox")[1], { target: { value: "Muthu" } });
    fireEvent.click(add);
    expect(onAdd).toHaveBeenCalledWith({ helper1: "Ali", helper2: "Muthu" });
  });
});
