import { describe, expect, test } from "vitest";
import {
  partyTypeFor, snapshotFromSo, snapshotFromSupplier, snapshotFromProject,
  snapshotFromAssr, emptySnapshot,
} from "../src/scm/lib/dp-party";

/* Each DP job type auto-fills its party from a different master, and the masters
   disagree on shape. These tests pin the mapping so the auto-fill lands on the
   right field — a supplier's single-line address must not silently vanish, and a
   project's PIC name/phone must come from the USER, not the project. */

describe("partyTypeFor — which master a type draws from", () => {
  test("customer types", () => {
    for (const t of ["DELIVERY", "PICKUP", "SERVICE"] as const) expect(partyTypeFor(t)).toBe("CUSTOMER");
  });
  test("supplier pickup → SUPPLIER", () => {
    expect(partyTypeFor("SUPPLIER_PICKUP")).toBe("SUPPLIER");
  });
  test("setup / dismantle → VENUE", () => {
    expect(partyTypeFor("SETUP")).toBe("VENUE");
    expect(partyTypeFor("DISMANTLE")).toBe("VENUE");
  });
});

describe("snapshotFromSo — SO header, no contact person", () => {
  test("maps debtor + structured address + customer_state", () => {
    const snap = snapshotFromSo({
      debtor_name: "Tan Wei Ming", phone: "012-1", address1: "12 Jalan Kenari",
      address2: "Puchong", address3: "", address4: null, city: "Puchong",
      postcode: "47100", customer_state: "Selangor",
    });
    expect(snap.party_type).toBe("CUSTOMER");
    expect(snap.party_name).toBe("Tan Wei Ming");
    expect(snap.contact_name).toBeNull();          // SO has no contact-person column
    expect(snap.contact_phone).toBe("012-1");
    expect(snap.address1).toBe("12 Jalan Kenari");
    expect(snap.address3).toBeNull();              // blank string → null
    expect(snap.state).toBe("Selangor");
  });
});

describe("snapshotFromSupplier — structured when present, legacy line otherwise", () => {
  test("the legacy single address falls back into address1 (rows not re-entered yet)", () => {
    const snap = snapshotFromSupplier({
      name: "Guan Chong Timber Sdn Bhd", contact_person: "Mr. Tan", phone: "012-345",
      address: "Lot 12, Jalan Perusahaan 3, Batu Caves", postcode: "68100", state: "Selangor",
    });
    expect(snap.party_type).toBe("SUPPLIER");
    expect(snap.party_name).toContain("Guan Chong");
    expect(snap.contact_name).toBe("Mr. Tan");
    expect(snap.address1).toContain("Lot 12");     // the whole legacy line, not dropped
    expect(snap.city).toBeNull();
    expect(snap.postcode).toBe("68100");
    expect(snap.state).toBe("Selangor");
  });

  test("the structured address1-4 + city WIN once entered (mig 0131)", () => {
    const snap = snapshotFromSupplier({
      name: "Guan Chong Timber Sdn Bhd",
      address: "old single line — should be ignored",
      address1: "Lot 12", address2: "Jalan Perusahaan 3", address3: "", address4: null,
      city: "Batu Caves", postcode: "68100", state: "Selangor",
    });
    expect(snap.address1).toBe("Lot 12");          // structured wins over legacy `address`
    expect(snap.address2).toBe("Jalan Perusahaan 3");
    expect(snap.address3).toBeNull();
    expect(snap.city).toBe("Batu Caves");
  });
  test("contact falls back: attention when no contact_person, mobile when no phone", () => {
    const snap = snapshotFromSupplier({ name: "X", attention: "Ms. Lee", mobile: "019-9" });
    expect(snap.contact_name).toBe("Ms. Lee");
    expect(snap.contact_phone).toBe("019-9");
  });
});

describe("snapshotFromProject — PIC comes from the USER, not the project", () => {
  test("venue + state from the project; contact name/phone from the PIC user", () => {
    const snap = snapshotFromProject(
      { venue: "Sunway Pyramid", venue_address: "3 Jalan PJS 11/15", state: "Selangor" },
      { name: "Ali (PIC)", phone: "013-777" },
    );
    expect(snap.party_type).toBe("VENUE");
    expect(snap.party_name).toBe("Sunway Pyramid");
    expect(snap.contact_name).toBe("Ali (PIC)");   // from users, per the FK
    expect(snap.contact_phone).toBe("013-777");
    expect(snap.address1).toBe("3 Jalan PJS 11/15");
    expect(snap.state).toBe("Selangor");
  });
  test("no PIC user → contact is null, not a crash", () => {
    const snap = snapshotFromProject({ venue: "Booth", state: "KL" }, null);
    expect(snap.contact_name).toBeNull();
    expect(snap.contact_phone).toBeNull();
    expect(snap.party_name).toBe("Booth");
  });
});

describe("snapshotFromAssr — location doubles as state", () => {
  test("service case addr1-4 + location", () => {
    const snap = snapshotFromAssr({
      customer_name: "Nurul", phone: "011-2", addr1: "8 Jalan SS15", addr2: "Subang",
      addr3: null, addr4: null, location: "Selangor",
    });
    expect(snap.party_type).toBe("CUSTOMER");
    expect(snap.party_name).toBe("Nurul");
    expect(snap.address1).toBe("8 Jalan SS15");
    expect(snap.state).toBe("Selangor");           // location is the region key
    expect(snap.postcode).toBeNull();              // assr has no postcode
  });
});

describe("emptySnapshot — a manual order still knows its party type", () => {
  test("supplier-pickup manual → SUPPLIER, all fields null", () => {
    const snap = emptySnapshot("SUPPLIER_PICKUP");
    expect(snap.party_type).toBe("SUPPLIER");
    expect(snap.party_name).toBeNull();
    expect(snap.state).toBeNull();
  });
});
