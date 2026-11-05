import { describe, it, expect } from "vitest";
import { podWriteScopeCompany } from "./deliveryScope";

/* The company a DO status WRITE scopes to. A bypassed driver completing their
 * OWN POD acts on the DO's own company (one lorry carries both companies' goods,
 * no switcher on the phone); everyone else stays on the active company. The
 * caller's company grant is the outer boundary — a DO in no granted company
 * (null) is "not your job", never a cross-company confirmation. */
describe("podWriteScopeCompany", () => {
  it("a non-driver (real-access) caller always uses the ACTIVE company", () => {
    expect(podWriteScopeCompany(false, null)).toEqual({ kind: "active" });
    expect(podWriteScopeCompany(false, 2)).toEqual({ kind: "active" });
  });

  it("a driver POD on a DO in a granted company acts on the DO's OWN company", () => {
    expect(podWriteScopeCompany(true, 2)).toEqual({ kind: "do_company", companyId: 2 });
    expect(podWriteScopeCompany(true, 1)).toEqual({ kind: "do_company", companyId: 1 });
  });

  it("a driver POD on a DO in NO granted company is not_your_job (no leak)", () => {
    expect(podWriteScopeCompany(true, null)).toEqual({ kind: "not_your_job" });
    expect(podWriteScopeCompany(true, undefined)).toEqual({ kind: "not_your_job" });
  });

  it("a driver POD with a nonsense company id is not_your_job, never active", () => {
    expect(podWriteScopeCompany(true, 0)).toEqual({ kind: "not_your_job" });
    expect(podWriteScopeCompany(true, -1)).toEqual({ kind: "not_your_job" });
    expect(podWriteScopeCompany(true, 1.5)).toEqual({ kind: "not_your_job" });
  });
});
