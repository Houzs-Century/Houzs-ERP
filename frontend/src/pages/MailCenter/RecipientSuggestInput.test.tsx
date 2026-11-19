import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DIRECTORY_KEY } from "./RecipientPicker";
import { RECIPIENT_HISTORY_KEY, RecipientSuggestInput } from "./RecipientSuggestInput";

const history = {
  recipients: [{ email: "siti@customer.test", name: "Siti Aminah", timesUsed: 4, lastUsedAt: "2026-11-18" }],
};
const directory = { me: null, department: [], team: [], managers: [], everyone: [] };
let historyError: string | null = null;

vi.mock("../../api/client", () => ({ api: { get: vi.fn() } }));
vi.mock("../../hooks/useQuery", () => ({
  useQuery: (key: string) =>
    key === RECIPIENT_HISTORY_KEY
      ? { data: historyError ? null : history, loading: false, error: historyError, reload: vi.fn() }
      : key === DIRECTORY_KEY
        ? { data: directory, loading: false, error: null, reload: vi.fn() }
        : { data: null, loading: false, error: null, reload: vi.fn() },
}));

Element.prototype.scrollIntoView = vi.fn();

afterEach(() => {
  cleanup();
  historyError = null;
});

function Field() {
  const [value, setValue] = useState("");
  return (
    <RecipientSuggestInput
      value={value}
      onChange={setValue}
      placeholder="To"
      disabled={false}
      invalid={false}
      inputClassName=""
    />
  );
}

describe("RecipientSuggestInput", () => {
  it("suggestsAPastAddressAsYouTypeAndFillsItOnTap", () => {
    render(<Field />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "siti" } });
    fireEvent.mouseDown(screen.getByRole("option", { name: /Siti Aminah/ }));
    expect((input as HTMLInputElement).value).toBe("siti@customer.test, ");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("picksTheHighlightedSuggestionWithEnter", () => {
    render(<Field />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "ami" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect((input as HTMLInputElement).value).toBe("siti@customer.test, ");
  });

  it("saysSoWhenPastAddressesCouldNotLoad", () => {
    historyError = "Network error";
    render(<Field />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "siti" } });
    expect(screen.getByText(/Past addresses could not load/)).toBeTruthy();
  });
});
