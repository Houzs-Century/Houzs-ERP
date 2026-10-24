import { describe, expect, it } from "vitest";
import { projectStage, driverAssignedOf, PROJECT_STAGES } from "./projectStage";

const idxOf = (label: string) => PROJECT_STAGES.findIndex((s) => s.label === label);

// setup_crew JSON as the Setup & Dismantle editor writes it (serializePhaseCrew):
// { lorry_crew, drivers (flat mirror), helpers, lorries, outsourced, … }.
const crewWithDriver = JSON.stringify({
  lorry_crew: [{ plate: "WXY1234", drivers: [{ name: "Ali", phone: "0123" }], helpers: [] }],
  drivers: [{ name: "Ali", phone: "0123" }], helpers: [], lorries: ["WXY1234"],
});
const crewHelpersOnly = JSON.stringify({
  lorry_crew: [{ plate: "WXY1234", drivers: [{ name: "", phone: "" }], helpers: [{ name: "Sam", phone: "" }] }],
  drivers: [], helpers: [{ name: "Sam", phone: "" }], lorries: ["WXY1234"],
});
const crewOutsourced = JSON.stringify({
  lorry_crew: [], drivers: [], helpers: [],
  outsourced: { enabled: true, entries: [{ provider: "lalamove", name: "Pak Mat", phone: "0199", plate: "ABC1" }] },
});

describe("driverAssignedOf", () => {
  it("true when a driver is named in the flat mirror", () => {
    expect(driverAssignedOf(crewWithDriver)).toBe(true);
  });
  it("true when only a per-lorry driver is named", () => {
    expect(driverAssignedOf(JSON.stringify({ lorry_crew: [{ plate: "", drivers: [{ name: "Ali", phone: "" }], helpers: [] }] }))).toBe(true);
  });
  it("true for an outsourced (Lalamove) entry carrying a name", () => {
    expect(driverAssignedOf(crewOutsourced)).toBe(true);
  });
  it("false when only helpers are named", () => {
    expect(driverAssignedOf(crewHelpersOnly)).toBe(false);
  });
  it("false for empty / blank / junk / null", () => {
    expect(driverAssignedOf(null)).toBe(false);
    expect(driverAssignedOf("")).toBe(false);
    expect(driverAssignedOf("{}")).toBe(false);
    expect(driverAssignedOf("not json")).toBe(false);
  });
});

describe("projectStage · Driver Info means 'driver assigned'", () => {
  // Stock Out done, the post-dismantle Stock In still pending, Setup Image not
  // uploaded — the exact shape that used to pile events up at "Driver Info"
  // because the step was gated on the Stock In Transfer Record document.
  const items = [
    { title: "Stock Out Transfer Record", status: "done", review_status: null },
    { title: "Stock In Transfer Record", status: "pending", review_status: null },
    { title: "Setup Image", status: "pending", review_status: null },
  ];

  it("sits at Driver Info while no driver is assigned (helpers only)", () => {
    const st = projectStage(items, true, "2026-10-09", "2026-10-21", false);
    expect(PROJECT_STAGES[st.currentIdx]?.label).toBe("Driver Info");
  });

  it("advances past Driver Info once a driver is assigned, though Stock In is still pending", () => {
    const st = projectStage(items, true, "2026-10-09", "2026-10-21", true);
    expect(st.currentIdx).toBeGreaterThan(idxOf("Driver Info"));
    expect(PROJECT_STAGES[st.currentIdx]?.label).toBe("Setup Image");
  });

  it("no longer lets the post-event Stock In Transfer Record gate any stage", () => {
    expect(PROJECT_STAGES.some((s) => s.titles.includes("Stock In Transfer Record"))).toBe(false);
  });
});
