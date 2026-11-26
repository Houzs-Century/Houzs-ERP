import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { collaboratorEntries, collaboratorNames, collaboratorLabel } from "./so-collaborators";


const staff = [
  { id: "s-1", name: "Stanley" },
  { id: "s-2", name: "alicia" },
  { id: "s-3", name: "", staffCode: "HZ-009" },
];

describe("collaboratorNames", () => {
  it("resolves ids to names, A→Z and case-insensitively", () => {
    expect(collaboratorNames({ collaborator_staff_ids: ["s-1", "s-2"] }, staff))
      .toEqual(["alicia", "Stanley"]);
  });

  it("falls back to the staff code when a person has no display name", () => {
    expect(collaboratorNames({ collaborator_staff_ids: ["s-3"] }, staff))
      .toEqual(["HZ-009"]);
  });

  it("says Unknown user rather than printing a uuid", () => {
    expect(collaboratorNames({ collaborator_staff_ids: ["nope"] }, staff))
      .toEqual(["Unknown user"]);
    expect(collaboratorNames({ collaborator_staff_ids: ["s-1"] }, []))
      .toEqual(["Unknown user"]);
  });

  it("dedupes, so one person cannot read as two", () => {
    expect(collaboratorNames({ collaborator_staff_ids: ["s-1", "s-1"] }, staff))
      .toEqual(["Stanley"]);
  });

  it("is empty for an unshared order, and never throws on a thin header", () => {
    expect(collaboratorNames({ collaborator_staff_ids: [] }, staff)).toEqual([]);
    expect(collaboratorNames({}, staff)).toEqual([]);
    expect(collaboratorNames(null, staff)).toEqual([]);
    expect(collaboratorNames({ collaborator_staff_ids: null }, null)).toEqual([]);
    expect(collaboratorNames({ collaborator_staff_ids: ["", "  "] }, staff)).toEqual([]);
  });
});

describe("collaboratorLabel", () => {
  it("joins the names for a one-line surface", () => {
    expect(collaboratorLabel({ collaborator_staff_ids: ["s-1", "s-2"] }, staff))
      .toBe("alicia, Stanley");
  });

  it("is null when nothing is shared", () => {
    expect(collaboratorLabel({ collaborator_staff_ids: [] }, staff)).toBeNull();
    expect(collaboratorLabel(undefined, staff)).toBeNull();
  });
});

describe("collaboratorEntries", () => {
  it("keeps each id paired with its own name after sorting", () => {
    expect(collaboratorEntries({ collaborator_staff_ids: ["s-1", "s-2", "s-1"] }, staff))
      .toEqual([{ id: "s-2", name: "alicia" }, { id: "s-1", name: "Stanley" }]);
  });
});

describe("SO detail surfaces share one Shared-with editor", () => {
  const root = resolve(__dirname, "../../..");
  for (const file of ["pages/scm-v2/SalesOrderDetailV2.tsx", "mobile/MobileSODetail.tsx"]) {
    it(file, () => {
      expect(readFileSync(resolve(root, file), "utf8")).toMatch(/<SoSharedWith\b/);
    });
  }
});
