import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { MOBILE_MENU_GROUPS, PROFILE_ORG_ITEMS, type MobileMenuItem } from "./MobileApp";
import { NAV_TABS, type NavTab } from "../components/Sidebar";
import { CAPABILITY_KEYS } from "../auth/capabilities";
import { mobileDestinationMatches } from "./mobileRoute";

const HERE = dirname(fileURLToPath(import.meta.url));


const navDestinations = ((): string[] => {
  const out: string[] = [];
  const walk = (t: NavTab) => {
    if (t.to != null) out.push(t.to);
    (t.children ?? []).forEach(walk);
  };
  NAV_TABS.forEach(walk);
  return out;
})();

const hasNavDestination = (to: string): boolean =>
  navDestinations.some((navTo) => mobileDestinationMatches(to, navTo));

const UNGATED_BY_DESIGN = new Map<string, string>([
  [
    "/hr/punch",
    "Mobile-only path (no App.tsx route, no NAV_TABS entry). Punch In / Out is " +
      "the employee's OWN clock (HC-0125, Nico: punch with your ERP account), so " +
      "there is no page permission to apply: /api/attendance answers only for " +
      "the hr_employees row linked to the caller and refuses an unlinked account.",
  ],
  [
    "/activity-inbox",
    "Mobile-only path (no App.tsx route, no NAV_TABS entry, so no desktop gate " +
      "to borrow). The project-activity feed is the phone's equivalent of the " +
      "desktop bell, which every signed-in user has, and it is audience-filtered " +
      "server-side by hooks/useNotifications — there is no page permission to apply.",
  ],
  [
    "/announcements",
    "Owner rule 2026-07: announcements are readable by EVERY active user. The " +
      "mobile screen reads /api/announcements/banner, which needs no permission " +
      "and is audience-filtered server-side (only notices addressed to this user). " +
      "The row kept alwaysShow because the NAV_TABS entry it would borrow from " +
      "used to be gated on announcements.read — the ADMIN list/composer verb, " +
      "deliberately NOT the gate for reading your own notices. As of 2026-07-21 " +
      "that desktop entry is ungated too (owner approved, after #957 opened the " +
      "page itself), so the two surfaces now agree and alwaysShow is belt-and- " +
      "braces rather than the only thing holding the row open.",
  ],
]);

function gateOf(item: MobileMenuItem): string | null {
  const path = item.to.split("?")[0];
  if (item.capability) {
    return (CAPABILITY_KEYS as readonly string[]).includes(item.capability)
      ? `capability ${item.capability}`
      : null;
  }
  if (item.alwaysShow) return UNGATED_BY_DESIGN.has(path) ? "ungated by design (alwaysShow)" : null;
  if (item.gateVia) return hasNavDestination(item.gateVia) ? `gateVia ${item.gateVia}` : null;
  if (hasNavDestination(item.to)) return `NAV_TABS ${item.to}`;
  return UNGATED_BY_DESIGN.has(path) ? "ungated by design (no nav entry)" : null;
}

const allRows: MobileMenuItem[] = [
  ...MOBILE_MENU_GROUPS.flatMap((g) => g.items),
  ...PROFILE_ORG_ITEMS,
];

describe("mobile menu permission gates", () => {
  it("the runtime default fails CLOSED — an unlisted path is hidden, not shown to all", () => {
    const appSrc = readFileSync(resolve(HERE, "MobileApp.tsx"), "utf8");
    const at = appSrc.indexOf("const allowed = (to: string)");
    expect(at, "allowed() not found in MobileApp.tsx — did it get renamed?").toBeGreaterThan(-1);
    const decl = appSrc.slice(at, at + 640);
    expect(decl).toContain("matches.length === 0 ? false");
    expect(decl).not.toContain("matches.length === 0 ? true");
  });

  it("gives every menu and Profile row an explicit gate", () => {
    const ungated = allRows.filter((it) => gateOf(it) === null).map((it) => `${it.label} (${it.to})`);
    expect(
      ungated,
      ungated.length === 0
        ? ""
        : `These mobile rows have no permission gate. allowed() now fails CLOSED for a ` +
          `path with no NAV_TABS entry, so each of these currently VANISHES for the cohort ` +
          `that should see it (and before the 2026-07-19 flip was visible to everyone):\n  ${ungated.join("\n  ")}\n` +
          `Fix by pointing the row at a live NAV_TABS path, or adding gateVia to one that ` +
          `carries the same permission the backend enforces on the screen's endpoint. Do ` +
          `NOT add it to UNGATED_BY_DESIGN unless the screen genuinely has no permission ` +
          `to apply — read that list's comment first.`,
    ).toEqual([]);
  });

  it("keeps every gateVia pointing at a nav entry that still exists", () => {
    const dead = allRows
      .filter((it) => it.gateVia && !hasNavDestination(it.gateVia))
      .map((it) => `${it.label} (${it.to}) -> gateVia ${it.gateVia}`);
    expect(
      dead,
      dead.length === 0 ? "" : `These rows borrow a gate from a NAV_TABS path that no longer exists, so they now fail OPEN:\n  ${dead.join("\n  ")}`,
    ).toEqual([]);
  });

  it("keeps the ungated-by-design list honest", () => {
    for (const [path, reason] of UNGATED_BY_DESIGN) {
      expect(reason.length, `UNGATED_BY_DESIGN["${path}"] must say WHY it is ungated`).toBeGreaterThan(40);

      const row = allRows.find((it) => it.to.split("?")[0] === path);
      expect(row, `UNGATED_BY_DESIGN names "${path}", which is no longer a mobile menu row — remove it`).toBeDefined();

      expect(
        row!.alwaysShow === true || !hasNavDestination(row!.to),
        `"${path}" is now gated for real (it has a NAV_TABS entry and no alwaysShow) — remove it from UNGATED_BY_DESIGN and let the real gate apply`,
      ).toBe(true);
    }
  });

  it("pins the full set of ungated rows", () => {
    expect([...UNGATED_BY_DESIGN.keys()].sort()).toEqual(["/activity-inbox", "/announcements", "/hr/punch"]);
  });

  it("keeps Positions out of every mobile entry and route gate", () => {
    expect(allRows.some((item) => item.to === "/team?tab=positions")).toBe(false);
    expect(hasNavDestination("/team?tab=positions")).toBe(false);
  });

  it("gates every Team row on its exact query-bearing NAV_TABS destination", () => {
    const teamRows = allRows.filter((item) => item.to.startsWith("/team?tab="));
    expect(teamRows.map((item) => item.to).sort()).toEqual([
      "/team?tab=departments2",
      "/team?tab=directory",
    ]);
    for (const row of teamRows) {
      const matches = navDestinations.filter((navTo) => mobileDestinationMatches(row.to, navTo));
      expect(matches, `${row.to} must have exactly one gate`).toEqual([row.to]);
    }
    expect(mobileDestinationMatches("/team?tab=directory", "/team?tab=departments2")).toBe(false);
  });
});

/* Owner 2026-10-26: a driver could not find his run-sheet on the phone. The Driver
   role holds scm.transportation.last_mile but not .planning, and the row borrowed
   Delivery Planning's gate. It must carry the same key as the desktop row. */
describe("Last Mile Delivery (Driver) on the phone", () => {
  it("gates on last_mile, the key the Driver role holds", () => {
    const row = MOBILE_MENU_GROUPS.flatMap((g) => g.items).find((it) => it.to === "/scm/delivery-planning-driver")!;
    const gate = row.gateVia ?? row.to;
    const find = (ts: NavTab[]): NavTab | undefined => {
      for (const t of ts) { if (t.to === gate) return t; const c = find(t.children ?? []); if (c) return c; }
      return undefined;
    };
    expect(find(NAV_TABS)?.anyAccess).toEqual(["scm.transportation.last_mile"]);
  });
});
