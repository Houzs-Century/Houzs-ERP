import { describe, expect, test } from "vitest";
import { parseProvenanceNote } from "../src/scm/routes/document-flow";
import {
  companyPrefix,
  classifyToken,
  classifySourceRef,
  classifyIdRestamp,
  parseFromSosTokens,
  rewriteFromSosNote,
} from "../scripts/lib/doc-ref-repair-core.mjs";
import { pairPoLinesToSoLines, pairPoLinesAcrossSos } from "../scripts/lib/po-so-line-pairing.mjs";

// The 2990 import prefixed document NUMBERS but not the references stored as
// free text inside another column, so `purchase_orders.notes` and
// `batch_no` name PRE-IMPORT numbers and every consumer's string equality
// fails. These pin the RULE that decides whether such a reference may be
// rewritten — the part that makes the repair provable rather than a guess.
//
// The hazard the rule exists for: doc-number TAILS collide across company
// namespaces. HOUZS (the base company) mints BARE numbers and every other
// company prefixes, so PO-2607-002 and 2990-PO-2607-002 are BOTH real
// purchase orders. A blanket prefix would repoint a batch at a different real
// document and corrupt the costing trail.

describe("companyPrefix — mirrors companyDocPrefix (lib/companyScope.ts)", () => {
  test("the base company and an unknown code mint BARE numbers", () => {
    expect(companyPrefix("HOUZS")).toBe("");
    expect(companyPrefix("houzs")).toBe("");
    expect(companyPrefix("")).toBe("");
    expect(companyPrefix(null)).toBe("");
    expect(companyPrefix(undefined)).toBe("");
  });

  test("every other company prefixes with its code", () => {
    expect(companyPrefix("2990")).toBe("2990-");
    expect(companyPrefix(" 2990 ")).toBe("2990-");
  });
});

describe("classifyToken — the three-part safety rule", () => {
  test("repairs only when it resolves to NOTHING now and to EXACTLY ONE prefixed", () => {
    expect(
      classifyToken({
        token: "SO-2606-005",
        prefix: "2990-",
        ownCompanyMatches: 0,
        prefixedOwnCompanyMatches: 1,
      }),
    ).toMatchObject({ verdict: "repair", prefixed: "2990-SO-2606-005" });
  });

  test("a reference that already resolves is never touched", () => {
    expect(
      classifyToken({
        token: "2990-SO-2606-005",
        prefix: "2990-",
        ownCompanyMatches: 1,
        prefixedOwnCompanyMatches: 0,
      }),
    ).toMatchObject({ verdict: "already-resolves" });
  });

  test("idempotence: re-running over a repaired reference plans nothing", () => {
    const first = classifyToken({
      token: "SO-2606-005",
      prefix: "2990-",
      ownCompanyMatches: 0,
      prefixedOwnCompanyMatches: 1,
    });
    expect(first.verdict).toBe("repair");
    // Second pass sees the rewritten value, which now resolves.
    expect(
      classifyToken({
        token: first.prefixed,
        prefix: "2990-",
        ownCompanyMatches: 1,
        prefixedOwnCompanyMatches: 0,
      }).verdict,
    ).toBe("already-resolves");
  });

  test("a base-company row can never be repaired — its prefix is empty", () => {
    expect(
      classifyToken({
        token: "PO-2607-002",
        prefix: "",
        ownCompanyMatches: 0,
        prefixedOwnCompanyMatches: 0,
      }),
    ).toMatchObject({ verdict: "no-prefix", prefixed: "PO-2607-002" });
  });

  test("the prefixed form matching nothing, or more than one, is left alone", () => {
    expect(
      classifyToken({ token: "PO-2606-001", prefix: "2990-", ownCompanyMatches: 0, prefixedOwnCompanyMatches: 0 }).verdict,
    ).toBe("prefixed-missing");
    expect(
      classifyToken({ token: "PO-2606-001", prefix: "2990-", ownCompanyMatches: 0, prefixedOwnCompanyMatches: 2 }).verdict,
    ).toBe("prefixed-ambiguous");
  });

  test("THE COLLIDING TAIL: a real HOUZS PO-2607-002 does not block, and does not cause, a 2990 repair", () => {
    // The batch sits on a 2990 row. As stored it resolves to nothing IN 2990
    // (the PO-2607-002 that exists belongs to HOUZS — foreignMatches), and
    // 2990-PO-2607-002 exists in 2990. The rule repairs, and the result names
    // the 2990 document, never the HOUZS one.
    const v = classifyToken({
      token: "PO-2607-002",
      prefix: "2990-",
      ownCompanyMatches: 0,
      prefixedOwnCompanyMatches: 1,
      foreignMatches: 1,
    });
    expect(v).toMatchObject({ verdict: "repair", prefixed: "2990-PO-2607-002", foreignMatches: 1 });
  });

  test("a batch that already names a PO IN ITS OWN company is left alone even when a prefixed twin exists", () => {
    // The bare-on-BASE case the production diagnostic found: correct by design.
    expect(
      classifyToken({
        token: "PO-2607-002",
        prefix: "",
        ownCompanyMatches: 1,
        prefixedOwnCompanyMatches: 0,
        foreignMatches: 1,
      }).verdict,
    ).toBe("already-resolves");
  });
});

describe("classifySourceRef — A3 ledger source refs: the number rule plus the sibling doc id", () => {
  // The ledger names its parent twice — source_doc_no AND source_doc_id — and
  // the import broke them independently (bare numbers; ids copied verbatim
  // from a database whose parent was sometimes dropped on PK collision). The
  // number decision is classifyToken's, unchanged; these pin the id half.

  test("repairs a bare DO ref and restamps its dangling id from the SAME resolution", () => {
    const v = classifySourceRef({
      token: "DO-2607-003",
      prefix: "2990-",
      ownCompanyMatches: 0,
      prefixedOwnCompanyMatches: 1,
      resolvedDocId: "new-do-uuid",
      storedDocIds: [{ id: "old-2990-db-uuid", exists: false, rows: 5 }],
    });
    expect(v).toMatchObject({ verdict: "repair", prefixed: "2990-DO-2607-003", resolvedDocId: "new-do-uuid" });
    expect(v.idWrites).toEqual([{ id: "old-2990-db-uuid", rows: 5, action: "restamp" }]);
  });

  test("a NULL stored id is stamped, not skipped — the row asserted nothing", () => {
    const v = classifySourceRef({
      token: "GRN-2606-010",
      prefix: "2990-",
      ownCompanyMatches: 0,
      prefixedOwnCompanyMatches: 1,
      resolvedDocId: "grn-uuid",
      storedDocIds: [{ id: null, exists: false, rows: 2 }],
    });
    expect(v.verdict).toBe("repair");
    expect(v.idWrites).toEqual([{ id: null, rows: 2, action: "stamp" }]);
  });

  test("a stored id that already IS the resolved document is kept", () => {
    const v = classifySourceRef({
      token: "DO-2607-003",
      prefix: "2990-",
      ownCompanyMatches: 0,
      prefixedOwnCompanyMatches: 1,
      resolvedDocId: "do-uuid",
      storedDocIds: [{ id: "do-uuid", exists: true, rows: 3 }],
    });
    expect(v.verdict).toBe("repair");
    expect(v.idWrites).toEqual([{ id: "do-uuid", rows: 3, action: "keep" }]);
  });

  test("THE REFUSAL: a stored id naming a DIFFERENT real document refuses the whole group", () => {
    // The row's two columns disagree about which real document it belongs to;
    // rewriting either would be picking sides with no evidence.
    const v = classifySourceRef({
      token: "DO-2607-003",
      prefix: "2990-",
      ownCompanyMatches: 0,
      prefixedOwnCompanyMatches: 1,
      resolvedDocId: "do-uuid-A",
      storedDocIds: [{ id: "do-uuid-B", exists: true, rows: 1 }],
    });
    expect(v.verdict).toBe("doc-id-conflict");
  });

  test("mixed stored ids: dangling restamped, correct kept, no conflict", () => {
    const v = classifySourceRef({
      token: "DO-2607-003",
      prefix: "2990-",
      ownCompanyMatches: 0,
      prefixedOwnCompanyMatches: 1,
      resolvedDocId: "do-uuid",
      storedDocIds: [
        { id: "old-dead-uuid", exists: false, rows: 4 },
        { id: "do-uuid", exists: true, rows: 2 },
      ],
    });
    expect(v.verdict).toBe("repair");
    expect(v.idWrites).toEqual([
      { id: "old-dead-uuid", rows: 4, action: "restamp" },
      { id: "do-uuid", rows: 2, action: "keep" },
    ]);
  });

  test("a number that already resolves passes through untouched — the id is never examined here", () => {
    // The number-resolves-but-id-dangles shape is REPORTED by the script, not
    // repaired: the prefix rule proves nothing about that id.
    const v = classifySourceRef({
      token: "2990-DO-2607-003",
      prefix: "2990-",
      ownCompanyMatches: 1,
      prefixedOwnCompanyMatches: 0,
      storedDocIds: [{ id: "dead-uuid", exists: false, rows: 5 }],
    });
    expect(v.verdict).toBe("already-resolves");
    expect(v).not.toHaveProperty("idWrites");
  });

  test("idempotence: re-running over a repaired group plans nothing", () => {
    const first = classifySourceRef({
      token: "DO-2607-003",
      prefix: "2990-",
      ownCompanyMatches: 0,
      prefixedOwnCompanyMatches: 1,
      resolvedDocId: "do-uuid",
      storedDocIds: [{ id: null, exists: false, rows: 5 }],
    });
    expect(first.verdict).toBe("repair");
    // Second pass sees the rewritten number (resolves) and the stamped id.
    expect(
      classifySourceRef({
        token: first.prefixed,
        prefix: "2990-",
        ownCompanyMatches: 1,
        prefixedOwnCompanyMatches: 0,
        storedDocIds: [{ id: "do-uuid", exists: true, rows: 5 }],
      }).verdict,
    ).toBe("already-resolves");
  });

  test("THE COLLIDING TAIL holds for DOs too: a real HOUZS DO-2607-003 neither blocks nor misdirects a 2990 repair", () => {
    const v = classifySourceRef({
      token: "DO-2607-003",
      prefix: "2990-",
      ownCompanyMatches: 0,
      prefixedOwnCompanyMatches: 1,
      foreignMatches: 1,
      resolvedDocId: "the-2990-do-uuid",
      storedDocIds: [{ id: null, exists: false, rows: 1 }],
    });
    expect(v).toMatchObject({ verdict: "repair", prefixed: "2990-DO-2607-003", resolvedDocId: "the-2990-do-uuid", foreignMatches: 1 });
  });

  test("a repair verdict with no resolvedDocId throws — never plan a write without the resolved document", () => {
    expect(() =>
      classifySourceRef({
        token: "DO-2607-003",
        prefix: "2990-",
        ownCompanyMatches: 0,
        prefixedOwnCompanyMatches: 1,
        storedDocIds: [],
      }),
    ).toThrow(/resolvedDocId/);
  });
});

describe("classifyIdRestamp — part `ids` (W1): the id-heal for numbers that already resolve", () => {
  // The shape part `consumptions` deliberately reports and does not touch:
  // the importer's repair pass fixed the NUMBER, but the verbatim-copied
  // source_doc_id still names the PRE-IMPORT parent, which no longer exists.
  // The audit's sections 4 and 10b read the ID, so the finding stands until
  // the id is restamped — from the number's unique resolution, nothing else.

  test("THE WOUND (run 30695536709): the number resolves, the stored id matches nothing — restamped", () => {
    const v = classifyIdRestamp({
      token: "2990-DO-2607-016",
      ownCompanyMatches: 1,
      resolvedDocId: "68362d70-real",
      storedDocIds: [{ id: "6d9ecfd5-preimport", exists: false, rows: 4 }],
    });
    expect(v.verdict).toBe("restamp");
    expect(v.idWrites).toEqual([{ id: "6d9ecfd5-preimport", rows: 4, action: "restamp" }]);
    expect(v.resolvedDocId).toBe("68362d70-real");
  });

  test("two distinct dangling ids in one group are both restamped to the one resolution", () => {
    const v = classifyIdRestamp({
      token: "2990-DO-2607-016",
      ownCompanyMatches: 1,
      resolvedDocId: "real-id",
      storedDocIds: [
        { id: "dead-a", exists: false, rows: 4 },
        { id: "dead-b", exists: false, rows: 2 },
      ],
    });
    expect(v.verdict).toBe("restamp");
    expect(v.idWrites).toEqual([
      { id: "dead-a", rows: 4, action: "restamp" },
      { id: "dead-b", rows: 2, action: "restamp" },
    ]);
  });

  test("a NULL stored id is counted but NEVER written — sections 4/10b read only non-NULL ids", () => {
    const v = classifyIdRestamp({
      token: "2990-DO-2607-016",
      ownCompanyMatches: 1,
      resolvedDocId: "real-id",
      storedDocIds: [
        { id: null, exists: false, rows: 3 },
        { id: "dead-a", exists: false, rows: 1 },
      ],
    });
    expect(v.verdict).toBe("restamp");
    expect(v.idWrites).toEqual([
      { id: null, rows: 3, action: "null-report" },
      { id: "dead-a", rows: 1, action: "restamp" },
    ]);
  });

  test("a group whose ids are all NULL or already correct plans nothing", () => {
    const v = classifyIdRestamp({
      token: "2990-DO-2607-016",
      ownCompanyMatches: 1,
      resolvedDocId: "real-id",
      storedDocIds: [
        { id: "real-id", exists: true, rows: 5 },
        { id: null, exists: false, rows: 2 },
      ],
    });
    expect(v.verdict).toBe("no-dangling-id");
  });

  test("THE REFUSAL: a stored id naming a DIFFERENT real document refuses the whole group", () => {
    const v = classifyIdRestamp({
      token: "2990-DO-2607-016",
      ownCompanyMatches: 1,
      resolvedDocId: "real-id",
      storedDocIds: [
        { id: "dead-a", exists: false, rows: 4 },
        { id: "another-real-do", exists: true, rows: 1 },
      ],
    });
    expect(v.verdict).toBe("doc-id-conflict");
  });

  test("an unresolved number is the PREFIX repair's territory, never healed here", () => {
    const v = classifyIdRestamp({
      token: "DO-2607-016",
      ownCompanyMatches: 0,
      storedDocIds: [{ id: "dead-a", exists: false, rows: 4 }],
    });
    expect(v.verdict).toBe("number-unresolved");
  });

  test("a number matching TWO same-company documents has no unique resolution — refused", () => {
    const v = classifyIdRestamp({
      token: "2990-DO-2607-016",
      ownCompanyMatches: 2,
      storedDocIds: [{ id: "dead-a", exists: false, rows: 4 }],
    });
    expect(v.verdict).toBe("number-ambiguous");
  });

  test("a unique resolution without its id throws — never plan a write without the resolved document", () => {
    expect(() =>
      classifyIdRestamp({
        token: "2990-DO-2607-016",
        ownCompanyMatches: 1,
        storedDocIds: [{ id: "dead-a", exists: false, rows: 4 }],
      }),
    ).toThrow(/resolvedDocId/);
  });

  test("idempotence: re-running over a restamped group plans nothing", () => {
    const first = classifyIdRestamp({
      token: "2990-DO-2607-016",
      ownCompanyMatches: 1,
      resolvedDocId: "real-id",
      storedDocIds: [{ id: "dead-a", exists: false, rows: 4 }],
    });
    expect(first.verdict).toBe("restamp");
    expect(
      classifyIdRestamp({
        token: "2990-DO-2607-016",
        ownCompanyMatches: 1,
        resolvedDocId: "real-id",
        storedDocIds: [{ id: "real-id", exists: true, rows: 4 }],
      }).verdict,
    ).toBe("no-dangling-id");
  });

  test("a foreign company's document with the same number neither blocks nor misdirects (informational only)", () => {
    const v = classifyIdRestamp({
      token: "2990-DO-2607-016",
      ownCompanyMatches: 1,
      foreignMatches: 1,
      resolvedDocId: "real-id",
      storedDocIds: [{ id: "dead-a", exists: false, rows: 1 }],
    });
    expect(v).toMatchObject({ verdict: "restamp", foreignMatches: 1 });
  });
});

describe("rewriteFromSosNote — the rewrite must match what parseProvenanceNote reads", () => {
  const roundTrip = (note: string, map: Map<string, string>) => {
    const next = rewriteFromSosNote(note, map);
    // The script's parser and the route's parser must agree on the result.
    expect(parseFromSosTokens(next)).toEqual(parseProvenanceNote(next));
    return next;
  };

  test("rewrites the named tokens and leaves the rest of the note byte-identical", () => {
    const next = roundTrip(
      "From SOs: SO-2606-005, SO-2606-006",
      new Map([["SO-2606-005", "2990-SO-2606-005"]]),
    );
    expect(next).toBe("From SOs: 2990-SO-2606-005, SO-2606-006");
    expect(parseProvenanceNote(next)).toEqual(["2990-SO-2606-005", "SO-2606-006"]);
  });

  test("preserves the label's own casing, odd spacing and other lines", () => {
    const note = "  from so: SO-1 ,SO-2  \nDeliver to bay 3\n";
    const next = roundTrip(note, new Map([["SO-1", "2990-SO-1"], ["SO-2", "2990-SO-2"]]));
    expect(next).toBe("  from so: 2990-SO-1 ,2990-SO-2  \nDeliver to bay 3\n");
    expect(parseProvenanceNote(next)).toEqual(["2990-SO-1", "2990-SO-2"]);
  });

  test("a substring of another token is never rewritten by accident", () => {
    const next = roundTrip("From SOs: SO-1, SO-10", new Map([["SO-1", "2990-SO-1"]]));
    expect(next).toBe("From SOs: 2990-SO-1, SO-10");
    expect(parseProvenanceNote(next)).toEqual(["2990-SO-1", "SO-10"]);
  });

  test("no replacements, a plain note, or empty input returns the input unchanged", () => {
    expect(rewriteFromSosNote("From SOs: SO-1", new Map())).toBe("From SOs: SO-1");
    expect(rewriteFromSosNote("call the supplier", new Map([["SO-1", "X"]]))).toBe("call the supplier");
    expect(rewriteFromSosNote(null, new Map([["SO-1", "X"]]))).toBe(null);
  });

  test("re-running the rewrite over its own output changes nothing", () => {
    const map = new Map([["SO-2606-005", "2990-SO-2606-005"]]);
    const once = rewriteFromSosNote("From SOs: SO-2606-005", map);
    expect(rewriteFromSosNote(once, map)).toBe(once);
  });
});

describe("pairPoLinesToSoLines — a link is written only when the item code pairs 1:1", () => {
  test("pairs an unambiguous code", () => {
    const res = pairPoLinesToSoLines(
      [{ id: "po1", item_code: "A", so_item_id: null }],
      [{ id: "so1", item_code: "A" }],
    );
    expect(res.pairs).toEqual([{ poLineId: "po1", soLineId: "so1", code: "A" }]);
    expect(res.ambiguous).toEqual([]);
  });

  test("two PO lines of the same code are ambiguous — reported, never guessed", () => {
    const res = pairPoLinesToSoLines(
      [
        { id: "po1", item_code: "A", so_item_id: null },
        { id: "po2", item_code: "A", so_item_id: null },
      ],
      [{ id: "so1", item_code: "A" }],
    );
    expect(res.pairs).toEqual([]);
    expect(res.ambiguous).toEqual([{ code: "A", unlinkedPoLines: 2, freeSoLines: 1 }]);
  });

  test("an SO line already claimed by another PO is not double-linked", () => {
    const res = pairPoLinesToSoLines(
      [{ id: "po1", item_code: "A", so_item_id: null }],
      [{ id: "so1", item_code: "A" }],
      new Set(["so1"]),
    );
    expect(res.pairs).toEqual([]);
    expect(res.unmatched).toEqual([{ code: "A", unlinkedPoLines: 1, freeSoLines: 0 }]);
  });

  test("an already-linked PO line is left alone (idempotent re-run)", () => {
    const res = pairPoLinesToSoLines(
      [{ id: "po1", item_code: "A", so_item_id: "so1" }],
      [{ id: "so1", item_code: "A" }],
      new Set(["so1"]),
    );
    expect(res.pairs).toEqual([]);
    expect(res.alreadyLinked).toBe(1);
  });
});

describe("pairPoLinesAcrossSos — TIER 3, the consolidated PO", () => {
  test("one line per named order: each code unique across the SET, so every line is determined", () => {
    // The owner's model — one PO to the supplier covering three customers.
    const res = pairPoLinesAcrossSos(
      [
        { id: "po1", item_code: "ANGGN-FIRM(Q)", so_item_id: null },
        { id: "po2", item_code: "ANGGN-SOFT(K)", so_item_id: null },
        { id: "po3", item_code: "ARRUS-FIRM(Q)", so_item_id: null },
      ],
      [
        { doc: "SO-1", lines: [{ id: "s1", item_code: "ANGGN-FIRM(Q)" }] },
        { doc: "SO-2", lines: [{ id: "s2", item_code: "ANGGN-SOFT(K)" }] },
        { doc: "SO-3", lines: [{ id: "s3", item_code: "ARRUS-FIRM(Q)" }] },
      ],
    );
    expect(res.ambiguous).toEqual([]);
    expect(res.pairs).toEqual([
      { poLineId: "po1", soLineId: "s1", code: "ANGGN-FIRM(Q)", soDoc: "SO-1" },
      { poLineId: "po2", soLineId: "s2", code: "ANGGN-SOFT(K)", soDoc: "SO-2" },
      { poLineId: "po3", soLineId: "s3", code: "ARRUS-FIRM(Q)", soDoc: "SO-3" },
    ]);
  });

  test("two of the named orders want the SAME code — refused, and both are named", () => {
    const res = pairPoLinesAcrossSos(
      [{ id: "po1", item_code: "A", so_item_id: null }],
      [
        { doc: "SO-1", lines: [{ id: "s1", item_code: "A" }] },
        { doc: "SO-2", lines: [{ id: "s2", item_code: "A" }] },
      ],
    );
    expect(res.pairs).toEqual([]);
    expect(res.ambiguous).toEqual([
      { code: "A", unlinkedPoLines: 1, freeSoLines: 2, soDocs: ["SO-1", "SO-2"] },
    ]);
  });

  test("quantity is NOT a discriminator — equal qty does not break a tie", () => {
    const res = pairPoLinesAcrossSos(
      [{ id: "po1", item_code: "A", qty: 3, so_item_id: null }],
      [
        { doc: "SO-1", lines: [{ id: "s1", item_code: "A", qty: 3 }] },
        { doc: "SO-2", lines: [{ id: "s2", item_code: "A", qty: 9 }] },
      ],
    );
    expect(res.pairs).toEqual([]);
    expect(res.ambiguous[0].code).toBe("A");
  });

  test("a stronger tier's claim frees the tie: the taken SO line leaves the code unique", () => {
    // Tier 1/2 already bound s1, so only s2 is a candidate and po1 is determined.
    const res = pairPoLinesAcrossSos(
      [{ id: "po1", item_code: "A", so_item_id: null }],
      [
        { doc: "SO-1", lines: [{ id: "s1", item_code: "A" }] },
        { doc: "SO-2", lines: [{ id: "s2", item_code: "A" }] },
      ],
      new Set(["s1"]),
    );
    expect(res.ambiguous).toEqual([]);
    expect(res.pairs).toEqual([
      { poLineId: "po1", soLineId: "s2", code: "A", soDoc: "SO-2" },
    ]);
  });

  test("two PO lines of one code stay ambiguous even when the set offers two", () => {
    const res = pairPoLinesAcrossSos(
      [
        { id: "po1", item_code: "A", so_item_id: null },
        { id: "po2", item_code: "A", so_item_id: null },
      ],
      [
        { doc: "SO-1", lines: [{ id: "s1", item_code: "A" }] },
        { doc: "SO-2", lines: [{ id: "s2", item_code: "A" }] },
      ],
    );
    expect(res.pairs).toEqual([]);
    expect(res.ambiguous).toEqual([
      { code: "A", unlinkedPoLines: 2, freeSoLines: 2, soDocs: ["SO-1", "SO-2"] },
    ]);
  });

  test("a code no named order carries is unmatched, not paired", () => {
    const res = pairPoLinesAcrossSos(
      [{ id: "po1", item_code: "SVC-TRANS.CHARGES", so_item_id: null }],
      [{ doc: "SO-1", lines: [{ id: "s1", item_code: "A" }] }],
    );
    expect(res.pairs).toEqual([]);
    expect(res.unmatched).toEqual([
      { code: "SVC-TRANS.CHARGES", unlinkedPoLines: 1, freeSoLines: 0 },
    ]);
  });

  test("an already-linked PO line is not re-paired against a different order", () => {
    const res = pairPoLinesAcrossSos(
      [{ id: "po1", item_code: "A", so_item_id: "s1" }],
      [
        { doc: "SO-1", lines: [{ id: "s1", item_code: "A" }] },
        { doc: "SO-2", lines: [{ id: "s2", item_code: "A" }] },
      ],
      new Set(["s1"]),
    );
    expect(res.pairs).toEqual([]);
    expect(res.alreadyLinked).toBe(1);
  });
});
