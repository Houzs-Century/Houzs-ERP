import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { collaboratorEntries, collaboratorNames, collaboratorLabel } from "./so-collaborators";

/* These names appear on the SO detail screen, which is where somebody checks
   who can touch their customer's order. The three things pinned here are the
   three that would be wrong in a way nobody notices: a uuid rendered as a
   name, a name printed twice, and an empty list rendered as a real field. */

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

  /* An id that resolves to nobody is information — a grant to somebody who has
     since been removed. It must say so, never render the uuid. */
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

  /* null, not "" or "—": the caller skips the field entirely, because a field
     that is blank on almost every order teaches people to stop reading it. */
  it("is null when nothing is shared", () => {
    expect(collaboratorLabel({ collaborator_staff_ids: [] }, staff)).toBeNull();
    expect(collaboratorLabel(undefined, staff)).toBeNull();
  });
});

/* The share editor withdraws a person by id, so each chip must carry the id of
   the name it shows — a sort that reordered names but not ids would remove the
   wrong colleague. */
describe("collaboratorEntries", () => {
  it("keeps each id paired with its own name after sorting", () => {
    expect(collaboratorEntries({ collaborator_staff_ids: ["s-1", "s-2", "s-1"] }, staff))
      .toEqual([{ id: "s-2", name: "alicia" }, { id: "s-1", name: "Stanley" }]);
  });
});

/* Owner rule: desktop and mobile SO detail are one product. Both must render
   the shared editor, so granting access on one surface is not a feature the
   other silently lacks. */
describe("SO detail surfaces share one Shared-with editor", () => {
  const root = resolve(__dirname, "../../..");
  for (const file of ["pages/scm-v2/SalesOrderDetailV2.tsx", "mobile/MobileSODetail.tsx"]) {
    it(file, () => {
      expect(readFileSync(resolve(root, file), "utf8")).toMatch(/<SoSharedWith\b/);
    });
  }
});
