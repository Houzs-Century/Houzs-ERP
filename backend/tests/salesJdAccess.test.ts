import { describe, expect, test } from "vitest";
import { applySalesJdOverride, salesJdDenial } from "../src/services/salesJdAccess";
import type { AccessLevel } from "../src/services/pageAccess";

/* The Sales JD is a RULE, not a setting (owner 2026-07-17: "用coding 去改backend
   … 把整個sales department的這個移除掉 根據我們的指令來做"). These lock the rule
   itself — the matrix cannot be trusted to express it and a mis-click must not
   be able to kill the document chain at step one. */

const MATRIX_SAYS_VIEW: Record<string, AccessLevel> = {
  "scm.sales.orders": "view",
  "scm.sales.delivery": "view",
  "scm.sales.invoices": "view",
  "scm.sales.returns": "view",
  "projects": "view",
};

const salesRep = {
  permissions: new Set<string>(["scm.access"]),
  position_name: "Sales Executive",
  department_name: "Sales Department",
};

describe("Sales JD override", () => {
  test("Sales OWNS the SO — edit, whatever the matrix says", () => {
    const out = applySalesJdOverride(MATRIX_SAYS_VIEW, salesRep);
    expect(out["scm.sales.orders"]).toBe("edit");
  });

  test("Office operates DO + SI — Sales only looks", () => {
    const out = applySalesJdOverride(
      { ...MATRIX_SAYS_VIEW, "scm.sales.delivery": "full", "scm.sales.invoices": "edit" },
      salesRep,
    );
    expect(out["scm.sales.delivery"]).toBe("view");
    expect(out["scm.sales.invoices"]).toBe("view");
  });

  test("Delivery Returns is off for the cohort — including the director", () => {
    expect(applySalesJdOverride(MATRIX_SAYS_VIEW, salesRep)["scm.sales.returns"]).toBe("none");
    expect(
      applySalesJdOverride(MATRIX_SAYS_VIEW, {
        permissions: new Set<string>(),
        position_name: "Sales Director",
        department_name: "Sales Department",
      })["scm.sales.returns"],
    ).toBe("none");
  });

  test("the `*` wildcard is UNTOUCHED — narrowing it would lock the owner out", () => {
    const full: Record<string, AccessLevel> = { "scm.sales.returns": "full" };
    const out = applySalesJdOverride(full, {
      permissions: new Set<string>(["*"]),
      position_name: "Owner",
      department_name: "Management",
    });
    expect(out).toBe(full);
    expect(out["scm.sales.returns"]).toBe("full");
  });

  test("non-Sales is untouched — Office keeps what its position grants", () => {
    const office: Record<string, AccessLevel> = {
      "scm.sales.delivery": "edit",
      "scm.sales.invoices": "edit",
      "scm.sales.returns": "edit",
    };
    const out = applySalesJdOverride(office, {
      permissions: new Set<string>(),
      position_name: "Operation Executive",
      department_name: "Operation Department",
    });
    expect(out).toBe(office);
    expect(out["scm.sales.delivery"]).toBe("edit");
  });

  test("cohort matches on DEPARTMENT even when the position name does not start with Sales", () => {
    const out = applySalesJdOverride(MATRIX_SAYS_VIEW, {
      permissions: new Set<string>(),
      position_name: "Senior Account Executive",
      department_name: "Sales Department",
    });
    expect(out["scm.sales.orders"]).toBe("edit");
  });

  test("pages outside the SCM sales chain are left to the matrix", () => {
    const out = applySalesJdOverride(MATRIX_SAYS_VIEW, salesRep);
    expect(out["projects"]).toBe("view");
  });

  /* RULED 2026-07-18 — owner: "DO SI 只能看 salesdirector". The Sales Director
     matches isSalesCohort, so the JD is SET on him and CAPS him at `view` on
     DO/SI whatever his matrix row grants. His matrix row is `scm.sales = full`
     (prod snapshot, id 5); a `scm.sales` row makes him scm_l2_configured, so the
     cap is ENFORCED, not decorative — the area-guard requires `edit` for a DO/SI
     write and `view` fails it (a real 403). This was the one open question from
     2026-07-17 ("算sales" settled the cohort, not the DO/SI cap); the owner has
     now settled it, and the answer is the behaviour this test already pinned.
     It stays here so any future removal of the cap is a deliberate, visible
     change against a stated ruling rather than a silent side effect. */
  test("RULED 2026-07-18: the Sales Director is capped at view on DO/SI", () => {
    const director = {
      permissions: new Set<string>(["scm.access"]),
      position_name: "Sales Director",
      department_name: "Sales Department",
    };
    const out = applySalesJdOverride(
      { ...MATRIX_SAYS_VIEW, "scm.sales.delivery": "full", "scm.sales.invoices": "edit" },
      director,
    );
    expect(out["scm.sales.delivery"]).toBe("view");
    expect(out["scm.sales.invoices"]).toBe("view");
  });

  /* `role_page_access` is still live (auth.ts:297) — a user with NO position
     hydrates from the ROLE matrix and lands here anyway, because the cohort is
     keyed on department_name, which is independent of position_id. Any rule
     added to this file must keep working for them. */
  test("a Sales user with NO position still gets the JD (cohort is the department)", () => {
    const out = applySalesJdOverride(MATRIX_SAYS_VIEW, {
      permissions: new Set<string>(["scm.access"]),
      position_name: null,
      department_name: "Sales Department",
    });
    expect(out["scm.sales.orders"]).toBe("edit");
  });
});

/* THE DENY HALF — salesJdDenial, consulted by scmAreaGuard BEFORE the
   `scm_l2_configured` no-lockout fallthrough and by the DR report handler.
   Until 2026-07-17 the `"none"` above was theatre: a rep has no explicit `scm*`
   row, so the guard fell straight through and the Delivery Returns URL returned
   real data behind a hidden nav entry. Owner: "该关（我确实讲过 / 就是要关）" +
   "sales director 算sales". These lock BOTH directions — that the door is shut
   for the cohort, and that it moved for NOBODY else. */
describe("Sales JD deny — scm.sales.returns", () => {
  const RETURNS = "scm.sales.returns";

  test("a Sales rep is DENIED returns — no scm_l2_configured needed", () => {
    expect(salesJdDenial(salesRep, RETURNS)).toBeTruthy();
  });

  test("a Sales DIRECTOR is DENIED returns — owner: sales director 算sales", () => {
    expect(
      salesJdDenial(
        {
          permissions: new Set<string>(["scm.access"]),
          position_name: "Sales Director",
          department_name: "Sales Department",
        },
        RETURNS,
      ),
    ).toBeTruthy();
  });

  test("the denial is a plain-language sentence, not a code", () => {
    const msg = salesJdDenial(salesRep, RETURNS)!;
    expect(msg).toContain("Office");
    // No key, no level, no HTTP jargon leaking into the user's face.
    expect(msg).not.toContain("scm.sales");
    expect(msg).not.toMatch(/403|Forbidden/i);
  });

  test("the `*` wildcard is DENIED NOTHING — narrowing it would lock the owner out", () => {
    expect(
      salesJdDenial(
        { permissions: new Set<string>(["*"]), position_name: "Owner", department_name: "Management" },
        RETURNS,
      ),
    ).toBeNull();
    // Even a Sales-department `*` holder (Owner filed under Sales) stays exempt.
    expect(
      salesJdDenial(
        { permissions: ["*"], position_name: "Sales Director", department_name: "Sales Department" },
        RETURNS,
      ),
    ).toBeNull();
  });

  test("Office is UNCHANGED — the deny is the cohort's, not everyone's", () => {
    const office = {
      permissions: new Set<string>(["scm.access"]),
      position_name: "Operation Executive",
      department_name: "Operation Department",
    };
    expect(salesJdDenial(office, RETURNS)).toBeNull();
  });

  /* THE BLAST-RADIUS TEST. The rule must move EXACTLY ONE key. If a future edit
     adds a second `"none"` to SALES_JD, or points the deny at the `view` caps,
     this fails — which is the point: `delivery`/`invoices` at `view` are #671's
     INFERENCE about "销售人员" and enforcing them here would strip a Sales
     Director's DO/SI writes on something the owner never said. */
  test("NOTHING ELSE is denied — not even the JD's own `view` caps", () => {
    for (const area of [
      "scm.sales.orders",
      "scm.sales.delivery",
      "scm.sales.invoices",
      "scm.procurement.po",
      "scm.warehouse.inventory",
      "scm.finance.outstanding",
      "projects",
    ]) {
      expect(salesJdDenial(salesRep, area)).toBeNull();
    }
  });

  /* The two callers pass DIFFERENT shapes: scmAreaGuard holds an AuthUser
     (permissions_set), the DR report handler holds `houzsUser` (permissions
     array, every field optional). One predicate answers for both or the two
     doors drift. */
  test("reads both caller shapes — AuthUser's permissions_set and houzsUser's array", () => {
    expect(
      salesJdDenial(
        { permissions_set: new Set<string>(["scm.access"]), position_name: "Sales Executive", department_name: "Sales Department" },
        RETURNS,
      ),
    ).toBeTruthy();
    expect(
      salesJdDenial(
        { permissions: ["scm.access"], position_name: "Sales Executive", department_name: "Sales Department" },
        RETURNS,
      ),
    ).toBeTruthy();
  });

  /* Fail-OPEN on an unidentifiable caller, pinned deliberately rather than left
     to be discovered. This predicate only ADDS a denial on top of gates that
     already ran; denying on missing data would lock people out on a bridge hiccup. */
  test("an unidentifiable caller is not denied — this only ever ADDS a deny", () => {
    expect(salesJdDenial(undefined, RETURNS)).toBeNull();
    expect(salesJdDenial(null, RETURNS)).toBeNull();
    expect(salesJdDenial({ permissions: [], position_name: null, department_name: null }, RETURNS)).toBeNull();
  });
});
