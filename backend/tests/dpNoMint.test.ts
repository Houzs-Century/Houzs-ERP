import { describe, expect, test } from "vitest";
import {
  collectDpNos,
  dayPrefix,
  mintNextDpNo,
  mintDpNoForLorry,
  plateForLorry,
} from "../src/scm/lib/dp-no-mint";

/* The property this file exists to pin: the TWO scheduling paths share ONE number
   space. Before the unification only the manual path minted, so reading dp_orders
   alone was complete. It no longer is — a board-scheduled delivery takes its number
   onto trip_stops — and a minter that reads one table would hand the same number to
   two different jobs, which surfaces as two drivers holding the same job sheet.

   The second property is the failure DIRECTION: an unreadable registry must yield
   NO number, never a low one. Not knowing what has been issued and issuing anyway is
   how you reissue a live number. */

type Row = { dp_no: string };

/** A fake PostgREST that serves each table its own rows and can be told to fail. */
function stubSb(tables: { trip_stops?: Row[]; dp_orders?: Row[]; lorries?: { plate: string } | null }, opts: { throwOn?: string } = {}) {
  return {
    from: (t: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (opts.throwOn === t) throw new Error(`cannot read ${t}`);
            return { data: tables.lorries ?? null };
          },
        }),
        like: async () => {
          if (opts.throwOn === t) throw new Error(`cannot read ${t}`);
          return { data: (tables as Record<string, Row[] | undefined>)[t] ?? [] };
        },
      }),
    }),
  } as unknown as Parameters<typeof mintNextDpNo>[0];
}

describe("dayPrefix", () => {
  test("is date-only so ONE read covers every lorry that day", () => {
    expect(dayPrefix("2026-07-18")).toBe("DP-260718-");
  });

  test("a malformed date does not silently borrow another day's numbers", () => {
    // A sentinel prefix matches nothing real, so the mint starts at 01 under a
    // prefix no live number uses — rather than colliding with a real day.
    expect(dayPrefix("not-a-date")).toBe("DP-000000-");
  });
});

describe("collectDpNos", () => {
  test("reads snake_case and camelCase, and drops empties", () => {
    expect(collectDpNos([{ dp_no: "DP-260718-WPX01" }, { dpNo: "DP-260718-WPX02" }, { dp_no: "" }, {}]))
      .toEqual(["DP-260718-WPX01", "DP-260718-WPX02"]);
  });

  test("null/undefined rows are an empty list, not a crash", () => {
    expect(collectDpNos(null)).toEqual([]);
    expect(collectDpNos(undefined)).toEqual([]);
  });
});

describe("mintNextDpNo", () => {
  test("first number of the day for a plate is 01", async () => {
    const sb = stubSb({ trip_stops: [], dp_orders: [] });
    expect(await mintNextDpNo(sb, { tripDate: "2026-07-18", plate: "WPX 4471" })).toBe("DP-260718-WPX01");
  });

  test("THE ONE THAT MATTERS: a number held by the OTHER path is not reissued", async () => {
    // trip_stops holds 01 (a board-scheduled delivery). The manual path must go to
    // 02 — reading only dp_orders, as the old code did, would have returned 01.
    const sb = stubSb({ trip_stops: [{ dp_no: "DP-260718-WPX01" }], dp_orders: [] });
    expect(await mintNextDpNo(sb, { tripDate: "2026-07-18", plate: "WPX 4471" })).toBe("DP-260718-WPX02");
  });

  test("and symmetrically: a header-only dp_order's number blocks the board path", async () => {
    // A DP order scheduled with no trip has a number but NO stop, so trip_stops
    // alone is not a complete registry either. Both directions must hold.
    const sb = stubSb({ trip_stops: [], dp_orders: [{ dp_no: "DP-260718-WPX01" }] });
    expect(await mintNextDpNo(sb, { tripDate: "2026-07-18", plate: "WPX 4471" })).toBe("DP-260718-WPX02");
  });

  test("max+1, never count+1 — a deleted middle number does not collapse onto a live one", async () => {
    // 01 and 03 live, 02 deleted. count+1 would return 03, which is IN USE.
    const sb = stubSb({ trip_stops: [{ dp_no: "DP-260718-WPX03" }], dp_orders: [{ dp_no: "DP-260718-WPX01" }] });
    expect(await mintNextDpNo(sb, { tripDate: "2026-07-18", plate: "WPX 4471" })).toBe("DP-260718-WPX04");
  });

  test("each lorry runs its own sequence on the same day", async () => {
    const sb = stubSb({ trip_stops: [{ dp_no: "DP-260718-WPX01" }, { dp_no: "DP-260718-WPX02" }], dp_orders: [] });
    expect(await mintNextDpNo(sb, { tripDate: "2026-07-18", plate: "VPC 9058" })).toBe("DP-260718-VPC01");
  });

  test("another DAY's numbers do not advance today's sequence", async () => {
    const sb = stubSb({ trip_stops: [{ dp_no: "DP-260717-WPX07" }], dp_orders: [] });
    expect(await mintNextDpNo(sb, { tripDate: "2026-07-18", plate: "WPX 4471" })).toBe("DP-260718-WPX01");
  });

  test("THE FAILURE DIRECTION: an unreadable registry yields NO number, not a low one", async () => {
    const sb = stubSb({ trip_stops: [], dp_orders: [] }, { throwOn: "trip_stops" });
    expect(await mintNextDpNo(sb, { tripDate: "2026-07-18", plate: "WPX 4471" })).toBeNull();
  });

  test("a 3-digit run keeps ordering by VALUE, not by string", async () => {
    // "DP-...-WPX9" vs "WPX10": string compare would call 9 the max. parseInt must.
    const sb = stubSb({ trip_stops: [{ dp_no: "DP-260718-WPX09" }, { dp_no: "DP-260718-WPX10" }], dp_orders: [] });
    expect(await mintNextDpNo(sb, { tripDate: "2026-07-18", plate: "WPX 4471" })).toBe("DP-260718-WPX11");
  });
});

describe("plateForLorry / mintDpNoForLorry", () => {
  test("no lorry id = no plate = no number (the board may not have picked one yet)", async () => {
    const sb = stubSb({ trip_stops: [], dp_orders: [], lorries: null });
    expect(await plateForLorry(sb, null)).toBeNull();
    expect(await mintDpNoForLorry(sb, { tripDate: "2026-07-18", lorryId: null })).toBeNull();
  });

  test("an unknown lorry yields no number rather than a plate-less one", async () => {
    const sb = stubSb({ trip_stops: [], dp_orders: [], lorries: null });
    expect(await mintDpNoForLorry(sb, { tripDate: "2026-07-18", lorryId: "gone" })).toBeNull();
  });

  test("a known lorry mints through the same registry", async () => {
    const sb = stubSb({ trip_stops: [{ dp_no: "DP-260718-WPX01" }], dp_orders: [], lorries: { plate: "WPX 4471" } });
    expect(await mintDpNoForLorry(sb, { tripDate: "2026-07-18", lorryId: "l1" })).toBe("DP-260718-WPX02");
  });
});
