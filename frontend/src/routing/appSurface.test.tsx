import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { appSurfaceForPath, useAppSurface } from "./appSurface";

afterEach(cleanup);

function SurfaceProbe() {
  const surface = useAppSurface();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="surface">{surface}</output>
      <button onClick={() => navigate("/", { replace: true })}>Go to login</button>
    </>
  );
}

describe("app surface routing", () => {
  it.each([
    ["/survey/token", "survey"],
    ["/track", "portal"],
    ["/portal/case/token", "portal"],
    ["/reset/token", "reset"],
    ["/invite/token", "invite"],
    ["/privacy", "privacy"],
    ["/", "staff"],
    ["/scm/sales-orders", "staff"],
  ] as const)("classifies %s as %s", (path, surface) => {
    expect(appSurfaceForPath(path)).toBe(surface);
  });

  it.each(["/reset/token", "/invite/token"])(
    "reacts to navigation out of the %s-only tree",
    (entry) => {
      render(
        <MemoryRouter
          initialEntries={[entry]}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <SurfaceProbe />
        </MemoryRouter>,
      );
      expect(screen.getByTestId("surface").textContent).not.toBe("staff");
      fireEvent.click(screen.getByRole("button", { name: "Go to login" }));
      expect(screen.getByTestId("surface").textContent).toBe("staff");
    },
  );
});
