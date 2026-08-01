import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { __resetCompanyContextCacheForTest } from "../src/middleware/companyContext";

/* ────────────────────────────────────────────────────────────────────────────
   TABLE LAYOUTS (routes/tableLayouts.ts, mig 0236 / D1 142).

   Column layouts moved off localStorage so that (1) an admin can set a
   COMPANY-WIDE default view without a deploy, and (2) a user's own arrangement
   follows their account to another machine. The properties worth pinning:

     • a user's row and the company default are DIFFERENT rows — writing one
       never touches the other, which is what makes changing a default safe;
     • the company is the SERVER's resolved active company. There is no company
       field in any body, so a caller cannot write into a company they aren't
       in — and the same table_key in two companies stays two rows;
     • only settings.manage may write a default (everyone may write their own);
     • whatever a browser sends is normalised before storage, because the input
       is one machine's accumulated prefs and a corrupt width must not cost the
       user the rest of the layout.
   ──────────────────────────────────────────────────────────────────────────── */

const TABLE = "sales-orders-v2";

interface Actor {
  id: number;
  bearer: string;
}

async function seedActor(permissions: string[]): Promise<Actor> {
  const suffix = Math.random().toString(36).slice(2);
  const role = await env.DB.prepare(
    `INSERT INTO roles (name, description, permissions, scope_to_pic)
     VALUES (?, 'test', ?, 0)`,
  )
    .bind(`tl_${suffix}`, JSON.stringify(permissions))
    .run();
  const user = await env.DB.prepare(
    `INSERT INTO users (email, name, role_id, status, joined_at)
     VALUES (?, 'Layout Tester', ?, 'active', datetime('now'))`,
  )
    .bind(`tl_${suffix}@test.local`, role.meta.last_row_id)
    .run();
  const id = Number(user.meta.last_row_id);
  const token = `tl-${suffix}`;
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
  )
    .bind(token, id, new Date(Date.now() + 3_600_000).toISOString())
    .run();
  await env.DB.prepare(
    `INSERT INTO user_companies (user_id, company_id) VALUES (?, 1), (?, 2)`,
  )
    .bind(id, id)
    .run();
  return { id, bearer: `Bearer ${token}` };
}

function req(
  actor: Actor,
  path: string,
  init: { method?: string; body?: unknown; companyId?: number } = {},
) {
  return SELF.fetch(`https://test.local/api/table-layouts${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: actor.bearer,
      "Content-Type": "application/json",
      "X-Company-Id": String(init.companyId ?? 2),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const layout = (over: Record<string, unknown> = {}) => ({
  order: ["so_date", "debtor_name", "status"],
  hidden: ["reference"],
  shown: ["stock_status"],
  widths: { so_date: 120 },
  pinned: [],
  ...over,
});

beforeEach(async () => {
  // The companies master lives only in Postgres (multi-company arrived after
  // the D1 cutover), so the mirror has to stand it up — same as
  // idempotencyCompanyScope.test.ts.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS companies (
       id INTEGER PRIMARY KEY,
       code TEXT NOT NULL,
       name TEXT NOT NULL,
       is_active INTEGER NOT NULL DEFAULT 1
     )`,
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS user_companies (
       user_id INTEGER NOT NULL,
       company_id INTEGER NOT NULL,
       PRIMARY KEY (user_id, company_id)
     )`,
  ).run();
  await env.DB.exec(`DELETE FROM table_layouts`);
  await env.DB.exec(`DELETE FROM user_companies`);
  await env.DB.exec(`DELETE FROM companies`);
  await env.DB.exec(`DELETE FROM sessions`);
  await env.DB.exec(`DELETE FROM users`);
  await env.DB.exec(`DELETE FROM roles WHERE is_system = 0`);
  await env.DB.prepare(
    `INSERT INTO companies (id, code, name, is_active) VALUES
       (1, 'HOUZS', 'Houzs Century', 1),
       (2, '2990', '2990 Home', 1)`,
  ).run();
  __resetCompanyContextCacheForTest();
});

describe("table layouts", () => {
  test("a saved layout comes back as MINE, and a second save updates one row", async () => {
    const user = await seedActor(["sales_orders.read"]);

    expect((await req(user, `/${TABLE}`, { method: "PUT", body: { layout: layout() } })).status).toBe(200);
    let body = await (await req(user, "")).json<{ mine: Record<string, { layout: { order: string[] } }> }>();
    expect(body.mine[TABLE]?.layout.order).toEqual(["so_date", "debtor_name", "status"]);

    await req(user, `/${TABLE}`, { method: "PUT", body: { layout: layout({ order: ["status"] }) } });
    body = await (await req(user, "")).json<{ mine: Record<string, { layout: { order: string[] } }> }>();
    expect(body.mine[TABLE]?.layout.order).toEqual(["status"]);

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM table_layouts WHERE user_id = ?`,
    )
      .bind(user.id)
      .first<{ n: number }>();
    expect(Number(rows?.n)).toBe(1);
  });

  test("the company default is a separate row, and only settings.manage may write it", async () => {
    const plain = await seedActor(["sales_orders.read"]);
    const admin = await seedActor(["settings.manage"]);

    // A user's own layout, then an admin default on the SAME table.
    await req(plain, `/${TABLE}`, { method: "PUT", body: { layout: layout({ order: ["mine"] }) } });
    expect(
      (await req(plain, `/${TABLE}/default`, { method: "PUT", body: { layout: layout() } })).status,
    ).toBe(403);
    expect(
      (await req(admin, `/${TABLE}/default`, {
        method: "PUT",
        body: { layout: layout({ order: ["company"] }) },
      })).status,
    ).toBe(200);

    // The admin write reached the default row only — the user still has theirs.
    const body = await (await req(plain, "")).json<{
      defaults: Record<string, Record<string, { order: string[] }>>;
      mine: Record<string, { layout: { order: string[] } }>;
      canManageDefaults: boolean;
    }>();
    expect(body.defaults["2"]?.[TABLE]?.order).toEqual(["company"]);
    expect(body.mine[TABLE]?.layout.order).toEqual(["mine"]);
    expect(body.canManageDefaults).toBe(false);

    const adminView = await (await req(admin, "")).json<{ canManageDefaults: boolean }>();
    expect(adminView.canManageDefaults).toBe(true);
  });

  test("the active company owns the row — the same table in two companies is two layouts", async () => {
    const admin = await seedActor(["settings.manage"]);

    await req(admin, `/${TABLE}/default`, {
      method: "PUT",
      companyId: 2,
      body: { layout: layout({ order: ["for_2990"] }) },
    });
    await req(admin, `/${TABLE}/default`, {
      method: "PUT",
      companyId: 1,
      body: { layout: layout({ order: ["for_houzs"] }) },
    });

    // Both defaults are offered whichever company the caller is in — that is
    // what lets the Columns panel present the other company's layout as a
    // one-click preset.
    const body = await (await req(admin, "", { companyId: 2 })).json<{
      defaults: Record<string, Record<string, { order: string[] }>>;
    }>();
    expect(body.defaults["2"]?.[TABLE]?.order).toEqual(["for_2990"]);
    expect(body.defaults["1"]?.[TABLE]?.order).toEqual(["for_houzs"]);
  });

  test("MINE is scoped to the active company, so a switch never shows the other company's layout", async () => {
    const user = await seedActor(["sales_orders.read"]);
    await req(user, `/${TABLE}`, { method: "PUT", companyId: 2, body: { layout: layout({ order: ["a"] }) } });

    const inHouzs = await (await req(user, "", { companyId: 1 })).json<{ mine: Record<string, unknown> }>();
    expect(inHouzs.mine[TABLE]).toBeUndefined();
  });

  test("a browser's junk is normalised rather than stored or echoed", async () => {
    const user = await seedActor(["sales_orders.read"]);
    await req(user, `/${TABLE}`, {
      method: "PUT",
      body: {
        layout: {
          order: ["ok", 7, null, "ok", "x".repeat(200)],
          hidden: "not-an-array",
          widths: { ok: "wide", tall: -50, fine: 300.4 },
          pinned: ["ok"],
          note: "<script>alert(1)</script>",
        },
      },
    });

    const body = await (await req(user, "")).json<{
      mine: Record<string, { layout: Record<string, unknown> }>;
    }>();
    const stored = body.mine[TABLE]!.layout;
    // Non-strings, duplicates and over-long keys drop; a bad list becomes empty;
    // widths clamp to a usable pixel range; unknown fields never survive.
    expect(stored.order).toEqual(["ok"]);
    expect(stored.hidden).toEqual([]);
    expect(stored.widths).toEqual({ tall: 40, fine: 300 });
    expect(stored).not.toHaveProperty("note");
  });

  test("deleting my layout leaves the company default standing", async () => {
    const admin = await seedActor(["settings.manage"]);
    await req(admin, `/${TABLE}/default`, { method: "PUT", body: { layout: layout({ order: ["company"] }) } });
    await req(admin, `/${TABLE}`, { method: "PUT", body: { layout: layout({ order: ["mine"] }) } });

    expect((await req(admin, `/${TABLE}`, { method: "DELETE" })).status).toBe(200);

    const body = await (await req(admin, "")).json<{
      defaults: Record<string, Record<string, { order: string[] }>>;
      mine: Record<string, unknown>;
    }>();
    expect(body.mine[TABLE]).toBeUndefined();
    expect(body.defaults["2"]?.[TABLE]?.order).toEqual(["company"]);
  });

  test("an unknown table key is refused before anything is written", async () => {
    const user = await seedActor(["sales_orders.read"]);
    const res = await req(user, "/../../etc/passwd", { method: "PUT", body: { layout: layout() } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM table_layouts`).first<{ n: number }>();
    expect(Number(rows?.n)).toBe(0);
  });
});
