/* RECORDING A FAILED LOGIN MUST NEVER CHANGE THE LOGIN.
 *
 * Every failed branch of /login now saves a row (services/failedLogins.ts).
 * The save runs after the response, and here it is made to throw in the
 * harshest way (getDb throws synchronously, as it does with no database URL):
 * each failed login must still answer with exactly the status and body it
 * answered with before, both with and without an execution context.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "hono";

const { getDb } = vi.hoisted(() => ({
  getDb: vi.fn(() => {
    throw new Error("boom: no database");
  }),
}));
vi.mock("../db/client", () => ({ getDb }));

const auth = (await import("./auth")).default;
const { hashPassword } = await import("../services/auth");

type UserRow = { id: number; password_hash: string | null; status: string; totp_enabled: number };

function fakeEnv(user: UserRow | null, rateCount: string | null) {
  const stmt = { bind: () => stmt, first: async () => user, run: async () => ({}) };
  return {
    DB: { prepare: () => stmt },
    SESSION_CACHE: { get: async () => rateCount, put: async () => {}, delete: async () => {} },
  };
}

async function login(env: ReturnType<typeof fakeEnv>, waitUntil?: (p: Promise<unknown>) => void) {
  const ctx: ExecutionContext | undefined = waitUntil && { waitUntil, passThroughOnException: () => {}, props: {} };
  const res = await auth.request(
    "/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "1.2.3.4" },
      body: JSON.stringify({ email: " Someone@Test.Local ", password: "not-it" }),
    },
    env,
    ctx,
  );
  return { status: res.status, body: await res.json() };
}

const silence = () => vi.spyOn(console, "error").mockImplementation(() => {});

afterEach(() => {
  getDb.mockClear();
  vi.restoreAllMocks();
});

describe("failed login recording cannot change the response", () => {
  it("unknown email: 401 and the one shared message, no execution context", async () => {
    const err = silence();
    expect(await login(fakeEnv(null, null))).toEqual({
      status: 401,
      body: { error: "Email or password is incorrect." },
    });
    await vi.waitFor(() => expect(err).toHaveBeenCalled());
    expect(getDb).toHaveBeenCalledTimes(1);
  });

  it("wrong password: 401 unchanged, and the waitUntil promise settles without rejecting", async () => {
    const err = silence();
    const waited: Promise<unknown>[] = [];
    const user = { id: 7, password_hash: await hashPassword("the-real-one"), status: "active", totp_enabled: 0 };
    expect(await login(fakeEnv(user, null), (p) => waited.push(p))).toEqual({
      status: 401,
      body: { error: "Email or password is incorrect." },
    });
    expect(waited).toHaveLength(1);
    await expect(waited[0]).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith("[failed-logins] record failed", expect.any(Error));
  });

  it("rate limited: the limiter's 429 body passes through untouched", async () => {
    silence();
    expect(await login(fakeEnv(null, "10"))).toEqual({
      status: 429,
      body: { error: "Too many attempts. Please wait a few minutes and try again.", retryAfterSec: 900 },
    });
  });

  it("disabled account with the right password: 403 unchanged", async () => {
    silence();
    const user = { id: 8, password_hash: await hashPassword("not-it"), status: "disabled", totp_enabled: 0 };
    expect(await login(fakeEnv(user, null))).toEqual({
      status: 403,
      body: { error: "Account is disabled" },
    });
  });
});
