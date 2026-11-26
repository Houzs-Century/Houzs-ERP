import { describe, expect, test } from "vitest";
import { stopContactName } from "./delivery-job-queries";

describe("stopContactName", () => {
  test("the job's contact person, for the Customer card", () => {
    expect(stopContactName({ kind: "SUPPLIER_PICKUP", contact_name: "Ali" }, "ACME Supplies")).toBe("Ali");
  });
  test("none, or the stop's own name again: nothing to add", () => {
    expect(stopContactName({ kind: "SETUP" }, "ACME")).toBeNull();
    expect(stopContactName({ kind: "SETUP", contact_name: "acme " }, "ACME")).toBeNull();
    expect(stopContactName(undefined, "ACME")).toBeNull();
  });
});
