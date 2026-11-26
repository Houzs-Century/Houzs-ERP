import { describe, it, expect } from "vitest";
import { createMirrorMapper, prefixDoc, toPgArray, C2990 } from "./mirror-map";


const fakeDB = (cols: Array<{ col: string; dtype: string }>) =>
  ({
    prepare: () => ({ bind: () => ({ all: async () => ({ results: cols }) }) }),
  }) as never;

describe("toPgArray", () => {
  it("renders an empty array as {} and not the empty string (PR #471)", () => {
    expect(toPgArray([])).toBe("{}");
  });

  it("quotes elements", () => {
    expect(toPgArray(["a", "b"])).toBe('{"a","b"}');
  });

  it("escapes embedded quotes and backslashes", () => {
    expect(toPgArray(['a"b\\c'])).toBe('{"a\\"b\\\\c"}');
  });

  it("renders a null element as an unquoted NULL", () => {
    expect(toPgArray([null])).toBe("{NULL}");
  });
});

describe("prefixDoc", () => {
  it("stamps the 2990 prefix", () => {
    expect(prefixDoc("SO-2607-006")).toBe("2990-SO-2607-006");
  });

  it("is idempotent so a re-delivered outbox row cannot double-prefix", () => {
    expect(prefixDoc("2990-SO-2607-006")).toBe("2990-SO-2607-006");
  });

  it("passes null through", () => {
    expect(prefixDoc(null)).toBeNull();
  });
});

describe("createMirrorMapper / applyMap", () => {
  const CANON = new Set([
    "REQUESTED", "SUPPLIER_PENDING", "SO_APPROVED", "PO_APPROVED", "SENT", "REJECTED",
  ]);
  const mapper = createMirrorMapper({
    so_amendments: {
      prefixCols: ["so_doc_no", "amendment_no"],
      forceCols: { header_changes: null, old_header_snapshot: null },
      normalize: {
        status: (v: unknown) => {
          const s = v == null ? "" : String(v).trim().toUpperCase();
          if (!CANON.has(s)) throw new Error(`unknown_amendment_status:${String(v)}`);
          return s;
        },
      },
    },
  });

  const DB = fakeDB([
    { col: "id", dtype: "uuid" },
    { col: "so_doc_no", dtype: "text" },
    { col: "amendment_no", dtype: "text" },
    { col: "status", dtype: "USER-DEFINED" },
    { col: "requested_by", dtype: "uuid" },
    { col: "header_changes", dtype: "jsonb" },
    { col: "old_header_snapshot", dtype: "jsonb" },
    { col: "company_id", dtype: "bigint" },
    { col: "tags", dtype: "ARRAY" },
  ]);

  const row = {
    id: "b1f2c3d4-0000-4000-8000-000000000001",
    so_doc_no: "SO-2607-006",
    amendment_no: "SO-2607-006/A1",
    status: "REQUESTED",
    requested_by: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    tags: [],
    hr_only_2990_column: "dropped: exists in 2990, not in scm",
  };

  it("copies uuids verbatim and never remaps them", async () => {
    const out = mapper.applyMap(row, await mapper.tableMap(DB, "so_amendments"));
    expect(out.id).toBe("b1f2c3d4-0000-4000-8000-000000000001");
    expect(out.requested_by).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  });

  it("prefixes so_doc_no so the FK reaches the mirrored SO, and amendment_no with it", async () => {
    const out = mapper.applyMap(row, await mapper.tableMap(DB, "so_amendments"));
    expect(out.so_doc_no).toBe("2990-SO-2607-006");
    expect(out.amendment_no).toBe("2990-SO-2607-006/A1");
  });

  it("stamps company_id and drops columns absent from the dest table", async () => {
    const out = mapper.applyMap(row, await mapper.tableMap(DB, "so_amendments"));
    expect(out.company_id).toBe(C2990);
    expect("hr_only_2990_column" in out).toBe(false);
  });

  it("forces a forceCol the source never sends, so the UPDATE clears it too", async () => {
    const out = mapper.applyMap(row, await mapper.tableMap(DB, "so_amendments"));
    expect("header_changes" in out).toBe(true);
    expect(out.header_changes).toBeNull();
    expect(out.old_header_snapshot).toBeNull();
  });

  it("coerces an empty array-typed column to a Postgres array literal", async () => {
    const out = mapper.applyMap(row, await mapper.tableMap(DB, "so_amendments"));
    expect(out.tags).toBe("{}");
  });

  it("forces header_changes NULL even if a value arrives — a 2990 amendment is line-changes-only", async () => {
    const m = await mapper.tableMap(DB, "so_amendments");
    const out = mapper.applyMap(
      { ...row, header_changes: { customerDeliveryDate: "2026-08-01" } },
      m,
    );
    expect(out.header_changes).toBeNull();
  });

  it("does not invent a forceCol that the dest table does not have", async () => {
    const m2 = createMirrorMapper({ t: { forceCols: { not_in_dest: null } } });
    const out = m2.applyMap({ id: "x" }, await m2.tableMap(fakeDB([{ col: "id", dtype: "uuid" }]), "t"));
    expect("not_in_dest" in out).toBe(false);
  });

  it("refuses an unknown status rather than guessing a state", async () => {
    const m = await mapper.tableMap(DB, "so_amendments");
    expect(() => mapper.applyMap({ ...row, status: "PARTIALLY_APPROVED" }, m)).toThrow(
      /unknown_amendment_status/,
    );
  });

  it("normalizes status case and whitespace", async () => {
    const m = await mapper.tableMap(DB, "so_amendments");
    expect(mapper.applyMap({ ...row, status: " sent " }, m).status).toBe("SENT");
  });
});

describe("createMirrorMapper / aliasCols (inbound rename, source repo not yet deployed)", () => {
  const db = (cols: string[]) =>
    ({
      prepare: () => ({
        bind: () => ({ all: async () => ({ results: cols.map((col) => ({ col, dtype: "date" })) }) }),
      }),
    }) as never;

  it("drops an unknown inbound key in SILENCE — no throw, no marker (the behaviour aliases exist for)", async () => {
    const m = createMirrorMapper({ t: {} });
    const map = await m.tableMap(db(["doc_no", "processing_date"]), "t");
    const out = m.applyMap({ doc_no: "SO-1", internal_expected_dd: "2026-09-01" }, map);
    expect("internal_expected_dd" in out).toBe(false);
    expect("processing_date" in out).toBe(false);
    expect(out.doc_no).toBe("SO-1");
  });

  it("lands the old inbound name on the renamed dest column", async () => {
    const m = createMirrorMapper({ t: { aliasCols: { internal_expected_dd: "processing_date" } } });
    const map = await m.tableMap(db(["doc_no", "processing_date"]), "t");
    const out = m.applyMap({ doc_no: "SO-1", internal_expected_dd: "2026-09-01" }, map);
    expect(out.processing_date).toBe("2026-09-01");
    expect("internal_expected_dd" in out).toBe(false);
  });

  it("does nothing while the OLD name is still a live dest column", async () => {
    const m = createMirrorMapper({ t: { aliasCols: { internal_expected_dd: "internal_expected_dd" } } });
    const map = await m.tableMap(db(["doc_no", "internal_expected_dd"]), "t");
    const out = m.applyMap({ doc_no: "SO-1", internal_expected_dd: "2026-09-01" }, map);
    expect(out.internal_expected_dd).toBe("2026-09-01");
  });

  it("does not invent a dest column that does not exist", async () => {
    const m = createMirrorMapper({ t: { aliasCols: { internal_expected_dd: "not_a_column" } } });
    const map = await m.tableMap(db(["doc_no"]), "t");
    const out = m.applyMap({ doc_no: "SO-1", internal_expected_dd: "2026-09-01" }, map);
    expect("not_a_column" in out).toBe(false);
    expect("internal_expected_dd" in out).toBe(false);
  });

  it("keeps the new spelling when the payload carries both", async () => {
    const m = createMirrorMapper({ t: { aliasCols: { internal_expected_dd: "processing_date" } } });
    const map = await m.tableMap(db(["doc_no", "processing_date"]), "t");
    const out = m.applyMap(
      { doc_no: "SO-1", internal_expected_dd: "2026-09-01", processing_date: "2026-10-02" },
      map,
    );
    expect(out.processing_date).toBe("2026-10-02");
  });

  it("does not mutate the caller's row object", async () => {
    const m = createMirrorMapper({ t: { aliasCols: { internal_expected_dd: "processing_date" } } });
    const map = await m.tableMap(db(["doc_no", "processing_date"]), "t");
    const row = { doc_no: "SO-1", internal_expected_dd: "2026-09-01" };
    m.applyMap(row, map);
    expect(row.internal_expected_dd).toBe("2026-09-01");
  });
});

describe("createMirrorMapper / shared masters (scm.staff has no company_id)", () => {
  const fakeDB2 = (cols: Array<{ col: string; dtype: string }>) =>
    ({ prepare: () => ({ bind: () => ({ all: async () => ({ results: cols }) }) }) }) as never;

  const staffDB = fakeDB2([
    { col: "id", dtype: "uuid" },
    { col: "staff_code", dtype: "text" },
    { col: "name", dtype: "text" },
    { col: "showroom_id", dtype: "uuid" },
    { col: "venue_id", dtype: "uuid" },
    { col: "active", dtype: "boolean" },
    { col: "user_id", dtype: "integer" },
  ]);

  const staffMapper = createMirrorMapper({
    staff: {
      forceCols: { showroom_id: null, venue_id: null, active: false },
      preserveCols: ["user_id"],
    },
  });

  const staffRow = {
    id: "9f8e7d6c-0000-4000-8000-00000000002a",
    staff_code: "2990S-011",
    name: "New Hire",
    showroom_id: "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa",
    venue_id: "11111111-2222-4333-8444-555555555555",
    active: true,
  };

  it("does not stamp company_id on a table that has no company_id column", async () => {
    const out = staffMapper.applyMap(staffRow, await staffMapper.tableMap(staffDB, "staff"));
    expect("company_id" in out).toBe(false);
  });

  it("still stamps company_id where the dest table does have it", async () => {
    const m = createMirrorMapper({ warehouses: {} });
    const out = m.applyMap(
      { id: "w1" },
      await m.tableMap(fakeDB2([{ col: "id", dtype: "uuid" }, { col: "company_id", dtype: "bigint" }]), "warehouses"),
    );
    expect(out.company_id).toBe(C2990);
  });

  it("never writes user_id — #688's relink must survive a re-delivery", async () => {
    const out = staffMapper.applyMap(
      { ...staffRow, user_id: null },
      await staffMapper.tableMap(staffDB, "staff"),
    );
    expect("user_id" in out).toBe(false);
  });

  it("forces a non-null value (active=false), matching the importer's forceInactive", async () => {
    const out = staffMapper.applyMap(staffRow, await staffMapper.tableMap(staffDB, "staff"));
    expect(out.active).toBe(false);
  });

  it("forces the dangling-master FKs null (showrooms is empty in Houzs)", async () => {
    const out = staffMapper.applyMap(staffRow, await staffMapper.tableMap(staffDB, "staff"));
    expect(out.showroom_id).toBeNull();
    expect(out.venue_id).toBeNull();
  });
});

describe("derived *_centi -> *_sen aliases (migration 0305 vs the 2990 drainer)", () => {
  const mapper = createMirrorMapper({ mfg_sales_order_payments: { prefixCols: ["so_doc_no"] } });
  const DB = fakeDB([
    { col: "id", dtype: "uuid" },
    { col: "so_doc_no", dtype: "text" },
    { col: "amount_sen", dtype: "bigint" },
    { col: "method", dtype: "text" },
  ]);

  it("renames a stale amount_centi onto amount_sen instead of dropping it", async () => {
    const out = mapper.applyMap(
      { id: "p1", so_doc_no: "SO-1", amount_centi: 336500, method: "cash" },
      await mapper.tableMap(DB, "mfg_sales_order_payments"),
    );
    expect(out.amount_sen).toBe(336500);
    expect("amount_centi" in out).toBe(false);
  });

  it("keeps the NEW spelling when a payload carries both", async () => {
    const out = mapper.applyMap(
      { id: "p1", so_doc_no: "SO-1", amount_sen: 100, amount_centi: 999, method: "cash" },
      await mapper.tableMap(DB, "mfg_sales_order_payments"),
    );
    expect(out.amount_sen).toBe(100);
  });

  it("explicit config aliases win over a derived pair for the same key", async () => {
    const m2 = createMirrorMapper({
      t: { aliasCols: { amount_centi: "method" } },
    });
    const out = m2.applyMap(
      { id: "x", amount_centi: "bank" },
      await m2.tableMap(DB, "t"),
    );
    expect(out.method).toBe("bank");
    expect("amount_sen" in out).toBe(false);
  });

  it("is inert for a column family the dest does not carry", async () => {
    const NO_SEN = fakeDB([{ col: "id", dtype: "uuid" }, { col: "note", dtype: "text" }]);
    const out = mapper.applyMap(
      { id: "x", amount_centi: 5, note: "n" },
      await mapper.tableMap(NO_SEN, "mfg_sales_order_payments_no_sen"),
    );
    expect("amount_centi" in out).toBe(false);
    expect("amount_sen" in out).toBe(false);
  });
});
