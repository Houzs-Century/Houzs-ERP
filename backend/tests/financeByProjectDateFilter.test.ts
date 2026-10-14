// Finances → List: the From/To window selects PROJECTS by their event dates
// (the "Dates" column), not ledger lines by occurred_at.
//
// Symptom (2026-10-14): a September window listed a July 2027 event because
// its rent line happened to be keyed in September. The user reading the table
// cannot see why a row is there — the only date on screen is the event's.
//
// The route runs on the Postgres Drizzle client, so it is driven through its
// real Hono app with `getDb` replaced by a recorder that renders every
// statement through the Postgres dialect. The assertions are on the SQL the
// handler actually issued, so a return to the per-line filter fails here.
import { describe, expect, test, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

type Recorded = { sql: string; params: unknown[] };
const seen: Recorded[] = [];
const dialect = new PgDialect();

vi.mock("../src/db/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/db/client")>();
  const render = (q: SQL | string) =>
    typeof q === "string" ? { sql: q, params: [] } : dialect.sqlToQuery(q);
  const fake = {
    async execute(q: SQL | string) {
      const r = render(q);
      seen.push({ sql: r.sql, params: r.params });
      return [];
    },
    async get(q: SQL | string) {
      const r = render(q);
      seen.push({ sql: r.sql, params: r.params });
      return undefined;
    },
  };
  return { ...mod, getDb: () => fake };
});

const flat = (s: string) => s.replace(/\s+/g, " ");

async function drive(query: string) {
  seen.length = 0;
  const { Hono } = await import("hono");
  const projects = (await import("../src/routes/projects")).default;
  const outer = new Hono<any>();
  outer.use("*", async (c: any, next: any) => {
    // No position_id: denyFinance lets the request through.
    c.set("user", { id: 1, permissions: ["*"], permissions_set: new Set(["*"]) });
    await next();
  });
  outer.route("/", projects);
  const res = await outer.request(`/finance/by-project${query}`, { method: "GET" }, {} as any);
  return { res, rows: seen.find((s) => /LIMIT/.test(s.sql))! };
}

describe("GET /finance/by-project — the date window is on the event dates", () => {
  test("a September window filters projects by start_date / end_date overlap", async () => {
    const { res, rows } = await drive("?date_from=2026-09-01&date_to=2026-09-30");
    expect(res.status).toBe(200);
    const sql = flat(rows.sql);
    // Ends on/after From, starts on/before To (end_date falls back to start_date).
    expect(sql).toContain("substr(COALESCE(p.end_date, p.start_date), 1, 10) >= $");
    expect(sql).toContain("substr(p.start_date, 1, 10) <= $");
    expect(rows.params).toEqual(expect.arrayContaining(["2026-09-01", "2026-09-30"]));
    // The line SUMs count every line of a matching project: no per-line date
    // predicate, and no "has a line in range" visibility gate.
    expect(sql).not.toContain("l.occurred_at");
    expect(sql).not.toContain("l.created_at");
    expect(sql).not.toContain("line_count > 0");
  });

  test("no window: no date predicate at all, every project surfaces", async () => {
    const { res, rows } = await drive("");
    expect(res.status).toBe(200);
    const sql = flat(rows.sql);
    expect(sql).not.toContain("p.start_date, 1, 10) <=");
    expect(sql).not.toContain("p.end_date, p.start_date), 1, 10) >=");
    expect(sql).not.toContain("l.occurred_at");
  });

  test("a datetime From/To is truncated to the day", async () => {
    const { rows } = await drive("?date_from=2026-09-01T10:00:00&date_to=2026-09-30T23:59:59");
    expect(rows.params).toEqual(expect.arrayContaining(["2026-09-01", "2026-09-30"]));
    expect(rows.params).not.toContain("2026-09-30T23:59:59");
  });
});

// Symptom (2026-10-14, same day): the Sales column read RM 0.00 for every
// September event while each project page showed its sales. The page's P&L
// snapshot falls back to the lump "Total Sales" box (project_finance.
// total_sales) when no individual sales line exists; the list summed lines
// only. On production 18 / 26 September events carried their sales ONLY in
// that box.
describe("GET /finance/by-project — sales agrees with the project page", () => {
  test("sales = sales lines when any exist, else project_finance.total_sales", async () => {
    const { rows } = await drive("?date_from=2026-09-01&date_to=2026-09-30");
    const sql = flat(rows.sql);
    expect(sql).toContain('LEFT JOIN "project_finance" pf ON pf.project_id = p.id');
    const salesCol = /CASE WHEN (.+?) > 0 THEN .+? ELSE COALESCE\(MAX\(pf\.total_sales\), 0\) END AS sales/.exec(sql);
    expect(salesCol).not.toBeNull();
    // The thing being tested for > 0 is the SUM of individual sales lines.
    expect(salesCol![1]).toContain("l.category = 'sales'");
  });
});
