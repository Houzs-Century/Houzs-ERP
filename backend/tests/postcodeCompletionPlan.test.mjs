/* Owner 2026-11-18 — "records that have a postcode but no City/State — backfill
 * all of them", and store the postcode an old DP job only shows at read time.
 * scripts/complete-postcode-fields.mjs plans from scripts/lib/postcode-completion.mjs;
 * these pin what it fills, what it refuses, and that DP detection is the
 * read-time rule (src/scm/lib/postcode-from-address.ts) and not a copy of it. */
import { describe, expect, test } from "vitest";
import {
  ALL_GROUPS,
  buildCompletionPlan,
  COMPLETION_TARGETS,
  completionIndex,
  countByField,
  DEFAULT_GROUPS,
  parseGroups,
  planVenueRenames,
  VENUE_RENAMES,
  venueCoverage,
  verifyWritten,
} from "../scripts/lib/postcode-completion.mjs";
import { fillPostcodeFields, dpDestFields } from "../src/scm/lib/postcode-from-address.ts";

const LOCALITIES = [
  { postcode: "43500", city: "Semenyih", state: "Selangor" },
  { postcode: "47000", city: "Sungai Buloh", state: "Selangor" },
  { postcode: "81300", city: "Skudai", state: "Johor" },
  { postcode: "81300", city: "Johor Bahru", state: "Johor" },
  { postcode: "50000", city: "Kuala Lumpur", state: "W.P. Kuala Lumpur" },
  { postcode: "99999", city: "Somewhere", state: "Perak" },
  { postcode: "99999", city: "Somewhere", state: "Kedah" },
];

const plan = (rows) => buildCompletionPlan({ rows, localities: LOCALITIES });
const row = (target, id, values, extra = {}) => ({ target, id, companyId: 1, name: `name ${id}`, values, locked: null, ...extra });

describe("complete from postcode", () => {
  test("the owner's supplier: postcode 43500, empty State and City -> both filled", () => {
    const { planned } = plan([row("suppliers", "s1", { postcode: "43500", city: null, state: "" })]);
    expect(planned).toEqual([expect.objectContaining({ target: "suppliers", id: "s1", name: "name s1", changes: { state: "Selangor", city: "Semenyih" } })]);
  });

  test("never overwrites: an existing city stays, only the empty state is filled", () => {
    const { planned } = plan([row("venues", "v1", { postcode: "43500", city: "Kajang", state: null })]);
    expect(planned[0].changes).toEqual({ state: "Selangor" });
  });

  test("a postcode under several cities fills the state only and lists the city as unresolved", () => {
    const { planned, unresolved } = plan([row("warehouses", "w1", { postcode: "81300", city: "", state: "" })]);
    expect(planned[0].changes).toEqual({ state: "Johor" });
    expect(unresolved[0].reason).toMatch(/several cities \(Skudai, Johor Bahru\)/);
    expect(unresolved[0].codes).toBe("city-several-cities");
  });

  test("a postcode under several states fills nothing", () => {
    const { planned, unresolved } = plan([row("threepl", "t1", { postcode: "99999", city: "", state: "" })]);
    expect(planned).toEqual([]);
    expect(unresolved[0].codes).toBe("postcode-several-states");
  });

  test("an existing state that disagrees is flagged and nothing on that side is written, not even the empty city", () => {
    const { planned, flagged } = plan([row("suppliers", "s2", { postcode: "43500", city: "", state: "Johor" })]);
    expect(planned).toEqual([]);
    expect(flagged[0].reason).toMatch(/43500 is Selangor .* state says "Johor"/);
  });

  test("a state spelled differently but canonically the same is not a disagreement", () => {
    const { planned, flagged } = plan([row("suppliers", "s3", { postcode: "50000", city: "", state: "Kuala Lumpur" })]);
    expect(flagged).toEqual([]);
    expect(planned[0].changes).toEqual({ city: "Kuala Lumpur" });
  });

  test("an unknown or malformed postcode is unresolved, and an empty one on a master is not this script's job", () => {
    const { planned, unresolved } = plan([
      row("suppliers", "a", { postcode: "12345", city: "", state: "" }),
      row("suppliers", "b", { postcode: "4350", city: "", state: "" }),
      row("suppliers", "c", { postcode: "", city: "", state: "", address1: "Lot 1, 43500 Semenyih" }),
    ]);
    expect(planned).toEqual([]);
    expect(unresolved.map((u) => u.codes)).toEqual(["postcode-not-in-my_localities", "postcode-not-5-digits"]);
  });

  test("a complete row plans nothing", () => {
    expect(plan([row("suppliers", "s", { postcode: "43500", city: "Semenyih", state: "Selangor" })]).planned).toEqual([]);
  });

  test("a Delivery Order fills both state columns when both are empty, and only the empty one otherwise", () => {
    const { planned } = plan([
      row("do", "d1", { postcode: "47000", city: "", state: "", customer_state: "" }),
      row("do", "d2", { postcode: "47000", city: "Sungai Buloh", state: "Selangor", customer_state: "" }),
    ]);
    expect(planned.map((p) => p.changes)).toEqual([
      { state: "Selangor", customer_state: "Selangor", city: "Sungai Buloh" },
      { customer_state: "Selangor" },
    ]);
  });

  test("a Sales Order fills customer_state, and its name is never carried into the plan", () => {
    const { planned } = plan([row("so", "HC-SO-1", { postcode: "47000", city: "", customer_state: "" })]);
    expect(planned[0]).toEqual(expect.objectContaining({ name: null, changes: { customer_state: "Selangor", city: "Sungai Buloh" } }));
  });

  test("a locked document is listed as locked and never planned", () => {
    const { planned, locked } = plan([row("so", "HC-SO-2", { postcode: "47000", city: "", customer_state: "" }, { locked: "a live Delivery Order carries it" })]);
    expect(planned).toEqual([]);
    expect(locked[0]).toEqual(expect.objectContaining({ id: "HC-SO-2", reason: "a live Delivery Order carries it", changes: { customer_state: "Selangor", city: "Sungai Buloh" } }));
  });

  test("locked must be passed explicitly", () => {
    expect(() => buildCompletionPlan({ rows: [{ target: "so", id: "x", companyId: 1, values: {} }], localities: LOCALITIES })).toThrow(/locked/);
  });
});

describe("old DP jobs", () => {
  test("an empty postcode written once in the address is stored with its city and state, on both sides", () => {
    const { planned } = plan([row("dp", "j1", {
      postcode: "", city: "", state: "", address1: "HOOKKA MANUFACTURING", address2: "Lot 5, 47000 SUNGAI BULOH.",
      from_postcode: null, from_city: null, from_state: null, from_address1: "No 2, Jalan 1", from_address2: "43500 Semenyih",
    })]);
    expect(planned[0].changes).toEqual({
      postcode: "47000", state: "Selangor", city: "Sungai Buloh",
      from_postcode: "43500", from_state: "Selangor", from_city: "Semenyih",
    });
    expect(planned[0].notes).toBe("postcode taken from the address text; from_postcode taken from the address text");
  });

  test("two known postcodes in one address = none", () => {
    const { planned, unresolved } = plan([row("dp", "j2", { postcode: "", city: "", state: "", address1: "43500 Semenyih / 47000 Sungai Buloh" })]);
    expect(planned).toEqual([]);
    expect(unresolved[0].codes).toBe("two-known-postcodes");
  });

  test("a lot number that my_localities does not know is not a postcode", () => {
    const { planned } = plan([row("dp", "j3", { postcode: "", city: "", state: "", address1: "12345 Jalan Besar, 43500 Semenyih" })]);
    expect(planned[0].changes.postcode).toBe("43500");
  });

  test("a detected postcode in another state than the stored one is flagged, not written", () => {
    const { planned, flagged } = plan([row("dp", "j4", { postcode: "", city: "", state: "Johor", address1: "43500 Semenyih" })]);
    expect(planned).toEqual([]);
    expect(flagged[0].codes).toBe("state-disagrees(state)");
  });

  test("detection agrees with the read-time fill (postcode-from-address.ts) on the same rows", () => {
    const known = new Map([["47000", { city: "Sungai Buloh", state: "Selangor" }], ["43500", { city: "Semenyih", state: "Selangor" }]]);
    const cases = [
      { address1: "Lot 5, 47000 SUNGAI BULOH.", postcode: "", city: "", state: "" },
      { address1: "12345 Jalan Besar", address2: "43500 Semenyih", postcode: null, city: null, state: null },
      { address1: "43500 / 47000", postcode: "", city: "", state: "" },
      { address1: "Tel 0123456789", postcode: "", city: "", state: "" },
    ];
    for (const values of cases) {
      const readTime = fillPostcodeFields(dpDestFields(values), known);
      const stored = plan([row("dp", "x", values)]).planned[0]?.changes ?? {};
      expect(stored.postcode ?? null).toBe(readTime.postcode);
      if (readTime.postcode) expect([stored.city, stored.state]).toEqual([readTime.city, readTime.state]);
    }
  });
});

describe("TABLES=", () => {
  test("defaults leave Sales Orders and Delivery Orders out", () => {
    expect(parseGroups("")).toEqual({ ok: true, groups: DEFAULT_GROUPS });
    expect(DEFAULT_GROUPS).not.toContain("so");
    expect(DEFAULT_GROUPS).not.toContain("do");
  });
  test("names, all, and a typo", () => {
    expect(parseGroups("so, DO")).toEqual({ ok: true, groups: ["so", "do"] });
    expect(parseGroups("all")).toEqual({ ok: true, groups: ["masters", "dp", "case", "so", "do"] });
    expect(parseGroups("all,venue_rename").groups).toContain("venue_rename");
    expect(ALL_GROUPS).toContain("venue_rename");
    expect(parseGroups("masters,sos").ok).toBe(false);
  });
  test("every target belongs to a known group, and only masters print names", () => {
    for (const x of COMPLETION_TARGETS) expect(ALL_GROUPS).toContain(x.group);
    expect(COMPLETION_TARGETS.filter((x) => x.printName).map((x) => x.key)).toEqual(["suppliers", "venues", "warehouses", "threepl"]);
    expect(COMPLETION_TARGETS.filter((x) => x.lock).map((x) => x.key)).toEqual(["so", "do"]);
  });
});

describe("countByField", () => {
  test("counts each filled column per table", () => {
    const { planned } = plan([
      row("suppliers", "1", { postcode: "43500", city: "", state: "" }),
      row("suppliers", "2", { postcode: "43500", city: "Kajang", state: "" }),
    ]);
    expect(Object.fromEntries(countByField(planned).get("suppliers"))).toEqual({ state: 2, city: 1 });
  });
});

describe("verifyWritten", () => {
  const idx = completionIndex(LOCALITIES);
  test("exactly the planned values in my_localities' shape passes", () => {
    expect(verifyWritten("suppliers", { state: "Selangor", city: "Semenyih" }, { postcode: "43500", state: "Selangor", city: "Semenyih" }, idx)).toEqual([]);
  });
  test("a different value, a wrong state, a vanished row each fail", () => {
    expect(verifyWritten("suppliers", { city: "Semenyih" }, { postcode: "43500", state: "Selangor", city: "Kajang" }, idx)).toHaveLength(2);
    expect(verifyWritten("do", { state: "Johor" }, { postcode: "43500", state: "Johor", customer_state: "Selangor", city: "x" }, idx)[0]).toMatch(/not postcode 43500's state/);
    expect(verifyWritten("dp", { postcode: "43500" }, null, idx)).toEqual(["row not found on re-read"]);
  });
  test("a DP from-side write is checked against the from-side postcode", () => {
    const read = { postcode: null, city: null, state: null, from_postcode: "47000", from_city: "Sungai Buloh", from_state: "Selangor" };
    expect(verifyWritten("dp", { from_postcode: "47000", from_city: "Sungai Buloh", from_state: "Selangor" }, read, idx)).toEqual([]);
  });
});

describe("venueCoverage", () => {
  test("matched / unmatched / with postcode and state, and what this plan adds", () => {
    const cov = venueCoverage([
      { venue: "Sunway Pyramid", venueId: "1", venuePostcode: "47500", venueState: "Selangor", venueCity: "Subang Jaya" },
      { venue: "Sunway Pyramid", venueId: "1", venuePostcode: "47500", venueState: "Selangor", venueCity: "Subang Jaya" },
      { venue: "MITEC", venueId: "2", venuePostcode: "50480", venueState: null, venueCity: null },
      { venue: "Unknown Hall", venueId: null },
      { venue: "Unknown Hall", venueId: null },
      { venue: "Other Hall", venueId: null },
      { venue: "  ", venueId: null },
    ], new Set(["2"]));
    expect(cov).toEqual({
      projects: 7, noVenue: 1, matched: 3, matchedVenues: 2, withPostcode: 3, withState: 2, withCity: 2, withStateAfterPlan: 3,
      unmatched: [["Unknown Hall", 2], ["Other Hall", 1]],
    });
  });
});

describe("project venue rename (IOIGECC)", () => {
  const MASTER = ["IOI GRAND EXHIBITION & CONVENTION CENTRE", "MID VALLEY"];
  const proj = (id, code, venue) => ({ id, code, venue });
  test("all six IOIGECC projects, the IOI-MALL-PUTRAJAYA-coded one included, get the official name; others untouched", () => {
    const projects = [
      proj(1, "2026-10-HOMELOVE-PUTRAJAYA-IOIGECC-AKEMI", "IOIGECC"),
      proj(2, "2026-10-HOMELOVE-PUTRAJAYA-IOIGECC-ZANOTTI", "ioigecc "),
      proj(3, "2026-12-X", "IOIGECC"),
      proj(4, "2027-03-X", "IOIGECC"),
      proj(5, "2027-07-HOMELOVE-PUTRAJAYA-IOI-MALL-PUTRAJAYA-AKEMI", "IOIGECC"),
      proj(6, "2027-10-X", "IOIGECC"),
      proj(7, "MV", "MID VALLEY"),
      proj(8, "NEAR", "IOIGECC HALL 2"),
    ];
    const { planned, refused } = planVenueRenames(projects, MASTER);
    expect(refused).toEqual([]);
    expect(planned.map((p) => p.id)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(new Set(planned.map((p) => p.to))).toEqual(new Set(["IOI GRAND EXHIBITION & CONVENTION CENTRE"]));
    expect(planned[1]).toEqual({ id: "2", code: "2026-10-HOMELOVE-PUTRAJAYA-IOIGECC-ZANOTTI", from: "ioigecc", to: "IOI GRAND EXHIBITION & CONVENTION CENTRE" });
  });
  test("refused when the company's venue master lacks the official name, or already has an IOIGECC row", () => {
    expect(planVenueRenames([proj(1, "A", "IOIGECC")], ["MID VALLEY"])).toEqual({
      planned: [], refused: [expect.objectContaining({ projects: 1, reason: expect.stringMatching(/has no "IOI GRAND/) })],
    });
    expect(planVenueRenames([proj(1, "A", "IOIGECC")], [...MASTER, "ioigecc"]).planned).toEqual([]);
  });
  test("a second run plans nothing", () => {
    expect(planVenueRenames([proj(1, "A", "IOI GRAND EXHIBITION & CONVENTION CENTRE")], MASTER)).toEqual({ planned: [], refused: [] });
  });
  test("the rename list is the owner's one rename, and TABLES knows venue_rename without running it by default", () => {
    expect(VENUE_RENAMES).toEqual([{ from: "IOIGECC", to: "IOI GRAND EXHIBITION & CONVENTION CENTRE" }]);
    expect(parseGroups("venue_rename")).toEqual({ ok: true, groups: ["venue_rename"] });
    expect(DEFAULT_GROUPS).not.toContain("venue_rename");
  });
});
