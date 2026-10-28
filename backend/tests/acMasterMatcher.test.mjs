// The master-data matcher, tested on the pairs it exists for.
//
// EVERY LOCATION CASE BELOW IS REAL. The ERP values are `scm.warehouses` codes
// for company 1 and the candidates are the account book's own 15 stock
// locations, both read from the committed harvest — so this file is the owner's
// worked table turned into a gate: eleven of the twelve codes the
// field-alignment report calls "unknown" are locations the book ALREADY HOLDS,
// and binding them is what stops `/ensure-masters` opening a duplicate.
//
// The three properties that matter, in the order they matter:
//   1. a confident pair really is explained by normalisation alone;
//   2. a genuinely new value is NOT matched to anything (`CHINA WAREHOUSE`);
//   3. a value that merely LOOKS similar is not confident (`AEON BIG PUCHONG`
//      shares `AEON` and `BIG` with a dozen book venues and is none of them).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildIndex,
  canonicalKey,
  editSimilarity,
  matchValue,
  normalise,
  selfTest,
} from "../scripts/lib/ac-master-matcher.mjs";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "data");
const book = JSON.parse(readFileSync(join(DATA, "autocount-so-writeback-mappings.json"), "utf8"));

const locations = buildIndex(
  Object.entries(book.autocount_locations_reference).map(([code, name]) => ({ value: code, aliases: [name] })),
  "location",
);
const venues = buildIndex(
  readFileSync(join(DATA, "autocount-venue-options.txt"), "utf8")
    .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")),
  "venue",
);
const agents = buildIndex(book.autocount_agents_reference_79, "agent");

describe("the matcher's own self-test", () => {
  it("passes, because a matcher that cannot match reports a clean run", () => {
    expect(selfTest()).toEqual([]);
  });
});

describe("stock locations the account book already holds", () => {
  /* The owner's table, verbatim. ERP code -> the book's SHORT code, and the
     long name that makes it recognisable. */
  const confident = [
    ["SUNWAY SHOWROOM", "SUNWAY", "DUNLOPILLO SUITE SUNWAY"],
    ["KELANA.J SHOWROOM", "KELANA.J", "AKEMI SLEEP STUDIO KELANA JAYA"],
    ["C&C DISPLAY", "C&C DISP", "CASH & CARRY - FAIR"],
    ["EM DISPLAY", "EM DISP", "SARAWAK BEDDING DISPLAY"],
    ["KL DISPLAY", "KL DISP", "BALAKONG BEDDING DISPLAY"],
    ["PG DISPLAY", "PG DISP", "PENANG BEDDING DISPLAY"],
    ["SBH DISPLAY", "SBH DISP", "SABAH BEDDING DISPLAY"],
    ["KL SERVICE", "SERV KL", "BALAKONG RETURNED TO SUPPLIER"],
    ["PG SERVICE", "SERV PG", "PENANG RETURNED TO SUPPLIER"],
    ["SBH WAREHOUSE", "SBH", "SABAH"],
    ["SRW WAREHOUSE", "SRW", "SARAWAK VENUE"],
  ];

  it.each(confident)("%s is the book's %s (%s)", (erp, code) => {
    const m = matchValue(erp, locations);
    expect(m.bucket).toBe("confident");
    expect(m.target).toBe(code);
    expect(m.reason).toMatch(/normalisation alone/);
  });

  it("proposes eleven of the twelve unknown warehouse codes, and refuses the twelfth", () => {
    /* The twelve `scm.warehouses` codes the field-alignment report reported as
       unknown to both LOCATION_MAP and the book, run 31815502403 (main,
       2026-08-14). Eleven already exist. */
    const unknown = [...confident.map(([erp]) => erp), "CHINA WAREHOUSE"];
    const matched = unknown.filter((v) => matchValue(v, locations).bucket === "confident");
    expect(matched).toHaveLength(11);
    expect(matchValue("CHINA WAREHOUSE", locations).bucket).toBe("none");
    expect(matchValue("CHINA WAREHOUSE", locations).target).toBeNull();
  });

  it("keeps a warehouse and its display bay apart — they are two masters", () => {
    /* The reason `DISPLAY` is ALIASED and not dropped. Dropping it would bind a
       showroom's display stock onto the main warehouse, which is the exact
       shape of damage this whole report exists to prevent. */
    expect(matchValue("KL DISPLAY", locations).target).toBe("KL DISP");
    expect(matchValue("KL WAREHOUSE", locations).target).toBe("KL");
    expect(canonicalKey("KL DISPLAY", "location")).not.toBe(canonicalKey("KL WAREHOUSE", "location"));
  });

  it("refuses a location whose distinctive word the book has never used", () => {
    for (const v of ["CHINA WAREHOUSE", "SLGR WAREHOUSE", "VIETNAM WAREHOUSE"]) {
      expect(matchValue(v, locations).bucket).toBe("none");
    }
  });
});

describe("venues", () => {
  it("folds the book's SOLO suffix", () => {
    const m = matchValue("SUTERA MALL", venues);
    expect(m.bucket).toBe("confident");
    expect(m.target).toBe("SUTERA MALL SOLO");
    expect(m.reason).toContain('dropped "SOLO"');
  });

  it("does NOT bind a venue that only shares common words", () => {
    /* `AEON BIG PUCHONG` was on a live company-1 order on 2026-08-14. The book
       holds AEON BIG KEPONG, AEON BIG SUBANG and AEON BIG WANGSA MAJU — and
       none of them is Puchong. This is the case that decides whether the
       matcher is safe to act on. */
    const m = matchValue("AEON BIG PUCHONG", venues);
    expect(m.bucket).toBe("none");
    expect(m.target).toBeNull();
  });

  it("does bind the same shape when the distinctive word DOES match", () => {
    const m = matchValue("AEON BIG KEPONG", venues);
    expect(m.bucket).toBe("confident");
    expect(m.target).toBe("AEON BIG KEPONG SOLO");
  });

  it("proposes the book's longer name only when it contains every ERP word", () => {
    const m = matchValue("KSL CITY MALL", venues);
    expect(m.bucket).toBe("likely");
    expect(m.target).toBe("KSL CITY MALL JOHOR SOLO");
  });

  it("sees the word the book writes as one and the ERP as two — but only as LIKELY", () => {
    /* `MID VALLEY` is 254 company-1 orders, the largest venue in the ERP, and
       the first run reported it as no-match because it shares no TOKEN with
       `MIDVALLEY EXHIBITION CENTRE`. Gluing is a real spelling variant, so it
       earns a proposal — and it stops there, because the book has TWO
       MIDVALLEY masters and only a person knows which roadshow this was. */
    const m = matchValue("MID VALLEY", venues);
    expect(m.bucket).toBe("likely");
    expect(m.target).toMatch(/^MIDVALLEY /);
    expect([m.target, ...m.alternatives.map((a) => a.value)].sort())
      .toEqual(['MIDVALLEY EXHIBITION CENTRE', 'MIDVALLEY SOUTHKEY JB']);
  });

  it("never lets a glued word alone make a pair confident", () => {
    expect(matchValue("MID VALLEY", venues).bucket).not.toBe("confident");
    expect(matchValue("Pei Fen", agents).bucket).not.toBe("confident");
  });

  it("leaves an acronym to a human rather than guessing", () => {
    /* `KLCC CONVENTION CENTRE` IS `KUALA LUMPUR CONVENTION CENTRE` and no
       normalisation can know that — a person put it in VENUE_MAP. Reporting it
       as no-match is the honest answer; inventing the expansion is not. */
    expect(matchValue("KLCC CONVENTION CENTRE", venues).bucket).toBe("none");
  });
});

describe("sales agents", () => {
  it("proposes a rep the book spells with a surname, as LIKELY not confident", () => {
    /* `Sheldon Tan` -> `SHELDON` is a JUDGEMENT — the book could hold another
       Sheldon — so it must never arrive as confident. */
    const m = matchValue("Sheldon Tan", agents);
    expect(m.bucket).toBe("likely");
    expect(m.target).toBe("SHELDON");
    expect(m.reason).toContain("SHELDON");
  });

  it("finds the book's own word order", () => {
    const m = matchValue("Kar Jiun", agents);
    expect(m.target).toBe("TAN KAR JIUN");
  });

  it("finds a name the book writes without the space", () => {
    expect(matchValue("Pei Fen", agents).target).toBe("PEIFEN");
    expect(matchValue("Hwa Sheng", agents).target).toBe("Hwasheng");
  });

  it("does not match a test account onto a real rep", () => {
    expect(matchValue("Test Sales Director", agents).bucket).toBe("none");
  });

  /* Pairs the matcher CANNOT derive, because the evidence is outside the text.
     "Lim" is the owner's own shorthand for Lim Wei Siang, whom the book calls
     WEI SIANG; on spelling alone LIM YAU WEI is the better candidate and the
     matcher says so. That is the whole reason this runs as a report a human
     rules on, and the reason a human ruling must never be regressed to fit the
     algorithm. Listed here, with the ruling, rather than quietly filtered. */
  const HUMAN_ONLY = new Map([
    ["Lim", "owner 2026-08-15: 'Lim 是 lim wei siang' — the book's WEI SIANG, not LIM YAU WEI"],
  ]);

  it("reproduces every differently-spelled pair a human already confirmed", () => {
    /* GROUND TRUTH. Each of these was bound by hand, so they are the only pairs
       known to be RIGHT. The matcher must reach the same answer — as a
       proposal, never as an automatic bind. */
    const confirmed = Object.entries(book.agent_map).filter(
      ([erp, ac]) => normalise(erp) !== normalise(ac) && !HUMAN_ONLY.has(erp),
    );
    expect(confirmed.length).toBeGreaterThan(5);
    for (const [erp, ac] of confirmed) {
      const m = matchValue(erp, agents);
      expect(`${erp} -> ${m.target}`).toBe(`${erp} -> ${ac}`);
    }
  });

  it("says so out loud when it disagrees with a human ruling", () => {
    /* If the matcher ever starts agreeing, this fails and HUMAN_ONLY should
       shrink — the exemption must not outlive the reason for it. */
    for (const [erp] of HUMAN_ONLY) {
      const m = matchValue(erp, agents);
      expect(m.target).not.toBe(book.agent_map[erp]);
    }
  });
});

describe("normalisation primitives", () => {
  it("is order-insensitive and punctuation-insensitive within a dimension", () => {
    expect(canonicalKey("C&C  disp", "location")).toBe(canonicalKey("C & C DISPLAY", "location"));
    expect(canonicalKey("SERV KL", "location")).toBe(canonicalKey("kl service", "location"));
  });

  it("never reduces a value to nothing, even when it is all noise", () => {
    expect(canonicalKey("WAREHOUSE", "location")).toBe("WAREHOUSE");
    expect(normalise("  KL  Warehouse ")).toBe("KL WAREHOUSE");
  });

  it("does not fold DISP into DISPLAY outside the location vocabulary", () => {
    /* Per-dimension on purpose: a venue or a brand called `DISP` is not an
       abbreviation, and one shared alias table would silently make it one. */
    expect(canonicalKey("KL DISP", "venue")).not.toBe(canonicalKey("KL DISPLAY", "venue"));
  });

  it("scores an exact string as identical and an unrelated one as not", () => {
    expect(editSimilarity("SUNWAY", "SUNWAY")).toBe(1);
    expect(editSimilarity("SUNWAY", "CHINA")).toBeLessThan(0.4);
  });
});
