import { describe, it, expect } from "vitest";
import { roleLabelAdmitsRole } from "./roleLabelAdmits";

describe("roleLabelAdmitsRole — mirrors backend roleLabelAdmits", () => {
  it("admits the badged role, case- and space-insensitively", () => {
    expect(roleLabelAdmitsRole("PURCHASER", "Purchaser")).toBe(true);
    expect(roleLabelAdmitsRole("  purchaser  ", "PURCHASER")).toBe(true);
  });

  it("refuses another function's badge — the 0489 scoping", () => {
    // Owner 2026-09-02, "add for sim task only": the BD-badged Display Floor
    // Plan in her screenshot must stay untouchable by a Purchaser.
    expect(roleLabelAdmitsRole("BD", "Purchaser")).toBe(false);
    expect(roleLabelAdmitsRole("SALES PIC", "Purchaser")).toBe(false);
  });

  it("lets a combined badge admit each listed role", () => {
    expect(roleLabelAdmitsRole("SALES PIC & DRIVER", "Driver")).toBe(true);
    expect(roleLabelAdmitsRole("SALES PIC & DRIVER", "Sales PIC")).toBe(true);
    expect(roleLabelAdmitsRole("SALES PIC & DRIVER", "Purchaser")).toBe(false);
  });

  it("extends DRIVER field work to helpers and storekeepers, not the reverse", () => {
    expect(roleLabelAdmitsRole("DRIVER", "Helper")).toBe(true);
    expect(roleLabelAdmitsRole("DRIVER", "Storekeeper")).toBe(true);
    expect(roleLabelAdmitsRole("HELPER", "Driver")).toBe(false);
  });

  it("refuses when either side is missing — an unbadged task is nobody's", () => {
    expect(roleLabelAdmitsRole(null, "Purchaser")).toBe(false);
    expect(roleLabelAdmitsRole("", "Purchaser")).toBe(false);
    expect(roleLabelAdmitsRole("PURCHASER", null)).toBe(false);
    expect(roleLabelAdmitsRole("PURCHASER", "   ")).toBe(false);
    expect(roleLabelAdmitsRole(" & ", "Purchaser")).toBe(false);
  });
});
