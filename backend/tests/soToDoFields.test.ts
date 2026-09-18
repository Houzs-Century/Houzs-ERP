import { describe, expect, test } from "vitest";
import {
  SO_CONVERT_HEADER,
  missingSourceFields,
  soHeaderToDoSource,
} from "../src/scm/lib/so-to-do-fields";

/* THE FIELDS MUST ACTUALLY CARRY ACROSS.

   The reported symptom was a "New Delivery Order" form with Customer Name,
   Phone, Email, Customer Type, Salesperson, all four Delivery Address fields and
   Sales Location blank, while the "Converted from 2990-SO-2606-002" badge and the
   document-flow strip rendered correctly — because those two read the ?fromSo=
   query STRING and never touch the fetch. The fetch itself was the company-scoped
   GET /mfg-sales-orders/:docNo, which 404s for a MIRRORED 2990 SO (company_id = 2)
   read while the active company is HOUZS.

   So there are two claims to pin, and they are different claims:
     1. Given a source row, every field the owner listed maps onto the form. */

/** A native Houzs SO — every header field populated. */
const nativeSo: Record<string, unknown> = {
  doc_no: "SO-2607-014",
  company_id: 1,
  debtor_code: "C-0042",
  debtor_name: "Tan Mei Ling",
  agent: "Lim Wei Siang",
  salesperson_id: "9f1c2d3e-0000-4000-8000-00000000abcd",
  address1: "12 Jalan Bukit Bintang",
  address2: "Unit 8-3, Menara Suria",
  city: "Kuala Lumpur",
  customer_state: "Wilayah Persekutuan",
  postcode: "55100",
  phone: "0123456789",
  email: "meiling@example.com",
  customer_type: "RETAIL",
  building_type: "Condominium",
  branding: "HOUZS",
  venue: "Showroom KL",
  venue_id: "11111111-0000-4000-8000-000000000001",
  ref: "REF-991",
  customer_so_no: "CUST-PO-7781",
  sales_location: "KL Showroom",
  customer_country: "Malaysia",
  customer_delivery_date: "2026-08-01",
  emergency_contact_name: "Tan Ah Kow",
  emergency_contact_phone: "0198887777",
  emergency_contact_relationship: "Father",
  currency: "MYR",
};

/** The MIRRORED SO from the owner's report. so-mirror.ts copies the 2990 header
 *  VERBATIM and stamps company_id = 2 + a "2990-" doc prefix, so the header data
 *  is all present — it was never the mirror that lost it. */
const mirroredSo: Record<string, unknown> = {
  ...nativeSo,
  doc_no: "2990-SO-2606-002",
  company_id: 2,
  debtor_name: "Sofa Gallery Sdn Bhd",
  branding: "2990",
};

describe("soHeaderToDoSource — every field the owner listed arrives", () => {
  test("customer identity + contact", () => {
    const s = soHeaderToDoSource(nativeSo);
    expect(s.customerName).toBe("Tan Mei Ling");
    expect(s.debtorCode).toBe("C-0042");
    expect(s.phone).toBe("0123456789");
    expect(s.email).toBe("meiling@example.com");
    expect(s.customerType).toBe("RETAIL");
  });

  test("customer SO ref prefers the customer's own number over the generic ref", () => {
    expect(soHeaderToDoSource(nativeSo).customerSoRef).toBe("CUST-PO-7781");
    const noCustomerNo = { ...nativeSo, customer_so_no: null };
    expect(soHeaderToDoSource(noCustomerNo).customerSoRef).toBe("REF-991");
  });

  test("salesperson prefers the readable agent, falls back to the id", () => {
    expect(soHeaderToDoSource(nativeSo).salesperson).toBe("Lim Wei Siang");
    const noAgent = { ...nativeSo, agent: null };
    expect(soHeaderToDoSource(noAgent).salesperson).toBe(
      "9f1c2d3e-0000-4000-8000-00000000abcd",
    );
  });

  test("the FULL delivery address — all four fields", () => {
    const s = soHeaderToDoSource(nativeSo);
    expect(s.address1).toBe("12 Jalan Bukit Bintang");
    expect(s.address2).toBe("Unit 8-3, Menara Suria");
    expect(s.customerState).toBe("Wilayah Persekutuan");
    expect(s.city).toBe("Kuala Lumpur");
    expect(s.postcode).toBe("55100");
  });

  test("address2 folds the SO's extra lines — the DO has two, the SO has four", () => {
    const fourLine = {
      ...nativeSo,
      address2: null,
      address3: "Block B",
      address4: "Level 12",
    };
    expect(soHeaderToDoSource(fourLine).address2).toBe("Block B, Level 12");
  });

  test("sales location and the rest of the header snapshot", () => {
    const s = soHeaderToDoSource(nativeSo);
    expect(s.salesLocation).toBe("KL Showroom");
    expect(s.buildingType).toBe("Condominium");
    expect(s.branding).toBe("HOUZS");
    expect(s.venue).toBe("Showroom KL");
    expect(s.customerDeliveryDate).toBe("2026-08-01");
    expect(s.currency).toBe("MYR");
  });

  test("A MIRRORED 2990 SO carries EVERY field a native one does", () => {
    // The mirror copies the header verbatim, so the two must differ only where
    // the source data differs — never in which fields arrive.
    const native = soHeaderToDoSource(nativeSo);
    const mirrored = soHeaderToDoSource(mirroredSo);
    for (const key of Object.keys(native) as Array<keyof typeof native>) {
      if (key === "soDocNo" || key === "companyId" || key === "customerName" || key === "branding") continue;
      expect(mirrored[key], key).toEqual(native[key]);
    }
    expect(mirrored.soDocNo).toBe("2990-SO-2606-002");
    expect(mirrored.companyId).toBe(2);
    expect(mirrored.customerName).toBe("Sofa Gallery Sdn Bhd");
  });
});

describe("an absent value is reported, never papered over", () => {
  test("a missing field is null — not an empty string", () => {
    const s = soHeaderToDoSource({ doc_no: "SO-1", company_id: 1 });
    expect(s.customerName).toBeNull();
    expect(s.phone).toBeNull();
    expect(s.address1).toBeNull();
    expect(s.salesperson).toBeNull();
  });

  test("whitespace-only columns count as absent, not as present-and-blank", () => {
    const s = soHeaderToDoSource({ ...nativeSo, phone: "   ", email: "" });
    expect(s.phone).toBeNull();
    expect(s.email).toBeNull();
  });

  test("missingSourceFields names the gaps in the user's own words", () => {
    const s = soHeaderToDoSource({ ...nativeSo, email: null, postcode: null });
    expect(missingSourceFields(s)).toEqual(["Email", "Postcode"]);
  });

  test("a fully populated SO reports NOTHING missing", () => {
    expect(missingSourceFields(soHeaderToDoSource(nativeSo))).toEqual([]);
    expect(missingSourceFields(soHeaderToDoSource(mirroredSo))).toEqual([]);
  });

  test("an empty source reports every field, so the form can never look fresh", () => {
    const missing = missingSourceFields(soHeaderToDoSource({}));
    expect(missing).toContain("Customer Name");
    expect(missing).toContain("Phone");
    expect(missing).toContain("Sales Location");
    expect(missing).toContain("Delivery Date");
    expect(missing.length).toBe(12);
  });

  test("currency is the ONE default, and it matches what the commit writes", () => {
    expect(soHeaderToDoSource({}).currency).toBe("MYR");
  });
});

describe("the shared column list", () => {
  test("selects every column the mapping reads", () => {
    // A column dropped from the select but still read by the mapping is exactly
    // how a field silently stops carrying across.
    for (const col of [
      "debtor_name", "phone", "email", "customer_type", "agent", "salesperson_id",
      "address1", "address2", "address3", "address4", "city", "customer_state",
      "postcode", "sales_location", "customer_so_no", "ref", "company_id",
    ]) {
      expect(SO_CONVERT_HEADER.split(",").map((s) => s.trim())).toContain(col);
    }
  });
});
