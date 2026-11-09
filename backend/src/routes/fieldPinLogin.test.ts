/* Crew PIN sign-in — the lock, the two speed bumps, and the door the session
 * is stamped with. The database is a small in-memory stand-in that dispatches
 * on the statement text; the SQL itself is executed on real Postgres in
 * tests-pg/fieldPins.pg.test.ts. */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/failedLogins", () => ({
  recordFailedLogin: vi.fn(),
  recordRateLimitedOnce: vi.fn(),
}));
vi.mock("../services/audit", () => ({ writeAudit: vi.fn(async () => {}), audit: vi.fn(async () => {}) }));

const { Hono } = await import("hono");
const { fieldPinLogin, LOCKED_MESSAGE, WRONG_PIN_MESSAGE } = await import("./fieldPinLogin");
const { hashPassword } = await import("../services/auth");
const { recordFailedLogin } = await import("../services/failedLogins");
const { writeAudit } = await import("../services/audit");
const { FIELD_PIN_MAX_FAILURES, FIELD_PIN_IP_MAX } = await import("../services/fieldPin");

const app = new Hono<{ Bindings: import("../types").Env }>();
app.post("/pin-login", fieldPinLogin);

type Member = {
  id: number;
  status: string;
  totp_enabled: number;
  staff_id: string;
  pin_hash: string | null;
  failed_count: number;
  locked_until: string | null;
  cohort: string | null;
  profile: string | null;
};

function fakeEnv(member: Member | null) {
  const kv = new Map<string, string>();
  const sessions: { userId: number; origin: string | null }[] = [];
  const DB = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind: (...a: unknown[]) => ((args = a), stmt),
        async first() {
          if (sql.includes("FROM scm.staff s")) return args[0] === "EMP-0042" ? member && { ...member } : null;
          if (sql.startsWith("UPDATE field_pins\n   SET failed_count")) {
            if (!member) return null;
            member.failed_count += 1;
            if (member.failed_count >= FIELD_PIN_MAX_FAILURES) {
              member.locked_until = new Date(Date.now() + 15 * 60_000).toISOString();
            }
            return { failed_count: member.failed_count, locked_until: member.locked_until };
          }
          return null;
        },
        async run() {
          if (sql.startsWith("UPDATE field_pins SET failed_count = 0") && member) {
            member.failed_count = 0;
            member.locked_until = null;
          }
          if (sql.startsWith("INSERT INTO sessions")) sessions.push({ userId: args[1] as number, origin: args[3] as string | null });
          return { meta: {} };
        },
      };
      return stmt;
    },
  };
  return {
    env: {
      DB,
      SESSION_CACHE: {
        get: async (k: string) => kv.get(k) ?? null,
        put: async (k: string, v: string) => void kv.set(k, v),
        delete: async (k: string) => void kv.delete(k),
      },
    },
    sessions,
    kv,
  };
}

async function crew(pin = "482913", over: Partial<Member> = {}): Promise<Member> {
  return {
    id: 42,
    status: "active",
    totp_enabled: 0,
    staff_id: "s-42",
    pin_hash: await hashPassword(pin),
    failed_count: 0,
    locked_until: null,
    cohort: "restricted",
    profile: "driver_helper",
    ...over,
  };
}

async function attempt(env: object, login: string, pin: string, ip = "1.2.3.4") {
  const res = await app.request(
    "/pin-login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ login, pin }),
    },
    env as import("../types").Env,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

afterEach(() => vi.clearAllMocks());

describe("POST /api/auth/pin-login", () => {
  it("the right PIN mints a session stamped origin 'field'", async () => {
    const f = fakeEnv(await crew());
    const r = await attempt(f.env, "42", "482913");
    expect(r.status).toBe(200);
    expect(r.body.session_origin).toBe("field");
    expect(f.sessions).toEqual([{ userId: 42, origin: "field" }]);
    expect(writeAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "auth.field_pin.login" }));
  });

  it("a wrong PIN is 401 with one message, and is recorded without the PIN", async () => {
    const f = fakeEnv(await crew());
    const r = await attempt(f.env, "EMP-0042", "111222");
    expect(r).toEqual({ status: 401, body: { error: WRONG_PIN_MESSAGE } });
    expect(recordFailedLogin).toHaveBeenCalledWith(expect.anything(), "EMP-0042", 42, "wrong_password");
    expect(JSON.stringify(vi.mocked(recordFailedLogin).mock.calls)).not.toContain("111222");
  });

  it("an unknown code answers exactly like a wrong PIN", async () => {
    const f = fakeEnv(await crew());
    expect(await attempt(f.env, "77", "482913")).toEqual({ status: 401, body: { error: WRONG_PIN_MESSAGE } });
  });

  it(`locks after ${FIELD_PIN_MAX_FAILURES} wrong PINs, then refuses even the RIGHT PIN`, async () => {
    const m = await crew();
    const f = fakeEnv(m);
    for (let i = 0; i < FIELD_PIN_MAX_FAILURES; i++) {
      expect((await attempt(f.env, "42", "111222", `10.0.0.${i}`)).status).toBe(401);
    }
    expect(m.locked_until).not.toBeNull();
    expect(writeAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "auth.field_pin.locked" }));
    f.kv.clear(); // KV down or expired: the durable lock on the row must still hold
    const r = await attempt(f.env, "42", "482913", "10.9.9.9");
    expect(r.status).toBe(429);
    expect(r.body.error).toBe(LOCKED_MESSAGE);
    expect(f.sessions).toEqual([]);
  });

  it("the per-code speed bump gives an unknown code the same 429 after the same count", async () => {
    const f = fakeEnv(null);
    for (let i = 0; i < FIELD_PIN_MAX_FAILURES; i++) {
      expect((await attempt(f.env, "42", "111222", `10.1.0.${i}`)).status).toBe(401);
    }
    const r = await attempt(f.env, "42", "111222", "10.1.9.9");
    expect(r.status).toBe(429);
    expect(r.body.error).toBe(LOCKED_MESSAGE);
  });

  it(`one IP is held to ${FIELD_PIN_IP_MAX} tries across many codes`, async () => {
    const f = fakeEnv(null);
    for (let i = 0; i < FIELD_PIN_IP_MAX; i++) {
      expect((await attempt(f.env, String(1000 + i), "111222", "9.9.9.9")).status).toBe(401);
    }
    expect((await attempt(f.env, "5000", "111222", "9.9.9.9")).status).toBe(429);
    expect((await attempt(f.env, "5000", "111222", "8.8.8.8")).status).toBe(401);
  });

  it("a correct PIN clears the failure count", async () => {
    const m = await crew();
    const f = fakeEnv(m);
    await attempt(f.env, "42", "111222");
    await attempt(f.env, "42", "111222");
    expect(m.failed_count).toBe(2);
    expect((await attempt(f.env, "42", "482913")).status).toBe(200);
    expect(m.failed_count).toBe(0);
  });

  it("a member whose Title is not a crew Title is refused even with the right PIN", async () => {
    const f = fakeEnv(await crew("482913", { cohort: "full", profile: null }));
    const r = await attempt(f.env, "42", "482913");
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("field_pin_not_eligible");
    expect(f.sessions).toEqual([]);
  });

  it("a Title with no policy row is refused", async () => {
    const f = fakeEnv(await crew("482913", { cohort: null, profile: null }));
    expect((await attempt(f.env, "42", "482913")).status).toBe(403);
  });

  it("a disabled member is refused after the PIN check", async () => {
    const f = fakeEnv(await crew("482913", { status: "disabled" }));
    expect((await attempt(f.env, "42", "482913")).status).toBe(403);
    expect((await attempt(f.env, "42", "000111")).status).toBe(401);
  });

  it("a 2FA member gets a challenge that carries the field door", async () => {
    const f = fakeEnv(await crew("482913", { totp_enabled: 1 }));
    const r = await attempt(f.env, "42", "482913");
    expect(r.body.totp_required).toBe(true);
    expect(f.kv.get(`2fa:${String(r.body.challenge)}`)).toBe("42:0:field");
    expect(f.sessions).toEqual([]);
  });

  it("refuses a malformed body before touching the database", async () => {
    const f = fakeEnv(await crew());
    expect((await attempt(f.env, "abc", "482913")).status).toBe(400);
    expect((await attempt(f.env, "42", "4829")).status).toBe(400);
  });
});
