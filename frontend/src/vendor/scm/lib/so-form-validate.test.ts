import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  companyRequiresStockLocation,
  soStockLocationError,
  soRequiredFieldErrors,
  soRequiredFieldsMessage,
  soProceedingAddressErrors,
  LOCATION_REQUIRED_COMPANY_CODES,
  type SoRequiredFieldsInput,
} from "./so-form-validate";

/* Owner 2026-08-13, after both AutoCount write-back test orders were refused
   for carrying no stock location: "Company 1 (Houzs Century) 开单必须有 State。
   Company 2 (2990) 不需要。其他公司也不必填。"

   The backend is the authoritative gate (so-location-gate.ts); this guard only
   decides whether the salesperson is told BEFORE or AFTER losing their typing.
   These pin that the two lists and the two verdicts agree. */

const input = (o: Partial<Parameters<typeof soStockLocationError>[0]> = {}) => ({
  companyCode: "HOUZS",
  salesLocation: "",
  state: "",
  ...o,
});

describe("company scope", () => {
  it("covers company 1 (HOUZS) and nothing else — mirrors the backend list", () => {
    expect(LOCATION_REQUIRED_COMPANY_CODES).toEqual(["HOUZS"]);
  });

  it("company 2 (2990) saves with no State, exactly as before", () => {
    expect(soStockLocationError(input({ companyCode: "2990" }))).toBeNull();
  });

  it("any other company is untouched", () => {
    expect(soStockLocationError(input({ companyCode: "HOOKKA" }))).toBeNull();
  });

  it("an unresolved company code does not block (the server still gates)", () => {
    expect(soStockLocationError(input({ companyCode: null }))).toBeNull();
    expect(soStockLocationError(input({ companyCode: "" }))).toBeNull();
  });
});

describe("company 1", () => {
  it("blocks a create with no State picked", () => {
    const e = soStockLocationError(input());
    expect(e?.title).toContain("State");
    expect(e?.body).toContain("warehouse");
  });

  it("blocks a State that resolved NO warehouse, with its own sentence", () => {
    const e = soStockLocationError(input({ state: "Perlis" }));
    expect(e?.title).toContain("Perlis");
    expect(e?.body).toContain("administrator");
  });

  it("passes once the State resolved a Sales Location", () => {
    expect(soStockLocationError(input({ state: "Selangor", salesLocation: "KL" })))
      .toBeNull();
  });

  it("treats a whitespace-only Sales Location as none", () => {
    expect(soStockLocationError(input({ salesLocation: "  " }))?.title).toContain("State");
  });
});

describe("what the gate never blocks", () => {
  it("a draft — a draft is never written to AutoCount", () => {
    expect(soStockLocationError(input({ asDraft: true }))).toBeNull();
  });

  it("an edit — an AutoCount EDIT leaves the account book's own Location alone", () => {
    expect(soStockLocationError(input({ isEdit: true }))).toBeNull();
  });

  it("a save while the state->warehouse mappings are still loading", () => {
    /* Every State looks unmapped before that query answers; the server reads
       the mappings directly, so let it have the last word rather than refusing
       a legitimate order over a request in flight. */
    expect(soStockLocationError(input({ state: "Selangor", mappingsLoaded: false })))
      .toBeNull();
  });

  it("…but a surface that resolves no location at all is still gated", () => {
    expect(soStockLocationError(input())).not.toBeNull();
  });
});

/* ── The predicate, and the ONE surface that reads it directly ──────────────
   `SalesOrderNewFromProducts` collects no address by design, so under a
   location-gated company it could never satisfy a CONFIRMED create: PR #2112
   made every cart on that page a 422 with no field on the screen to fix. Owner
   approved landing a DRAFT there instead — a draft is never written to
   AutoCount, so it owes no Location, and the DRAFT -> live transition on the SO
   detail re-runs the same gate once the address exists.

   The company scope of that behaviour must come from the ONE list, or the day a
   company is added to LOCATION_REQUIRED_COMPANY_CODES the page silently keeps
   confirming for it. */

describe("companyRequiresStockLocation", () => {
  it("answers for company 1 and for nobody else", () => {
    expect(companyRequiresStockLocation("HOUZS")).toBe(true);
    expect(companyRequiresStockLocation("2990")).toBe(false);
    expect(companyRequiresStockLocation("HOOKKA")).toBe(false);
  });

  it("is case- and whitespace-insensitive, like the backend twin", () => {
    expect(companyRequiresStockLocation(" houzs ")).toBe(true);
  });

  it("does NOT gate an unresolved company (branding still loading)", () => {
    expect(companyRequiresStockLocation(null)).toBe(false);
    expect(companyRequiresStockLocation(undefined)).toBe(false);
    expect(companyRequiresStockLocation("")).toBe(false);
  });

  it("agrees with soStockLocationError on every code it is asked about", () => {
    for (const code of ["HOUZS", "2990", "HOOKKA", "", null]) {
      const blocked = soStockLocationError({
        companyCode: code, salesLocation: "", state: "",
      }) !== null;
      expect(blocked, `disagreement on ${String(code)}`)
        .toBe(companyRequiresStockLocation(code));
    }
  });
});

describe("SalesOrderNewFromProducts lands a draft exactly where it must", () => {
  /* Source-text: the page's outcome is a body field on a mutation inside a
     1,100-line screen, and what matters is WHICH predicate decides it. */
  const source = readFileSync(
    resolve(process.cwd(), "src/pages/scm-v2/SalesOrderNewFromProducts.tsx"),
    "utf8",
  );

  it("derives the draft decision from the shared list, never re-derived", () => {
    expect(source).toContain(
      "const landsDraft = companyRequiresStockLocation(branding.companyCode);",
    );
    // No second copy of the company scope on this page — no company CODE at all.
    expect(source).not.toContain('"HOUZS"');
    expect(source).not.toContain('"2990"');
  });

  it("sends asDraft only for those companies — everyone else is unchanged", () => {
    expect(source).toContain("asDraft: landsDraft || undefined,");
  });

  it("keeps the location guard wired, inert only because the create is a draft", () => {
    /* Same shape as the guided wizard: the day this flow stops drafting it is
       gated automatically instead of silently minting locationless orders. */
    const guard = source.slice(
      source.indexOf("soStockLocationError({"),
      source.indexOf("if (preErr) {"),
    );
    expect(guard).toContain("asDraft: landsDraft,");
  });

  it("no longer tells the operator to go and use the Full form", () => {
    /* The nav link in the header stays — it is a way to a fuller screen, not a
       workaround for a create this page cannot do. What went is the refusal
       that sent the operator there after they had built a whole cart. */
    expect(source).not.toContain('use "Switch to Full form" to enter it');
  });

  it("says up front what it will produce, and labels the button to match", () => {
    expect(source).toContain("The order lands as a DRAFT");
    expect(source).toContain('landsDraft ? "Save draft SO"');
  });
});

/* Owner 2026-08-20, live QA: "为什么要慢慢爆呢" — the create form popped ONE
   missing field at a time (customer name -> phone -> venue -> salesperson ->
   delivery State), so the operator fixed-and-retried five times. soRequiredFieldErrors
   collects the always-required set in one pass so they see it all at once. */
describe("soRequiredFieldErrors — one message, not one-at-a-time", () => {
  const houzsConfirm: SoRequiredFieldsInput = {
    customerName: "",
    phone: "",
    hasNamedLine: false,
    asDraft: false,
    hasVenue: false,
    hasSalesperson: false,
    location: { companyCode: "HOUZS", salesLocation: "", state: "", mappingsLoaded: true },
  };

  it("collects EVERY missing required field at once (not just the first)", () => {
    const missing = soRequiredFieldErrors(houzsConfirm);
    expect(missing).toEqual([
      "Customer name",
      "Phone number",
      "At least one line item with a product",
      "Venue",
      "Salesperson",
      "Delivery State (it sets the shipping warehouse)",
    ]);
  });

  it("returns empty when everything required is present", () => {
    expect(soRequiredFieldErrors({
      customerName: "Lim", phone: "0123", hasNamedLine: true, asDraft: false,
      hasVenue: true, hasSalesperson: true,
      location: { companyCode: "HOUZS", salesLocation: "PG WAREHOUSE", state: "Selangor", mappingsLoaded: true },
    })).toEqual([]);
  });

  it("a DRAFT needs none of the confirm-only fields", () => {
    // Same empty inputs, but asDraft — only the two non-confirm fields remain.
    expect(soRequiredFieldErrors({ ...houzsConfirm, asDraft: true, location: { ...houzsConfirm.location, asDraft: true } }))
      .toEqual(["Customer name", "Phone number", "At least one line item with a product"]);
  });

  it("company 2 (2990) is not asked for a Delivery State", () => {
    const missing = soRequiredFieldErrors({
      ...houzsConfirm, customerName: "A", phone: "1", hasNamedLine: true, hasVenue: true, hasSalesperson: true,
      location: { companyCode: "2990", salesLocation: "", state: "", mappingsLoaded: true },
    });
    expect(missing).toEqual([]);
  });

  it("does NOT fold the 'State has no warehouse' config error into the list (a picked State)", () => {
    // State IS picked but resolves no warehouse — that's an admin config problem,
    // handled by soStockLocationError afterwards, NOT a field the operator forgot.
    const missing = soRequiredFieldErrors({
      ...houzsConfirm, customerName: "A", phone: "1", hasNamedLine: true, hasVenue: true, hasSalesperson: true,
      location: { companyCode: "HOUZS", salesLocation: "", state: "Selangor", mappingsLoaded: true },
    });
    expect(missing).toEqual([]);
    // ...and soStockLocationError still catches it as its own message.
    expect(soStockLocationError({ companyCode: "HOUZS", salesLocation: "", state: "Selangor", mappingsLoaded: true })).not.toBeNull();
  });
});

describe("soRequiredFieldsMessage", () => {
  it("names the single field directly", () => {
    expect(soRequiredFieldsMessage(["Phone number"], [])).toEqual({ title: "Phone number is required." });
  });
  it("lists them all together when several are missing", () => {
    const m = soRequiredFieldsMessage(["Customer name", "Venue"], []);
    expect(m.title).toContain("Fill in the required fields");
    expect(m.body).toBe("Still missing: Customer name, Venue.");
  });

  /* ONE PRESS, ONE LIST. Owner 2026-08-23: 「create salesorder 要两次？」 —
     Venue and Delivery State came back on the first press, address line 1 and
     postcode on the second, because the address group sat behind a `return`.
     Its condition is only "a Processing Date was entered", which is known on the
     first press, so it belongs in the same list. */
  it("merges the proceeding-address list into the SAME message", () => {
    const m = soRequiredFieldsMessage(["Venue"], ["address line 1", "postcode"]);
    expect(m.body).toContain("Venue");
    expect(m.body).toContain("address line 1");
    expect(m.body).toContain("postcode");
  });

  it("says WHY the address fields are required, so they do not read as arbitrary", () => {
    const m = soRequiredFieldsMessage(["Venue"], ["postcode"]);
    expect(m.body).toContain("Processing Date");
  });

  it("leads with the reason when ONLY the address half is missing", () => {
    const m = soRequiredFieldsMessage([], ["address line 1"]);
    expect(m.title).toContain("Processing Date");
  });

  /* Deliberately NOT the bare "postcode is required." — that sentence gives an
     operator no way to know a postcode became required when they set a
     Processing Date. The reason is the useful half. */
  it("a lone proceeding field keeps its reason instead of the bare shortcut", () => {
    const m = soRequiredFieldsMessage([], ["postcode"]);
    expect(m.title).toContain("Processing Date");
    expect(m.body).toContain("postcode");
  });
});

describe("soProceedingAddressErrors", () => {
  const filled = {
    processingDate: "2026-09-01",
    customerName: "Lim",
    fillAddressLater: false,
    address1: "12 Jalan Ujian",
    postcode: "47810",
    deliveryDate: "2026-09-05",
  };

  it("asks for nothing when the order is not proceeding", () => {
    expect(soProceedingAddressErrors({ ...filled, processingDate: "", address1: "", postcode: "" })).toEqual([]);
  });

  it("asks for nothing when everything is filled", () => {
    expect(soProceedingAddressErrors(filled)).toEqual([]);
  });

  it("collects EVERY missing one at once, not the first", () => {
    const got = soProceedingAddressErrors({ ...filled, address1: "", postcode: "", deliveryDate: "" });
    expect(got).toEqual(["address line 1", "postcode", "delivery date"]);
  });

  /* Ticking it BLANKS the address out of the payload, so a typed address that
     is about to be discarded still counts as missing. */
  it("counts the address as missing when 'fill in later' is ticked, even if typed", () => {
    const got = soProceedingAddressErrors({ ...filled, fillAddressLater: true });
    expect(got).toEqual(["address line 1", "postcode"]);
  });

  it("a whitespace-only processing date is not a proceeding order", () => {
    expect(soProceedingAddressErrors({ ...filled, processingDate: "   ", address1: "" })).toEqual([]);
  });
});
