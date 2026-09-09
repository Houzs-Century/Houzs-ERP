// Document reference numbers (services/documentRefs.ts, mig 20260906T1417):
// [DEPT]-[TYPE]-[YYMM]-[NNNN], minted per (department, type, month). The D1
// mirror has no scm.next_doc_no_n, so these run the FALLBACK path — floor + 1
// guarded by the registry's primary key with retry — which is exactly the
// path that must stay correct when the counter is absent. The counter path
// itself is the SCM one (mig 0316) and is pinned by the SCM suites.
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, describe, expect, test } from "vitest";
import documentRefRoutes from "../src/routes/documentRefs";
import {
  findRef,
  findRefForEntity,
  formatRefNo,
  getDocumentType,
  listDocumentTypes,
  mintDocumentRef,
  normaliseCode,
  voidDocumentRef,
  yymmFor,
} from "../src/services/documentRefs";

const state = { user: undefined as unknown };
const app = new Hono();
app.use("*", async (c: never, next: never) => {
  (c as { set: (k: string, v: unknown) => void }).set("user", state.user);
  await (next as unknown as () => Promise<void>)();
});
app.route("/api", documentRefRoutes);
const ADMIN = { id: 1, permissions: ["settings.manage"], permissions_set: new Set(["settings.manage"]) };
const STAFF = { id: 2, permissions: [] as string[], permissions_set: new Set<string>() };
async function call(user: unknown, path: string, init?: RequestInit) {
  state.user = user;
  const res = await app.request(path, init, env as never);
  return { status: res.status, body: (await res.json()) as any };
}
const json = (method: string, payload: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

// 2026-09-15 10:00 UTC = 18:00 MYT, September; 2026-09-30 17:00 UTC = 01:00 MYT on 1 Oct.
const SEP = Date.parse("2026-09-15T10:00:00Z");
const OCT_BY_MYT = Date.parse("2026-09-30T17:00:00Z");

describe("document reference numbers", () => {
  beforeAll(async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS document_refs (
         ref_no TEXT PRIMARY KEY, series TEXT NOT NULL, dept_code TEXT NOT NULL, type_code TEXT NOT NULL,
         yymm TEXT NOT NULL, seq INTEGER NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'ACTIVE', created_by INTEGER, created_at TEXT NOT NULL,
         voided_by INTEGER, voided_at TEXT, void_reason TEXT, UNIQUE (entity_type, entity_id))`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS document_types (
         code TEXT PRIMARY KEY, label TEXT NOT NULL, attachment_required INTEGER NOT NULL DEFAULT 0,
         is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT)`,
    ).run();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO document_types (code, label, attachment_required, is_active, created_at) VALUES ('ANN', 'Announcement', 0, 1, '2026-09-06T00:00:00Z')`,
    ).run();
  });

  test("the pieces: MYT month, code normalisation, the number's shape", () => {
    expect(yymmFor(SEP)).toBe("2609");
    expect(yymmFor(OCT_BY_MYT)).toBe("2610"); // already October in Kuala Lumpur
    expect(normaliseCode(" ops ")).toBe("OPS");
    expect(normaliseCode("ANN")).toBe("ANN");
    expect(normaliseCode("A")).toBeNull();
    expect(normaliseCode("OPS1")).toBeNull();
    expect(normaliseCode("TOOLONG")).toBeNull();
    expect(formatRefNo("OPS", "ANN", "2609", 7)).toBe("OPS-ANN-2609-0007");
  });

  test("mints 0001, 0002 … per (department, type, month); a second department or month starts over", async () => {
    const a = await mintDocumentRef(env, { deptCode: "ops", typeCode: "ann", entityType: "announcement", entityId: "ann-1", createdBy: 1, now: SEP });
    const b = await mintDocumentRef(env, { deptCode: "OPS", typeCode: "ANN", entityType: "announcement", entityId: "ann-2", createdBy: 1, now: SEP });
    expect(a.refNo).toBe("OPS-ANN-2609-0001");
    expect(b.refNo).toBe("OPS-ANN-2609-0002");
    expect(b).toMatchObject({ series: "OPS-ANN-2609", deptCode: "OPS", typeCode: "ANN", yymm: "2609", seq: 2, status: "ACTIVE", createdBy: 1 });
    const fin = await mintDocumentRef(env, { deptCode: "FIN", typeCode: "ANN", entityType: "announcement", entityId: "ann-3", createdBy: 1, now: SEP });
    expect(fin.refNo).toBe("FIN-ANN-2609-0001");
    const oct = await mintDocumentRef(env, { deptCode: "OPS", typeCode: "ANN", entityType: "announcement", entityId: "ann-4", createdBy: 1, now: OCT_BY_MYT });
    expect(oct.refNo).toBe("OPS-ANN-2610-0001");
  });

  test("a record that already holds a number gets the same one back — a retried save never mints twice", async () => {
    const again = await mintDocumentRef(env, { deptCode: "OPS", typeCode: "ANN", entityType: "announcement", entityId: "ann-1", createdBy: 9, now: SEP });
    expect(again.refNo).toBe("OPS-ANN-2609-0001");
    expect(await findRefForEntity(env, "announcement", "ann-1")).toMatchObject({ refNo: "OPS-ANN-2609-0001" });
  });

  test("a number taken between the floor read and the insert is skipped, not re-issued", async () => {
    // Simulate a concurrent writer that grabbed 0003 first.
    await env.DB.prepare(
      `INSERT INTO document_refs (ref_no, series, dept_code, type_code, yymm, seq, entity_type, entity_id, status, created_by, created_at)
       VALUES ('OPS-ANN-2609-0003', 'OPS-ANN-2609', 'OPS', 'ANN', '2609', 3, 'announcement', 'ann-race', 'ACTIVE', 5, '2026-09-15T10:00:00Z')`,
    ).run();
    const next = await mintDocumentRef(env, { deptCode: "OPS", typeCode: "ANN", entityType: "announcement", entityId: "ann-5", createdBy: 1, now: SEP });
    expect(next.refNo).toBe("OPS-ANN-2609-0004");
  });

  test("void keeps the number and its place: the next mint moves on, the registry remembers who and why", async () => {
    const v = await voidDocumentRef(env, "ops-ann-2609-0002", 7, "Posted in error", SEP);
    expect(v).toMatchObject({ refNo: "OPS-ANN-2609-0002", status: "VOID", voidedBy: 7, voidReason: "Posted in error" });
    expect(await findRef(env, "OPS-ANN-2609-0002")).toMatchObject({ status: "VOID" });
    const next = await mintDocumentRef(env, { deptCode: "OPS", typeCode: "ANN", entityType: "announcement", entityId: "ann-6", createdBy: 1, now: SEP });
    expect(next.refNo).toBe("OPS-ANN-2609-0005"); // 0002 is not re-used
    // Idempotent.
    expect(await voidDocumentRef(env, "OPS-ANN-2609-0002", 8, "again", SEP)).toMatchObject({ voidedBy: 7 });
    expect(await voidDocumentRef(env, "OPS-ANN-2609-9999", 8, "x", SEP)).toBeNull();
  });

  test("bad codes are refused before anything is minted", async () => {
    await expect(
      mintDocumentRef(env, { deptCode: "O", typeCode: "ANN", entityType: "x", entityId: "y", createdBy: null }),
    ).rejects.toThrow(/Department code/);
    await expect(
      mintDocumentRef(env, { deptCode: "OPS", typeCode: "A1", entityType: "x", entityId: "y", createdBy: null }),
    ).rejects.toThrow(/type code/);
    expect(await findRef(env, "not a number")).toBeNull();
  });

  test("routes: resolve a number; list / add / edit document types behind settings.manage", async () => {
    const r = await call(STAFF, "/api/document-refs/ops-ann-2609-0001");
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ refNo: "OPS-ANN-2609-0001", entityType: "announcement", entityId: "ann-1", status: "ACTIVE" });
    expect((await call(STAFF, "/api/document-refs/OPS-ANN-2609-0099")).status).toBe(404);

    const types = await call(STAFF, "/api/document-types");
    expect(types.body.data).toEqual([{ code: "ANN", label: "Announcement", attachmentRequired: false, isActive: true }]);

    expect((await call(STAFF, "/api/document-types", json("POST", { code: "SOP", label: "Standard operating procedure" }))).status).toBe(403);
    const created = await call(ADMIN, "/api/document-types", json("POST", { code: "sop", label: "Standard operating procedure", attachmentRequired: true }));
    expect(created.status).toBe(201);
    expect(created.body.data).toEqual({ code: "SOP", label: "Standard operating procedure", attachmentRequired: true, isActive: true });
    expect((await call(ADMIN, "/api/document-types", json("POST", { code: "SOP", label: "dup" }))).status).toBe(409);
    expect((await call(ADMIN, "/api/document-types", json("POST", { code: "S", label: "bad" }))).status).toBe(400);

    const edited = await call(ADMIN, "/api/document-types/ann", json("PATCH", { attachmentRequired: true, isActive: false }));
    expect(edited.status).toBe(200);
    expect(edited.body.data).toEqual({ code: "ANN", label: "Announcement", attachmentRequired: true, isActive: false });
    expect((await call(STAFF, "/api/document-types")).body.data.map((t: { code: string }) => t.code)).toEqual(["SOP"]);
    expect((await call(STAFF, "/api/document-types?all=1")).body.data.map((t: { code: string }) => t.code)).toEqual(["ANN", "SOP"]);
    expect(await getDocumentType(env, "ann")).toMatchObject({ attachmentRequired: true });
    expect((await listDocumentTypes(env)).map((t) => t.code)).toEqual(["SOP"]);
    expect((await call(ADMIN, "/api/document-types/ZZZ", json("PATCH", { label: "x" }))).status).toBe(404);
    expect((await call(ADMIN, "/api/document-types/SOP", json("PATCH", {}))).status).toBe(400);
  });
});
