/* The owner's compartment rulings as DATA — and the two properties that decide
 * whether reading them is right or dangerous.
 *
 * 1. A RULING EXCUSES THE AXIS HE RULED, NOT THE DOCUMENT. `HC-SO-013475` being
 *    settled on its compartments must not stop the checker reporting a wrong
 *    PRICE or a missing LINE on the same order. `tests/variantReport.test.mjs`
 *    proves that inside the variant axes (a colour difference on a ruled line
 *    still locks); this file proves it at the layer where `clean` — and
 *    therefore the LOCK — is actually decided, with a money difference, which is
 *    the axis that has a customer behind it.
 *
 * 2. A RULING MUST NOT GO STALE SILENTLY. The exemption is not "ignore this
 *    document", it is "this document must equal THIS". The assertion of the ERP
 *    against his stated pieces lives in lib/variant-reconcile.mjs and is proved
 *    in tests/variantReport.test.mjs; what is proved HERE is the other half —
 *    that a ruling he gives cannot reach the prose document and stop there.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildRulingIndex, loadSofaRulings, resolveRuling } from "../scripts/lib/sofa-ruling-index.mjs";
import { buildVerdictRows, makeVerdictRecorder } from "../scripts/lib/so-verdict-derive.mjs";
import { bucketOf, isTallied, tallyVerdict } from "../scripts/lib/so-tally-verdict.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(here, "..", "scripts");
const RULINGS_DOC = path.join(here, "..", "..", "docs", "sofa-compartment-owner-rulings-2026-09-08.md");

const build = (over = {}) => ({
  docs: ["HC-SO-013475"],
  model: "8030",
  pieces: ["1A(LHF)", "1NA", "1A(RHF)"],
  desc2Match: '3S(28")',
  why: "the drawing shows three seats",
  source: "sofa-compartment-corrections-2026-09.json",
  ...over,
});
const line = (desc2) => ({ description2: desc2 });

describe("buildRulingIndex / resolveRuling", () => {
  it("finds the ruling for a document, by the build its desc2Match names", () => {
    const idx = buildRulingIndex([build()]);
    const got = resolveRuling(idx, { erpNo: "HC-SO-013475", erpLines: [line('HOK-8030 SOFA 3S(28") / COL: X')] });
    expect(got.ruling.pieces).toEqual(["1A(LHF)", "1NA", "1A(RHF)"]);
    expect(got.ruling.source).toBe("sofa-compartment-corrections-2026-09.json");
  });

  it("uses the SAME normalising matcher the applier uses — a written \\n is not a real newline", () => {
    /* The failure this matcher exists for: the data file's line breaks are the
       two CHARACTERS backslash-n and production's are real newlines. A plain
       `includes` silently dropped 7 owner-approved builds on 2026-09-02, and a
       second, stricter matcher here would drop them again — from the CHECKER
       this time, which would report his settled sofas as differences. */
    const idx = buildRulingIndex([build({ desc2Match: "8030 \\nbottom wrap" })]);
    const got = resolveRuling(idx, { erpNo: "HC-SO-013475", erpLines: [line("HOK-8030 \nbottom wrap nylon")] });
    expect(got.ruling).not.toBeNull();
  });

  it("a ruling whose desc2Match reaches no line does not reach the build", () => {
    const idx = buildRulingIndex([build()]);
    expect(resolveRuling(idx, { erpNo: "HC-SO-013475", erpLines: [line("SOMETHING ELSE ENTIRELY")] }).ruling).toBeNull();
  });

  it("TWO rulings reaching one build are REFUSED, never chosen between", () => {
    const idx = buildRulingIndex([build(), build({ desc2Match: "SOFA", pieces: ["2A(LHF)", "1A(RHF)"] })]);
    const got = resolveRuling(idx, { erpNo: "HC-SO-013475", erpLines: [line('HOK-8030 SOFA 3S(28")')] });
    expect(got.ruling).toBeNull();
    expect(got.ambiguous).toHaveLength(2);
  });

  it("a row stating no pieces is not a ruling — an empty one would assert the ERP holds nothing", () => {
    expect(buildRulingIndex([build({ pieces: [] })]).size).toBe(0);
    expect(buildRulingIndex([build({ pieces: undefined })]).size).toBe(0);
  });

  it("a ruling with no desc2Match covers every build on the document", () => {
    const idx = buildRulingIndex([build({ desc2Match: null })]);
    expect(resolveRuling(idx, { erpNo: "HC-SO-013475", erpLines: [line("anything")] }).ruling).not.toBeNull();
  });

  it("the document number is matched case- and whitespace-insensitively", () => {
    const idx = buildRulingIndex([build({ docs: [" hc-so-013475 "] })]);
    expect(resolveRuling(idx, { erpNo: "HC-SO-013475", erpLines: [line('3S(28")')] }).ruling).not.toBeNull();
  });

  it("the REAL committed rulings load, and HC-SO-013475 is among them", () => {
    /* If this goes red the checker is reading nothing, and every sofa the owner
       has settled goes straight back to DIFFER and re-locks. */
    const got = loadSofaRulings(SCRIPTS);
    expect(got.builds).toBeGreaterThan(0);
    expect(got.index.has("HC-SO-013475")).toBe(true);
    expect(got.index.get("HC-SO-013475")[0].pieces).toEqual(["1A(LHF)", "1NA", "1A(RHF)"]);
  });
});

describe("a ruling excuses the AXIS he ruled, not the DOCUMENT", () => {
  /* Driven through the real recorder and the real verdict builder, because
     `clean` is the column the migrated-sales-order guard reads and a property
     proved anywhere else is a property about something else. */
  const verdictFor = (add) => {
    const V = makeVerdictRecorder();
    V.seen("SO", "SO-013475", "HC-SO-013475");
    V.note("SO", "SO-013475", "HC-SO-013475", "ruled", "sofa compartments", "the owner ruled 1A(LHF)+1NA+1A(RHF)", true);
    add(V);
    return buildVerdictRows({ recorder: V, type: "SO", companyId: 1, measuredAt: "t", runId: "r" })[0];
  };

  it("a ruled order with NOTHING else wrong is clean, so the lock opens it", () => {
    const row = verdictFor(() => {});
    expect(row.clean).toBe(true);
    expect(row.axes).toEqual([]);
    expect(bucketOf(row)).toBe("identical");
  });

  it("the SAME ruled order with a MONEY difference is NOT clean — the exemption does not spread", () => {
    const row = verdictFor((V) =>
      V.record("SO", "SO-013475", "HC-SO-013475", "document total", "book RM 4,200.00 vs ERP RM 3,900.00", true),
    );
    expect(row.clean).toBe(false);
    expect(row.axes).toEqual(["document total"]);
    expect(bucketOf(row)).toBe("work");
  });

  it("and with a missing LINE it is not clean either", () => {
    const row = verdictFor((V) =>
      V.record("SO", "SO-013475", "HC-SO-013475", "a book line we do not have", "DtlKey 924984 has no ERP line", true),
    );
    expect(row.clean).toBe(false);
    expect(bucketOf(row)).toBe("work");
  });

  it("a build that no longer matches his ruling LOCKS on its own axis and is WORK", () => {
    const row = verdictFor((V) =>
      V.record("SO", "SO-013475", "HC-SO-013475", "sofa build differs from the owner ruling", "ERP holds 2 pieces", true),
    );
    expect(row.clean).toBe(false);
    expect(row.axes).toEqual(["sofa build differs from the owner ruling"]);
    /* NOT `unanswerable`: the comparison ran and gave an answer he has to see. */
    expect(bucketOf(row)).toBe("work");
  });

  it("the owner's report NAMES the ruling class rather than silently subtracting it", () => {
    const v = tallyVerdict({ rows: [verdictFor(() => {})], population: {}, presence: {} });
    expect(isTallied(v)).toBe(true);
    const declared = v.declared.find((d) => d.klass === "ruled");
    expect(declared).toBeTruthy();
    expect(declared.axes).toContain("sofa compartments");
  });
});

describe("the prose document and the data the checker reads may not drift", () => {
  /* `docs/sofa-compartment-owner-rulings-2026-09-08.md` is where his WORDS are
     quoted and it is written for people; the machine authority is
     `backend/scripts/data/sofa-compartment-corrections-*.json`, which is also
     what apply-sofa-compartment-corrections.mjs writes from. A ruling that
     reaches only the prose is a ruling the reconcile cannot see, so the order it
     settles stays locked — which is the whole bug.
     WHAT THIS DOES NOT COVER, said plainly: he writes in the slip's shorthand
     (`1AL + 2AR + 1BR`), not in ERP piece codes, and translating that is a
     judgement about a drawing, not a string operation. So the PIECES are not
     machine-compared; only that every document he has ruled on is present in the
     data. The piece list is checked the only way it can be — against the ERP, at
     run time, by lib/variant-reconcile.mjs. */
  it("every document named in the rulings doc has a ruling in the corrections data", () => {
    const md = fs.readFileSync(RULINGS_DOC, "utf8");
    const table = md
      .split("\n")
      .filter((l) => l.trim().startsWith("|") && /`HC-(SO|PO)-\d+`/.test(l));
    expect(table.length, "the rulings table has no document rows — has the doc been restructured?").toBeGreaterThan(0);

    const { index } = loadSofaRulings(SCRIPTS);
    const missing = [];
    for (const row of table) {
      for (const [, doc] of row.matchAll(/`(HC-(?:SO|PO)-\d+)`/g)) {
        if (!index.has(doc.toUpperCase())) missing.push(doc);
      }
    }
    expect(
      missing,
      `these documents are ruled on in ${path.basename(RULINGS_DOC)} but carry no entry in ` +
        "backend/scripts/data/sofa-compartment-corrections-*.json, so the reconcile cannot see the ruling and " +
        "will keep reporting them as differences and LOCKING them: " + missing.join(", "),
    ).toEqual([]);
  });
});
