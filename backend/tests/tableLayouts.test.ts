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

  test("a DataGrid table key round-trips, group-by and all", async () => {
    // The 30 pages still on the vendored SCM DataGrid namespace their rows
    // 'dg:<storageKey>', and those storage keys carry dots. Both shapes used to
    // be rejected by the key check, which would have left those lists out.
    const admin = await seedActor(["settings.manage"]);
    const key = "dg:cn-g.cn-from-order-lines.layout.v1";

    const res = await req(admin, `/${key}/default`, {
      method: "PUT",
      body: { layout: layout({ groupBy: ["supplier"], pinned: ["doc_no"] }) },
    });
    expect(res.status).toBe(200);

    const body = await (await req(admin, "")).json<{
      defaults: Record<string, Record<string, { groupBy: string[]; pinned: string[] }>>;
    }>();
    expect(body.defaults["2"]?.[key]?.groupBy).toEqual(["supplier"]);
    expect(body.defaults["2"]?.[key]?.pinned).toEqual(["doc_no"]);
  });

  test("an unknown table key is refused before anything is written", async () => {
    const user = await seedActor(["sales_orders.read"]);
    const res = await req(user, "/../../etc/passwd", { method: "PUT", body: { layout: layout() } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM table_layouts`).first<{ n: number }>();
    expect(Number(rows?.n)).toBe(0);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
   NAMED layouts (mig 0239). A saved column set the user can switch back to —
   data, not a pointer, which is why none of this touches the live-arrangement
   sync above. What matters: the live row and the saved ones share a table and
   must never write through each other, names are the user's own namespace, and
   another account's layout is invisible rather than merely read-only.
   ──────────────────────────────────────────────────────────────────────────── */
describe("named layouts", () => {
  const listMine = async (actor: Actor) =>
    (await (await req(actor, `/${TABLE}/layouts`)).json<{
      layouts: Array<{ id: number; name: string; layout: { order: string[] } }>;
    }>()).layouts;

  test("saving a layout leaves the live arrangement alone, and vice versa", async () => {
    const user = await seedActor(["sales_orders.read"]);

    await req(user, `/${TABLE}`, { method: "PUT", body: { layout: layout({ order: ["live"] }) } });
    const created = await req(user, `/${TABLE}/layouts`, {
      method: "POST",
      body: { name: "Finance review", layout: layout({ order: ["saved"] }) },
    });
    expect(created.status).toBe(200);

    // Two rows, two jobs.
    expect((await listMine(user))[0]?.layout.order).toEqual(["saved"]);
    let body = await (await req(user, "")).json<{
      mine: Record<string, { layout: { order: string[] } }>;
      myLayouts: Record<string, Array<{ name: string }>>;
    }>();
    expect(body.mine[TABLE]?.layout.order).toEqual(["live"]);
    expect(body.myLayouts[TABLE]?.map((l) => l.name)).toEqual(["Finance review"]);

    // Editing the live arrangement must not write through to the saved one…
    await req(user, `/${TABLE}`, { method: "PUT", body: { layout: layout({ order: ["moved"] }) } });
    expect((await listMine(user))[0]?.layout.order).toEqual(["saved"]);

    // …and a reset must not take the saved layouts with it.
    expect((await req(user, `/${TABLE}`, { method: "DELETE" })).status).toBe(200);
    body = await (await req(user, "")).json<{
      mine: Record<string, unknown>;
      myLayouts: Record<string, Array<{ name: string }>>;
    }>();
    expect(body.mine[TABLE]).toBeUndefined();
    expect(body.myLayouts[TABLE]?.map((l) => l.name)).toEqual(["Finance review"]);
  });

  test("names are the user's own namespace, case-insensitively", async () => {
    const user = await seedActor(["sales_orders.read"]);
    const other = await seedActor(["sales_orders.read"]);

    await req(user, `/${TABLE}/layouts`, { method: "POST", body: { name: "Ops", layout: layout() } });
    const dupe = await req(user, `/${TABLE}/layouts`, {
      method: "POST",
      body: { name: "  ops  ", layout: layout() },
    });
    expect(dupe.status).toBe(409);

    // The same name under a different account is not a clash.
    expect(
      (await req(other, `/${TABLE}/layouts`, { method: "POST", body: { name: "Ops", layout: layout() } })).status,
    ).toBe(200);
    expect((await listMine(other)).map((l) => l.name)).toEqual(["Ops"]);
  });

  test("rename and delete answer 404 for somebody else's layout", async () => {
    const owner = await seedActor(["sales_orders.read"]);
    const stranger = await seedActor(["settings.manage"]);
    await req(owner, `/${TABLE}/layouts`, { method: "POST", body: { name: "Mine", layout: layout() } });
    const id = (await listMine(owner))[0]!.id;

    // Not 403: an id that isn't yours should not be confirmed to exist.
    expect(
      (await req(stranger, `/${TABLE}/layouts/${id}`, { method: "PATCH", body: { name: "Theirs" } })).status,
    ).toBe(404);
    expect((await req(stranger, `/${TABLE}/layouts/${id}`, { method: "DELETE" })).status).toBe(404);
    expect((await listMine(owner))[0]?.name).toBe("Mine");

    expect(
      (await req(owner, `/${TABLE}/layouts/${id}`, { method: "PATCH", body: { name: "Renamed" } })).status,
    ).toBe(200);
    expect((await listMine(owner))[0]?.name).toBe("Renamed");
    expect((await req(owner, `/${TABLE}/layouts/${id}`, { method: "DELETE" })).status).toBe(200);
    expect(await listMine(owner)).toEqual([]);
  });

  test("a blank or unusable name is refused, not stored", async () => {
    const user = await seedActor(["sales_orders.read"]);
    for (const name of ["", "   ", 42, null]) {
      const res = await req(user, `/${TABLE}/layouts`, { method: "POST", body: { name, layout: layout() } });
      expect(res.status).toBe(400);
    }
    expect(await listMine(user)).toEqual([]);
  });

  test("the live row cannot be deleted through the layouts route", async () => {
    const user = await seedActor(["sales_orders.read"]);
    await req(user, `/${TABLE}`, { method: "PUT", body: { layout: layout({ order: ["live"] }) } });
    const live = await env.DB.prepare(
      `SELECT id FROM table_layouts WHERE user_id = ? AND name IS NULL`,
    )
      .bind(user.id)
      .first<{ id: number }>();

    // Handing the live row's id to the named-layout route must miss entirely.
    expect((await req(user, `/${TABLE}/layouts/${Number(live?.id)}`, { method: "DELETE" })).status).toBe(404);
    const body = await (await req(user, "")).json<{ mine: Record<string, unknown> }>();
    expect(body.mine[TABLE]).toBeTruthy();
  });
});
