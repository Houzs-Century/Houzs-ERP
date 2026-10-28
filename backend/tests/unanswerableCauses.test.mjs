/* The SPECIFICATION for the `CANNOT BE COMPARED` column's cause registry.
 *
 * ONE PROPERTY carries this file: A CAUSE IS NEVER A LABEL WITHOUT AN OWNER,
 * AND NEVER AN OWNER WITHOUT A LABEL. A cause with a sentence and no owner
 * prints as work nobody owns; a cause with an owner and no sentence prints its
 * own engineering key at a man who has said, in his own words, that he is not
 * an engineer. Both are how a column starts carrying several populations again.
 *
 * The second property is that the SOFA arm is IMPORTED, never copied. If a
 * later lane adds a bucket to lib/sofa-unread-split.mjs, it must appear here
 * with an owner or this file fails — which is what makes "one statement of the
 * rule" a test rather than an intention.
 */
import { describe, expect, it } from "vitest";

import { MECHANICAL, UNREAD_LABEL } from "../scripts/lib/sofa-unread-split.mjs";
import {
  ABSENT_SOURCE_CAUSES,
  CAUSE_LABEL,
  CAUSE_OWNER,
  CHAIN_CAUSES,
  CHAIN_LINE_NOT_STAMPED,
  CHAIN_PARENT_UNSTAMPED,
  CHAIN_UNSPECIFIED,
  MECHANICAL_CAUSES,
  OWNER_CAUSES,
  UNNAMED,
} from "../scripts/lib/unanswerable-causes.mjs";

describe("every cause has both a sentence and an owner", () => {
  it("the two maps have identical key sets", () => {
    expect(Object.keys(CAUSE_LABEL).sort()).toEqual(Object.keys(CAUSE_OWNER).sort());
  });

  it("no sentence is the bare key — the owner reads these", () => {
    for (const [k, label] of Object.entries(CAUSE_LABEL)) {
      expect(label).toBeTruthy();
      expect(label).not.toBe(k);
      /* long enough to be a sentence rather than a word */
      expect(label.length).toBeGreaterThan(20);
    }
  });

  it("every owner tag is one of the three answers, plus the honest UNNAMED", () => {
    const allowed = new Set(["MECHANICAL", "MECHANICAL, THEN YOURS", "YOURS", "ABSENT SOURCE", "UNNAMED"]);
    for (const v of Object.values(CAUSE_OWNER)) expect(allowed.has(v)).toBe(true);
  });
});

describe("the sofa arm is imported, not restated", () => {
  it("every bucket lib/sofa-unread-split.mjs declares is registered here", () => {
    for (const k of Object.keys(UNREAD_LABEL)) {
      expect(CAUSE_LABEL[k]).toBe(UNREAD_LABEL[k]);
      expect(CAUSE_OWNER[k]).toBeTruthy();
    }
  });

  it("the sofa MECHANICAL bucket is in the mechanical set, and the owner arms are not", () => {
    expect(MECHANICAL_CAUSES.has(MECHANICAL)).toBe(true);
    expect(MECHANICAL_CAUSES.has("keyedBookUnreadable")).toBe(false);
    expect(OWNER_CAUSES.has("keyedBookUnreadable")).toBe(true);
  });
});

describe("the transfer-chain arm is TWO populations, and they are owed opposite things", () => {
  it("a line key we never stamped is MECHANICAL — a backfill, no ruling", () => {
    expect(CAUSE_OWNER[CHAIN_LINE_NOT_STAMPED]).toBe("MECHANICAL");
    expect(MECHANICAL_CAUSES.has(CHAIN_LINE_NOT_STAMPED)).toBe(true);
  });

  it("an ERP-native parent is an ABSENT SOURCE — nobody can answer it, the owner included", () => {
    expect(CAUSE_OWNER[CHAIN_PARENT_UNSTAMPED]).toBe("ABSENT SOURCE");
    expect(ABSENT_SOURCE_CAUSES.has(CHAIN_PARENT_UNSTAMPED)).toBe(true);
    /* THE POINT of splitting it: an absent source must never be countable as a
       backlog somebody owes. */
    expect(MECHANICAL_CAUSES.has(CHAIN_PARENT_UNSTAMPED)).toBe(false);
    expect(OWNER_CAUSES.has(CHAIN_PARENT_UNSTAMPED)).toBe(false);
  });

  it("both, and the unspecified fallback, are recognised as chain causes", () => {
    expect(CHAIN_CAUSES.has(CHAIN_LINE_NOT_STAMPED)).toBe(true);
    expect(CHAIN_CAUSES.has(CHAIN_PARENT_UNSTAMPED)).toBe(true);
    expect(CHAIN_CAUSES.has(CHAIN_UNSPECIFIED)).toBe(true);
    /* a sofa cause is NOT a chain cause: the fallback in lib/so-tally-verdict.mjs
       turns on this exact set, and widening it would stop naming the chain
       refusal on a document that is also an unreadable sofa. */
    expect(CHAIN_CAUSES.has(MECHANICAL)).toBe(false);
  });

  it("the two UNNAMED buckets claim neither an owner's drawing nor a backfill", () => {
    for (const k of [CHAIN_UNSPECIFIED, UNNAMED]) {
      expect(CAUSE_OWNER[k]).toBe("UNNAMED");
      expect(MECHANICAL_CAUSES.has(k)).toBe(false);
      expect(ABSENT_SOURCE_CAUSES.has(k)).toBe(false);
      expect(OWNER_CAUSES.has(k)).toBe(false);
    }
  });
});
