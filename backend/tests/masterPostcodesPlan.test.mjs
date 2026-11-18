/* Owner 2026-11-17 — every Delivery Planning job carries Postcode + City + State,
 * so the masters it draws from (suppliers, venues, warehouses, 3PL) get a
 * postcode proposed by scripts/fill-master-postcodes.mjs. These pin which
 * evidence is enough and which is refused: a postcode must exist in
 * my_localities, City/State come from my_localities, and anything ambiguous is
 * UNRESOLVED, never written. */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  buildPlan,
  CURATED_CONFIDENCE,
  curatedIndex,
  curatedWarehouseIndex,
  geocodeQuery,
  localityIndex,
  MASTER_TABLES,
  parseGeocodePostcode,
  postcodeCandidates,
  postcodeFromAddress,
} from "../scripts/lib/master-postcodes.mjs";

const LOCALITIES = [
  { postcode: "47500", city: "Subang Jaya", state: "Selangor" },
  { postcode: "10050", city: "George Town", state: "Pulau Pinang" },
  { postcode: "81300", city: "Skudai", state: "Johor" },
  { postcode: "81300", city: "Johor Bahru", state: "Johor" },
  { postcode: "50000", city: "Kuala Lumpur", state: "Kuala Lumpur" },
  // A seed conflict: one postcode under two states.
  { postcode: "99999", city: "Somewhere", state: "Perak" },
  { postcode: "99999", city: "Somewhere", state: "Kedah" },
];
const idx = localityIndex(LOCALITIES);

describe("postcodeCandidates", () => {
  test("finds standalone 5-digit runs and ignores digits inside longer numbers", () => {
    expect(postcodeCandidates("No 3, Jalan SS15/4, 47500 Subang Jaya, tel 012-3456789, SSM 202301012345")).toEqual(["47500"]);
  });
  test("de-duplicates a postcode written twice", () => {
    expect(postcodeCandidates("47500 Subang Jaya, Selangor 47500")).toEqual(["47500"]);
  });
  test("empty and missing text give nothing", () => {
    expect(postcodeCandidates(null)).toEqual([]);
    expect(postcodeCandidates("")).toEqual([]);
  });
});

describe("postcodeFromAddress", () => {
  test("one valid postcode: City and State come from my_localities", () => {
    expect(postcodeFromAddress(idx, "12 Lebuh Pantai, 10050 Penang")).toEqual({
      ok: true, postcode: "10050", city: "George Town", state: "Pulau Pinang", confidence: "high",
    });
  });
  test("a 5-digit number that is not in my_localities is not a postcode", () => {
    const r = postcodeFromAddress(idx, "Lot 12345, Kawasan Perindustrian");
    expect(r.ok).toBe(false);
    expect(r.ambiguous).toBeUndefined();
  });
  test("two different valid postcodes are ambiguous", () => {
    const r = postcodeFromAddress(idx, "Office 47500 Subang Jaya; store 50000 KL");
    expect(r).toMatchObject({ ok: false, ambiguous: true });
  });
  test("a postcode under several cities resolves only when the address names one", () => {
    expect(postcodeFromAddress(idx, "Jalan Pendidikan, 81300 Skudai, Johor")).toMatchObject({ ok: true, city: "Skudai" });
    expect(postcodeFromAddress(idx, "Jalan Pendidikan, 81300 Johor")).toMatchObject({ ok: false, ambiguous: true });
  });
  test("a postcode the catalog puts under two states is refused", () => {
    expect(postcodeFromAddress(idx, "Kampung X, 99999")).toMatchObject({ ok: false, ambiguous: true });
  });
  test("a stray non-postcode number beside the real one lowers confidence, not the answer", () => {
    expect(postcodeFromAddress(idx, "Lot 12345, 47500 Subang Jaya")).toMatchObject({ ok: true, postcode: "47500", confidence: "medium" });
  });
});

describe("geocodeQuery", () => {
  const venues = MASTER_TABLES.find((m) => m.key === "venues");
  const suppliers = MASTER_TABLES.find((m) => m.key === "suppliers");
  test("a venue is looked up by its name and state", () => {
    expect(geocodeQuery(venues, { name: "Sunway Pyramid", state: "Selangor" })).toBe("Sunway Pyramid, Selangor, Malaysia");
    expect(geocodeQuery(venues, { name: "MITEC", state: null })).toBe("MITEC, Malaysia");
  });
  test("the others by their address, and nothing when there is none", () => {
    expect(geocodeQuery(suppliers, { name: "ABC", address: "Jalan 1", city: null, state: "Johor" })).toBe("Jalan 1, Johor, Malaysia");
    expect(geocodeQuery(suppliers, { name: "ABC", address: "  " })).toBe("");
  });
});

describe("parseGeocodePostcode", () => {
  test("reads the top result's postal_code, location type and partial flag", () => {
    expect(parseGeocodePostcode({
      status: "OK",
      results: [{
        formatted_address: "Sunway Pyramid, 47500 Subang Jaya",
        partial_match: false,
        geometry: { location_type: "GEOMETRIC_CENTER" },
        address_components: [{ long_name: "47500", types: ["postal_code"] }],
      }],
    })).toEqual({ postcode: "47500", locationType: "GEOMETRIC_CENTER", partial: false, formatted: "Sunway Pyramid, 47500 Subang Jaya" });
  });
  test("ZERO_RESULTS is no hit", () => {
    expect(parseGeocodePostcode({ status: "ZERO_RESULTS", results: [] })).toBeNull();
  });
});

describe("buildPlan", () => {
  const row = (over) => ({ master: "suppliers", id: "s1", companyId: 1, name: "ABC Sdn Bhd", address: "", city: null, state: null, ...over });
  const run = (rows, geocodes = new Map()) =>
    buildPlan({ rows, localities: LOCALITIES, geocodes, geocodeSkipped: () => "not geocoded: no key", curated: null, curatedWarehouses: null });

  test("an address-text postcode is planned with its source and confidence", () => {
    const { planned, unresolved } = run([row({ address: "No 3, 47500 Subang Jaya" })]);
    expect(unresolved).toEqual([]);
    expect(planned).toEqual([expect.objectContaining({
      master: "suppliers", id: "s1", proposed: { postcode: "47500", city: "Subang Jaya", state: "Selangor", street: null },
      source: "address text", confidence: "high", note: null,
    })]);
  });

  test("no postcode in the text and no geocode: unresolved, with why", () => {
    const { planned, unresolved } = run([row({ master: "venues", id: "7", name: "Sunway Pyramid", address: null, state: "Selangor" })]);
    expect(planned).toEqual([]);
    expect(unresolved[0].reason).toMatch(/no postcode in the address text; not geocoded: no key/);
  });

  test("a geocoded venue is planned when Google's postcode is in my_localities", () => {
    const geo = new Map([["venues:7", { postcode: "47500", locationType: "GEOMETRIC_CENTER", partial: false }]]);
    const { planned } = run([row({ master: "venues", id: "7", name: "Sunway Pyramid", address: null, state: "Selangor" })], geo);
    expect(planned[0]).toMatchObject({ source: "geocode", confidence: "medium", proposed: { postcode: "47500", state: "Selangor" } });
  });

  test("a partial or approximate geocode, or one outside my_localities, is never planned", () => {
    const rows = [row({ id: "a", address: "Jalan X" }), row({ id: "b", address: "Jalan Y" }), row({ id: "c", address: "Jalan Z" })];
    const geo = new Map([
      ["suppliers:a", { postcode: "47500", locationType: "ROOFTOP", partial: true }],
      ["suppliers:b", { postcode: "47500", locationType: "APPROXIMATE", partial: false }],
      ["suppliers:c", { postcode: "12345", locationType: "ROOFTOP", partial: false }],
    ]);
    const { planned, unresolved } = run(rows, geo);
    expect(planned).toEqual([]);
    expect(unresolved.map((u) => u.id)).toEqual(["a", "b", "c"]);
  });

  test("a postcode that contradicts the State already on the row is refused", () => {
    const { planned, unresolved } = run([row({ address: "10050 George Town", state: "Johor" })]);
    expect(planned).toEqual([]);
    expect(unresolved[0]).toMatchObject({ settled: true });
    expect(unresolved[0].reason).toMatch(/is in Pulau Pinang, but the row says Johor/);
  });

  test("an alias of the same state is not a contradiction (Penang = Pulau Pinang)", () => {
    const { planned } = run([row({ master: "warehouses", address: "10050 George Town", state: "Penang" })]);
    expect(planned[0].proposed.state).toBe("Pulau Pinang");
  });

  test("a differing City is replaced by my_localities' and the plan says so", () => {
    const { planned } = run([row({ address: "47500 Subang", city: "Subang" })]);
    expect(planned[0].note).toBe('city "Subang" becomes my_localities\' "Subang Jaya"');
  });

  test("an ambiguous address is settled: geocoding is not consulted", () => {
    const geo = new Map([["suppliers:s1", { postcode: "50000", locationType: "ROOFTOP", partial: false }]]);
    const { planned, unresolved } = run([row({ address: "47500 and 50000" })], geo);
    expect(planned).toEqual([]);
    expect(unresolved[0]).toMatchObject({ settled: true });
  });
});

describe("curated venue postcodes", () => {
  const venue = (over) => ({ master: "venues", id: "28", companyId: 1, name: "SUNWAY PYRAMID CONVENTION CENTRE", address: null, city: null, state: null, ...over });
  const entry = (over) => ({ id: 28, name: "SUNWAY PYRAMID CONVENTION CENTRE", postcode: "47500", city: "Subang Jaya", state: "Selangor", confidence: "high", ...over });
  const run = (rows, entries, geocodes = new Map()) =>
    buildPlan({ rows, localities: LOCALITIES, geocodes, geocodeSkipped: () => "not geocoded: no key", curated: curatedIndex(entries).byName, curatedWarehouses: null });

  test("buildPlan refuses a call that forgets to say whether there is a curated list", () => {
    expect(() => buildPlan({ rows: [], localities: LOCALITIES, geocodes: new Map(), geocodeSkipped: () => "", curatedWarehouses: null })).toThrow(/curated/);
    expect(() => buildPlan({ rows: [], localities: LOCALITIES, geocodes: new Map(), geocodeSkipped: () => "", curated: null })).toThrow(/curatedWarehouses/);
  });

  test("an exact name match is planned, City and State from my_localities", () => {
    const { planned, unresolved } = run([venue()], [entry()]);
    expect(unresolved).toEqual([]);
    expect(planned[0]).toMatchObject({
      id: "28", source: "curated list", confidence: "high", note: null,
      proposed: { postcode: "47500", city: "Subang Jaya", state: "Selangor", street: null },
    });
  });

  test("the name must match; a near name is not used", () => {
    const { planned, unresolved } = run([venue({ name: "SUNWAY PYRAMID" })], [entry()]);
    expect(planned).toEqual([]);
    expect(unresolved[0].reason).toMatch(/no curated entry with this name/);
  });

  test("case and surrounding spaces are ignored (company 2's Penang Waterfront Convention Centre), nothing else", () => {
    const pwcc = entry({ id: 70, name: "PENANG WATERFRONT CONVENTION CENTRE", postcode: "10050", city: "George Town", state: "Pulau Pinang" });
    const ok = run([venue({ id: "512", companyId: 2, name: "  Penang Waterfront Convention Centre " })], [pwcc]);
    expect(ok.planned[0]).toMatchObject({ id: "512", source: "curated list", proposed: { postcode: "10050", state: "Pulau Pinang" } });
    for (const name of ["Penang Waterfront Convention Center", "Penang  Waterfront Convention Centre", "PENANG WATERFRONT CONVENTION CENTRE (PWCC)"]) {
      expect(run([venue({ name })], [pwcc]).planned, name).toEqual([]);
    }
  });

  test("two entries that differ only in case are a duplicate, dropped", () => {
    const idx = curatedIndex([entry(), entry({ name: "Sunway Pyramid Convention Centre", postcode: "50000" })]);
    expect(idx.duplicates).toEqual(["SUNWAY PYRAMID CONVENTION CENTRE"]);
    expect(idx.byName.size).toBe(0);
  });

  test("the committed list has THE STARLING MALL (id 33) at 47400 Petaling Jaya, Selangor", () => {
    const data = JSON.parse(readFileSync(new URL("../scripts/data/venue-postcodes.json", import.meta.url), "utf8"));
    expect(curatedIndex(data.entries).byName.get("the starling mall")).toMatchObject({ id: "33", postcode: "47400", city: "Petaling Jaya", state: "Selangor", confidence: "high" });
  });

  test("the id is only a hint: a different id with the same name is planned and noted", () => {
    const { planned } = run([venue({ id: "999" })], [entry()]);
    expect(planned[0].note).toMatch(/curated id 28 differs from row id 999/);
  });

  test("only high and medium confidence are used; low goes to unresolved", () => {
    expect([...CURATED_CONFIDENCE]).toEqual(["high", "medium"]);
    expect(run([venue()], [entry({ confidence: "medium" })]).planned[0].confidence).toBe("medium");
    const low = run([venue()], [entry({ confidence: "low" })]);
    expect(low.planned).toEqual([]);
    expect(low.unresolved[0].reason).toMatch(/curated entry is low confidence, not used/);
  });

  test("a curated postcode not in my_localities is not planned", () => {
    const { planned, unresolved } = run([venue()], [entry({ postcode: "12345" })]);
    expect(planned).toEqual([]);
    expect(unresolved[0].reason).toMatch(/curated postcode 12345 is not in my_localities/);
  });

  test("my_localities disagreeing with the researched state is flagged and settled (geocode cannot override)", () => {
    const geo = new Map([["venues:28", { postcode: "47500", locationType: "ROOFTOP", partial: false }]]);
    const { planned, unresolved } = run([venue()], [entry({ state: "Kuala Lumpur" })], geo);
    expect(planned).toEqual([]);
    expect(unresolved[0]).toMatchObject({ settled: true });
    expect(unresolved[0].reason).toMatch(/is Selangor in my_localities, but the research says Kuala Lumpur/);
  });

  test("a researched city that my_localities spells differently is replaced and noted", () => {
    const { planned } = run([venue()], [entry({ city: "Petaling Jaya" })]);
    expect(planned[0].proposed.city).toBe("Subang Jaya");
    expect(planned[0].note).toMatch(/researched city "Petaling Jaya", my_localities says "Subang Jaya"/);
  });

  test("the researched city breaks a tie between cities under one postcode", () => {
    const row = venue({ name: "SUTERA MALL", id: "32" });
    const { planned } = run([row], [entry({ id: 32, name: "SUTERA MALL", postcode: "81300", city: "Skudai", state: "Johor" })]);
    expect(planned[0].proposed).toEqual({ postcode: "81300", city: "Skudai", state: "Johor", street: null });
  });

  test("a row whose State already contradicts the curated postcode is refused", () => {
    const { planned, unresolved } = run([venue({ state: "Johor" })], [entry()]);
    expect(planned).toEqual([]);
    expect(unresolved[0].reason).toMatch(/is in Selangor, but the row says Johor/);
  });

  test("curated entries never apply to other masters", () => {
    const { planned } = run([venue({ master: "suppliers" })], [entry()]);
    expect(planned).toEqual([]);
  });

  test("a name listed twice is dropped, never guessed", () => {
    const idx = curatedIndex([entry(), entry({ postcode: "50000" })]);
    expect(idx.duplicates).toEqual(["SUNWAY PYRAMID CONVENTION CENTRE"]);
    expect(idx.byName.size).toBe(0);
  });

  test("the committed data file is well-formed: unique names, 5-digit postcodes, canonical states, a source each", () => {
    const data = JSON.parse(readFileSync(new URL("../scripts/data/venue-postcodes.json", import.meta.url), "utf8"));
    const states = new Set(["Johor", "Kedah", "Kelantan", "Kuala Lumpur", "Labuan", "Melaka", "Negeri Sembilan", "Pahang", "Perak", "Perlis", "Pulau Pinang", "Putrajaya", "Sabah", "Sarawak", "Selangor", "Terengganu"]);
    expect(data.entries.length).toBeGreaterThan(0);
    expect(curatedIndex(data.entries).duplicates).toEqual([]);
    for (const e of data.entries) {
      expect(e.postcode, e.name).toMatch(/^\d{5}$/);
      expect(states.has(e.state), `${e.name}: ${e.state}`).toBe(true);
      expect(["high", "medium", "low"]).toContain(e.confidence);
      expect(e.source, e.name).toMatch(/^https?:\/\//);
    }
  });
});

describe("curated warehouse addresses", () => {
  const wh = (over) => ({ master: "warehouses", id: "w1", companyId: 1, name: "PENANG WAREHOUSE", code: "PG WAREHOUSE", address: null, city: null, state: "Pulau Pinang", ...over });
  const ENTRIES = [
    { names: ["PENANG WAREHOUSE", "PG WAREHOUSE"], street: "868, Jalan Estate Baru, Mukim 12", postcode: "10050", city: "George Town", state: "Pulau Pinang" },
    { names: ["BALAKONG WAREHOUSE"], street: "1831-B, Jalan KPB 1", postcode: "47500", city: "Subang Jaya", state: "Selangor" },
  ];
  const run = (rows, entries = ENTRIES) =>
    buildPlan({ rows, localities: LOCALITIES, geocodes: new Map(), geocodeSkipped: () => "not geocoded: no key", curated: null, curatedWarehouses: curatedWarehouseIndex(entries).byName });

  test("a name match ignoring case plans postcode, my_localities City/State, and the street for an empty location", () => {
    const { planned, unresolved } = run([wh({ name: "penang warehouse" })]);
    expect(unresolved).toEqual([]);
    expect(planned[0]).toMatchObject({
      source: "official warehouse address", confidence: "high", note: null,
      proposed: { postcode: "10050", city: "George Town", state: "Pulau Pinang", street: "868, Jalan Estate Baru, Mukim 12" },
    });
  });

  test("the code matches when the name does not", () => {
    const { planned } = run([wh({ name: "Penang Main Store", code: "PG WAREHOUSE" })]);
    expect(planned[0].proposed.postcode).toBe("10050");
  });

  test("otherwise the match is exact: a longer name is not used", () => {
    const { planned, unresolved } = run([wh({ name: "PENANG WAREHOUSE 2", code: "PG2" })]);
    expect(planned).toEqual([]);
    expect(unresolved[0].reason).toMatch(/no curated warehouse entry with this name or code/);
  });

  test("a location already filled is kept: no street planned", () => {
    const { planned } = run([wh({ address: "Lot 9, Simpang Ampat" })]);
    expect(planned[0].proposed.street).toBeNull();
    expect(planned[0].note).toMatch(/location already filled, kept/);
  });

  test("a location holding a different valid postcode is refused", () => {
    const { planned, unresolved } = run([wh({ address: "Lot 9, 47500 Subang Jaya" })]);
    expect(planned).toEqual([]);
    expect(unresolved[0]).toMatchObject({ settled: true });
    expect(unresolved[0].reason).toMatch(/already holds postcode 47500/);
  });

  test("the code-guessed State is replaced by the official one, and the plan says so", () => {
    const { planned } = run([wh({ name: "BALAKONG WAREHOUSE", code: "KL WAREHOUSE", state: "Kuala Lumpur" })]);
    expect(planned[0].proposed.state).toBe("Selangor");
    expect(planned[0].note).toMatch(/STATE "Kuala Lumpur" becomes "Selangor" \(official address\)/);
  });

  test("name and code pointing at different addresses are refused", () => {
    const { planned, unresolved } = run([wh({ name: "BALAKONG WAREHOUSE", code: "PG WAREHOUSE" })]);
    expect(planned).toEqual([]);
    expect(unresolved[0].reason).toMatch(/different curated warehouse addresses/);
  });

  test("a name claimed by two entries is dropped", () => {
    const idx = curatedWarehouseIndex([{ names: ["X"], postcode: "47500" }, { names: ["x"], postcode: "50000" }]);
    expect(idx.duplicates).toEqual(["x"]);
    expect(idx.byName.size).toBe(0);
  });

  test("warehouse entries never apply to venues", () => {
    const { planned } = run([wh({ master: "venues" })]);
    expect(planned).toEqual([]);
  });

  test("the committed warehouse file is well-formed and leaves out the sites with no fixed address", () => {
    const data = JSON.parse(readFileSync(new URL("../scripts/data/warehouse-addresses.json", import.meta.url), "utf8"));
    const idx = curatedWarehouseIndex(data.entries);
    expect(idx.duplicates).toEqual([]);
    for (const e of data.entries) {
      expect(e.postcode).toMatch(/^\d{5}$/);
      expect(e.street.length).toBeGreaterThan(0);
    }
    for (const n of ["guangzhou warehouse", "consignment (out)", "cash & carry segment - fair"]) expect(idx.byName.has(n)).toBe(false);
    expect(idx.byName.get("pg warehouse")?.postcode).toBe("14100");
    expect(idx.byName.get("sbh display")?.postcode).toBe("88100");
    expect(idx.byName.get("sunway showroom")?.postcode).toBe("13700");
    expect(idx.byName.has("em display")).toBe(false);
  });
});
