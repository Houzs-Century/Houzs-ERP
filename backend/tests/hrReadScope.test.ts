// requireHrRead is the /api/hr/* gate. A narrow hr.attendance.read user may
// read ONLY the Attendance + Working Hours GETs — never salary, payroll or the
// employee master — so an attendance / OT supervisor can be given that key
// without seeing what anyone is paid. This pins that boundary: it is the one
// thing that keeps a UI tab-hide from being the only wall in front of salaries.
import { describe, expect, test } from "vitest";
import { requireHrRead } from "../src/middleware/auth";

const NEXT = Symbol("next");

type FakeUser = { permissions?: string[]; permissions_set?: Set<string> };
async function gate(user: FakeUser | null, path: string, method = "GET"): Promise<{ passed: boolean; status: number | null }> {
  let status: number | null = null;
  const c = {
    get: (k: string) => (k === "user" ? user : undefined),
    req: { path, method },
    json: (_body: unknown, s?: number) => {
      status = s ?? 200;
      return { status };
    },
  };
  const next = async () => NEXT;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a hand-rolled minimal Hono context for a middleware unit test
  const out = await requireHrRead(c as any, next as any);
  return { passed: out === NEXT, status };
}

const broad: FakeUser = { permissions: ["hr.employees.read"] };
const manager: FakeUser = { permissions: ["hr.employees.manage"] };
const god: FakeUser = { permissions: ["*"] };
const attendanceOnly: FakeUser = { permissions: ["hr.attendance.read"] };
const otOnly: FakeUser = { permissions: ["hr.ot.confirm"] };

describe("requireHrRead — /api/hr/* scope", () => {
  test("a broad reader (or manager, or god) reaches everything", async () => {
    for (const u of [broad, manager, god]) {
      expect((await gate(u, "/api/hr/employees")).passed).toBe(true);
      expect((await gate(u, "/api/hr/payroll")).passed).toBe(true);
      expect((await gate(u, "/api/hr/attendance")).passed).toBe(true);
    }
  });

  test("hr.attendance.read reaches ONLY the attendance + working-hours reads", async () => {
    expect((await gate(attendanceOnly, "/api/hr/attendance")).passed).toBe(true);
    expect((await gate(attendanceOnly, "/api/hr/attendance/42/photo")).passed).toBe(true);
    expect((await gate(attendanceOnly, "/api/hr/working-hours")).passed).toBe(true);
    expect((await gate(attendanceOnly, "/api/hr/working-hours/9")).passed).toBe(true);
  });

  test("hr.attendance.read is REFUSED the salary / pay / master endpoints", async () => {
    for (const p of ["/api/hr/employees", "/api/hr/employees/1", "/api/hr/payroll", "/api/hr/labor-cost", "/api/hr/pay-rules", "/api/hr/allowances", "/api/hr/advances", "/api/hr/trip-pay"]) {
      const r = await gate(attendanceOnly, p);
      expect(r.passed).toBe(false);
      expect(r.status).toBe(403);
    }
  });

  test("the narrow key is read-only: a write to an allowed path is still refused", async () => {
    const r = await gate(attendanceOnly, "/api/hr/attendance", "PUT");
    expect(r.passed).toBe(false);
    expect(r.status).toBe(403);
  });

  test("hr.ot.confirm alone does not open the HR reads (OT lives under /api/attendance)", async () => {
    expect((await gate(otOnly, "/api/hr/attendance")).passed).toBe(false);
    expect((await gate(otOnly, "/api/hr/employees")).passed).toBe(false);
  });

  test("no session is 401", async () => {
    expect((await gate(null, "/api/hr/attendance")).status).toBe(401);
  });
});
