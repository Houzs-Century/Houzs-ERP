import { describe, expect, it } from "vitest";
import { SCM_SEGMENT_LABELS, labelForPath } from "./routeLabels";
import { sectionKeyFor } from "./workspaceTabs";
import { STAFF_ROUTE_PATTERNS } from "../routing/routeManifest";

// The workspace tab strip labels every tab with labelForPath(sectionKeyFor(href))
// (see components/WorkspaceTabs.tsx). An uncurated /scm/* page used to fall
// through to the FIRST segment and render the tab as a bare "Scm" — the owner's
// report was /scm/fleet-day ("Last Mile Delivery") showing "Scm". These tests
// pin the fix and, by walking the route manifest, stop any NEW page from
// regressing silently.

/** Turn a manifest pattern into a concrete path by filling `:params`. */
function concretePath(pattern: string): string {
  return pattern
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "sample" : seg))
    .join("/");
}

/** The label the tab strip actually shows for a given route. */
function tabLabel(pattern: string): string {
  return labelForPath(sectionKeyFor(concretePath(pattern)));
}

describe("labelForPath — owner-reported tab names", () => {
  it("names /scm/fleet-day by its page title, not 'Scm'", () => {
    expect(tabLabel("/scm/fleet-day")).toBe("Last Mile Delivery");
    expect(labelForPath("/scm/fleet-day")).toBe("Last Mile Delivery");
  });
  // The driver view of Last Mile Delivery (page h1 "Last Mile Delivery"); its
  // slug is delivery-planning-driver, so without an entry it read "Delivery
  // Planning (Driver)" — owner asked for the Last Mile name the sidebar uses.
  it("names /scm/delivery-planning-driver after the sidebar's Last Mile name", () => {
    expect(tabLabel("/scm/delivery-planning-driver")).toBe("Last Mile Delivery (Driver)");
  });
});

describe("labelForPath — no route is ever labelled 'Scm'", () => {
  for (const pattern of STAFF_ROUTE_PATTERNS) {
    it(`${pattern} resolves to a real name`, () => {
      const label = tabLabel(pattern);
      expect(label).not.toBe("");
      expect(label.toLowerCase()).not.toBe("scm");
    });
  }
});

describe("SCM_SEGMENT_LABELS — every /scm section is curated", () => {
  // Every /scm/<section> in the manifest must carry its own title, so a tab
  // shows the page name rather than a prettied slug. `reports` and `hr` nest
  // one level deeper and are handled by their own tables in routeLabels.
  const sections = new Set<string>();
  for (const pattern of STAFF_ROUTE_PATTERNS) {
    const segs = pattern.split("/").filter(Boolean);
    if (segs[0] === "scm" && segs[1] && segs[1] !== "reports" && segs[1] !== "hr") {
      sections.add(segs[1]);
    }
  }

  for (const section of sections) {
    it(`/scm/${section} has a label entry`, () => {
      expect(SCM_SEGMENT_LABELS[section]).toBeTruthy();
    });
  }
});
