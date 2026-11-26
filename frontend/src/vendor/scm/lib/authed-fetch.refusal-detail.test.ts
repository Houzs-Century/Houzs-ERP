import { describe, expect, test } from "vitest";
import { humanApiError } from "./authed-fetch";

const GENERIC_400 =
  "Some of the details weren't accepted. Please check what you entered and try again.";

const PROD_TOTAL_HEIGHTS = [
  '10"', '12"', '14"', '16"', '17“', '18"', '19“', '20"',
  '21”', '22"', '23“', '24"', '25”', '26"', '27“', '28"',
];

const body = (o: unknown) => JSON.stringify(o);

describe("variant_not_allowed — the derived field is the whole point", () => {
  const refusal = body({
    error: "variant_not_allowed",
    field: "total_height",
    value: '30"',
    allowed: PROD_TOTAL_HEIGHTS,
    derivedFrom: [
      { field: "divan_height", value: '16"' },
      { field: "leg_height", value: '4"' },
      { field: "gap", value: '10"' },
    ],
    itemCode: "BF-DEMO-K",
  });

  test("it is no longer the generic sentence", () => {
    expect(humanApiError(400, refusal)).not.toBe(GENERIC_400);
  });

  test("it names the value the operator has and how it was arrived at", () => {
    const msg = humanApiError(400, refusal);
    expect(msg).toContain('30"');
    expect(msg).toContain('Divan Height 16"');
    expect(msg).toContain('Leg Height 4"');
    expect(msg).toContain('Gap 10"');
  });

  test("it names the three boxes he CAN change, because Total Height has no input", () => {
    const msg = humanApiError(400, refusal);
    expect(msg).toMatch(/no Total Height/i);
    expect(msg).toMatch(/change Divan Height, Leg Height or Gap/i);
    expect(msg).toMatch(/add up to/i);
  });

  test("it lists what the totals may be", () => {
    const msg = humanApiError(400, refusal);
    expect(msg).toContain('10"');
    expect(msg).toContain('28"');
  });

  test("LOOK-ALIKE GLYPHS: the printed list never shows two spellings of one number", () => {
    const msg = humanApiError(400, refusal);
    expect(msg).not.toMatch(/[‘’‚‛“”„‟′″]/);
    const rendered = msg.slice(msg.indexOf("add up to"));
    for (const n of [17, 19, 21, 23, 25, 27]) {
      expect(rendered).toContain(`${n}"`);
    }
  });

  test("no column names, no JSON, no wire vocabulary reaches the operator", () => {
    const msg = humanApiError(400, refusal);
    for (const leak of ["total_height", "total_heights", "divan_height", "leg_height", "derivedFrom", "variant_not_allowed", "{", "}", "["]) {
      expect(msg, `"${leak}" must never be shown to a salesperson`).not.toContain(leak);
    }
  });
});

describe("variant_not_allowed — fields the operator does type", () => {
  test("a refused gap names the box and the values it accepts", () => {
    const msg = humanApiError(400, body({
      error: "variant_not_allowed",
      field: "gap",
      value: '21"',
      allowed: ['4"', '5"', '6"'],
      itemCode: "BF-DEMO-K",
    }));
    expect(msg).not.toBe(GENERIC_400);
    expect(msg).toContain("Gap");
    expect(msg).toContain('21"');
    expect(msg).toContain('4"');
    expect(msg).not.toContain("gap");
  });

  test("a refused fabric names the Fabric box", () => {
    const msg = humanApiError(400, body({
      error: "variant_not_allowed",
      field: "fabric",
      value: "CG-999",
      allowed: ["CG-001", "CG-002"],
    }));
    expect(msg).toContain("Fabric");
    expect(msg).toContain("CG-999");
    expect(msg).toContain("CG-002");
  });
});

describe("variant_not_allowed — fields that are NOT on the line at all", () => {
  test("size_code says the size comes from the item code, not a box", () => {
    const msg = humanApiError(400, body({
      error: "variant_not_allowed",
      field: "size_code",
      value: "SK",
      allowed: ["K", "Q", "S"],
      itemCode: "BF-DEMO-SK",
    }));
    expect(msg).not.toBe(GENERIC_400);
    expect(msg).toContain("Size");
    expect(msg).toContain("SK");
    expect(msg).toMatch(/item code/i);
    expect(msg).not.toContain("size_code");
  });

  test("compartment says the same, and never prints the storage word", () => {
    const msg = humanApiError(400, body({
      error: "variant_not_allowed",
      field: "compartment",
      value: "3C",
      allowed: ["1A(LHF)", "2A(LHF)", "L"],
    }));
    expect(msg).toContain("Compartment");
    expect(msg).toContain("3C");
    expect(msg).toContain("1A(LHF)");
    expect(msg).toMatch(/item code|sofa build/i);
  });
});

describe("the generic sentence still covers genuinely unknown shapes", () => {
  test("a body with no allowed set is untouched", () => {
    expect(humanApiError(400, body({ error: "item_code_required" }))).toBe(GENERIC_400);
  });

  test("a body carrying `allowed` but no field/value pair stays generic", () => {
    expect(humanApiError(400, body({
      error: "invalid_variant_key",
      key: "divanHeightt",
      allowed: ["divanHeight", "legHeight"],
    }))).toBe(GENERIC_400);
  });

  test("an empty allowed pool stays generic rather than promising an empty list", () => {
    expect(humanApiError(400, body({
      error: "variant_not_allowed", field: "gap", value: '9"', allowed: [],
    }))).toBe(GENERIC_400);
  });

  test("a curated code still wins — the detail renderer never overrides one", () => {
    expect(humanApiError(422, body({
      error: "extra_addon_needs_description",
      field: "gap", value: "x", allowed: ["a"],
    }))).toContain("Describe the special order");
  });

  test("non-JSON and 5xx are unchanged", () => {
    expect(humanApiError(400, "<html>gateway</html>")).toBe(GENERIC_400);
    expect(humanApiError(500, body({ error: "boom" }))).toContain("The system hit a problem");
  });
});

describe("a NEW structured refusal renders without anyone remembering to map it", () => {
  test("an uncurated code with field/value/allowed is rendered by shape alone", () => {
    const msg = humanApiError(400, body({
      error: "some_future_refusal_nobody_mapped",
      field: "gap",
      value: '99"',
      allowed: ['4"', '5"'],
    }));
    expect(msg).not.toBe(GENERIC_400);
    expect(msg).toContain('99"');
  });

  test("an unmapped field name is never printed raw — the value carries the message", () => {
    const msg = humanApiError(400, body({
      error: "variant_not_allowed",
      field: "some_new_column_name",
      value: "ZZ",
      allowed: ["AA", "BB"],
    }));
    expect(msg).not.toBe(GENERIC_400);
    expect(msg).toContain("ZZ");
    expect(msg).toContain("AA");
    expect(msg).not.toContain("some_new_column_name");
  });
});
