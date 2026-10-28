import { describe, expect, test } from "vitest";
import {
  draftOf,
  dutyEditableFor,
  flagsEditableFor,
  fleetEditableFor,
  normalise,
  orderedPositions,
  profileOptionsFor,
  type TitlePolicyEntry,
  type TitlePolicyPayload,
} from "./titlePolicyModel";

/* The one logic layer the desktop Titles table and the phone Titles editor both
 * build on. These pin the two pure transforms so a change reaches both surfaces
 * identically: draftOf (row over name), and normalise (the body the API accepts
 * for each cohort — profile only where the cohort takes one, flags only where it
 * owns them). */

function payload(over: Partial<TitlePolicyPayload> = {}): TitlePolicyPayload {
  return {
    cohorts: ["god", "full", "restricted", "sales"],
    restricted_profiles: ["driver_helper", "storekeeper", "storekeeper_supervisor", "calendar_viewer"],
    sales_profiles: ["director", "rep"],
    duties: ["management", "finance", "purchasing", "logistic", "driver", "helper", "warehouse", "other"],
    positions: [],
    ...over,
  };
}

function entry(over: Partial<TitlePolicyEntry> = {}): TitlePolicyEntry {
  return {
    id: 1,
    name: "Some Title",
    slug: "some_title",
    department_name: "Operation Department",
    active: true,
    row: null,
    source: "name",
    effective: { cohort: "full", profile: null, can_move_money: false, can_write_config: false, is_fleet: false },
    ...over,
  };
}

describe("draftOf", () => {
  test("the stored row wins over the effective fallback", () => {
    const d = draftOf(
      entry({
        row: { position_id: 1, cohort: "restricted", profile: "storekeeper", can_move_money: false, can_write_config: false, is_fleet: true, duty: "warehouse" },
        source: "row",
        effective: { cohort: "full", profile: null, can_move_money: true, can_write_config: true, is_fleet: false, duty: "management" },
      }),
    );
    expect(d).toEqual({ cohort: "restricted", profile: "storekeeper", can_move_money: false, can_write_config: false, is_fleet: true, duty: "warehouse" });
  });

  test("a name-resolved effective with no duty defaults to 'other'", () => {
    expect(draftOf(entry()).duty).toBe("other");
  });
});

describe("normalise — the body per cohort", () => {
  test("restricted takes the first profile and drops money/config, keeps fleet + duty", () => {
    const d = normalise({ cohort: "restricted", profile: null, can_move_money: true, can_write_config: true, is_fleet: true, duty: "warehouse" }, payload());
    expect(d).toEqual({ cohort: "restricted", profile: "driver_helper", can_move_money: false, can_write_config: false, is_fleet: true, duty: "warehouse" });
  });

  test("sales defaults to rep and drops every flag", () => {
    const d = normalise({ cohort: "sales", profile: null, can_move_money: true, can_write_config: true, is_fleet: true, duty: "finance" }, payload());
    expect(d).toEqual({ cohort: "sales", profile: "rep", can_move_money: false, can_write_config: false, is_fleet: false, duty: "finance" });
  });

  test("god forces money+config on, no profile, duty management", () => {
    const d = normalise({ cohort: "god", profile: "x", can_move_money: false, can_write_config: false, is_fleet: true, duty: "driver" }, payload());
    expect(d).toEqual({ cohort: "god", profile: null, can_move_money: true, can_write_config: true, is_fleet: false, duty: "management" });
  });

  test("full keeps its two flag switches, forces fleet off, keeps a valid duty", () => {
    const d = normalise({ cohort: "full", profile: "x", can_move_money: true, can_write_config: false, is_fleet: true, duty: "finance" }, payload());
    expect(d).toEqual({ cohort: "full", profile: null, can_move_money: true, can_write_config: false, is_fleet: false, duty: "finance" });
  });

  test("an unknown duty coerces to 'other'", () => {
    const d = normalise({ cohort: "full", profile: null, can_move_money: false, can_write_config: false, is_fleet: false, duty: "nonsense" }, payload());
    expect(d.duty).toBe("other");
  });

  test("with no duties in the payload every duty coerces to 'other'", () => {
    const d = normalise({ cohort: "full", profile: null, can_move_money: false, can_write_config: false, is_fleet: false, duty: "finance" }, payload({ duties: undefined }));
    expect(d.duty).toBe("other");
  });
});

describe("orderedPositions", () => {
  test("keeps only active Titles, ordered Management then Sales then Operation, then by name", () => {
    const p = payload({
      positions: [
        entry({ id: 1, name: "Zeta", department_name: "Operation Department" }),
        entry({ id: 2, name: "Alpha", department_name: "Sales Department" }),
        entry({ id: 3, name: "Beta", department_name: "Management" }),
        entry({ id: 4, name: "Andy", department_name: "Operation Department" }),
        entry({ id: 5, name: "Retired", department_name: "Management", active: false }),
      ],
    });
    expect(orderedPositions(p).map((e) => e.name)).toEqual(["Beta", "Alpha", "Andy", "Zeta"]);
  });
});

describe("which controls a cohort exposes", () => {
  test("profileOptionsFor is the restricted/sales list, empty otherwise", () => {
    const p = payload();
    expect(profileOptionsFor("restricted", p)).toEqual(p.restricted_profiles);
    expect(profileOptionsFor("sales", p)).toEqual(p.sales_profiles);
    expect(profileOptionsFor("full", p)).toEqual([]);
    expect(profileOptionsFor("god", p)).toEqual([]);
  });

  test("flags edit on full; fleet edits on restricted; duty edits except god", () => {
    expect(flagsEditableFor("full")).toBe(true);
    expect(flagsEditableFor("restricted")).toBe(false);
    expect(fleetEditableFor("restricted")).toBe(true);
    expect(fleetEditableFor("full")).toBe(false);
    expect(dutyEditableFor("god")).toBe(false);
    expect(dutyEditableFor("full")).toBe(true);
  });
});
