import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { MOBILE_MENU_GROUPS, PROFILE_ORG_ITEMS, type MobileMenuItem } from "./MobileApp";
import { NAV_TABS, type NavTab } from "../components/Sidebar";
import { CAPABILITY_KEYS } from "../auth/capabilities";
import { mobileDestinationMatches } from "./mobileRoute";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * EVERY mobile menu row must state its permission gate. This test is the reason
 * "I forgot to gate this" is a CI failure instead of a silently mis-scoped page.
 *
 * THE MECHANISM IT GUARDS. `MobileApp`'s `allowed(to)` now ends with
 * `matches.length === 0 ? false` — a path with NO NAV_TABS entry is HIDDEN, not
 * shown. That default was fail-OPEN (`? true`) until 2026-07-19, which made every
 * ungated row a page visible to EVERY mobile user, and it produced the same bug
 * twice: once when the desktop /scm/drivers page was retired out from under the
 * mobile row that borrowed its gate, and again when the mobile-only /scm/helpers
 * row was added. Both were caught by a human reading the code; neither by a
 * compiler, because an ungated row is perfectly valid TypeScript.
 *
 * THE FLIP DID NOT REMOVE ANY ROW. The two rows that have no nav gate to borrow —
 * `/activity-inbox` and `/announcements` (see UNGATED_BY_DESIGN) — carry
 * `alwaysShow`, which short-circuits `allowed()` at the filter call sites, so they
 * stay visible under the closed default. Nothing depended on the permissive
 * default itself; the enumeration below (every row names its gate) is what made
 * the flip safe, and the flip is what makes the enumeration true at runtime.
 *
 * WHY THE ENUMERATION STILL MATTERS UNDER FAIL-CLOSED. A row that names no gate no
 * longer leaks — it now VANISHES for the cohort that should see it, silently,
 * because `allowed()` denies an unmatched path. A screen that disappears with
 * nobody deciding it should is its own bug, so every row must still name its gate.
 *
 * WHEN THIS TEST FAILS, DO NOT ADD YOUR PATH TO UNGATED_BY_DESIGN TO GO GREEN.
 * That list is for rows with no permission to apply at all. If the screen reads
 * business data, it needs a real gate: give the row a `to` with a live NAV_TABS
 * entry, or a `gateVia` pointing at one that carries the same permission the
 * backend enforces on the screen's endpoint.
 */

/** Every complete `to` in the desktop nav tree. Queries are part of the
 *  destination identity: /team?tab=members is not the gate for Departments.
 *  A mobile destination with no exact declared gate fails closed. */
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

/**
 * Rows that are ungated ON PURPOSE, each with the reason it has no permission to
 * apply. Adding to this list is a deliberate act that a reviewer must agree with
 * — it is not the way to silence a failure.
 *
 * TWO different mechanisms land a row here, and both must be justified:
 *   • no gate to borrow — no NAV_TABS entry, so `allowed()` fails open;
 *   • `alwaysShow` — which SKIPS `allowed()` even when a nav entry exists, and is
 *     therefore an ungating mechanism in its own right, not a mere hint.
 *
 * The third test below stops this list from rotting into a blanket exemption: an
 * entry that no longer names a row, or whose row has since become genuinely
 * gated, fails CI and must be removed.
 */
const UNGATED_BY_DESIGN = new Map<string, string>([
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

/** How a row states its gate, or null when it states none.
 *
 *  Order matters. `capability` and `alwaysShow` are checked BEFORE the nav
 *  lookup because both short-circuit `allowed()` at runtime — a row carrying
 *  `alwaysShow` is ungated whether or not a NAV_TABS entry happens to exist for
 *  its path, so crediting it with that entry's gate would be a false pass.
 *
 *  `capability` replaced `directorOnly`. It is the STRONGEST gate form a row can
 *  carry: the boolean is decided by the backend (services/capabilities.ts) and
 *  read verbatim, so unlike a nav-tab gate it cannot drift from the rule the
 *  endpoint enforces. A row is credited only when the key is one the frontend
 *  actually declares — a typo'd or retired key would otherwise read as a gate
 *  while `capability()` silently returned false for everyone, which is a
 *  fail-CLOSED bug but still a screen that vanished without anyone deciding it
 *  should. */
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
    /* The gate this whole file exists around lives in MobileApp's `allowed()`,
       a closure inside MobileAppInner that cannot be imported. Its guarantee is
       pinned at the source instead: the no-NAV_TABS-match branch must resolve to
       FALSE. This is the inversion of the original fail-open default (`? true`);
       a future edit that restores it turns every ungated path back into a public
       page and fails HERE, next to the enumeration that made the flip safe. */
    const appSrc = readFileSync(resolve(HERE, "MobileApp.tsx"), "utf8");
    const at = appSrc.indexOf("const allowed = (to: string)");
    expect(at, "allowed() not found in MobileApp.tsx — did it get renamed?").toBeGreaterThan(-1);
    const decl = appSrc.slice(at, at + 640);
    expect(decl).toContain("matches.length === 0 ? false");
    expect(decl).not.toContain("matches.length === 0 ? true");
  });

  it("gives every menu and Profile row an explicit gate", () => {
    const ungated = allRows.filter((it) => gateOf(it) === null).map((it) => `${it.label} (${it.to})`);
    // Named in the failure so the next author sees WHICH row and WHAT to do,
    // rather than a bare `false !== true`.
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
    /* A gateVia is only a gate while its TARGET is live. If /scm/fleet were
       retired the way /scm/drivers was, the Drivers and Helpers rows would fail
       open again in silence — the same bug a third time, one level further in.
       gateOf() already returns null for a dead target, so the test above would
       catch it; this asserts it directly so the failure names the cause. */
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
      // A reason is the point of the list; an empty one is an exemption with no
      // argument behind it.
      expect(reason.length, `UNGATED_BY_DESIGN["${path}"] must say WHY it is ungated`).toBeGreaterThan(40);

      // Still a real row — a stale entry silently widens the exemption.
      const row = allRows.find((it) => it.to.split("?")[0] === path);
      expect(row, `UNGATED_BY_DESIGN names "${path}", which is no longer a mobile menu row — remove it`).toBeDefined();

      /* Still genuinely ungated by one of the two mechanisms. If a row loses its
         `alwaysShow` AND gains a nav entry, it is gated for real and the
         exemption must go rather than sit here quietly claiming otherwise. */
      expect(
        row!.alwaysShow === true || !hasNavDestination(row!.to),
        `"${path}" is now gated for real (it has a NAV_TABS entry and no alwaysShow) — remove it from UNGATED_BY_DESIGN and let the real gate apply`,
      ).toBe(true);
    }
  });

  it("pins the full set of ungated rows", () => {
    /* The list this PR was asked to produce, as an assertion rather than prose:
       a future change that ungates a second screen fails here, so the owner is
       told before it ships — not after someone notices a page they should not
       be able to see. Sorted so the assertion does not depend on list order. */
    expect([...UNGATED_BY_DESIGN.keys()].sort()).toEqual(["/activity-inbox", "/announcements"]);
  });

  it("keeps Positions out of every mobile entry and route gate", () => {
    expect(allRows.some((item) => item.to === "/team?tab=positions")).toBe(false);
    expect(hasNavDestination("/team?tab=positions")).toBe(false);
  });

  it("gates every Team row on its exact query-bearing NAV_TABS destination", () => {
    const teamRows = allRows.filter((item) => item.to.startsWith("/team?tab="));
    /* The 2026-08 Team redesign renamed the strip tabs — the mobile rows follow
       the NAV_TABS destinations (directory / departments2) so the gate stays an
       exact query match while the mobile screens remain the classic modules. */
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
