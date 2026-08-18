import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

import {
  PROVENANCE_LABEL_ALTERNATION,
  PROVENANCE_NOTE_LABELS,
  TRANSFER_DOC,
  parseProvenanceNote,
  provenanceNote,
  provenanceNoteLabel,
  provenanceNoteSqlPattern,
  relabelProvenanceNote,
  transferFromColumnLabel,
  transferFromLabel,
  transferToColumnLabel,
  transferToLabel,
} from "../src/scm/shared/transfer-vocabulary";
// Imported through the ROUTE as well as from the shared module: po-so-coverage
// and the graph both reach the parser via this re-export, so it is the path a
// caller actually takes and it has to resolve to the same function.
import { parseProvenanceNote as parseViaDocumentFlow } from "../src/scm/routes/document-flow";
import { parseFromSosTokens, rewriteFromSosNote } from "../scripts/lib/doc-ref-repair-core.mjs";
import * as twin from "../scripts/lib/transfer-vocabulary.mjs";

// ---------------------------------------------------------------------------
// The referee for the provenance note.
//
// The note in `purchase_orders.notes` is a STORED DATA CONTRACT: an MRP-raised
// PO carries no per-line so_item_id, so this note is the ONLY record of which
// Sales Orders it was bought for. Seven readers parse it and they live in three
// languages that cannot import each other — backend TS, frontend TS, and plain
// .mjs scripts that run under bare node with no build step.
//
// The failure this file exists to prevent is not a crash. It is a reader taught
// only the CURRENT label: every PO written under the old one then resolves to
// NO source orders, and the PO Relationship Map's Sales Order node and the
// printed PO's "Your Ref No." simply go blank. No error, no log, no exception —
// the note reads like ordinary free text. Total loss, silently.
//
// So every parser is held to ONE corpus file, and the frontend's readers are
// held to the same one in frontend/src/vendor/shared/transfer-vocabulary.test.ts.
// ---------------------------------------------------------------------------

type Case = { name: string; note: string; expect: string[] };
const CORPUS: Case[] = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/provenance-note-corpus.json"), "utf8"),
).cases;

test("the corpus itself covers both eras — otherwise every check below is vacuous", () => {
  const accepted = CORPUS.filter((c) => c.expect.length > 0);
  const current = accepted.filter((c) => /transfer from sales order/i.test(c.note));
  const legacy = accepted.filter((c) => /from sos?:/i.test(c.note));
  const rejected = CORPUS.filter((c) => c.expect.length === 0);
  expect(current.length).toBeGreaterThanOrEqual(4);
  expect(legacy.length).toBeGreaterThanOrEqual(4);
  expect(rejected.length).toBeGreaterThanOrEqual(4);
});

describe("every backend reader extracts the same set from the same corpus", () => {
  const READERS: Array<[string, (n: string) => string[]]> = [
    ["shared parseProvenanceNote", parseProvenanceNote],
    ["document-flow re-export", parseViaDocumentFlow],
    ["doc-ref-repair-core parseFromSosTokens", parseFromSosTokens],
    ["script twin parseProvenanceNote", twin.parseProvenanceNote],
  ];

  for (const [who, read] of READERS) {
    for (const c of CORPUS) {
      test(`${who} — ${c.name}`, () => {
        expect(read(c.note)).toEqual(c.expect);
      });
    }
  }
});

describe("the writer and the readers agree", () => {
  test("the note the raise writes parses back to the doc numbers it was given", () => {
    const docNos = ["SO-2699-021", "SO-2699-022", "SO-2699-023"];
    const note = provenanceNote("so", docNos);
    expect(note).toBe("Transfer from Sales Order: SO-2699-021, SO-2699-022, SO-2699-023");
    expect(parseProvenanceNote(note)).toEqual(docNos);
    expect(parseViaDocumentFlow(note)).toEqual(docNos);
    expect(parseFromSosTokens(note)).toEqual(docNos);
  });

  test("the note's label IS the button's label — one rule, not a sixteenth variant", () => {
    expect(provenanceNoteLabel("so")).toBe(transferFromLabel("so"));
  });

  test("blanks and duplicates never reach the stored note", () => {
    expect(provenanceNote("so", ["SO-2699-021", "", "SO-2699-021", "  "]))
      .toBe("Transfer from Sales Order: SO-2699-021");
  });
});

describe("the script twin has not drifted from the shared module", () => {
  test("the accepted-label lists are identical", () => {
    expect(twin.PROVENANCE_NOTE_LABELS).toEqual(PROVENANCE_NOTE_LABELS);
  });

  test("the regex alternation is identical", () => {
    expect(twin.PROVENANCE_LABEL_ALTERNATION).toBe(PROVENANCE_LABEL_ALTERNATION);
  });

  test("the SQL pattern is identical", () => {
    expect(twin.provenanceNoteSqlPattern()).toBe(provenanceNoteSqlPattern());
  });

  test("the word table is identical", () => {
    expect(twin.TRANSFER_DOC).toEqual({ ...TRANSFER_DOC });
  });

  test("every doc key generates the same sentence on both sides", () => {
    for (const key of Object.keys(TRANSFER_DOC) as Array<keyof typeof TRANSFER_DOC>) {
      expect(twin.transferFromLabel(key)).toBe(transferFromLabel(key));
    }
  });
});

describe("the LEGACY labels are permanent", () => {
  // Deleting one of these does not throw. It empties the Sales Order node on
  // the PO Relationship Map, and the "Your Ref No." on the printed PO, for
  // every PO raised before 2026-08-18 — with nothing logged. This test is the
  // only thing that would say so.
  test("both pre-2026-08-18 spellings are still accepted", () => {
    expect(PROVENANCE_NOTE_LABELS).toContain("From SOs");
    expect(PROVENANCE_NOTE_LABELS).toContain("From SO");
    expect(parseProvenanceNote("From SOs: SO-2699-001")).toEqual(["SO-2699-001"]);
    expect(parseProvenanceNote("From SO: SO-2699-001")).toEqual(["SO-2699-001"]);
  });

  test("the current label is listed first in intent, and longest-first in order", () => {
    expect(PROVENANCE_NOTE_LABELS).toContain(provenanceNoteLabel("so"));
    const lengths = PROVENANCE_NOTE_LABELS.map((l) => l.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  });

  test("the alternation cannot half-match the plural as the singular", () => {
    // "From SO" tried before "From SOs" would consume the label, find "s"
    // where it needs ":", and drop a legitimate note on the floor.
    expect(parseProvenanceNote("From SOs: SO-2699-001")).toEqual(["SO-2699-001"]);
  });
});

describe("the SQL predicate selects every row the JS parser accepts", () => {
  // The three prod-touching scripts narrow to candidate rows in SQL
  // (`notes ~* <pattern>`) and only then parse in JS. A pattern that knows
  // fewer labels than the parser silently shrinks the whole run — the script
  // reports a clean pass over rows it never looked at.
  const sqlRe = new RegExp(provenanceNoteSqlPattern(), "i");

  for (const c of CORPUS.filter((x) => x.expect.length > 0)) {
    test(`selected — ${c.name}`, () => {
      expect(sqlRe.test(c.note)).toBe(true);
    });
  }

  test("the pattern is a candidate FILTER, not the parser — a superset is correct", () => {
    // It has no line anchor, so it also selects notes the parser rejects. That
    // is intended: SQL narrows, JS decides. What must never happen is the
    // reverse — a row the parser would accept that SQL never fetched.
    expect(sqlRe.test("See remarks. Transfer from Sales Order: SO-2699-001")).toBe(true);
    expect(parseProvenanceNote("See remarks. Transfer from Sales Order: SO-2699-001")).toEqual([]);
  });
});

describe("relabelProvenanceNote — the backfill's primitive", () => {
  // This function is a PRODUCTION DATA WRITE. Everything below is the contract
  // the backfill leans on; if any of it is wrong, the backfill loses data.

  test("THE INVARIANT — the wording changes, the extracted set does not", () => {
    // Proven by parsing both sides and comparing, over the whole corpus, not by
    // reading a sample. This is the same check the script re-runs against the
    // database after it writes.
    for (const c of CORPUS) {
      const after = relabelProvenanceNote(c.note);
      expect(parseProvenanceNote(after)).toEqual(parseProvenanceNote(c.note));
      expect(parseProvenanceNote(after)).toEqual(c.expect);
    }
  });

  test("it rewrites the LABEL and not one other character", () => {
    expect(relabelProvenanceNote("From SOs: SO-2699-001, SO-2699-002"))
      .toBe("Transfer from Sales Order: SO-2699-001, SO-2699-002");
    expect(relabelProvenanceNote("From SO: SO-2699-001"))
      .toBe("Transfer from Sales Order: SO-2699-001");
  });

  test("ragged spacing, other lines and the trailing run survive byte-for-byte", () => {
    expect(relabelProvenanceNote("  From SOs:   SO-1 ,SO-2  "))
      .toBe("  Transfer from Sales Order:   SO-1 ,SO-2  ");
    expect(relabelProvenanceNote("Rush job.\nFrom SOs: SO-1\nCall the supplier."))
      .toBe("Rush job.\nTransfer from Sales Order: SO-1\nCall the supplier.");
  });

  test("IDEMPOTENT — a second pass returns the very same string object", () => {
    const once = relabelProvenanceNote("From SOs: SO-2699-001");
    const twice = relabelProvenanceNote(once);
    expect(twice).toBe(once);
    // Identity, not equality: this is what lets the script plan zero rows on a
    // re-run instead of rewriting every note to the value it already holds.
    expect(relabelProvenanceNote(once) === once).toBe(true);
  });

  test("a note that is not provenance is returned untouched", () => {
    const plain = "urgent — call the supplier first";
    expect(relabelProvenanceNote(plain)).toBe(plain);
    const midline = "See remarks. From SOs: SO-1";
    expect(relabelProvenanceNote(midline)).toBe(midline);
  });

  test("the label's own casing is normalised, because the label is generated", () => {
    expect(relabelProvenanceNote("FROM SOS: SO-1"))
      .toBe("Transfer from Sales Order: SO-1");
  });

  test("it is the inverse-safe partner of rewriteFromSosNote", () => {
    // The doc-ref repair rewrites NUMBERS and never the label; this rewrites the
    // LABEL and never the numbers. Either order, same result — so the two
    // migrations never have to be sequenced against each other.
    const start = "From SOs: SO-2699-001, SO-2699-002";
    const map = new Map([["SO-2699-001", "2990-SO-2699-001"]]);
    const a = relabelProvenanceNote(rewriteFromSosNote(start, map));
    const b = rewriteFromSosNote(relabelProvenanceNote(start), map);
    expect(a).toBe(b);
    expect(a).toBe("Transfer from Sales Order: 2990-SO-2699-001, SO-2699-002");
  });

  test("the script twin relabels identically over the whole corpus", () => {
    for (const c of CORPUS) {
      expect(twin.relabelProvenanceNote(c.note)).toBe(relabelProvenanceNote(c.note));
    }
  });
});

describe("the lineage COLUMN header has a short form, and it is generated", () => {
  test("source side", () => {
    expect(transferFromColumnLabel("so")).toBe("Transfer From (SO)");
    expect(transferFromColumnLabel("do")).toBe("Transfer From (DO)");
    expect(transferFromColumnLabel("po")).toBe("Transfer From (PO)");
    expect(transferFromColumnLabel("grn")).toBe("Transfer From (GRN)");
  });

  test("destination side", () => {
    expect(transferToColumnLabel("do")).toBe("Transfer To (DO)");
  });

  test("the consignment pair keeps the words those screens already used", () => {
    expect(transferFromColumnLabel("pco")).toBe("Transfer From (Order)");
    expect(transferFromColumnLabel("pcr")).toBe("Transfer From (Receive)");
  });

  test("a column header is short; a button keeps the full document name", () => {
    expect(transferToLabel("grn")).toBe("Transfer to Goods Received");
    expect(transferFromLabel("so")).toBe("Transfer from Sales Order");
  });
});
