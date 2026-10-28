// ----------------------------------------------------------------------------
// SO Maintenance is gated in FOUR places — desktop route, desktop toolbar
// button, mobile menu row, mobile overlay mount. Before this change all four
// independently asked `isDirectorUser(user)`, a frontend re-derivation, and all
// four were wrong in the same direction: they resolved {`*`, Super Admin, Sales
// Director, Finance Manager} while the API's write gate
// (houzs-perms.canWriteScmConfig) also admits Procurement/Purchasing, Operation
// Manager, Operation Executive and Logistic Admin.
//
// Four copies of a rule is four chances to fix three of them. This test pins
// that all four now read ONE server-decided answer, and that the frontend has
// stopped deriving the answer for itself. backend/tests/capabilities.test.ts
// pins the other half — that the answer equals what the API enforces.
//
// Source-scanning is deliberate. The four sites are inline in three large
// components under active concurrent edit; rendering them would couple this test
// to their routers, lazy boundaries and query clients, and would break for
// reasons that have nothing to do with the gate. What must not drift is which
// KEY each site reads, and that is exactly what the text says.
// ----------------------------------------------------------------------------

import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { MOBILE_MENU_GROUPS } from "../mobile/MobileApp";
import { CAPABILITY_KEYS } from "./capabilities";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(resolve(HERE, "..", rel), "utf8");

/** The one key every SO Maintenance surface must ask for. */
const KEY = "scm.maintenance.open";

const SITES: { label: string; file: string }[] = [
  { label: "desktop route guard (SoMaintenanceGuard)", file: "App.tsx" },
  { label: "desktop toolbar button (canMaintain)", file: "pages/scm-v2/MfgSalesOrdersListV2.tsx" },
  { label: "mobile menu row + overlay mount", file: "mobile/MobileApp.tsx" },
];

describe("SO Maintenance — one gate, four surfaces", () => {
  test("the key is a real capability the backend ships", () => {
    // Guards the typo case: a key nothing produces would deny everyone, which is
    // safe but is still a screen vanishing without anyone deciding it should.
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
    // It must NOT also carry alwaysShow, which short-circuits every gate.
    expect(row!.alwaysShow).toBeFalsy();
  });

  test("the mobile overlay mount is gated too, not just the menu row", () => {
    // A gated row with an ungated mount is the "off, not hide" failure: the row
    // is absent but a deep link still mounts the screen and fires its queries.
    const text = src("mobile/MobileApp.tsx");
    const overlay = text.slice(text.indexOf('screen.t === "so-maintenance"'));
    expect(overlay.slice(0, 800)).toContain(KEY);
  });

  test("no SO Maintenance surface re-derives the answer with isDirectorUser", () => {
    // App.tsx still imports isDirectorUser for OTHER guards (ScmGuard's
    // allowDirector), so this asserts the narrower thing that matters: the
    // maintenance guard body does not call it.
    const app = src("App.tsx");
    const guard = app.slice(app.indexOf("function SoMaintenanceGuard"));
    const body = guard.slice(0, guard.indexOf("\n}"));
    expect(body).not.toContain("isDirectorUser(");

    // These two dropped the IMPORT entirely — if it comes back, someone has
    // reintroduced a second answer to a question the server already answered.
    // Asserted on the import rather than on the identifier, because both files
    // still NAME isDirectorUser in the comments explaining why it was wrong, and
    // a test that forbids explaining the bug is a test that deletes the warning.
    const importsIsDirector = (file: string) =>
      /import\s*\{[^}]*\bisDirectorUser\b[^}]*\}\s*from/.test(src(file));
    expect(importsIsDirector("pages/scm-v2/MfgSalesOrdersListV2.tsx")).toBe(false);
    expect(importsIsDirector("mobile/MobileApp.tsx")).toBe(false);
  });

  test("the mobile row's gate is not the retired directorOnly flag", () => {
    // directorOnly was removed from MobileMenuItem. A reintroduction would
    // compile only if the type grew it back, so this is a belt-and-braces
    // assertion against a revert that restores the shape but not the reasoning.
    expect(src("mobile/MobileApp.tsx")).not.toContain("directorOnly:");
  });
});
