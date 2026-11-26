import { describe, expect, it } from "vitest";
import { SCM_SEGMENT_LABELS, labelForPath } from "./routeLabels";
import { sectionKeyFor } from "./workspaceTabs";
import { STAFF_ROUTE_PATTERNS } from "../routing/routeManifest";


function concretePath(pattern: string): string {
  return pattern
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "sample" : seg))
    .join("/");
}

function tabLabel(pattern: string): string {
  return labelForPath(sectionKeyFor(concretePath(pattern)));
}

describe("labelForPath — owner-reported tab names", () => {
  it("names /scm/fleet-day by its page title, not 'Scm'", () => {
    expect(tabLabel("/scm/fleet-day")).toBe("Last Mile Delivery");
    expect(labelForPath("/scm/fleet-day")).toBe("Last Mile Delivery");
  });
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
