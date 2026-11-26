
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { MOBILE_MENU_GROUPS } from "../mobile/MobileApp";
import { CAPABILITY_KEYS } from "./capabilities";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(resolve(HERE, "..", rel), "utf8");

const KEY = "scm.maintenance.open";

const SITES: { label: string; file: string }[] = [
  { label: "desktop route guard (SoMaintenanceGuard)", file: "App.tsx" },
  { label: "desktop toolbar button (canMaintain)", file: "pages/scm-v2/MfgSalesOrdersListV2.tsx" },
  { label: "mobile menu row + overlay mount", file: "mobile/MobileApp.tsx" },
];

describe("SO Maintenance — one gate, four surfaces", () => {
  test("the key is a real capability the backend ships", () => {
    expect(CAPABILITY_KEYS as readonly string[]).toContain(KEY);
  });

  for (const { label, file } of SITES) {
    test(`${label} reads ${KEY}`, () => {
      expect(src(file)).toContain(`"${KEY}"`);
    });
  }

  test("the mobile menu row declares the capability as its gate", () => {
    const row = MOBILE_MENU_GROUPS.flatMap((g) => g.items).find(
      (it) => it.to === "/scm/sales-orders/maintenance",
    );
    expect(row, "the SO Maintenance mobile row disappeared").toBeDefined();
    expect(row!.capability).toBe(KEY);
    expect(row!.alwaysShow).toBeFalsy();
  });

  test("the mobile overlay mount is gated too, not just the menu row", () => {
    const text = src("mobile/MobileApp.tsx");
    const overlay = text.slice(text.indexOf('screen.t === "so-maintenance"'));
    expect(overlay.slice(0, 800)).toContain(KEY);
  });

  test("no SO Maintenance surface re-derives the answer with isDirectorUser", () => {
    const app = src("App.tsx");
    const guard = app.slice(app.indexOf("function SoMaintenanceGuard"));
    const body = guard.slice(0, guard.indexOf("\n}"));
    expect(body).not.toContain("isDirectorUser(");

    const importsIsDirector = (file: string) =>
      /import\s*\{[^}]*\bisDirectorUser\b[^}]*\}\s*from/.test(src(file));
    expect(importsIsDirector("pages/scm-v2/MfgSalesOrdersListV2.tsx")).toBe(false);
    expect(importsIsDirector("mobile/MobileApp.tsx")).toBe(false);
  });

  test("the mobile row's gate is not the retired directorOnly flag", () => {
    expect(src("mobile/MobileApp.tsx")).not.toContain("directorOnly:");
  });
});
