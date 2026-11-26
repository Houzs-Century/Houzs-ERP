import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { caseAddressPatch, seedCaseAddressForm } from "../../lib/assrCaseAddressForm";

/* Owner 2026-11-17: the service case's address uses the SO form's layout and
   cascade — typing / picking a postcode fills City and State from my_localities. */

const ROWS = [
  { postcode: "11900", city: "Bayan Lepas", state: "Pulau Pinang", stateCode: "PNG", country: "Malaysia" },
  { postcode: "47300", city: "Petaling Jaya", state: "Selangor", stateCode: "SGR", country: "Malaysia" },
];
vi.mock("../../vendor/scm/lib/localities-queries", async (orig) => ({
  ...(await orig<typeof import("../../vendor/scm/lib/localities-queries")>()),
  useLocalities: () => ({ data: ROWS, isLoading: false }),
}));

import { CaseAddressFields, CASE_ADDRESS_DESKTOP } from "./CaseAddressFields";

const OLD_CASE = { addr1: "1-G-9 Halaman Teratai", addr2: "lebuh nipah 2", addr3: "11900 Bayan Lepas", addr4: null };

describe("CaseAddressFields", () => {
  test("picking a postcode fills City and State, and Save sends only what changed", async () => {
    const onSave = vi.fn(async () => {});
    render(<CaseAddressFields c={OLD_CASE} onSave={onSave} classes={CASE_ADDRESS_DESKTOP} />);
    // Two lines only (owner 2026-11-18); the old case's third line shows inside line 2.
    expect(screen.queryByLabelText("Address line 3")).toBeNull();
    expect(screen.queryByLabelText("Address line 4")).toBeNull();
    expect((screen.getByLabelText("Address line 2") as HTMLInputElement).value).toBe("lebuh nipah 2, 11900 Bayan Lepas");

    const postcode = screen.getAllByRole("combobox").find((el) => (el as HTMLInputElement).placeholder.startsWith("Pick postcode"))!;
    fireEvent.focus(postcode);
    fireEvent.change(postcode, { target: { value: "11900" } });
    fireEvent.keyDown(postcode, { key: "Enter" });

    expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe("Bayan Lepas");
    expect((screen.getByLabelText("Address line 2") as HTMLInputElement).value).toBe("lebuh nipah 2");
    fireEvent.click(screen.getByRole("button", { name: "Save address" }));
    expect(onSave).toHaveBeenCalledWith({ postcode: "11900", city: "Bayan Lepas", state: "Pulau Pinang" });
  });

  test("editing line 2 saves all of it there and clears lines 3 / 4 — nothing typed is lost", () => {
    const onSave = vi.fn(async () => {});
    render(<CaseAddressFields c={{ ...OLD_CASE, addr4: "Taman Lama" }} onSave={onSave} classes={CASE_ADDRESS_DESKTOP} />);
    const line2 = screen.getByLabelText("Address line 2") as HTMLInputElement;
    expect(line2.value).toBe("lebuh nipah 2, 11900 Bayan Lepas, Taman Lama");
    fireEvent.change(line2, { target: { value: "lebuh nipah 2, Taman Lama" } });
    fireEvent.click(screen.getByRole("button", { name: "Save address" }));
    expect(onSave).toHaveBeenCalledWith({ addr2: "lebuh nipah 2, Taman Lama", addr3: null, addr4: null });
  });

  test("no change, no Save button", () => {
    render(<CaseAddressFields c={{ ...OLD_CASE, postcode: "11900", city: "Bayan Lepas", state: "Pulau Pinang" }} onSave={async () => {}} classes={CASE_ADDRESS_DESKTOP} />);
    expect(screen.queryByRole("button", { name: "Save address" })).toBeNull();
  });
});

describe("caseAddressPatch", () => {
  test("only changed keys, blank as null", () => {
    const seed = seedCaseAddressForm({ addr1: "A", addr2: "B", postcode: "11900" });
    expect(caseAddressPatch(seed, { ...seed, addr2: " ", city: "Bayan Lepas" })).toEqual({ addr2: null, city: "Bayan Lepas" });
    expect(caseAddressPatch(seed, seed)).toBeNull();
  });
});
