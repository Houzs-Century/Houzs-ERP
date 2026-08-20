import { describe, expect, test } from "vitest";
import {
  ENTITY_TYPES,
  isEntityType,
  fieldChange,
  compactChanges,
  statusChange,
  diffFields,
  assertAuditWritable,
  recordEntityAudit,
  auditUnavailableBody,
  AUDIT_UNAVAILABLE_ERROR,
  AUDIT_UNAVAILABLE_MESSAGE,
} from "../src/scm/lib/entity-audit";
import { isMissingRpc } from "../src/scm/lib/rpc-missing";
import { stripAuditFinance, AUDIT_FINANCE_FIELDS } from "../src/scm/lib/finance-keys";
import {
  GRN_LINE_AUDIT_FIELDS, GRN_LINE_AUDIT_SELECT,
  SI_LINE_AUDIT_FIELDS, SI_LINE_AUDIT_SELECT,
  PO_LINE_AUDIT_FIELDS, PO_LINE_AUDIT_SELECT,
  PI_LINE_AUDIT_FIELDS, PI_LINE_AUDIT_SELECT,
  auditSelectGaps,
  type AuditFieldMap,
} from "../src/scm/lib/entity-audit-fields";

/* WHAT IS AND IS NOT TESTED HERE.
   recordEntityAudit itself is NOT unit-tested: it is a thin insert against
   Postgres via the scm supabase client, and the scm tree does not ride the D1
   harness the rest of this suite uses (vitest.config.ts pins DATABASE_URL="" and
   applies src/db/migrations to an isolated D1; scm lives in Postgres under the
   `scm` schema, reached through Hyperdrive). There is no route-level harness for
   /api/scm/* and faking one would test the fake. What IS testable is every pure
   decision the writer delegates — which changes get recorded, in what shape, and
   whether a value counts as changed at all — so that is what this covers. */

describe("entity type vocabulary", () => {
  test("accepts every declared type", () => {
    for (const t of ENTITY_TYPES) expect(isEntityType(t)).toBe(true);
  });

  test("covers the document modules, not only money and stock", () => {
    // The read endpoint rejects any type not in this list, so a module wired up
    // in a route file but missing here writes rows nobody can ever read back.
    for (const t of ["SALES_INVOICE", "PURCHASE_ORDER", "PURCHASE_INVOICE", "DELIVERY_ORDER"]) {
      expect(isEntityType(t)).toBe(true);
    }
  });

  test("rejects anything else, including near-misses", () => {
    // The read endpoint 400s on an unknown type rather than answering with an
    // empty list, so this predicate is the difference between "no history" and
    // "wrong module name".
    for (const t of ["", "GRNS", "grn", "SALES_ORDER", "PAYMENT_VOUCHERS", null, undefined, 7]) {
      expect(isEntityType(t)).toBe(false);
    }
  });
});

describe("fieldChange", () => {
  test("records a real move as an explicit from -> to pair", () => {
    expect(fieldChange("payeeName", "Acme", "Acme Sdn Bhd")).toEqual({
      field: "payeeName", from: "Acme", to: "Acme Sdn Bhd",
    });
  });

  test("returns null when nothing moved", () => {
    expect(fieldChange("status", "POSTED", "POSTED")).toBeNull();
  });

  test("treats null and empty string as the same absence", () => {
    // Mirrors diffFields' loose equality so a hand-built change and a diffed one
    // do not disagree about whether a blanked field changed.
    expect(fieldChange("notes", null, "")).toBeNull();
    expect(fieldChange("notes", "", null)).toBeNull();
    expect(fieldChange("notes", undefined, null)).toBeNull();
  });

  test("does not confuse a numeric zero with an absent value", () => {
    // A stock count going 5 -> 0 is a real, important movement. If zero were
    // folded in with null this would silently record nothing.
    expect(fieldChange("countedQty", 5, 0)).toEqual({ field: "countedQty", from: 5, to: 0 });
    expect(fieldChange("countedQty", null, 0)).toEqual({ field: "countedQty", from: null, to: 0 });
  });

  test("normalises absent sides to null rather than leaving undefined", () => {
    // field_changes is jsonb; an `undefined` value is dropped entirely by
    // JSON.stringify, which would store { field } and lose the half of the pair
    // that says the value was previously unset.
    const c = fieldChange("supplierId", undefined, "abc");
    expect(c).toEqual({ field: "supplierId", from: null, to: "abc" });
    expect(JSON.parse(JSON.stringify(c))).toHaveProperty("from", null);
  });

  test("keeps money as the integer sen it was given", () => {
    // Money in this codebase is INTEGER SEN. Recording a formatted string would
    // make the history unsummable and locale-dependent.
    const c = fieldChange("totalSen", 123450, 99900);
    expect(c).toEqual({ field: "totalSen", from: 123450, to: 99900 });
    expect(typeof c?.from).toBe("number");
    expect(typeof c?.to).toBe("number");
  });

  test("a numeric string and its number are not a change", () => {
    // Postgres numerics can arrive as strings through PostgREST; a round-trip
    // must not manufacture a phantom edit in the history.
    expect(fieldChange("exchangeRate", "1", 1)).toBeNull();
    expect(fieldChange("totalSen", "500", 500)).toBeNull();
  });
});

describe("compactChanges", () => {
  test("drops the no-ops and keeps order", () => {
    expect(compactChanges([
      fieldChange("a", 1, 2),
      fieldChange("b", "x", "x"),
      fieldChange("c", null, "y"),
    ])).toEqual([
      { field: "a", from: 1, to: 2 },
      { field: "c", from: null, to: "y" },
    ]);
  });

  test("an all-no-op list compacts to empty", () => {
    // Callers branch on length to decide whether to write a row at all — the
    // stock-take line PATCH fires on every blur and must not log a non-edit.
    expect(compactChanges([fieldChange("a", 1, 1), null])).toEqual([]);
  });
});

describe("statusChange", () => {
  test("records the transition", () => {
    expect(statusChange("OPEN", "POSTED")).toEqual([{ field: "status", from: "OPEN", to: "POSTED" }]);
  });

  test("uses one spelling of the field name everywhere", () => {
    // A renderer keying on 'status' must not also have to know 'Status'.
    expect(statusChange("DRAFT", "CANCELLED")[0].field).toBe("status");
  });

  test("an unknown prior status still records the arrival", () => {
    expect(statusChange(null, "CANCELLED")).toEqual([{ field: "status", from: null, to: "CANCELLED" }]);
  });

  test("a non-transition records nothing", () => {
    expect(statusChange("CANCELLED", "CANCELLED")).toEqual([]);
  });
});

describe("diffFields is the SHARED differ, re-exported not reimplemented", () => {
  // The whole point of importing so-audit's differ is that both audit tables
  // answer "did this change" identically. If this file ever grows its own copy,
  // these expectations are what should fail.
  const ALIASES: Array<[string, string]> = [
    ["payeeName", "payee_name"],
    ["totalSen", "total_sen"],
    ["notes", "notes"],
  ];

  test("diffs camel patch against snake row", () => {
    expect(diffFields(
      { payee_name: "Acme", total_sen: 1000, notes: null },
      { payeeName: "Beta", totalSen: 2000 },
      ALIASES,
    )).toEqual([
      { field: "payeeName", from: "Acme", to: "Beta" },
      { field: "totalSen", from: 1000, to: 2000 },
    ]);
  });

  test("a field absent from the patch is not a change to null", () => {
    // PATCH is partial: an omitted key means "leave it alone", and recording it
    // as a clear would make every partial edit look destructive.
    expect(diffFields({ payee_name: "Acme", total_sen: 1000 }, { payeeName: "Acme" }, ALIASES))
      .toEqual([]);
  });

  test("agrees with fieldChange on the null/empty-string question", () => {
    expect(diffFields({ notes: null }, { notes: "" }, ALIASES)).toEqual([]);
    expect(fieldChange("notes", null, "")).toBeNull();
  });
});

describe("a document line's cost is gated on read by the field NAME it was written with", () => {
  /* The delivery-order line handlers record their diff with the API's camelCase
     names, and AUDIT_FINANCE_FIELDS is keyed on exactly those. That coupling is
     invisible at the call site — a line recorded as `unit_cost_sen` or
     `unitCost` would sail straight past the strip and hand every non-finance
     reader the cost basis, which is the #600/#625/#632 shape one endpoint over.
     These tests are the guard on the spelling. */

  const DO_LINE_FIELD_NAMES = [
    "qty", "unitPriceSen", "discountSen", "unitCostSen",
    "lineTotalSen", "itemCode", "itemGroup", "description",
    "uom", "notes", "rackId", "lineDeliveryDate",
  ];

  test("the cost field a line diff emits is one the strip knows", () => {
    expect(AUDIT_FINANCE_FIELDS.has("unitCostSen")).toBe(true);
    expect(DO_LINE_FIELD_NAMES).toContain("unitCostSen");
  });

  test("stripping a line-edit entry removes the cost and keeps the rest", () => {
    const line = diffFields(
      { qty: 2, unit_price_sen: 50000, unit_cost_sen: 30000, item_code: "BF-001" },
      { qty: 3, unitPriceSen: 55000, unitCostSen: 31000 },
      [
        ["qty", "qty"],
        ["unitPriceSen", "unit_price_sen"],
        ["unitCostSen", "unit_cost_sen"],
        ["itemCode", "item_code"],
      ],
    );
    const entries = [{ field_changes: line }];
    stripAuditFinance(entries);
    const fields = (entries[0].field_changes as Array<{ field: string }>).map((f) => f.field);
    expect(fields).toEqual(["qty", "unitPriceSen"]);
  });

  test("the price a customer is charged is NOT stripped", () => {
    // The line #625 drew: what the order is worth is visible to everyone who
    // passes the access gate; what it COST is not.
    for (const f of ["qty", "unitPriceSen", "discountSen", "lineTotalSen"]) {
      expect(AUDIT_FINANCE_FIELDS.has(f)).toBe(false);
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
   The four LINE vocabularies (lib/entity-audit-fields), now that GRN, SI, PO and
   PI all record line-level CRUD. These are the same coupling the DO tests above
   guard, generalised: the camelCase half of every tuple is what the strip is
   keyed on, and it is invisible at the call site.
   ──────────────────────────────────────────────────────────────────────────── */

const LINE_VOCABULARIES: Array<[label: string, fields: AuditFieldMap, select: string]> = [
  ["GRN", GRN_LINE_AUDIT_FIELDS, GRN_LINE_AUDIT_SELECT],
  ["SALES_INVOICE", SI_LINE_AUDIT_FIELDS, SI_LINE_AUDIT_SELECT],
  ["PURCHASE_ORDER", PO_LINE_AUDIT_FIELDS, PO_LINE_AUDIT_SELECT],
  ["PURCHASE_INVOICE", PI_LINE_AUDIT_FIELDS, PI_LINE_AUDIT_SELECT],
];

describe("every line vocabulary is readable and diffable", () => {
  test.each(LINE_VOCABULARIES)("%s: the select covers every audited column", (_l, fields, select) => {
    /* A column in the field list but missing from the select reads back as
       undefined, so diffFields treats it as "absent from the patch" and records
       NOTHING — a field that looks covered and silently is not. auditSelectGaps
       names the column rather than returning a bare false. */
    expect(auditSelectGaps(fields, select)).toEqual([]);
  });

  test.each(LINE_VOCABULARIES)("%s: no camel key is spelled snake_case", (_l, fields) => {
    // A snake_case key sails past stripAuditFinance, which matches literally.
    for (const [camel] of fields) expect(camel).not.toContain("_");
  });

  test.each(LINE_VOCABULARIES)("%s: no duplicate keys on either side", (_l, fields) => {
    // A repeated camel key makes the history ambiguous; a repeated column makes
    // the select invalid to PostgREST.
    expect(new Set(fields.map(([camel]) => camel)).size).toBe(fields.length);
    expect(new Set(fields.map(([, snake]) => snake)).size).toBe(fields.length);
  });

  test.each(LINE_VOCABULARIES)("%s: the cost column is recorded under the GATED name", (_l, fields) => {
    /* Every one of these four documents carries unit_cost_sen and every line
       handler diffs it. If it is emitted under any other spelling the strip
       misses it and the cost basis reaches every reader who can see the
       document — the #600/#625/#632 shape, one endpoint over. */
    const costEntry = fields.find(([, snake]) => snake === "unit_cost_sen");
    expect(costEntry).toBeDefined();
    expect(AUDIT_FINANCE_FIELDS.has(costEntry![0])).toBe(true);
  });

  test.each(LINE_VOCABULARIES)("%s: what the document is WORTH stays visible", (_l, fields) => {
    // line_total_sen is the counterpart to the rule above: it is what the
    // paper says, not what it cost, and #625 ruled it visible.
    const totalEntry = fields.find(([, snake]) => snake === "line_total_sen");
    expect(totalEntry).toBeDefined();
    expect(AUDIT_FINANCE_FIELDS.has(totalEntry![0])).toBe(false);
  });
});

describe("the SI line vocabulary carries BOTH derived money columns", () => {
  test("line cost and line margin are gated, line total is not", () => {
    /* The SI is the only one of the four that stores a per-line margin, and it
       stores the cost basis it was derived from. Both are cost data; recording
       either under an ungated name hands a reader the margin on every edit. */
    const byColumn = new Map(SI_LINE_AUDIT_FIELDS.map(([camel, snake]) => [snake, camel]));
    expect(AUDIT_FINANCE_FIELDS.has(byColumn.get("line_cost_sen")!)).toBe(true);
    expect(AUDIT_FINANCE_FIELDS.has(byColumn.get("line_margin_sen")!)).toBe(true);
    expect(AUDIT_FINANCE_FIELDS.has(byColumn.get("line_total_sen")!)).toBe(false);
  });

  test("stripping an SI line edit leaves the charged amounts and removes the basis", () => {
    const line = diffFields(
      {
        qty: 2, unit_price_sen: 50000, unit_cost_sen: 30000,
        line_total_sen: 100000, line_cost_sen: 60000, line_margin_sen: 40000,
      },
      {
        qty: 3, unitPriceSen: 55000, unitCostSen: 31000,
        lineTotalSen: 165000, lineCostSen: 93000, lineMarginSen: 72000,
      },
      SI_LINE_AUDIT_FIELDS,
    );
    const entries = [{ field_changes: line }];
    stripAuditFinance(entries);
    const fields = (entries[0].field_changes as Array<{ field: string }>).map((f) => f.field);
    expect(fields).toEqual(["qty", "unitPriceSen", "lineTotalSen"]);
  });
});

describe("a line delete records the vanished values as from -> null", () => {
  /* The delete handlers build their change list by hand rather than diffing,
     because after the row is gone there is nothing to diff against. This is the
     shape they build, asserted here because the handlers themselves cannot be
     route-tested (Postgres via Hyperdrive vs a D1 harness). */
  test("every audited column becomes a from-value with a null to-value", () => {
    const doomed: Record<string, unknown> = {
      qty: 4, unit_price_sen: 25000, unit_cost_sen: 12000,
      line_total_sen: 100000, item_code: "BF-009", uom: "UNIT",
    };
    const changes = compactChanges(
      SI_LINE_AUDIT_FIELDS.map(([camel, snake]) => fieldChange(camel, doomed[snake] ?? null, null)),
    );
    // Only the columns that HAD a value produce a pair — a null-to-null column
    // is not a change and must not pad the history.
    expect(changes.map((ch) => ch.field)).toEqual([
      "qty", "unitPriceSen", "unitCostSen", "lineTotalSen", "itemCode", "uom",
    ]);
    for (const ch of changes) expect(ch.to).toBeNull();
    expect(changes.find((ch) => ch.field === "qty")?.from).toBe(4);
  });

  test("a zero-money line still records its columns", () => {
    // A free-gift line is worth 0 and deleting it is still a real change; if
    // zero were folded in with null the deletion would record nothing at all.
    const changes = compactChanges(
      SI_LINE_AUDIT_FIELDS.map(([camel, snake]) =>
        fieldChange(camel, ({ qty: 1, line_total_sen: 0 } as Record<string, unknown>)[snake] ?? null, null)),
    );
    expect(changes.map((ch) => ch.field)).toEqual(["qty", "lineTotalSen"]);
  });
});

describe("a CREATE records the document as null -> value", () => {
  /* Every recordXCreate helper builds its pairs this way off the PERSISTED row.
     Reading the row back (rather than echoing the request body) is what makes a
     compensated create leave no row: a header a rollback already deleted reads
     back as nothing and the helper returns before writing. What is asserted here
     is the shape it writes when the row DOES survive. */
  test("money is the integer sen off the column, not a formatted amount", () => {
    const row = { status: "POSTED", total_sen: 123450, currency: "MYR" };
    const changes = compactChanges([
      fieldChange("status", null, row.status),
      fieldChange("currency", null, row.currency),
      fieldChange("totalSen", null, row.total_sen),
    ]);
    expect(changes).toEqual([
      { field: "status", from: null, to: "POSTED" },
      { field: "currency", from: null, to: "MYR" },
      { field: "totalSen", from: null, to: 123450 },
    ]);
    expect(typeof changes[2].to).toBe("number");
  });

  test("a column the document did not carry is not recorded as an empty edit", () => {
    // A manual GRN has no source PO; recording purchaseOrderId: null -> null
    // would pad every history with fields nobody set.
    expect(fieldChange("purchaseOrderId", null, null)).toBeNull();
  });

  test("a DRAFT create is distinguishable from a posted one", () => {
    // Both are recorded — "a draft existed first" is part of the story — and the
    // status pair is what tells them apart.
    expect(fieldChange("status", null, "DRAFT")).toEqual({ field: "status", from: null, to: "DRAFT" });
    expect(fieldChange("status", null, "POSTED")).toEqual({ field: "status", from: null, to: "POSTED" });
  });
});

describe("auditSelectGaps", () => {
  test("names the missing column rather than answering false", () => {
    expect(auditSelectGaps([["qty", "qty"], ["unitCostSen", "unit_cost_sen"]], "qty, item_code"))
      .toEqual(["unit_cost_sen"]);
  });

  test("tolerates the spacing PostgREST tolerates", () => {
    expect(auditSelectGaps([["qty", "qty"], ["itemCode", "item_code"]], "qty,item_code")).toEqual([]);
    expect(auditSelectGaps([["qty", "qty"]], "  qty  ,  notes ")).toEqual([]);
  });

  test("a prefix match is not a match", () => {
    // 'qty' must not be considered covered by 'qty_accepted'.
    expect(auditSelectGaps([["qty", "qty"]], "qty_accepted, qty_received")).toEqual(["qty"]);
  });
});

/* ──────────────────────────────────────────────────────────────────────
   THE FAILURE BEHAVIOUR (owner's ruling, 2026-07-19).

   Same boundary as the note at the top of this file: the probe's SQL half
   (scm.entity_audit_writable) runs in Postgres and is not reachable from the D1
   harness, and there is no route-level harness for /api/scm/*, so the handlers'
   409 is not exercised here. What IS pure — and what the ruling actually turns
   on — is the DECISION assertAuditWritable makes from a given database answer,
   and the promise recordEntityAudit makes about never throwing. Those are driven
   below through stub clients rather than a faked route.
   ────────────────────────────────────────────────────────────────────── */

type ProbeAnswer = { data: unknown; error: { code?: string; message?: string } | null };

function stubClient(opts: {
  rpc?: () => Promise<ProbeAnswer>;
  select?: () => Promise<ProbeAnswer>;
  onFrom?: () => void;
}) {
  return {
    rpc: async () => {
      if (!opts.rpc) throw new Error("rpc not stubbed");
      return await opts.rpc();
    },
    from: () => {
      opts.onFrom?.();
      return {
        select: () => ({
          limit: async () => (opts.select ? opts.select() : { data: [], error: null }),
        }),
      };
    },
  } as unknown as Parameters<typeof assertAuditWritable>[0];
}

const MISSING_RPC = { code: "PGRST202", message: "Could not find the function scm.entity_audit_writable in the schema cache" };

describe("assertAuditWritable — the decision that makes the refusal honest", () => {
  test("a writable sink lets the handler proceed", async () => {
    const r = await assertAuditWritable(stubClient({ rpc: async () => ({ data: true, error: null }) }), {
      entityType: "PAYMENT_VOUCHER", entityId: "pv-1", action: "POST",
    });
    expect(r.ok).toBe(true);
  });

  test("a sink that reports it will not accept a row blocks the write", async () => {
    // The probe ran and answered false — the INSERT inside it failed. Proceeding
    // would produce exactly the outcome the owner ruled against: a changed
    // document with no record of who changed it.
    const r = await assertAuditWritable(stubClient({ rpc: async () => ({ data: false, error: null }) }), {
      entityType: "GRN", entityId: "grn-1", action: "POST",
    });
    expect(r.ok).toBe(false);
  });

  test("an unknown answer blocks rather than waves through", async () => {
    // Fail-closed is the deliberate bias: a refusal costs one retry, proceeding
    // costs an unrecorded money or stock movement that nobody discovers.
    const r = await assertAuditWritable(
      stubClient({ rpc: async () => ({ data: null, error: { message: "connection reset" } }) }),
      { entityType: "STOCK_TAKE", entityId: "st-1", action: "POST" },
    );
    expect(r.ok).toBe(false);
  });

  test("a live probe error does NOT fall back to the weaker read", async () => {
    // The fallback exists only for a database that has not had the function
    // applied. Taking it on a real error would downgrade a failing sink to a
    // reachable one and let the write through.
    let fellBack = false;
    const r = await assertAuditWritable(
      stubClient({ rpc: async () => ({ data: null, error: { message: "permission denied" } }), onFrom: () => { fellBack = true; } }),
      { entityType: "STOCK_TRANSFER", entityId: "tr-1", action: "CANCEL" },
    );
    expect(r.ok).toBe(false);
    expect(fellBack).toBe(false);
  });

  test("a probe that rejects blocks instead of escaping the handler", async () => {
    // A GENUINE transport throw (socket/DB down) must stay fail-closed and must
    // NOT fall back to the weaker reachability read.
    let fellBack = false;
    const r = await assertAuditWritable(
      stubClient({ rpc: async () => { throw new Error("socket closed"); }, onFrom: () => { fellBack = true; } }),
      { entityType: "INVENTORY_ADJUSTMENT", action: "CREATE" },
    );
    expect(r.ok).toBe(false);
    expect(fellBack).toBe(false);
  });

  test("an rpc UNSUPPORTED in the atomic transaction client degrades to reachability", async () => {
    // pg-supabase-transaction.rpc() throws `Unsupported SCM transaction RPC: …`
    // for the entity_audit_writable probe when a runScmPgCommand-wrapped handler
    // (PO-amendment approve / SO-amendment PO follow-up confirm) runs it. That is
    // "not callable HERE", not a failure — it must fall through to the .from()
    // reachability read (which the atomic client DOES support), not 503. This is
    // the regression guard for the two-lane PO follow-up confirm.
    let fellBack = false;
    const r = await assertAuditWritable(
      stubClient({
        rpc: async () => { throw new Error("Unsupported SCM transaction RPC: entity_audit_writable"); },
        select: async () => ({ data: [], error: null }),
        onFrom: () => { fellBack = true; },
      }),
      { entityType: "PURCHASE_ORDER", entityId: "po-1", action: "AMENDMENT_PO_APPROVED" },
    );
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("reachability_only");
    expect(fellBack).toBe(true);
  });

  test("before the SQL is applied it degrades to reachability, and says so", async () => {
    // Merging the code ahead of the manual apply must not break a handler; it
    // weakens the guarantee instead, and the reason names which guarantee is in
    // force so a green result is not mistaken for a full write check.
    const r = await assertAuditWritable(
      stubClient({ rpc: async () => ({ data: null, error: MISSING_RPC }), select: async () => ({ data: [], error: null }) }),
      { entityType: "GRN", entityId: "grn-2", action: "UPDATE" },
    );
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("reachability_only");
  });

  test("an unreachable sink blocks even on the fallback path", async () => {
    const r = await assertAuditWritable(
      stubClient({ rpc: async () => ({ data: null, error: MISSING_RPC }), select: async () => ({ data: null, error: { message: "service unavailable" } }) }),
      { entityType: "GRN", entityId: "grn-3", action: "UPDATE" },
    );
    expect(r.ok).toBe(false);
  });
});

describe("isMissingRpc", () => {
  test("recognises an absent function by code and by wording", () => {
    expect(isMissingRpc({ code: "PGRST202" })).toBe(true);
    expect(isMissingRpc({ code: "42883" })).toBe(true);
    expect(isMissingRpc({ message: "Could not find the function scm.foo in the schema cache" })).toBe(true);
  });

  test("does not mistake a live failure for an absent function", () => {
    // This predicate gates every atomic-write fallback in the scm tree. A false
    // positive re-runs a non-atomic path against a database that just refused.
    expect(isMissingRpc({ message: "permission denied for table entity_audit_log" })).toBe(false);
    expect(isMissingRpc({ message: "canceling statement due to statement timeout" })).toBe(false);
    expect(isMissingRpc(null)).toBe(false);
  });
});

describe("recordEntityAudit stays non-throwing", () => {
  /* The pre-flight is the guarantee; this is the reporting. If this writer ever
     threw it would unwind a handler PAST a committed business write — a GRN that
     received stock reported as failed, which is the ruling's own bug pointing
     the other way. */
  test("reports a failed insert instead of throwing", async () => {
    const sb = { from: () => ({ insert: async () => ({ error: { message: "sink gone" } }) }) } as unknown as Parameters<typeof recordEntityAudit>[0];
    const r = await recordEntityAudit(sb, { entityType: "GRN", entityId: "grn-4", action: "POST" });
    expect(r.recorded).toBe(false);
    expect(r.reason).toBe("sink gone");
  });

  test("reports success when the row lands", async () => {
    const sb = { from: () => ({ insert: async () => ({ error: null }) }) } as unknown as Parameters<typeof recordEntityAudit>[0];
    const r = await recordEntityAudit(sb, { entityType: "GRN", entityId: "grn-5", action: "POST" });
    expect(r.recorded).toBe(true);
  });

  test("swallows a client that throws outright", async () => {
    const sb = { from: () => { throw new Error("no client"); } } as unknown as Parameters<typeof recordEntityAudit>[0];
    await expect(recordEntityAudit(sb, { entityType: "GRN", entityId: "grn-6", action: "POST" })).resolves.toMatchObject({ recorded: false });
  });
});

describe("the refusal an operator actually sees", () => {
  /* humanApiError (frontend/src/vendor/scm/lib/authed-fetch.ts) DROPS a server
     sentence that is too long, looks like JSON, or contains internals
     vocabulary, and shows a generic status line instead. These assertions mirror
     that filter so a future reword cannot silently make the message invisible —
     the failure mode would be an operator seeing "That clashes with something
     already in the system", which explains nothing and is not true. */
  const INTERNALS = /violates|constraint|null value|column|relation|syntax|PGRST|error_code|\b\d{5}\b/i;

  test("the body is shaped so the sentence reaches the operator", () => {
    const body = auditUnavailableBody();
    expect(body.error).toBe(AUDIT_UNAVAILABLE_ERROR);
    expect(body.message).toBe(AUDIT_UNAVAILABLE_MESSAGE);
  });

  test("the sentence survives the client's filter", () => {
    expect(AUDIT_UNAVAILABLE_MESSAGE.length).toBeLessThan(200);
    expect(AUDIT_UNAVAILABLE_MESSAGE.trim().startsWith("{")).toBe(false);
    expect(INTERNALS.test(AUDIT_UNAVAILABLE_MESSAGE)).toBe(false);
  });

  test("it tells the operator the edit did not happen, in plain words", () => {
    // The whole point of the pre-flight: this claim has to be TRUE, so the
    // message is allowed to say it. It must also not read like an error code.
    expect(AUDIT_UNAVAILABLE_MESSAGE).toMatch(/nothing has changed/i);
    expect(AUDIT_UNAVAILABLE_MESSAGE).toMatch(/try again/i);
    expect(AUDIT_UNAVAILABLE_MESSAGE).not.toMatch(/_/);
  });
});
