import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, test, beforeEach } from "vitest";
import searchApp, { searchPattern } from "../src/routes/search";

// The global search (GET /api/search, the Cmd+K / mobile palette) must scope
// every source the same way its owning module does — the standing incident is
// Houzs seeing 2990 data and vice versa. This exercises the PUBLIC-schema arms
// (projects / service cases / users) against the isolated test D1, injecting the
// same context vars the companyContext middleware sets in prod. The SCM arms
// (sales orders / products) talk to Supabase, which is unconfigured here, so they
// no-op — their scoping is the shared scopeToCompany helper, covered elsewhere.

const HOUZS = 1;
const CO2990 = 2;
const COMPANIES = [
  { id: HOUZS, code: "HOUZS" },
  { id: CO2990, code: "2990" },
];

// Rank-and-file Sales, holding no permissions. ASSR scopes by the caller's
// GRANTS, not their role (owner 2026-07-20, #934), so this user's reach is
// whatever allowedCompanyIds says — exactly a director's.
const SALES = { department_name: "Sales", permissions_set: new Set<string>() };
const DIRECTOR = { permissions_set: new Set<string>(["*"]) };

interface Ctx {
  companyId?: number;
  allowedCompanyIds?: number[];
  user?: Record<string, unknown>;
}

interface Hit {
  type: string;
  id: string | number;
  title: string;
}

async function search(q: string, ctx: Ctx): Promise<Hit[]> {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("companies" as never, COMPANIES as never);
    if ("companyId" in ctx) c.set("companyId" as never, ctx.companyId as never);
    if ("allowedCompanyIds" in ctx)
      c.set("allowedCompanyIds" as never, ctx.allowedCompanyIds as never);
    if ("user" in ctx) c.set("user" as never, ctx.user as never);
    await next();
  });
  app.route("/", searchApp);
  const res = await app.request(`/?q=${encodeURIComponent(q)}`, {}, env);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { hits: Hit[] };
  return body.hits;
}

const idsOfType = (hits: Hit[], type: string): number[] =>
  hits
    .filter((h) => h.type === type)
    .map((h) => Number(h.id))
    .sort((a, b) => a - b);

// company_id lives in the Postgres migration tree, not the D1 baseline; a lean
// D1 mirror may also lack some of the columns the search query reads. Add them
// idempotently so a missing column can never make the whole search 500.
async function ensureColumn(sql: string): Promise<void> {
  try {
    await env.DB.exec(sql);
  } catch {
    // Column already present — expected on the second suite run.
  }
}

beforeEach(async () => {
  await ensureColumn(`ALTER TABLE projects ADD COLUMN company_id INTEGER`);
  await ensureColumn(`ALTER TABLE assr_cases ADD COLUMN company_id INTEGER`);
  for (const col of [
    "complaint_issue TEXT",
    "status TEXT",
    "complained_date TEXT",
    "po_no TEXT",
    "archived_at TEXT",
  ]) {
    await ensureColumn(`ALTER TABLE assr_cases ADD COLUMN ${col}`);
  }
  await ensureColumn(`ALTER TABLE users ADD COLUMN user_type TEXT`);

  await env.DB.exec(`DELETE FROM projects WHERE id IN (9001, 9002, 9003)`);
  await env.DB.exec(`DELETE FROM assr_cases WHERE id IN (9001, 9002)`);
  await env.DB.exec(`DELETE FROM users WHERE id IN (9001, 9002)`);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO roles (id, name) VALUES (1, 'search-scope-role')`,
  ).run();

  // One project per company, both matching "acme".
  await env.DB.prepare(
    `INSERT INTO projects (id, code, name, stage, start_date, company_id) VALUES (?,?,?,?,?,?)`,
  )
    .bind(9001, "ACME-HZ", "Acme Expo HZ", "live", "2026-07-01", HOUZS)
    .run();
  await env.DB.prepare(
    `INSERT INTO projects (id, code, name, stage, start_date, company_id) VALUES (?,?,?,?,?,?)`,
  )
    .bind(9002, "ACME-29", "Acme Expo 2990", "live", "2026-07-02", CO2990)
    .run();
  await env.DB.prepare(
    `INSERT INTO projects (id, code, name, stage, start_date, company_id) VALUES (?,?,?,?,?,?)`,
  )
    .bind(9003, "ZZ-A1-ZZ", "Middle match only", "live", "2026-07-03", HOUZS)
    .run();

  // One service case per company, both matching "acme".
  await env.DB.prepare(
    `INSERT INTO assr_cases (id, assr_no, doc_no, stage, customer_name, company_id) VALUES (?,?,?,?,?,?)`,
  )
    .bind(9001, "ASSR-HZ", "SO-HZ", "pending_review", "Acme Buyer HZ", HOUZS)
    .run();
  await env.DB.prepare(
    `INSERT INTO assr_cases (id, assr_no, doc_no, stage, customer_name, company_id) VALUES (?,?,?,?,?,?)`,
  )
    .bind(9002, "ASSR-29", "SO-29", "pending_review", "Acme Buyer 2990", CO2990)
    .run();

  // Two users, both matching "acme". Users are a shared directory — never scoped.
  await env.DB.prepare(
    `INSERT INTO users (id, name, email, role_id, status) VALUES (?,?,?,1,'active')`,
  )
    .bind(9001, "Acme Person One", "acme1@example.com")
    .run();
  await env.DB.prepare(
    `INSERT INTO users (id, name, email, role_id, status) VALUES (?,?,?,1,'active')`,
  )
    .bind(9002, "Acme Person Two", "acme2@example.com")
    .run();
});

describe("global search — company scoping (both directions)", () => {
  test("wildcard-only input cannot turn SQL or PostgREST search into list-everything", async () => {
    const ctx = {
      companyId: HOUZS,
      allowedCompanyIds: [HOUZS, CO2990],
      user: DIRECTOR,
    };
    expect(await search("%", ctx)).toEqual([]);
    expect(await search("_", ctx)).toEqual([]);
    expect(await search("*", ctx)).toEqual([]);
    expect(searchPattern("*", true)).toBeNull();
    expect(searchPattern("%", true)).toBeNull();
    expect(searchPattern("_", true)).toBeNull();
    expect(searchPattern("a", true)).toBe("a%");
    expect(searchPattern("a1", true)).toBe("%a1%");
  });

  test("the first character runs a real cross-page search without weakening company scope", async () => {
    const hz = await search("a", {
      companyId: HOUZS,
      allowedCompanyIds: [HOUZS, CO2990],
      user: DIRECTOR,
    });
    expect(idsOfType(hz, "project")).toEqual([9001]);
    expect(idsOfType(hz, "assr_case")).toEqual([9001, 9002]);
    expect(idsOfType(hz, "user")).toEqual([9001, 9002]);

    const c2 = await search("a", {
      companyId: CO2990,
      allowedCompanyIds: [CO2990],
      user: DIRECTOR,
    });
    expect(idsOfType(c2, "project")).toEqual([9002]);
    expect(idsOfType(c2, "assr_case")).toEqual([9002]);
  });

  test("one character is prefix-only while two characters keep contains matching", async () => {
    const ctx = {
      companyId: HOUZS,
      allowedCompanyIds: [HOUZS],
      user: DIRECTOR,
    };
    expect(idsOfType(await search("a", ctx), "project")).toEqual([9001]);
    expect(idsOfType(await search("a1", ctx), "project")).toEqual([9003]);
  });

  test("projects: active HOUZS sees only HOUZS; active 2990 sees only 2990", async () => {
    const hz = await search("acme", {
      companyId: HOUZS,
      allowedCompanyIds: [HOUZS, CO2990],
      user: DIRECTOR,
    });
    expect(idsOfType(hz, "project")).toEqual([9001]);

    const c2 = await search("acme", {
      companyId: CO2990,
      allowedCompanyIds: [HOUZS, CO2990],
      user: DIRECTOR,
    });
    expect(idsOfType(c2, "project")).toEqual([9002]);
  });

  test("projects: a resolved-but-restricted caller matches NOTHING (never fails open)", async () => {
    // allowedCompanyIds = [] means the context resolved but the caller is granted
    // no active company — the per-company arm must fail CLOSED, not list all.
    const hits = await search("acme", { allowedCompanyIds: [], user: DIRECTOR });
    expect(idsOfType(hits, "project")).toEqual([]);
  });

  test("projects: unresolved company context degrades to single-company (legacy)", async () => {
    // No companyId and no allowedCompanyIds = pre-migration / cold-start. Legacy
    // single-company Houzs must keep working — no predicate, all rows.
    const hits = await search("acme", {});
    expect(idsOfType(hits, "project")).toEqual([9001, 9002]);
  });

  /* This test used to assert the OPPOSITE — that a rank-and-file Sales rep is
     pinned to HOUZS whatever they are granted. That pin was real until the owner
     removed it on 2026-07-20 (#934, `dc16fb2e`): Service Cases now follow
     user_companies like the rest of the SCM portal. #934 updated assr.ts and
     assrCompanyScope.test.ts and missed BOTH this expectation and the private
     copy of the rule that search.ts was still carrying, so the stale test kept
     agreeing with the stale copy and neither one was visible as wrong. */
  test("ASSR follows the caller's GRANTED companies, not their role", async () => {
    const both = await search("acme", {
      companyId: HOUZS,
      allowedCompanyIds: [HOUZS, CO2990],
      user: SALES,
    });
    expect(idsOfType(both, "assr_case")).toEqual([9001, 9002]);

    /* The other half of the stale pin: it HID a 2990-only rep's own cases and
       showed them HOUZS cases they hold no grant for. */
    const only2990 = await search("acme", {
      companyId: CO2990,
      allowedCompanyIds: [CO2990],
      user: SALES,
    });
    expect(idsOfType(only2990, "assr_case")).toEqual([9002]);
  });

  test("ASSR gives office/directors the same grant-scoped reach", async () => {
    const hits = await search("acme", {
      companyId: HOUZS,
      allowedCompanyIds: [HOUZS, CO2990],
      user: DIRECTOR,
    });
    expect(idsOfType(hits, "assr_case")).toEqual([9001, 9002]);
  });

  test("users stay global — the same directory regardless of active company", async () => {
    const hz = await search("acme", {
      companyId: HOUZS,
      allowedCompanyIds: [HOUZS],
      user: DIRECTOR,
    });
    const c2 = await search("acme", {
      companyId: CO2990,
      allowedCompanyIds: [CO2990],
      user: DIRECTOR,
    });
    expect(idsOfType(hz, "user")).toEqual([9001, 9002]);
    expect(idsOfType(c2, "user")).toEqual([9001, 9002]);
  });
});
