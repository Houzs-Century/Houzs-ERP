import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Service Case SO picker (GET /api/assr/search-so) merges two sources. Its
 * SCM arm must match `linked_ac_docno` alongside doc_no / ref / debtor_name:
 * migrated and write-back orders carry the ERP number in doc_no (HC-SO-…) and
 * their ORIGIN AutoCount number in linked_ac_docno (mig 0271), and the
 * AutoCount number is the one customers quote. Before this pin the arm searched
 * only the three legacy columns, so searching "001934" for an order the system
 * held answered "No matching sales orders" (owner sighting 2026-08-28,
 * docs/bugs/0553-service-so-picker-cannot-find-a-migrated-order-by-its-autoco.md).
 *
 * Pinned by source shape, not behaviour: the D1 test mirror does not carry the
 * scm schema (see assrCompanyScope.test.ts), so this query cannot execute here.
 * Same pattern as assrVisibilityRule.test.ts's single-home scan — and per
 * CLAUDE.md trap 3, the anchors assert their own existence so a moved handler
 * fails this file loudly instead of letting it scan nothing.
 */

const SRC = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/routes/assr.ts"),
  "utf8",
);

/** The SCM arm of search-so: from its prepare anchor to its .all(). */
function scmArm(): string {
  const start = SRC.indexOf("const scmRows");
  expect(start, "search-so's SCM arm anchor (const scmRows) is gone — re-point this scan").toBeGreaterThan(-1);
  const end = SRC.indexOf(".all()", start);
  expect(end, "the SCM arm no longer ends in .all()").toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe("search-so SCM arm matches the linked AutoCount number", () => {
  test("linked_ac_docno is in the OR group, lowered and null-safe like its siblings", () => {
    expect(scmArm()).toContain("OR LOWER(COALESCE(so.linked_ac_docno, '')) LIKE ?");
  });

  test("the OR group and the bind list agree — every LIKE placeholder is bound", () => {
    const arm = scmArm();
    expect((arm.match(/LIKE \?/g) ?? []).length).toBe(4);
    const bind = arm.match(/\.bind\(([^)]*)\)/);
    expect(bind, "the SCM arm's bind() call is gone").not.toBeNull();
    const args = (bind as RegExpMatchArray)[1].split(",").map((s) => s.trim()).filter(Boolean);
    expect(args).toEqual(["pattern", "pattern", "pattern", "pattern"]);
  });

  test("widening the match did not loosen the gates — status filter and company scope stay", () => {
    const arm = scmArm();
    expect(arm).toContain("so.status <> 'DRAFT' AND so.status <> 'CANCELLED'");
    expect(arm).toContain("${coFilter}");
  });
});
