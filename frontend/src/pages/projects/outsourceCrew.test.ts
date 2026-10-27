import { describe, expect, test } from "vitest";
import {
  driverToCrew,
  helperToCrew,
  outsourceOnly,
  mergeCrewOptions,
  validateOutsourceCrew,
} from "./outsourceCrew";

describe("outsourceCrew mapping", () => {
  test("driverToCrew trims the name, keeps the phone, prefixes the id", () => {
    expect(driverToCrew({ id: "u1", name: " Ah Chong ", phone: "+60123", in_house: false })).toEqual({
      id: "drv:u1",
      name: "Ah Chong",
      phone: "+60123",
      user_type: "driver",
      role_name: "Driver",
    });
  });

  test("helperToCrew reads the phone from contact and tolerates null", () => {
    expect(helperToCrew({ id: "h1", name: "Ali", contact: "+60187", in_house: false }).phone).toBe("+60187");
    expect(helperToCrew({ id: "h2", name: "Bob", contact: null, in_house: false }).phone).toBeNull();
  });
});

describe("outsourceOnly", () => {
  test("keeps only in_house === false (null is in-house)", () => {
    const rows = [
      { id: "a", in_house: false },
      { id: "b", in_house: true },
      { id: "c", in_house: null },
    ];
    expect(outsourceOnly(rows).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("mergeCrewOptions", () => {
  test("appends outsource crew, skips blanks and case-insensitive duplicates", () => {
    const base: ReturnType<typeof driverToCrew>[] = [
      { id: 1 as unknown as string, name: "Ali", phone: null, user_type: "helper", role_name: "Helper" },
    ];
    const extra = [
      helperToCrew({ id: "h1", name: "ali", contact: null, in_house: false }), // duplicate (case)
      helperToCrew({ id: "h2", name: "Siti", contact: "+6", in_house: false }),
      helperToCrew({ id: "h3", name: "   ", contact: null, in_house: false }), // blank
    ];
    expect(mergeCrewOptions(base, extra).map((m) => m.name)).toEqual(["Ali", "Siti"]);
  });
});

describe("validateOutsourceCrew", () => {
  test("a name is always required", () => {
    expect(validateOutsourceCrew("helper", "   ", "")).toMatch(/name/i);
  });

  test("a driver needs a phone, a helper does not", () => {
    expect(validateOutsourceCrew("driver", "Sam", "")).toMatch(/phone/i);
    expect(validateOutsourceCrew("driver", "Sam", "012-3456789")).toBeNull();
    expect(validateOutsourceCrew("helper", "Sam", "")).toBeNull();
  });
});
