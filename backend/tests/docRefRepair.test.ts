import { describe, expect, test } from "vitest";
import { parseFromSosNote } from "../src/scm/routes/document-flow";
import {
  companyPrefix,
  classifyToken,
  parseFromSosTokens,
  rewriteFromSosNote,
} from "../scripts/lib/doc-ref-repair-core.mjs";
import { pairPoLinesToSoLines } from "../scripts/lib/po-so-line-pairing.mjs";

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

describe("rewriteFromSosNote — the rewrite must match what parseFromSosNote reads", () => {
  const roundTrip = (note: string, map: Map<string, string>) => {
    const next = rewriteFromSosNote(note, map);
    // The script's parser and the route's parser must agree on the result.
    expect(parseFromSosTokens(next)).toEqual(parseFromSosNote(next));
    return next;
  };

  test("rewrites the named tokens and leaves the rest of the note byte-identical", () => {
    const next = roundTrip(
      "From SOs: SO-2606-005, SO-2606-006",
      new Map([["SO-2606-005", "2990-SO-2606-005"]]),
    );
    expect(next).toBe("From SOs: 2990-SO-2606-005, SO-2606-006");
    expect(parseFromSosNote(next)).toEqual(["2990-SO-2606-005", "SO-2606-006"]);
  });

  test("preserves the label's own casing, odd spacing and other lines", () => {
    const note = "  from so: SO-1 ,SO-2  \nDeliver to bay 3\n";
    const next = roundTrip(note, new Map([["SO-1", "2990-SO-1"], ["SO-2", "2990-SO-2"]]));
    expect(next).toBe("  from so: 2990-SO-1 ,2990-SO-2  \nDeliver to bay 3\n");
    expect(parseFromSosNote(next)).toEqual(["2990-SO-1", "2990-SO-2"]);
  });

  test("a substring of another token is never rewritten by accident", () => {
    const next = roundTrip("From SOs: SO-1, SO-10", new Map([["SO-1", "2990-SO-1"]]));
    expect(next).toBe("From SOs: 2990-SO-1, SO-10");
    expect(parseFromSosNote(next)).toEqual(["2990-SO-1", "SO-10"]);
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
