/* The copyright year on the customer portal and the sign-in screens is the
   MALAYSIAN year: from 00:00 on 1 Jan in Malaysia (16:00 UTC on 31 Dec) it
   reads the new year, on any device clock zone. Run with TZ=UTC. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../hooks/useBranding", () => ({ useBranding: () => ({ companyCode: "HOUZS", companyName: "Houzs Century" }) }));
vi.mock("../../components/AmbientSnow", () => ({ AmbientSnow: () => null }));
vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ user: null, login: vi.fn() }) }));

import { PortalFrame } from "./PortalFrame";
import { ForgotPasswordScreen } from "../../auth/AuthScreens";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-12-31T16:30:00Z")); // 00:30 on 1 Jan 2027 in Malaysia
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("copyright year is the Malaysian year", () => {
  it("customer portal footer", () => {
    const { container } = render(<MemoryRouter><PortalFrame><p>x</p></PortalFrame></MemoryRouter>);
    expect(container.textContent).toContain("2027 Houzs Century Sdn. Bhd.");
  });

  it("sign-in screens", () => {
    const { container } = render(<MemoryRouter><ForgotPasswordScreen /></MemoryRouter>);
    expect(container.textContent).toContain("2027 Houzs Century");
    expect(container.textContent).not.toContain("2026 Houzs Century");
  });
});
