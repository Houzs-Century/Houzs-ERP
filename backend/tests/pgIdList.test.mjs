/* An id list for `= ANY(…::bigint[])` as a Postgres array literal. postgres.js's
   sql.array() went out as "70,99,100" on a fresh connection whose first query
   carried it — "malformed array literal" — in the June repair's re-read after its
   apply (run 43826479002, 2026-11-16). */
import { describe, expect, it } from "vitest";
import { pgIdArray } from "../scripts/lib/pg-id-list.mjs";

describe("an id list for a bigint[] cast", () => {
  it("is a braced literal Postgres reads on any connection", () => {
    expect(pgIdArray([70, 99, 100, 235, 236, 351, 388, 389])).toBe("{70,99,100,235,236,351,388,389}");
    expect(pgIdArray(["16296", 18012])).toBe("{16296,18012}");
    expect(pgIdArray([])).toBe("{}");
  });

  it("refuses anything that is not an id, rather than quote it into the SQL", () => {
    expect(() => pgIdArray([70, "70); DROP TABLE x; --"])).toThrow(/not a list of ids/);
    expect(() => pgIdArray([1.5])).toThrow(/not a list of ids/);
    expect(() => pgIdArray([0])).toThrow(/not a list of ids/);
  });
});
