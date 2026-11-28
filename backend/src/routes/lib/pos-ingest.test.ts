import { describe, expect, test } from "vitest";
import { bookMovements } from "./pos-ingest";
import type { MovementRow } from "./pos-sync";

/* docs/bugs/README.md "A document number that is not unique by construction", audit H3: a receipt number
   that another sale already used must not book its stock silently. */
const ROW: MovementRow = { movement_type: "OUT", item_code: "MATT-A", product_name: "Mattress A", qty: 1, source_doc_type: "POS_SALE", source_doc_no: "000123", notes: "POS sale 000123", reverses: null };

function fakeTx(existing: number) {
  const writes: unknown[] = [];
  let call = 0;
  const tx = {
    execute: async (q: unknown) => {
      call += 1;
      if (call === 1) return [{ n: existing }];
      writes.push(q);
      return [];
    },
  };
  return { tx: tx as unknown as Parameters<typeof bookMovements>[0], writes };
}

describe("bookMovements", () => {
  test("a receipt number that already has movements books nothing and says so", async () => {
    const { tx, writes } = fakeTx(2);
    const warning = await bookMovements(tx, 1, "wh-1", [ROW], "Cashier");
    expect(writes).toEqual([]);
    expect(warning).toMatch(/stock NOT booked: receipt 000123/);
  });

  test("a fresh receipt number books its movements", async () => {
    const { tx, writes } = fakeTx(0);
    const warning = await bookMovements(tx, 1, "wh-1", [ROW], "Cashier");
    expect(writes.length).toBeGreaterThan(0);
    expect(warning).toBeNull();
  });
});
