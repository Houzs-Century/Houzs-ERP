// The stage tracker's rule — in particular that "Driver Info" tracks the keyed
// driver/helper (setup_crew), and that the post-dismantle "Stock In Transfer
// Record" is a late step, not a pre-event gate (owner 2026-10-27, the KL/MID
// VALLEY events stuck at "Driver Info" after the crew was keyed).
import { describe, expect, it } from "vitest";
import { PROJECT_STAGES, projectStage, setupArrangedOf, driverKeyedOf } from "./projectStage";

const idxOf = (label: string) => PROJECT_STAGES.findIndex((s) => s.label === label);
const done = (title: string) => ({ title, status: "done", review_status: null });
const approved = (title: string) => ({ title, status: "pending", review_status: "approved" });
const pending = (title: string) => ({ title, status: "pending", review_status: null });

// A post-091 event ready for the fair: floorplan, 3D, stock-out all done, the
// event images in, but the goods-return doc ("Stock In Transfer Record") still
// pending (it is due +2, after the event).
const readyEventItems = [
  done("Blank Floorplan"),
  done("3D Design"),
  approved("Stock Out Transfer Record"),
  done("Filled Floorplan"),
  pending("Stock In Transfer Record"),
];

describe("driverKeyedOf", () => {
  it("is false for blank / empty crew", () => {
    expect(driverKeyedOf(null)).toBe(false);
    expect(driverKeyedOf("")).toBe(false);
    expect(driverKeyedOf("{}")).toBe(false);
    expect(driverKeyedOf("not json")).toBe(false);
    expect(driverKeyedOf('{"drivers":[],"helpers":[]}')).toBe(false);
    expect(driverKeyedOf('{"drivers":[{"name":"  "}]}')).toBe(false);
  });

  it("is true once a driver or helper is named (flat or per-lorry)", () => {
    expect(driverKeyedOf('{"drivers":[{"name":"Abu","phone":"012"}]}')).toBe(true);
    expect(driverKeyedOf('{"helpers":[{"name":"Ali"}]}')).toBe(true);
    expect(driverKeyedOf('{"lorry_crew":[{"plate":"WABC","drivers":[{"name":"Abu"}],"helpers":[]}]}')).toBe(true);
    expect(driverKeyedOf('{"lorry_crew":[{"plate":"WABC","drivers":[],"helpers":[]}]}')).toBe(false);
  });

  it("is true for an arranged outsourced trip, false when outsourced is off/empty", () => {
    // Sarawak HOMELOVE shape: no in-house crew, an outsourced provider named.
    expect(driverKeyedOf('{"drivers":[],"helpers":[],"outsourced":{"enabled":true,"entries":[{"provider":"outsource","name":"Aim","phone":"011","plate":"WUS1834"}]}}')).toBe(true);
    expect(driverKeyedOf('{"drivers":[],"helpers":[],"outsourced":{"enabled":true,"entries":[{"plate":"WUS1834"}]}}')).toBe(true);
    expect(driverKeyedOf('{"drivers":[],"helpers":[],"outsourced":{"enabled":false,"entries":[]}}')).toBe(false);
    expect(driverKeyedOf('{"drivers":[],"helpers":[],"outsourced":{"enabled":true,"entries":[]}}')).toBe(false);
  });
});

describe("projectStage — Driver Info tracks the keyed crew", () => {
  it("sits at Driver Info while no driver/helper is keyed", () => {
    const st = projectStage(readyEventItems, false, false, "2026-10-23", "2026-10-27");
    expect(st.currentIdx).toBe(idxOf("Driver Info"));
    expect(st.allDone).toBe(false);
  });

  it("clears Driver Info once the driver/helper are keyed, landing on the post-event Stock In step", () => {
    const crew = '{"lorry_crew":[{"plate":"WABC","drivers":[{"name":"Abu"}],"helpers":[{"name":"Ali"}]}]}';
    const st = projectStage(readyEventItems, setupArrangedOf(crew, null), driverKeyedOf(crew), "2026-10-23", "2026-10-27");
    // Driver Info + Setup/Dismantle are satisfied by the crew; the only thing
    // left incomplete is the goods-return doc, now its own late step.
    expect(st.currentIdx).toBe(idxOf("Stock In"));
    expect(idxOf("Stock In")).toBeGreaterThan(idxOf("Filled Floorplan"));
  });

  it("moves a real MID VALLEY event (Filled Floorplan still pending) off Driver Info to Filled Floorplan", () => {
    // Floorplan/3D/Stock-Out done; Filled Floorplan, Stock In still pending —
    // the actual shape of the 3 MID VALLEY events on 2026-10-28.
    const items = [
      done("Blank Floorplan"),
      approved("3D Design"),
      approved("Stock Out Transfer Record"),
      pending("Filled Floorplan"),
      pending("Stock In Transfer Record"),
    ];
    const crew = '{"drivers":[{"name":"ABD KHALID"}],"helpers":[{"name":"JAMSED"}]}';
    const st = projectStage(items, setupArrangedOf(crew, "2026-10-22T13:00"), driverKeyedOf(crew), "2026-10-23", "2026-10-28");
    expect(st.currentIdx).toBe(idxOf("Filled Floorplan"));
    expect(st.currentIdx).toBeGreaterThan(idxOf("Driver Info"));
  });

  it("is all done when the return doc is absent (pre-091 events) and the crew is keyed", () => {
    const items = readyEventItems.filter((i) => i.title !== "Stock In Transfer Record");
    const crew = '{"drivers":[{"name":"Abu"}]}';
    const st = projectStage(items, setupArrangedOf(crew, null), driverKeyedOf(crew), "2026-10-23", "2026-10-27");
    expect(st.allDone).toBe(true);
    expect(st.currentIdx).toBe(st.lastIdx);
  });
});
