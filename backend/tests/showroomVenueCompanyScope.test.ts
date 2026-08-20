// The showroom/venue masters are PER-COMPANY. Owner 2026-08-19, after seeing
// 2990's showrooms offered to a Houzs user raising a project: "客人开单不能看到
// 2990 的展厅啊。分开的公司都不一样啊，收入单也不一样。venue 都不一样啊" and
// "我们的 Venue、我们的 Warehouse、我们的 Showroom 等等，都是跟着看到自己公司的".
//
// WHY THIS IS A SOURCE-SHAPE TEST AND NOT AN INTEGRATION TEST.
// The statement being guarded reads `scm.warehouses`, which exists in Postgres
// ONLY — the D1 test mirror has a plain `warehouses` table and no `scm.` one
// (migrations/141 says so in as many words). The route wraps its showroom half
// in try/catch and degrades to an empty list when that read throws, so a
// request-level test would return `[]` whether or not the predicate is there:
// a vacuous pass, which CLAUDE.md names as its own bug class ("a verdict
// computed over nothing must never read as a pass"). Asserting the SQL SHAPE is
// the strongest check that can actually fail here.
//
// Both locators THROW when they cannot find their statement, so deleting or
// renaming the handler fails this test loudly instead of silently checking
// nothing.
import { describe, expect, test } from "vitest";

function onlySource(glob: Record<string, string>, what: string): string {
  const paths = Object.keys(glob);
  if (paths.length !== 1) {
    throw new Error(
      `expected exactly one ${what} source, found ${paths.length}: ${paths.join(", ") || "(none)"}`,
    );
  }
  return glob[paths[0]];
}

const projectsSrc = onlySource(
  import.meta.glob("../src/routes/projects.ts", {
    eager: true, query: "?raw", import: "default",
  }) as Record<string, string>,
  "routes/projects.ts",
);

const mfgSoSrc = onlySource(
  import.meta.glob("../src/scm/routes/mfg-sales-orders.ts", {
    eager: true, query: "?raw", import: "default",
  }) as Record<string, string>,
  "scm/routes/mfg-sales-orders.ts",
);

/** The SELECT statement a locator points at, from `SELECT` to its closing
 *  backtick. Throws rather than returning "" when the anchor is gone. */
function statementContaining(src: string, anchor: string, what: string): string {
  const at = src.indexOf(anchor);
  if (at < 0) throw new Error(`${what}: anchor not found in source: ${anchor}`);
  const open = src.lastIndexOf("`", at);
  const close = src.indexOf("`", at);
  if (open < 0 || close < 0) throw new Error(`${what}: could not delimit the statement`);
  return src.slice(open, close + 1);
}

describe("showroom venue picker is company-scoped", () => {
  const stmt = statementContaining(
    projectsSrc,
    "FROM scm.warehouses",
    "GET /api/projects/venues showroom half",
  );

  test("the statement this test guards still exists", () => {
    expect(stmt).toContain("is_showroom = true");
    expect(stmt).toContain("venue_name");
  });

  test("it carries a company predicate", () => {
    // activeCompanySql(c, col) yields ` AND <col> = <active>`, or ` AND 1=0`
    // when the context resolved to no company. Interpolating it is the whole
    // tenant boundary here: the SCM client is service-role and bypasses RLS.
    expect(stmt).toMatch(/activeCompanySql\(\s*c\s*,\s*["']company_id["']\s*\)/);
  });

  test("the project_venues half it merges with is scoped too", () => {
    const pv = statementContaining(
      projectsSrc,
      "FROM project_venues\n      WHERE active = 1",
      "GET /api/projects/venues project half",
    );
    expect(pv).toContain("activeCompanySql(c)");
  });
});

describe("SO active-venue autofill maps the venue name within one company", () => {
  const stmt = statementContaining(
    mfgSoSrc,
    "SELECT id FROM project_venues",
    "GET active-venue project_venues id lookup",
  );

  test("the statement this test guards still exists", () => {
    expect(stmt).toContain("lower(trim(name))");
    expect(stmt).toContain("active = 1");
  });

  // Venue NAMES are not unique across the two companies' masters, so an
  // unscoped name match can return the OTHER company's project_venues id — and
  // that id is what the SO dropdown then selects and stores.
  test("it carries a company predicate", () => {
    expect(stmt).toContain("activeCompanySql(c)");
  });
});
