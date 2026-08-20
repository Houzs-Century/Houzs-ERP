// ----------------------------------------------------------------------------
// THE PASSWORD RULE HAS TWO HOMES ON PURPOSE. NOTHING WAS COMPARING THEM.
//
// backend/src/services/passwordStrength.ts and frontend/src/lib/
// passwordStrength.ts are 163 lines each and, as of today, byte-identical. The
// pair MUST stay two: the strength meter has to score as the user types, before
// any round-trip, and the two packages share no build graph — both files say so
// at their own lines 9-12 ("KEEP IN SYNC ... a change to one MUST be copied to
// the other").
//
// "MUST be copied" is a habit, not a mechanism, and this repo has spent the week
// proving what habits are worth. The only existing test,
// backend/src/services/passwordStrength.test.ts, imports the BACKEND copy alone.
// check-shared-mirrors.mjs cannot see the pair either: it walks
// backend/src/scm/shared and backend/src/scm/lib, and this pair lives in
// backend/src/services + frontend/src/lib. So until this file, the frontend copy
// could have drifted to any rule at all and every gate in the repo would have
// stayed green — the meter would have said "strong" about a password the server
// then refused, or, worse, said "weak" about one it would have taken.
//
// THIS IS THE phone.ts DISTINCTION, which check-shared-mirrors' own header
// draws: phone.ts has a canonical test and has never drifted; the copies with no
// referee are the ones that do.
//
// WHAT THIS DOES. It IMPORTS BOTH IMPLEMENTATIONS — really both, not one copy
// and a file hash — and runs one shared corpus through them, asserting the
// SAME `{ok, error, score}` for every case. The corpus covers each rule the
// module has: under the 12-char floor, each of the four character classes
// missing, an email-local-part hit, and the 16/20/24 scoring ladder including
// its exact boundaries.
//
// It does NOT contain a common-password hit, and writing this test is how that
// was discovered: the corpus's own vacuity guard demanded every refusal message
// and one of the seven could not be produced by any input. The dictionary check
// is unreachable behind the four class gates — proved, and pinned, at the
// bottom of this file.
//
// A backend test can import a frontend module here because vitest resolves and
// transforms it directly, and backend/tsconfig.json only includes src/**, so
// this cross-tree import cannot affect `npm run typecheck`.
// ----------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { validatePasswordStrength as backend } from "../src/services/passwordStrength";
import { validatePasswordStrength as frontend } from "../../frontend/src/lib/passwordStrength";

const HERE = dirname(fileURLToPath(import.meta.url));

/** (password, email) — one corpus, run through both copies. */
const CORPUS: Array<[string, string | null | undefined, string]> = [
  // The length floor, and its exact boundary in both directions.
  ["Ab1!", null, "far too short"],
  ["Ab1!Ab1!Ab", null, "10 chars — one under, with every class present"],
  ["Ab1!Ab1!Ab1", null, "11 chars — the last failing length"],
  ["Ab1!Ab1!Ab1!", null, "12 chars — the first passing length"],
  // One character class missing at a time, at a passing length.
  ["abcdefgh1234!", null, "no uppercase"],
  ["ABCDEFGH1234!", null, "no lowercase"],
  ["Abcdefghijkl!", null, "no digit"],
  ["Abcdefgh12345", null, "no symbol"],
  // The common-password list, including the case-folded form.
  ["Password", null, "a common password, but too short to reach the list"],
  ["qwertyuiop", null, "a common password under the floor"],
  ["Qwertyuiop123!", null, "passes every class — is the base word caught?"],
  // The email local-part rule, including the >=3 char guard.
  ["Weisiang329-Strong!", "weisiang329@example.test", "local part inside the password"],
  ["Weisiang329-Strong!", "someone.else@example.test", "same password, unrelated email"],
  ["AbcXyz123456!", "ab@example.test", "2-char local part must NOT be matched"],
  ["AbcXyz123456!", null, "no email at all"],
  ["AbcXyz123456!", undefined, "undefined email"],
  ["AbcXyz123456!", "", "empty email"],
  ["AbcXyz123456!", "abcxyz@example.test", "local part matched case-insensitively"],
  // The scoring ladder and each of its boundaries.
  ["Abcdefgh123!", null, "12 chars -> score 1"],
  ["Abcdefghijk123!", null, "15 chars -> still score 1"],
  ["Abcdefghijkl123!", null, "16 chars -> score 2"],
  ["Abcdefghijklmnop123!", null, "20 chars -> score 3"],
  ["Abcdefghijklmnopqrst123!", null, "24 chars -> score 4"],
  ["Abcdefghijklmnopqrstuvwxyz123!", null, "30 chars -> still score 4"],
  // Non-ASCII, because the class regexes are the part most likely to be
  // rewritten differently on one side.
  ["Ünïcödé-Pässwörd1!", null, "accented letters"],
  ["密码密码密码密码1Aa!", null, "CJK plus every class"],
];

describe("passwordStrength — the backend and the frontend answer identically", () => {
  test("the corpus is not vacuous: it exercises refusal, acceptance and every score", () => {
    const results = CORPUS.map(([pw, email]) => backend(pw, email));
    expect(results.some((r) => !r.ok), "no refusal in the corpus").toBe(true);
    expect(results.some((r) => r.ok), "no acceptance in the corpus").toBe(true);
    /* Every REACHABLE refusal message must appear, or a rule could be deleted
       from one copy and this test would not notice.

       "This password is too common" is deliberately NOT on this list, and that
       is a finding, not an omission — see the dead-branch test below. This
       assertion is what surfaced it: the first draft listed all seven messages
       and the corpus could not produce the seventh no matter what was fed in. */
    const messages = new Set(results.filter((r) => !r.ok).map((r) => r.error));
    expect(messages).toEqual(
      new Set([
        "Password must be at least 12 characters",
        "Add at least one uppercase letter",
        "Add at least one lowercase letter",
        "Add at least one number",
        "Add at least one symbol like !@#$",
        "Password can't contain your email name",
      ]),
    );
    // …and every score on the ladder.
    expect(new Set(results.filter((r) => r.ok).map((r) => r.score))).toEqual(new Set([1, 2, 3, 4]));
  });

  for (const [pw, email, what] of CORPUS) {
    test(`same answer: ${what}`, () => {
      expect(frontend(pw, email)).toEqual(backend(pw, email));
    });
  }
});

describe("passwordStrength — the rules the two copies agree ON", () => {
  // Pinning the ANSWERS as well as the agreement. Two copies that drifted the
  // same way would still agree with each other, so agreement alone is not a
  // rule; these say what the rule IS.
  test("the 12-character floor is the first thing checked", () => {
    // Short AND missing every class: the length message is the one returned,
    // because the module returns the FIRST violation so the user fixes one
    // thing at a time.
    expect(backend("abc", null)).toEqual({
      ok: false,
      error: "Password must be at least 12 characters",
      score: 0,
    });
  });

  test("a refusal always scores 0", () => {
    for (const [pw, email] of CORPUS) {
      const r = backend(pw, email);
      if (!r.ok) expect(r.score, `${pw} refused with a non-zero score`).toBe(0);
    }
  });

  test("the score ladder is 12 / 16 / 20 / 24", () => {
    const at = (n: number) => backend("Ab1!" + "x".repeat(n - 4), null).score;
    expect([at(12), at(15), at(16), at(19), at(20), at(23), at(24), at(40)]).toEqual([
      1, 1, 2, 2, 3, 3, 4, 4,
    ]);
  });

  test("a two-character email local part is ignored, a three-character one is not", () => {
    expect(backend("AbXyz1234567!", "ab@example.test").ok).toBe(true);
    expect(backend("AbcXyz123456!", "abc@example.test")).toEqual({
      ok: false,
      error: "Password can't contain your email name",
      score: 0,
    });
  });
});

/* ── A DEAD BRANCH, RECORDED RATHER THAN HIDDEN ─────────────────────────────
   The ~290-entry common-password set CANNOT FIRE. The four character-class
   gates run first and all four must pass, so any password that reaches the
   dictionary lookup is >= 12 characters and contains an uppercase letter, a
   lowercase letter, a digit AND a symbol. `pw.toLowerCase()` is then compared
   against the list with an exact `has()`, so a hit requires a LIST ENTRY that
   is >= 12 chars and carries a digit and a symbol. Measured over the list as it
   stands: the only entry with a symbol is 8 characters long, and the only two
   entries of 12+ characters carry neither a digit nor a symbol. Zero entries
   can reach it.

   NOT FIXED HERE. Making it fire means changing the password policy — matching
   a stripped or leet-folded form, or moving the check above the class gates —
   and that is the owner's call, not a gate's. What this does is convert a
   silent dead branch into a dated, visible fact: the test recomputes the
   reachable set from the source every run, so if somebody adds a long
   symbol-bearing entry (or reorders the checks) it goes red and says so. */
describe("passwordStrength — the common-password list is unreachable, on purpose recorded", () => {
  const COMMON = (() => {
    const src = readFileSync(resolve(HERE, "../src/services/passwordStrength.ts"), "utf8");
    const start = src.indexOf("const COMMON_PASSWORDS");
    expect(start, "COMMON_PASSWORDS not found — was it renamed?").toBeGreaterThan(-1);
    const open = src.indexOf("[", start);
    const end = src.indexOf("]);", open);
    expect(end, "end of COMMON_PASSWORDS not found").toBeGreaterThan(open);
    return [...src.slice(open, end).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  })();

  test("the list was actually parsed", () => {
    expect(COMMON.length).toBeGreaterThan(100);
  });

  test("no entry can survive the four class gates and the 12-character floor", () => {
    const reachable = COMMON.filter(
      (w) => w.length >= 12 && /[a-z]/.test(w) && /[0-9]/.test(w) && /[^A-Za-z0-9]/.test(w),
    );
    expect(
      reachable,
      "an entry can now reach the dictionary check — the branch is live and the message set in the vacuity test above must gain 'This password is too common'",
    ).toEqual([]);
  });

  test("and the guard above is not vacuous: relaxing any one condition finds entries", () => {
    // If this ever returns nothing, the filter is broken rather than the
    // property being true — the same "verdict computed over an empty set"
    // failure the checkers in this repo keep producing.
    expect(COMMON.filter((w) => w.length >= 12).length).toBeGreaterThan(0);
    expect(COMMON.filter((w) => /[^A-Za-z0-9]/.test(w)).length).toBeGreaterThan(0);
    expect(COMMON.filter((w) => /[0-9]/.test(w)).length).toBeGreaterThan(0);
  });
});
