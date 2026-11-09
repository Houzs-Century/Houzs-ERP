import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

// Both login screens tell a staging tester how to get in (production passwords
// are scrubbed from the staging copy), and neither says anything on production.

const { onStaging } = vi.hoisted(() => ({ onStaging: { current: false } }));

vi.mock("./stagingSignIn", async (importOriginal) => {
  const real = await importOriginal<typeof import("./stagingSignIn")>();
  return { ...real, currentHostIsStaging: () => onStaging.current };
});

vi.mock("./AuthContext", () => ({
  useAuth: () => ({ login: vi.fn(), verifyTotpLogin: vi.fn(), user: null }),
}));

vi.mock("../api/client", () => ({
  api: { get: vi.fn(() => Promise.resolve({})), post: vi.fn(() => Promise.resolve({})) },
}));

const { LoginScreen } = await import("./AuthScreens");
const { MobileLogin } = await import("../mobile/MobileLogin");
const { STAGING_TEST_ACCOUNT } = await import("./stagingSignIn");

const mount = (el: ReactElement) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{el}</MemoryRouter>
    </QueryClientProvider>,
  );

afterEach(() => {
  cleanup();
  onStaging.current = false;
});

describe.each([
  ["desktop", () => <LoginScreen />],
  ["mobile", () => <MobileLogin />],
])("%s login screen", (_name, screenEl) => {
  it("shows the staging sign-in note on staging", () => {
    onStaging.current = true;
    mount(screenEl());
    const note = screen.getByTestId("staging-sign-in-note");
    expect(note.textContent).toContain("Staging test site");
    expect(note.textContent).toContain(STAGING_TEST_ACCOUNT);
    expect(note.textContent).toContain("Production passwords do not work here");
  });

  it("shows nothing extra on production", () => {
    mount(screenEl());
    expect(screen.queryByTestId("staging-sign-in-note")).toBeNull();
  });
});
