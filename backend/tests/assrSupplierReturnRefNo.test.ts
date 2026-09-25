// Service-case document numbers (owner 2026-09-24):
//   · every supplier return (返厂 trip) carries its own SVC-RTN-YYMM-NNNN,
//     minted through the company-wide registry, and removing a trip VOIDS the
//     number instead of freeing it;
//   · the case number ASSR/YYMM-NNN takes its month in Malaysia time (it used
//     UTC, so a case opened before 08:00 MYT on the 1st got last month's
//     number).
// The D1 mirror has no scm.next_doc_no_n, so both run the floor + 1 fallback;
// the counter path is the SCM one (mig 0316) and is pinned by the SCM suites.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { nextAssrNumber } from "../src/services/assr";
import { archiveSupplierReturn, listSupplierReturns } from "../src/services/assrSupplierReturns";
import { findRef, yymmFor } from "../src/services/documentRefs";

const SEP = Date.parse("2026-09-15T10:00:00Z");
// 2026-09-30 23:30 UTC = 07:30 MYT on 1 Oct — UTC still says September.
const OCT_BY_MYT = Date.parse("2026-09-30T23:30:00Z");

describe("service-case document numbers", () => {
  beforeAll(async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS document_refs (
         ref_no TEXT PRIMARY KEY, series TEXT NOT NULL, dept_code TEXT NOT NULL, type_code TEXT NOT NULL,
         yymm TEXT NOT NULL, seq INTEGER NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'ACTIVE', created_by INTEGER, created_at TEXT NOT NULL,
         voided_by INTEGER, voided_at TEXT, void_reason TEXT, UNIQUE (entity_type, entity_id))`,
    ).run();
  });

  test("the case number's month is Malaysia time, not UTC", async () => {
    expect(await nextAssrNumber(env, OCT_BY_MYT)).toBe("ASSR/2610-001");
  });

  test("the case number continues from the month's live max", async () => {
    await env.DB.prepare(`INSERT INTO assr_cases (assr_no, doc_no) VALUES ('ASSR/2609-007', 'SO-T1')`).run();
    expect(await nextAssrNumber(env, SEP)).toBe("ASSR/2609-008");
  });

  test("each trip gets its own SVC-RTN number, stored on the row, stable on re-read", async () => {
    const kase = await env.DB.prepare(
      `INSERT INTO assr_cases (assr_no, doc_no) VALUES ('ASSR/2609-900', 'SO-T2') RETURNING id`,
    ).first<{ id: number }>();
    const caseId = Number(kase!.id);
    for (const round of [1, 2]) {
      await env.DB.prepare(`INSERT INTO assr_supplier_returns (assr_id, round_no, created_by) VALUES (?, ?, 1)`)
        .bind(caseId, round)
        .run();
    }

    const series = `SVC-RTN-${yymmFor(Date.now())}`;
    const first = (await listSupplierReturns(env, caseId)) as Array<{ id: number; ref_no: string }>;
    expect(first.map((r) => r.ref_no)).toEqual([`${series}-0001`, `${series}-0002`]);

    const stored = await env.DB.prepare(`SELECT ref_no FROM assr_supplier_returns WHERE assr_id = ? ORDER BY round_no`)
      .bind(caseId)
      .all<{ ref_no: string }>();
    expect(stored.results.map((r) => r.ref_no)).toEqual([`${series}-0001`, `${series}-0002`]);

    const again = (await listSupplierReturns(env, caseId)) as Array<{ ref_no: string }>;
    expect(again.map((r) => r.ref_no)).toEqual([`${series}-0001`, `${series}-0002`]);

    // Removing a trip voids its number; it is never handed out again.
    expect(await archiveSupplierReturn(env, caseId, first[1].id, 1)).toBe(true);
    expect(await findRef(env, `${series}-0002`)).toMatchObject({ status: "VOID", entityType: "assr_supplier_return" });
    await env.DB.prepare(`INSERT INTO assr_supplier_returns (assr_id, round_no, created_by) VALUES (?, 3, 1)`)
      .bind(caseId)
      .run();
    const after = (await listSupplierReturns(env, caseId)) as Array<{ round_no: number; ref_no: string }>;
    expect(after.map((r) => [r.round_no, r.ref_no])).toEqual([
      [1, `${series}-0001`],
      [3, `${series}-0003`],
    ]);
  });
});
