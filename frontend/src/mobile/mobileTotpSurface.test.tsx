/* A PHONE-ONLY MEMBER MUST BE ABLE TO TURN 2FA OFF AGAIN.
 *
 * `MobileLogin` already answers the TOTP challenge, so a member with 2FA on can
 * SIGN IN from a phone. Everything else about 2FA lived on the desktop Profile
 * page only (`pages/Profile.tsx`, TwoFactorSection) — status, enrol, backup-code
 * count, and DISABLE. The last one is the lockout: lose the authenticator with
 * no PC to hand and there is no way back into the account, from any screen the
 * phone can reach.
 *
 * These are the assertions for the phone surface. They drive the SAME endpoints
 * the desktop drives (/api/totp/status | setup | enable | disable) through the
 * shared `useTotpEnrollment` hook, because a second implementation of an auth
 * flow is how the two drift.
 *
 * Three things are security-load-bearing and each has its own `it`:
 *   1. DISABLE IS GATED. The desktop demands a current 6-digit code (or a backup
 *      code) and posts it to /api/totp/disable. The phone must demand the same
 *      thing — a Disable button that posts without a code would be a downgrade
 *      shipped in the name of parity.
 *   2. BACKUP CODES SURVIVE A RE-RENDER. They are shown exactly once. A parent
 *      re-render (a settling query, an orientation change) must not take them
 *      away — only the operator's own acknowledgement may.
 *   3. NOTHING PERSISTS. No secret and no backup code may reach localStorage,
 *      sessionStorage, or the console. They live in component state and die there.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiPost, apiPatch, authUser } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  authUser: { current: null as unknown },
}));

vi.mock("../api/client", () => ({
  api: {
    get: apiGet,
    post: apiPost,
    patch: apiPatch,
    del: vi.fn(),
    putBinary: vi.fn(),
    fetchBlobUrl: vi.fn(() => Promise.reject(new Error("no blob in test"))),
  },
}));

vi.mock("../hooks/useToast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

vi.mock("../vendor/scm/components/ConfirmDialog", () => ({
  useConfirm: () => async () => true,
}));

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    user: authUser.current,
    reload: vi.fn(),
    logout: vi.fn(),
    can: () => true,
    pageAccess: {},
  }),
}));

vi.mock("./useAnnouncementUnread", () => ({ useAnnouncementUnread: () => 0 }));

vi.mock("../lib/nativeSession", () => ({
  biometricSessionEnabled: () => false,
  setBiometricSessionEnabled: vi.fn(),
  nativeBiometricSupported: () => Promise.resolve(false),
  rememberNativeSession: vi.fn(),
  forgetNativeSession: vi.fn(),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MobileProfile } from "./MobileProfile";

afterEach(cleanup);

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiPatch.mockReset();
  authUser.current = {
    id: 7,
    name: "Wei Siang",
    email: "wei@example.com",
    role_name: "Sales",
    status: "active",
  };
});

/** The four TOTP endpoints, reduced to what the phone must be able to drive. */
function fakeTotpServer(initial: { enabled: boolean; remaining: number }) {
  const state = {
    enabled: initial.enabled,
    remaining: initial.remaining,
    disableCalls: [] as Array<{ code?: string }>,
    enableCalls: 0,
  };

  apiGet.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/totp/status")) {
      return { enabled: state.enabled, backup_codes_remaining: state.remaining };
    }
    if (path.startsWith("/api/users")) return { users: [] };
    if (path.startsWith("/api/scm/mfg-sales-orders/my-mtd")) return { mtd_orders: 0, mtd_sales_sen: 0 };
    if (path.startsWith("/api/assr/my-cases")) return { cases: [] };
    return {};
  });

  apiPost.mockImplementation(async (path: string, body?: unknown) => {
    if (path.startsWith("/api/totp/setup")) {
      return {
        secret: "JBSWY3DPEHPK3PXP",
        otpauth_uri: "otpauth://totp/Houzs:wei@example.com?secret=JBSWY3DPEHPK3PXP",
      };
    }
    if (path.startsWith("/api/totp/enable")) {
      state.enableCalls += 1;
      state.enabled = true;
      state.remaining = 8;
      return { backup_codes: ["AAAA-1111", "BBBB-2222", "CCCC-3333"] };
    }
    if (path.startsWith("/api/totp/disable")) {
      state.disableCalls.push((body ?? {}) as { code?: string });
      state.enabled = false;
      state.remaining = 0;
      return {};
    }
    return {};
  });

  return state;
}

const wrap = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MobileProfile onLogout={() => {}} />
    </QueryClientProvider>,
  );
};

/** Home → the account-security sub-screen that carries the 2FA card. */
async function openSecurity(user: ReturnType<typeof userEvent.setup>) {
  const row = await screen.findByText(/^(Password|Password & security|Security)$/i);
  await user.click(row);
}

describe("MobileProfile — the phone can manage two-factor authentication", () => {
  it("shows 2FA status and how many backup codes are left", async () => {
    fakeTotpServer({ enabled: true, remaining: 5 });
    const user = userEvent.setup();
    wrap();
    await openSecurity(user);

    expect(await screen.findByText("Two-Factor Authentication")).toBeTruthy();
    // The count is the thing a member checks before a trip.
    expect(await screen.findByText(/5 backup codes? left/i)).toBeTruthy();
  });

  it("DISABLE demands a current code and posts it — the desktop gate, not a weaker one", async () => {
    const server = fakeTotpServer({ enabled: true, remaining: 5 });
    const user = userEvent.setup();
    wrap();
    await openSecurity(user);

    await user.click(await screen.findByRole("button", { name: /turn off|disable/i }));

    /* THE GATE. Revealing the field must not itself post — the code has to be
       supplied and travel to the server, exactly as the desktop's prompt does. */
    expect(server.disableCalls.length).toBe(0);

    const field = await screen.findByLabelText(/code/i);
    await user.type(field, "123456");
    await user.click(await screen.findByRole("button", { name: /^(turn off 2fa|confirm|disable)$/i }));

    await waitFor(() => expect(server.disableCalls.length).toBe(1));
    expect(server.disableCalls[0]?.code).toBe("123456");
  });

  it("enrols, then holds the backup codes through a re-render until acknowledged", async () => {
    const server = fakeTotpServer({ enabled: false, remaining: 0 });
    const user = userEvent.setup();
    wrap();
    await openSecurity(user);

    await user.click(await screen.findByRole("button", { name: /enable 2fa/i }));
    // The setup key has to be readable — it is how the authenticator is seeded.
    expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeTruthy();

    await user.type(await screen.findByLabelText(/6-digit code/i), "654321");
    await user.click(await screen.findByRole("button", { name: /^enable$/i }));

    await waitFor(() => expect(server.enableCalls).toBe(1));
    expect(await screen.findByText("AAAA-1111")).toBeTruthy();

    /* SHOWN ONCE MEANS SHOWN UNTIL SAVED. Anything that re-renders the tree —
       a settling query, an orientation change — must leave them on screen. */
    window.dispatchEvent(new Event("resize"));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText("AAAA-1111")).toBeTruthy();

    await user.click(await screen.findByRole("button", { name: /saved them/i }));
    await waitFor(() => expect(screen.queryByText("AAAA-1111")).toBeNull());
  });

  it("never writes a secret or a backup code to storage", async () => {
    fakeTotpServer({ enabled: false, remaining: 0 });
    const user = userEvent.setup();
    wrap();
    await openSecurity(user);

    await user.click(await screen.findByRole("button", { name: /enable 2fa/i }));
    await screen.findByText("JBSWY3DPEHPK3PXP");
    await user.type(await screen.findByLabelText(/6-digit code/i), "654321");
    await user.click(await screen.findByRole("button", { name: /^enable$/i }));
    await screen.findByText("AAAA-1111");

    const dump = [
      JSON.stringify(window.localStorage),
      JSON.stringify(window.sessionStorage),
      document.cookie,
    ].join("|");
    expect(dump).not.toContain("JBSWY3DPEHPK3PXP");
    expect(dump).not.toContain("AAAA-1111");
  });
});
