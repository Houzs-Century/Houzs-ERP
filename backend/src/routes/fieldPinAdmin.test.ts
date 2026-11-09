import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/audit", () => ({ audit: vi.fn(async () => {}), writeAudit: vi.fn(async () => {}) }));
vi.mock("../services/sessionCache", () => ({ bustUserSessions: vi.fn(async () => {}) }));
const gate = vi.hoisted(() => ({ ok: true as boolean }));
vi.mock("./lib/actor-company-gate", () => ({
  targetWithinActorCompanies: vi.fn(async () =>
    gate.ok ? { ok: true } : { ok: false, body: { error: "not_in_your_companies", message: "x" } },
  ),
}));

const { Hono } = await import("hono");
const admin = (await import("./fieldPinAdmin")).default;
const { fieldPinStatusOf } = await import("./fieldPinAdmin");
const { audit } = await import("../services/audit");
const { bustUserSessions } = await import("../services/sessionCache");

type Row = import("./fieldPinAdmin").StatusRow;

const crewRow = (over: Partial<Row> = {}): Row => ({
  id: 42,
  status: "active",
  staff_code: "EMP-0042",
  cohort: "restricted",
  profile: "driver_helper",
  has_pin: false,
  failed_count: null,
  locked_until: null,
  set_at: null,
  ...over,
});

function harness(row: Row | null, perms: string[] = ["users.manage"]) {
  const writes: { sql: string; args: unknown[] }[] = [];
  const DB = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind: (...a: unknown[]) => ((args = a), stmt),
        first: async () => (sql.includes("FROM users u") ? row : null),
        run: async () => (writes.push({ sql, args }), { meta: {} }),
      };
      return stmt;
    },
  };
  const app = new Hono();
  const user = { id: 1, email: "admin@x", permissions: perms, permissions_set: new Set(perms) } as unknown as import("../services/auth").AuthUser;
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/", admin);
  const call = async (method: string, body?: unknown) => {
    const res = await app.request(
      "/42",
      { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined },
      { DB } as unknown as import("../types").Env,
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { call, writes };
}

afterEach(() => {
  vi.clearAllMocks();
  gate.ok = true;
});

describe("/api/field-pin", () => {
  it("needs users.manage", async () => {
    expect((await harness(crewRow(), ["users.read"]).call("GET")).status).toBe(403);
  });

  it("sets a PIN as a hash, never the PIN, and ends the member's PIN sessions", async () => {
    const h = harness(crewRow());
    const r = await h.call("POST", { pin: "482913" });
    expect(r).toEqual({ status: 200, body: { ok: true, login: "EMP-0042" } });
    const upsert = h.writes.find((w) => w.sql.startsWith("INSERT INTO field_pins"));
    expect(upsert?.args[0]).toBe(42);
    expect(String(upsert?.args[1])).toMatch(/^[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(JSON.stringify(h.writes)).not.toContain("482913");
    expect(h.writes.some((w) => w.sql.includes("origin = 'field'"))).toBe(true);
    expect(bustUserSessions).toHaveBeenCalledWith(expect.anything(), 42);
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "user.field_pin.set" }));
  });

  it("refuses a member whose Title is not a crew Title", async () => {
    const h = harness(crewRow({ cohort: "full", profile: null }));
    const r = await h.call("POST", { pin: "482913" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("field_pin_not_crew_title");
    expect(h.writes).toEqual([]);
  });

  it("refuses a member outside the admin's companies", async () => {
    gate.ok = false;
    const h = harness(crewRow());
    expect((await h.call("POST", { pin: "482913" })).status).toBe(403);
    expect((await h.call("DELETE")).status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it("refuses an obvious PIN", async () => {
    const r = await harness(crewRow()).call("POST", { pin: "123456" });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("field_pin_weak");
  });

  it("removing a PIN deletes it and ends PIN sessions", async () => {
    const h = harness(crewRow({ has_pin: true }));
    expect((await h.call("DELETE")).status).toBe(200);
    expect(h.writes.map((w) => w.sql.split(" ").slice(0, 3).join(" "))).toEqual([
      "DELETE FROM field_pins",
      "DELETE FROM sessions",
    ]);
  });
});

describe("fieldPinStatusOf", () => {
  const now = Date.parse("2026-11-10T00:00:00Z");
  it("explains why a member cannot hold one", () => {
    expect(fieldPinStatusOf(crewRow(), now).reason).toBe("ok");
    expect(fieldPinStatusOf(crewRow({ staff_code: null }), now).reason).toBe("no_staff_code");
    expect(fieldPinStatusOf(crewRow({ staff_code: "SP-1" }), now).reason).toBe("staff_code_shape");
    expect(fieldPinStatusOf(crewRow({ status: "disabled" }), now).reason).toBe("inactive");
    expect(fieldPinStatusOf(crewRow({ cohort: null }), now).reason).toBe("not_crew_title");
  });
  it("reports a live lock", () => {
    const s = fieldPinStatusOf(crewRow({ has_pin: true, locked_until: "2026-11-10T00:10:00Z" }), now);
    expect(s).toMatchObject({ hasPin: true, locked: true });
  });
});
