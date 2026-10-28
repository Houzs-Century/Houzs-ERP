import { describe, expect, it } from "vitest";
import {
  POSITION_CAPABILITY_DEFS,
  hasPositionCapability,
  isValidPositionCapability,
} from "./positionCapabilities";

/* The gate for the editable Roles & Permissions matrix. Pins the fail-closed
 * contract: no caller / no grants / unknown key all DENY; the `*` wildcard
 * (role grant or god-position injection) passes everything. */

describe("positionCapabilities", () => {
  it("declares a unique, non-empty catalogue", () => {
    const keys = POSITION_CAPABILITY_DEFS.map((d) => d.key);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
    for (const d of POSITION_CAPABILITY_DEFS) {
      expect(isValidPositionCapability(d.key)).toBe(true);
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.description.length).toBeGreaterThan(0);
    }
  });

  it("fails closed on a null / empty / positionless caller", () => {
    expect(hasPositionCapability(null, "scm.do.dispatch")).toBe(false);
    expect(hasPositionCapability(undefined, "scm.do.dispatch")).toBe(false);
    expect(hasPositionCapability({}, "scm.do.dispatch")).toBe(false);
    expect(
      hasPositionCapability({ position_capabilities: null }, "scm.do.dispatch"),
    ).toBe(false);
  });

  it("denies an unknown key even for a wildcard caller — the catalogue is code", () => {
    expect(
      hasPositionCapability(
        { permissions_set: new Set(["*"]) },
        "scm.do.teleport",
      ),
    ).toBe(false);
  });

  it("grants on a hydrated position grant, and only for the granted key", () => {
    const caller = { position_capabilities: ["scm.do.load"] };
    expect(hasPositionCapability(caller, "scm.do.load")).toBe(true);
    expect(hasPositionCapability(caller, "scm.do.dispatch")).toBe(false);
    expect(hasPositionCapability(caller, "scm.do.revert")).toBe(false);
  });

  it("passes every catalogue key for the `*` wildcard (god positions)", () => {
    const god = { permissions_set: new Set(["*"]) };
    const godViaArray = { permissions: ["users.read", "*"] };
    for (const d of POSITION_CAPABILITY_DEFS) {
      expect(hasPositionCapability(god, d.key)).toBe(true);
      expect(hasPositionCapability(godViaArray, d.key)).toBe(true);
    }
  });
});
