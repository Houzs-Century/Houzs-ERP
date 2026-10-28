import { describe, expect, test } from "vitest";
import { noteMentionsToken } from "../src/scm/routes/document-flow";

// R7 — the relationship graph links a PO to an SO when the SO's doc number
// appears in the PO's free-text "From SOs: …" note. The old check used a plain
// substring test, which wrongly linked documents whose numbers are substrings of
// one another (SO-1 ⊂ SO-10). noteMentionsToken requires a WHOLE-token match.

describe("noteMentionsToken (R7 word-boundary)", () => {
  test("matches a token that stands alone in the note", () => {
    expect(noteMentionsToken("From SOs: SO-2606-033", "SO-2606-033")).toBe(true);
    expect(noteMentionsToken("From SOs: SO-2606-033, SO-2606-034", "SO-2606-034")).toBe(true);
    expect(noteMentionsToken("From SOs: SO-2606-033,SO-2606-034", "SO-2606-033")).toBe(true);
  });

  test("does NOT match when the token is a substring of a longer doc number", () => {
    // The classic bug: SO-1 must not match the SO-10 in the note.
    expect(noteMentionsToken("From SOs: SO-10", "SO-1")).toBe(false);
    expect(noteMentionsToken("From SOs: SO-2606-33", "SO-2606-3")).toBe(false);
    // Left flank too: a longer prefix must not satisfy a shorter token.
    expect(noteMentionsToken("From SOs: XSO-1", "SO-1")).toBe(false);
  });

  test("real mixed note: matches the exact SO, rejects its substring sibling", () => {
    const note = "From SOs: SO-2606-1, SO-2606-10";
    expect(noteMentionsToken(note, "SO-2606-1")).toBe(true);
    expect(noteMentionsToken(note, "SO-2606-10")).toBe(true);
    expect(noteMentionsToken(note, "SO-2606-2")).toBe(false);
  });

  test("empty / missing inputs are safe", () => {
    expect(noteMentionsToken("", "SO-1")).toBe(false);
    expect(noteMentionsToken("From SOs: SO-1", "")).toBe(false);
  });

  test("regex metacharacters in the token are treated literally", () => {
    // Defensive: a token is escaped, so a '.' can't act as 'any char'.
    expect(noteMentionsToken("From SOs: SOA1", "SO.1")).toBe(false);
  });
});
