import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assrVisibilityPredicateSql } from "../src/services/assrVisibility";
import { assrCompanySql, canAccessServiceCases, holdsAnyCompanyGrant, holdsHouzsCompanyGrant } from "../src/routes/assr";

/**
 * Service Case visibility is decided by the COMPANY, not by a job title and not
 * by a name typed into a mirrored text field (owner decision 2026-08-20,
 * docs/SERVICE-CASE-VISIBILITY-DECISION.md).
 *
 * These tests pin the two halves of that decision so a later "tidy-up" cannot
 * quietly put the old, brittle inputs back:
 *
 *   1. ADMITTANCE — the HOUZS company grant admits; a `/^sales/i` position name
 *      does not admit on its own any more.
 *   2. ROW VISIBILITY — a scoped caller sees ONLY their own cases (owner ruling
 *      2026-09-28: "sales person cannot see all service case, they can see
 *      their own case and cust only"). Self + downline, keyed BY ID wherever an
 *      id exists; the legacy AutoCount `sales_agent` text is reached by a
 *      SELF-SCOPED substring match whose names are resolved in-SQL from the
 *      users master — never inlined as literals. This supersedes the
 *      2026-08-20 arm that opened every AutoCount-mirrored SO to whoever the
 *      company predicate admitted.
 *
 * The 2026-08 symptom stays closed: back then a batch of Sales Agents lost
 * every Service Case at once because the rule matched `sales_agent` against
 * name LITERALS baked into the query — a rename silently revoked access and
 * nothing said why. The name arm that exists now heals on the next query
 * (names come from the users master at execution time) and is ADDITIVE to five
 * id-keyed arms, never the only binding.
 */

const COMPANIES = [
  { id: 1, code: "HOUZS", name: "Houzs" },
  { id: 2, code: "2990", name: "2990" },
];

/** Minimal Hono-context stand-in — the company helpers read `.get()` only. */
function ctx(allowed: number[] | undefined, companies = COMPANIES) {
  const store: Record<string, unknown> = { companies, allowedCompanyIds: allowed };
  return { get: (k: string) => store[k] } as never;
}

/** Minimal AuthUser stand-in. */
function user(fields: Partial<{
  permissions: string[];
  position_name: string | null;
  department_name: string | null;
}> = {}) {
  return {
    id: 7,
    permissions: fields.permissions ?? [],
    permissions_set: new Set(fields.permissions ?? []),
    position_name: fields.position_name ?? null,
    department_name: fields.department_name ?? null,
  } as never;
}

const READ = ["service_cases.read"];

describe("admittance is keyed off a company grant, not the job title", () => {
  test("a HOUZS grantee with no service_cases permission and no Sales title is admitted", () => {
    expect(holdsHouzsCompanyGrant(ctx([1]))).toBe(true);
    expect(canAccessServiceCases(ctx([1]), user({ position_name: "Storekeeper" }), READ)).toBe(true);
  });

  test("a Sales TITLE alone no longer admits — this is the input the owner ruled out", () => {
    /* Granted NO company, so the grant term is false; the position/department are
       exactly what isSalesUser used to admit on. This case used to be written
       with ctx([2]) — granted only 2990 — which made it prove two things at once
       and then be cited as though 2990 were deliberately excluded. It was not:
       the ruling replaced the TITLE, and the HOUZS literal that shipped with it
       was narrower than the rule (docs/bugs/0621-*). Granted-nothing is the input
       that isolates the title. */
    expect(
      canAccessServiceCases(
        ctx([]),
        user({ position_name: "Sales Executive", department_name: "Sales Department" }),
        READ,
      ),
    ).toBe(false);
  });

  test("a 2990 grantee IS admitted — the gate asks WHICH company, not WHICH ONE", () => {
    /* 2026-07-20 already said Service Cases follow the caller's GRANTED
       companies and anticipated "a future 2990 rep's is {2990}"; 2026-08-20
       replaced the job title with a company grant and wrote HOUZS into it.
       Production had 8 non-archived 2990 cases at the 2026-08-21 census, so this
       is not a hypothetical tenant. */
    expect(canAccessServiceCases(ctx([2]), user({ position_name: "Storekeeper" }), READ)).toBe(true);
    expect(holdsAnyCompanyGrant(ctx([2]))).toBe(true);
  });

  test("ADMITTING IS NOT SHOWING — the door widens, the rows do not", () => {
    /* The reason widening the door is safe: every read is scoped by
       assrCompanySql -> allowedCompaniesSql, so a 2990 grantee sees 2990's
       cases. This pins the INPUT to that scoping rather than restating the SQL:
       the same context that admits also reports exactly one allowed company. */
    expect(assrCompanySql(ctx([2]), "company_id")).toContain("2");
    expect(assrCompanySql(ctx([2]), "company_id")).not.toContain("1,");
  });

  test("the permission holder is admitted regardless of company grant (legacy path, unchanged)", () => {
    expect(canAccessServiceCases(ctx([2]), user({ permissions: ["service_cases.read"] }), READ)).toBe(true);
    expect(canAccessServiceCases(ctx([]), user({ permissions: ["service_cases.read"] }), READ)).toBe(true);
  });

  test("a director is admitted regardless of company grant", () => {
    expect(canAccessServiceCases(ctx([]), user({ position_name: "Sales Director" }), READ)).toBe(true);
    expect(canAccessServiceCases(ctx([]), user({ permissions: ["*"] }), READ)).toBe(true);
  });

  test("no user is never admitted", () => {
    expect(canAccessServiceCases(ctx([1]), null, READ)).toBe(false);
    expect(canAccessServiceCases(ctx([1]), undefined, READ)).toBe(false);
  });

  test("the three company states: unresolved degrades, granted-nothing denies", () => {
    // undefined = company context unresolved (pre-migration / D1 mirror / cold
    // start). Degrade to the legacy single-company YES, exactly as
    // allowedCompaniesSql degrades to no predicate — a blip must not 403 everyone.
    expect(holdsHouzsCompanyGrant(ctx(undefined))).toBe(true);
    // [] = resolved, granted no active company.
    expect(holdsHouzsCompanyGrant(ctx([]))).toBe(false);
    // Granted only the other company.
    expect(holdsHouzsCompanyGrant(ctx([2]))).toBe(false);
    // Granted both.
    expect(holdsHouzsCompanyGrant(ctx([1, 2]))).toBe(true);
  });

  test("a companies master with no HOUZS row denies rather than inventing a grant", () => {
    expect(holdsHouzsCompanyGrant(ctx([2], [{ id: 2, code: "2990", name: "2990" }]))).toBe(false);
  });
});

describe("the row-visibility rule: ERP orders by id, AutoCount orders by company", () => {
  test("undefined = unrestricted emits NO predicate at all", () => {
    // The office / director tier must not be narrowed — owner 2026-08-20,
    // "要不然 office 的帮不到 sales 处理东西了". An emitted predicate here would
    // narrow them, so `null` (not an always-true string) is the contract.
    expect(assrVisibilityPredicateSql(undefined, "c.")).toBeNull();
  });

  test("an empty scope fails CLOSED", () => {
    expect(assrVisibilityPredicateSql([], "c.")).toBe("1=0");
    // `1=0` and not `false`, so the fragment stays valid on the D1/SQLite mirror.
    expect(assrVisibilityPredicateSql([], "c.")).not.toContain("false");
  });

  test("non-integer / non-positive ids are dropped, and dropping them ALL fails closed", () => {
    const sql = assrVisibilityPredicateSql([3, -1, 0, Number.NaN, 4], "c.") ?? "";
    expect(sql).toContain("IN (3,4)");
    expect(assrVisibilityPredicateSql([-1, 0], "c.")).toBe("1=0");
  });

  test("the id arms cover creator and BOTH assignees", () => {
    const sql = assrVisibilityPredicateSql([5], "c.") ?? "";
    expect(sql).toContain("c.created_by IN (5)");
    expect(sql).toContain("c.assigned_to IN (5)");
    expect(sql).toContain("c.assigned_to_2 IN (5)");
  });

  test("the open-to-company AutoCount arm is GONE — owner ruling 2026-09-28", () => {
    // 2026-08-20 admitted every non-ERP case to any company grantee; the owner
    // reversed that after a new Sales Executive's phone listed all 897 cases.
    // A scoped caller must never receive an arm that matches rows with no
    // linkage to them, which is what `doc_no NOT IN (all ERP docs)` was.
    const sql = assrVisibilityPredicateSql([5], "c.") ?? "";
    expect(sql).not.toContain("NOT IN");
  });

  test("the legacy AutoCount reach is SELF-scoped: own subtree names, resolved in-SQL", () => {
    // The arm that replaces it: the case's free-text sales_agent contains a
    // subtree member's display name — the SAME rule My Cases runs on
    // (myCasesPredicateSql), so the mobile board and the PC My Cases list can
    // never disagree about whose case it is. Names come from the users master
    // AT EXECUTION TIME (a rename heals on the next query), never as literals.
    const sql = assrVisibilityPredicateSql([5, 6], "c.") ?? "";
    expect(sql).toContain("SELECT ac.id FROM assr_cases ac, users nu");
    expect(sql).toContain("nu.id IN (5,6)");
    expect(sql).toContain(
      "LOWER(COALESCE(ac.sales_agent, '')) LIKE '%' || LOWER(TRIM(nu.name)) || '%'",
    );
    // An empty display name must not become LIKE '%%' (matches everything).
    expect(sql).toContain("TRIM(COALESCE(nu.name, '')) <> ''");
  });

  test("an ERP-native SO resolves the salesperson BY ID through scm.staff", () => {
    const sql = assrVisibilityPredicateSql([5], "c.") ?? "";
    expect(sql).toContain(`JOIN scm.staff es ON es.id = eo.salesperson_id`);
    expect(sql).toContain(`es.user_id IN (5)`);
  });

  test("name LITERALS are never inlined into the query — that is what broke in 2026-08", () => {
    // The names participate only through the users-master subquery; nothing a
    // caller's display name contains can appear in (or break) the SQL string.
    const sql = assrVisibilityPredicateSql([5, 6], "c.") ?? "";
    expect(sql).not.toMatch(/LIKE '%[^']/); // only the '%' || … || '%' shape
  });

  test("blank doc_no cannot match a blank order number", () => {
    const sql = assrVisibilityPredicateSql([5], "c.") ?? "";
    expect(sql).toContain("eo.doc_no IS NOT NULL");
    expect(sql).toContain("eo.doc_no <> ''");
  });

  test("'the ERP order' means the same thing here as it does on the CREATE path", () => {
    // fetchScmSoContext (services/assr.ts) resolves a doc_no to its ERP order
    // with exactly this status filter. Two definitions of the same object inside
    // one module is the drift this repo keeps paying for.
    const sql = assrVisibilityPredicateSql([5], "c.") ?? "";
    const armed = sql.match(/eo\.status <> 'DRAFT' AND eo\.status <> 'CANCELLED'/g) ?? [];
    expect(armed.length).toBe(1);
  });

  test("the case's doc_no is never referenced INSIDE a subquery", () => {
    // With a correlated `EXISTS (... WHERE LOWER(eo.doc_no) = LOWER(doc_no))` and
    // an unaliased outer table, the inner `doc_no` binds to eo.doc_no and the
    // condition degenerates to true for every row. The rule must keep the case's
    // column on the LEFT of the IN, in the outer scope.
    const sql = assrVisibilityPredicateSql([5], "assr_cases.") ?? "";
    for (const sub of sql.matchAll(/\(SELECT [^()]*(?:\([^()]*\)[^()]*)*\)/g)) {
      expect(sub[0]).not.toContain("assr_cases.");
    }
  });

  test("the prefix is honoured for every alias the readers use", () => {
    for (const prefix of ["c.", "ca.", "a.", "assr_cases."]) {
      const sql = assrVisibilityPredicateSql([9], prefix) ?? "";
      expect(sql).toContain(`${prefix}created_by IN (9)`);
      expect(sql).toContain(`LOWER(COALESCE(${prefix}doc_no, ''))`);
    }
  });
});

const REPO_BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const READERS = [
  "src/routes/assr.ts",
  "src/services/assr.ts",
  "src/routes/assr_print.ts",
];

describe("the row-visibility rule has exactly one home", () => {
  test("the scan can see the shape it bans", () => {
    // A guard that cannot match reports a clean run (CLAUDE.md, trap 3). Pin the
    // pattern against the exact text the two former twins carried.
    const HAND_COPY = /assigned_to_2 IN \(/;
    expect(HAND_COPY.test("`${prefix}assigned_to_2 IN (${idList})`")).toBe(true);
    expect(HAND_COPY.test("c.assigned_to_2 IN (?,?)")).toBe(true);
    expect(HAND_COPY.test("assigned_to_2 = ?")).toBe(false);
  });

  test("the files it scans exist — a moved path must not pass in silence", () => {
    for (const rel of READERS) {
      expect(fs.existsSync(path.join(REPO_BACKEND, rel)), `${rel} is missing`).toBe(true);
    }
  });

  test("no reader re-states the id clause; they all go through the predicate builder", () => {
    // routes/assr.ts and services/assr.ts each carried their own copy of this
    // rule and drifted — the list disagreed with its own totals
    // (fix/assr-aggregate-scope). Both now delegate, so the clause must appear in
    // assrVisibility.ts and nowhere else.
    for (const rel of READERS) {
      const src = fs.readFileSync(path.join(REPO_BACKEND, rel), "utf8");
      expect(/assigned_to_2 IN \(/.test(src), `${rel} carries a second copy of the visibility rule`).toBe(false);
    }
    const home = fs.readFileSync(path.join(REPO_BACKEND, "src/services/assrVisibility.ts"), "utf8");
    expect(/assigned_to_2 IN \(/.test(home)).toBe(true);
  });
});
