import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, test } from "vitest";
import { FreshMount } from "./freshMount";
import { useIdempotencyKey } from "./idempotency";

function Form({ onStartNew }: { onStartNew: () => void }) {
  const key = useIdempotencyKey();
  const [typed, setTyped] = useState("");
  return (
    <div>
      <span data-testid="key">{key}</span>
      <input aria-label="typed" value={typed} onChange={(e) => setTyped(e.target.value)} />
      <button type="button" onClick={onStartNew}>new</button>
    </div>
  );
}

describe("FreshMount", () => {
  test("a re-render keeps the key; startNew mints a new one and clears the form", () => {
    render(<FreshMount>{(startNew) => <Form onStartNew={startNew} />}</FreshMount>);
    const first = screen.getByTestId("key").textContent;
    fireEvent.change(screen.getByLabelText("typed"), { target: { value: "abc" } });
    expect(screen.getByTestId("key").textContent).toBe(first);

    fireEvent.click(screen.getByText("new"));
    expect(screen.getByTestId("key").textContent).not.toBe(first);
    expect((screen.getByLabelText("typed") as HTMLInputElement).value).toBe("");
  });
});
