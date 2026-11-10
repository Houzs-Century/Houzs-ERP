import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* The required-change screen is the ONLY thing a flagged member's session can
   reach, so a broken form here is a lockout. These pin that it sends the
   current + new password, refuses the obvious mistakes before a round trip, and
   shows the server's refusal instead of swallowing it. */

const completePasswordChange = vi.fn();
const logout = vi.fn();
let authUser: Record<string, unknown> | null = { email: "finance@houzs.test", password_change_required: true };

vi.mock("./AuthContext", () => ({
  useAuth: () => ({
    user: authUser,
    loading: false,
    hasUsers: true,
    completePasswordChange: (...a: unknown[]) => completePasswordChange(...a),
    logout: (...a: unknown[]) => logout(...a),
  }),
}));
vi.mock("../hooks/useBranding", () => ({ useBranding: () => ({ companyName: "Houzs", companyCode: "HOUZS" }) }));
vi.mock("../components/AmbientSnow", () => ({ AmbientSnow: () => null }));
vi.mock("../components/CompanyMark", () => ({ CompanyMark: () => null }));
vi.mock("../mobile/useIsMobile", () => ({ useIsMobile: () => false }));

import { ForcedPasswordChangeScreen } from "./AuthScreens";
import { AuthGate } from "./AuthGate";

const NEW_PW = "Brand-New#Passw0rd-2026";

function fill(current: string, next: string, confirm: string) {
  const inputs = document.querySelectorAll("input");
  fireEvent.change(inputs[0], { target: { value: current } });
  fireEvent.change(inputs[1], { target: { value: next } });
  fireEvent.change(inputs[2], { target: { value: confirm } });
}

beforeEach(() => {
  completePasswordChange.mockReset();
  logout.mockReset();
  authUser = { email: "finance@houzs.test", password_change_required: true };
});
afterEach(cleanup);

describe("ForcedPasswordChangeScreen", () => {
  it("sends the current and the new password", async () => {
    completePasswordChange.mockResolvedValue(undefined);
    render(<MemoryRouter><ForcedPasswordChangeScreen /></MemoryRouter>);
    fill("Old-Passw0rd#2025", NEW_PW, NEW_PW);
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
    await waitFor(() => expect(completePasswordChange).toHaveBeenCalledWith("Old-Passw0rd#2025", NEW_PW));
  });

  it("refuses mismatched confirmation without calling the server", async () => {
    render(<MemoryRouter><ForcedPasswordChangeScreen /></MemoryRouter>);
    fill("Old-Passw0rd#2025", NEW_PW, `${NEW_PW}x`);
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
    expect(await screen.findByText("The two new passwords don't match.")).toBeTruthy();
    expect(completePasswordChange).not.toHaveBeenCalled();
  });

  it("refuses keeping the same password", async () => {
    render(<MemoryRouter><ForcedPasswordChangeScreen /></MemoryRouter>);
    fill(NEW_PW, NEW_PW, NEW_PW);
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
    expect(await screen.findByText("Choose a password different from your current one.")).toBeTruthy();
    expect(completePasswordChange).not.toHaveBeenCalled();
  });

  it("shows the server's refusal", async () => {
    completePasswordChange.mockRejectedValue(new Error("Current password is incorrect"));
    render(<MemoryRouter><ForcedPasswordChangeScreen /></MemoryRouter>);
    fill("Wrong-Passw0rd#2025", NEW_PW, NEW_PW);
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
    expect(await screen.findByText("Current password is incorrect")).toBeTruthy();
  });

  it("offers a way out: sign out", () => {
    render(<MemoryRouter><ForcedPasswordChangeScreen /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(logout).toHaveBeenCalled();
  });
});

describe("AuthGate with a required password change", () => {
  it("shows the change screen instead of the app", async () => {
    render(<MemoryRouter><AuthGate><div>APP SHELL</div></AuthGate></MemoryRouter>);
    expect(await screen.findByRole("button", { name: "Save new password" })).toBeTruthy();
    expect(screen.queryByText("APP SHELL")).toBeNull();
  });

  it("an unflagged member goes straight into the app", async () => {
    authUser = { email: "staff@houzs.test" };
    render(<MemoryRouter><AuthGate><div>APP SHELL</div></AuthGate></MemoryRouter>);
    expect(await screen.findByText("APP SHELL")).toBeTruthy();
  });
});
