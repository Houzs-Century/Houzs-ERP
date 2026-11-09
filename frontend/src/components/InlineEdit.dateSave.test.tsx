import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { InlineEdit } from "./InlineEdit";

afterEach(cleanup);

function typeDate(text: string): void {
  const input = screen.getByRole("textbox");
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: text } });
}

describe("InlineEdit date field Save button", () => {
  test("does not appear while a date is typed or after it saves", async () => {
    const onSave = vi.fn(async () => {});
    render(<InlineEdit label="Scheduled Pickup" type="date" value={null} onSave={onSave} />);
    typeDate("2026/11/11");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    fireEvent.blur(screen.getByRole("textbox"));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("2026-11-11"));
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  test("appears after a failed save so the date can be retried", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("Network down");
    });
    render(<InlineEdit label="Scheduled Pickup" type="date" value={null} onSave={onSave} />);
    typeDate("2026/11/11");
    fireEvent.blur(screen.getByRole("textbox"));
    expect(await screen.findByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.getByText("Network down")).toBeTruthy();
  });
});
