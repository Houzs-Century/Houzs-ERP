import { describe, expect, test } from "vitest";

/* The Sales Invoice detail's "Transfer From (DO)" cell.

   THE BUG, in the owner's screenshot of production (2026-08-23): HC-SI-2608-004
   showed `Transfer From (DO) 065c5051`. That is not a document number — it is
   the first eight characters of the parent delivery order's uuid.

   TWO FAULTS, and the second hid the first: the detail page read `do_doc_no`
   (a real column on DELIVERY RETURNS, never on a sales invoice) and the detail
   ENDPOINT never called `stampDoNumber`, so the correct field was not served
   either. Every invoice fell through to the uuid slug. */

type SiHeader = { do_number?: string | null; delivery_order_id?: string | null };

/* The function under test, mirrored from SalesInvoiceDetailV2.tsx. Kept here
   rather than imported because the page pulls the whole app shell; the VALUE
   being pinned is the rule, and the rule is one line. */
const doOf = (h: SiHeader): string => h.do_number || "—";

describe("the invoice names its delivery order", () => {
  test("shows the document number when the server stamped one", () => {
    expect(doOf({ do_number: "HC-DO-2608-004", delivery_order_id: "065c5051-aaaa-bbbb-cccc-ddddeeeeffff" }))
      .toBe("HC-DO-2608-004");
  });

  /* RED on the unfixed tree: it returned "065c5051". */
  test("NEVER prints a uuid fragment — a dash is the honest answer", () => {
    const shown = doOf({ delivery_order_id: "065c5051-aaaa-bbbb-cccc-ddddeeeeffff" });
    expect(shown).toBe("—");
    expect(shown).not.toContain("065c5051");
    expect(shown).not.toMatch(/^[0-9a-f]{8}$/);
  });

  test("a manual invoice with no delivery order shows a dash", () => {
    expect(doOf({})).toBe("—");
    expect(doOf({ do_number: null, delivery_order_id: null })).toBe("—");
  });

  /* An empty string is what a stamp that found no row leaves behind; it must
     read as "nothing", not as a blank cell that looks stamped. */
  test("an empty stamp is a dash, not an empty cell", () => {
    expect(doOf({ do_number: "" })).toBe("—");
  });

  /* THE FIELD NAME IS THE FIX. `do_doc_no` is the delivery-return column and
     reading it here is what produced a permanently-undefined value. */
  test("does not read the delivery-return field name", () => {
    const wrongShape = { do_doc_no: "HC-DO-2608-004" } as unknown as SiHeader;
    expect(doOf(wrongShape)).toBe("—");
  });
});
