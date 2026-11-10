import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pinLogin = vi.fn();
vi.mock("./AuthContext", () => ({ useAuth: () => ({ pinLogin: (...a: unknown[]) => pinLogin(...a) }) }));

import { CrewPinForm, crewCodeInput } from "./CrewPinForm";

beforeEach(() => {
  pinLogin.mockReset();
});
afterEach(cleanup);

describe("crewCodeInput — EMP- is fixed, so it can never be typed twice", () => {
  it.each([
    ["0042", "0042"],
    ["EMP-0042", "0042"],
    ["emp-0042", "0042"],
    ["emp0042", "0042"],
    [" 00 42 ", "0042"],
    ["0042-1", "0042-1"],
    ["abc", ""],
  ])("%s -> %s", (raw, kept) => expect(crewCodeInput(raw)).toBe(kept));
});

function fill(code: string, pin: string) {
  fireEvent.change(screen.getByLabelText("Staff code"), { target: { value: code } });
  fireEvent.change(screen.getByLabelText("PIN"), { target: { value: pin } });
}

describe("CrewPinForm", () => {
  it("sends EMP- plus the digits and the PIN", async () => {
    pinLogin.mockResolvedValue({ kind: "ok" });
    render(<CrewPinForm onTotp={vi.fn()} onBack={vi.fn()} />);
    fill("EMP-0042", "4829 13");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(pinLogin).toHaveBeenCalledWith("EMP-0042", "482913"));
  });

  it("stays disabled until the PIN has 6 digits", () => {
    render(<CrewPinForm onTotp={vi.fn()} onBack={vi.fn()} />);
    fill("42", "4829");
    expect((screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the server's sentence and clears the PIN on a refusal", async () => {
    pinLogin.mockRejectedValue(new Error("Too many wrong PINs. Wait 15 minutes, or ask the office to set a new PIN."));
    render(<CrewPinForm onTotp={vi.fn()} onBack={vi.fn()} />);
    fill("42", "111222");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Too many wrong PINs/);
    expect((screen.getByLabelText("PIN") as HTMLInputElement).value).toBe("");
  });

  it("hands a 2FA challenge to the host screen", async () => {
    pinLogin.mockResolvedValue({ kind: "totp", challenge: "ch-1" });
    const onTotp = vi.fn();
    render(<CrewPinForm onTotp={onTotp} onBack={vi.fn()} />);
    fill("42", "482913");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(onTotp).toHaveBeenCalledWith("ch-1"));
  });
});
