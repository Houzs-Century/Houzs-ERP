import { describe, it, expect } from "vitest";
import { collaboratorNames, collaboratorLabel } from "./so-collaborators";

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
