import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CORRECTION_FILES, docsInScope, loadCorrections, parseDocScope, readCorrectionsDoc } from "./sofa-corrections-source.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "..", "data");

test("reads `corrections` (2026-08) and `entries` (2026-09) alike", () => {
  assert.deepEqual(
    readCorrectionsDoc({ corrections: [{ docs: ["A"] }] }, "old.json").builds.map((b) => b.docs[0]),
    ["A"],
  );
  assert.deepEqual(
    readCorrectionsDoc({ entries: [{ docs: ["B"] }] }, "new.json").builds.map((b) => b.docs[0]),
    ["B"],
  );
});

test("a file carrying both names contributes both, in that order", () => {
  const got = readCorrectionsDoc({ corrections: [{ docs: ["A"] }], entries: [{ docs: ["B"] }] }, "f");
  assert.deepEqual(got.builds.map((b) => b.docs[0]), ["A", "B"]);
});

test("every build is tagged with the file it came from", () => {
  const got = readCorrectionsDoc({ entries: [{ docs: ["B"] }] }, "new.json");
  assert.equal(got.builds[0].source, "new.json");
});

test("_held is carried too, so a held build keeps being printed", () => {
  const got = readCorrectionsDoc({ _held: [{ docs: ["X"], why: "no photo" }] }, "f");
  assert.equal(got.held.length, 1);
  assert.equal(got.held[0].source, "f");
});

test("a file with neither key contributes nothing rather than throwing", () => {
  assert.deepEqual(readCorrectionsDoc({ _note: "x" }, "f"), { builds: [], held: [] });
  assert.deepEqual(readCorrectionsDoc(null, "f"), { builds: [], held: [] });
});

test("BOTH real files load, and the 2026-08 round is still there", () => {
  const both = loadCorrections(DATA);
  assert.equal(both.files.length, CORRECTION_FILES.length, both.files.join(" | "));
  const bySource = new Map();
  for (const b of both.builds) bySource.set(b.source, (bySource.get(b.source) ?? 0) + 1);
  for (const f of CORRECTION_FILES) assert.ok(bySource.get(f) > 0, `${f} contributed no builds`);
  /* The 2026-09 round is eighteen builds. If that number changes the file
     changed, and whoever changed it should say so here.
     15 -> 18 on 2026-09-05: three builds were added to the file without this
     number following them, so the assertion had been RED on main and the
     working-agreement workflow (which runs `node --test scripts/lib/*.test.mjs`
     and reports rather than blocks) had been carrying the failure. Corrected to
     what the file actually holds.
     18 -> 19 on 2026-09-08: HC-SO-013475, the sofa the shop floor reported as
     "Autocount drawing is 1+1+1, ERP 2+1". It went into THIS file rather than a
     2026-09-08 one because the FILE= substring filter would then select two
     rounds at once - the test below pins that.
     19 -> 35 on 2026-09-08: the SIXTEEN builds the owner read off his own slips
     in one sitting, ending 「所以全部答案我都给你了」. Fifteen documents; two of
     the sixteen are the two sofas of HC-SO-012827 and two more are the two
     sofas of HC-SO-004709. Same file, same reason as above.
     35 -> 34 the same day: HC-SO-011657 moved to `_held`. His STOOL ruling is
     not in doubt, but 9838-STOOL is not minted and WHICH model the stool belongs
     to is a judgement (the book names `TNS-9838 DB`, and `TNS-9838 SOFA` is a
     separate item) — so the entry states no model rather than a typed one, which
     is the defect docs/bugs/0693 records. `_held` is counted separately and
     printed on every run, so it cannot be mistaken for done.
     34 -> 36 on 2026-09-08: the two builds the previous round HELD, both now
     answered by the owner in his own words. HC-SO-011601 is the full build he
     confirmed with 「对啊」 after only the corner and the seat had been given;
     HC-SO-011657 is the daybed he settled with 「那就放8030 daybed把」. `_held`
     is empty as a result — an answer that has been given may not sit in the
     held list, because the operator's log prints held builds as outstanding
     work and would keep asking him a question he has already answered.
     36 -> 37, and held 0 -> 3, later the same day: he re-read the enlarged
     slips of HC-SO-011733, HC-SO-012025 and HC-SO-013384 and gave six answers.
     TWO of them CONFIRM entries this file already held and add no build; ONE is
     a new entry (HC-SO-012025's second sofa); and THREE are HELD for reasons
     that are NOT "we have no answer" - two documents cannot yet be addressed at
     the grain his answer needs, and one asks him a question only he can close.
     The held count is asserted beside the build count because a held build that
     quietly became a written one would otherwise move neither number. */
  assert.equal(bySource.get("sofa-compartment-corrections-2026-09.json"), 37);
  const heldBySource = new Map();
  for (const h of both.held) heldBySource.set(h.source, (heldBySource.get(h.source) ?? 0) + 1);
  assert.equal(heldBySource.get("sofa-compartment-corrections-2026-09.json"), 3);
});

/* ── AN ANSWERED BUILD MAY NOT SIT IN `_held` ───────────────────────────────
 * `_held` is printed on every run as work still owed, and makeSofaRulingLookup
 * EXCLUDES it, so a build parked there keeps reporting "cannot be compared"
 * however complete its answer is. That is the report handing the owner back
 * work he has already done (docs/bugs/0720). These two were held for a real
 * reason and the reason is now gone; pinning them out of the list is what stops
 * a later edit quietly parking an answered build again. */
test("the two builds the owner answered on 2026-09-08 are entries, not held", () => {
  const { builds, held } = loadCorrections(DATA, "2026-09");
  for (const doc of ["HC-SO-011601", "HC-SO-011657"]) {
    assert.ok(
      builds.some((b) => (b.docs || []).includes(doc)),
      `${doc}: the owner answered this one — it belongs in entries`,
    );
    assert.ok(
      !held.some((h) => (h.docs || []).includes(doc)),
      `${doc}: still in _held, so every run keeps printing an answered build as outstanding`,
    );
  }
});

/* ── THE TWO SOURCES MAY NOT BE CONFUSED FOR EACH OTHER ─────────────────────
 * A build read off the owner's DRAWING may legitimately contradict the account
 * book — that is the whole of 「一律跟账本。除了sofa compartment而已啊」. A build
 * copied FROM the book may not: its target IS the book. Both kinds are loaded
 * through this one loader and handed to the reconcile as `deps.sofaRuling`, so
 * the only thing keeping them apart is which file they live in, and the only
 * thing telling a later reader which is which is the `why`. Neither survives an
 * unlabelled entry, which is what this pins. */
test("every build says which SOURCE it came from — the book's words or a drawing", () => {
  const { builds } = loadCorrections(DATA);
  for (const b of builds) {
    const where = `${b.source} ${(b.docs || []).join("/")}`;
    const why = String(b.why ?? "");
    /* `Desc2` IS a way of naming the book, and the terse 2026-08 entries use it
       — HC-SO-010955's whole why is "Desc2 2ER+C+1ER", which names its source
       exactly and would have failed a pattern that only looked for the words
       "account book". Recognising it is not loosening the guard: the guard asks
       that a source be NAMED, and that one is. */
    const saysBook = /ACCOUNT BOOK|account book's own words|一律跟账本|Desc2/.test(why);
    const saysDrawing = /photo|drawing|slip|OWNER|OCR/i.test(why);
    assert.ok(
      saysBook || saysDrawing,
      `${where}: the why names neither the book nor a drawing, so nobody can tell whether this build ` +
        "is allowed to disagree with AutoCount",
    );
  }
});

test("a BOOK-ALIGNED build never claims to be the owner's reading", () => {
  const { builds } = loadCorrections(DATA, "book-aligned");
  assert.ok(builds.length > 0, "the book-aligned round loaded nothing");
  for (const b of builds) {
    assert.match(String(b.why), /ACCOUNT BOOK/, `${(b.docs || []).join("/")}: no book provenance`);
    /* "photo:" is how every owner-read build in the other files opens. A
       book-aligned entry that opened that way would be indistinguishable from
       one, and the owner's drawing is the ONE authority allowed to overrule
       AutoCount. */
    assert.doesNotMatch(
      String(b.why),
      /^photo:/,
      `${(b.docs || []).join("/")}: a book-aligned build must not present itself as a drawing reading`,
    );
    assert.equal(b.seat, undefined, `${(b.docs || []).join("/")}: book-aligned builds write no seat`);
  }
});

/**
 * THE FILES MAY NOT DISAGREE ABOUT ONE DOCUMENT.
 *
 * Every file is loaded on every run and they are applied in order, so a
 * document named by two builds with DIFFERENT pieces has no answer — it has
 * whichever answer ran last. Worse, `FILE=2026-08` plans that round alone,
 * which is how the losing answer gets written on its own.
 *
 * WHAT THIS DOES NOT COVER, said plainly because the first draft of this
 * comment claimed otherwise: it keys on the document NUMBER, so it sees a
 * document contradicted by another entry — and it does NOT see the two HALVES
 * of one sofa contradicting each other, because a sales order and the purchase
 * order raised from it are different numbers in different files. That pair is
 * only linked by being the same physical sofa, and nothing in the data says so.
 * The 1ELT test below pins that particular pair by hand for exactly this
 * reason; a new build corrected on only one of its two documents will still get
 * past this check.
 */
test("no two builds give the same document different pieces", () => {
  const seen = new Map();
  for (const b of loadCorrections(DATA).builds) {
    const pieces = (b.pieces || []).map((p) => String(p).trim().toUpperCase()).join("+");
    for (const doc of b.docs || []) {
      /* A document CAN legitimately appear twice — two different builds on one
         document, told apart by their ADDRESS. Key on the address, whichever
         kind it is: `desc2Match` addresses by text, `lineKeys` by the account
         book's own DtlKey. HC-SO-012827 carries two builds addressed only by
         line key (the book wrote one line's Desc2 as a substring of the
         other's), and keying on desc2Match alone would call those two a
         contradiction when they are two different sofas. */
      const key = `${doc} :: ${b.desc2Match ?? ""} :: ${(b.lineKeys || []).join(",")}`;
      const prev = seen.get(key);
      if (prev && prev.pieces !== pieces) {
        assert.fail(
          `${doc} is given two different builds at the same address:\n` +
          `  ${prev.source}: ${prev.pieces}\n  ${b.source}: ${pieces}\n` +
          `Correct both, or the round that runs last silently wins.`,
        );
      }
      seen.set(key, { pieces, source: b.source });
    }
  }
});

test("the 1ELT build says L(LHF) on BOTH its documents (owner 2026-09-05)", () => {
  const builds = loadCorrections(DATA).builds
    .filter((b) => (b.desc2Match || "").includes("1 ELT"));
  /* The sales order (2026-09) and the purchase order (2026-08) of one sofa. */
  assert.equal(builds.length, 2, builds.map((b) => `${b.source} ${b.docs.join("/")}`).join(" | "));
  for (const b of builds) {
    assert.deepEqual(
      b.pieces.map((p) => String(p).toUpperCase()),
      ["L(LHF)", "1NA", "2A(RHF)"],
      `${b.source} ${b.docs.join("/")} still carries the retired 1ABOX reading`,
    );
  }
});

test("every build in every file names its documents, its pieces and how to find itself", () => {
  for (const b of loadCorrections(DATA).builds) {
    const where = `${b.source} ${(b.docs || []).join("/")}`;
    assert.ok(Array.isArray(b.docs) && b.docs.length, `${where}: no docs`);
    assert.ok(Array.isArray(b.pieces) && b.pieces.length, `${where}: no pieces`);
    /* A `why` is required but not a length: the 2026-08 round has one that
       reads exactly "owner" (HC-SO-011733), and that is a complete answer. */
    assert.ok(typeof b.why === "string" && b.why.trim() !== "", `${where}: no why`);
    /* A document can hold several builds, so a build MUST say which lines are
       its own — one without an address claims the whole document.
       `desc2Match` does that by text, and `lineKeys` by the account book's own
       DtlKey. The key was added for HC-SO-012827, where the book wrote one
       line's Desc2 as a SUBSTRING of the other's: no needle can address the
       shorter line alone, so text cannot be the only accepted address. Either
       one satisfies this; neither present does not. */
    assert.ok(
      b.desc2Match || (Array.isArray(b.lineKeys) && b.lineKeys.length),
      `${where}: no desc2Match and no lineKeys — nothing says which lines of the document this build is`,
    );
  }
});

test("a build addressed by lineKeys carries keys that are non-empty strings", () => {
  for (const b of loadCorrections(DATA).builds) {
    if (!Array.isArray(b.lineKeys)) continue;
    const where = `${b.source} ${(b.docs || []).join("/")}`;
    assert.ok(b.lineKeys.length, `${where}: lineKeys is present but empty`);
    for (const k of b.lineKeys)
      assert.ok(typeof k === "string" && k.trim() !== "", `${where}: a line key must be a non-empty string, got ${JSON.stringify(k)}`);
    /* One build is one document's lines. A build addressed by key names ONE
       document, because a DtlKey belongs to exactly one. */
    assert.equal(b.docs.length, 1, `${where}: a build addressed by line key names exactly one document`);
  }
});

test("the `only` filter loads one round without replanning the other", () => {
  const one = loadCorrections(DATA, "2026-09");
  assert.equal(one.files.length, 1);
  assert.ok(one.builds.every((b) => b.source.includes("2026-09")));
});

/* ── A DOC SCOPE IS A LIST, BECAUSE A SOFA IS TWO DOCUMENTS ─────────────────
 * `docs/bugs/0725` says plainly that `FILE=` and `DOC=` are the only safe way
 * to run the applier: an unscoped run over every corrections file was measured
 * planning to re-add a piece the owner had removed a round later. But `DOC=`
 * took ONE document, and a sofa build lives on TWO — the sales order and the
 * purchase order raised from it. Correcting one without the other is the
 * half-write `docs/bugs/0719` refuses, and doing them in two dispatches leaves
 * production holding the half state in between.
 *
 * So the scope is a LIST. Comma or whitespace separated, blank means every
 * document, and an entry is matched EXACTLY — never as a prefix or a
 * substring, because `HC-SO-01020` must not silently select `HC-SO-010209`.
 */
test("a blank scope means every document", () => {
  assert.equal(parseDocScope(""), null);
  assert.equal(parseDocScope("   "), null);
  assert.equal(parseDocScope(undefined), null);
  assert.deepEqual(docsInScope(["HC-SO-1", "HC-PO-2"], null), ["HC-SO-1", "HC-PO-2"]);
});

test("a scope of one document behaves exactly as it did before", () => {
  const scope = parseDocScope("HC-SO-012729");
  assert.deepEqual(docsInScope(["HC-SO-012729", "HC-PO-009554"], scope), ["HC-SO-012729"]);
});

test("a scope names a sales order AND its purchase order, so both are one operation", () => {
  const scope = parseDocScope("HC-SO-012729,HC-PO-009554");
  assert.deepEqual(docsInScope(["HC-SO-012729", "HC-PO-009554"], scope), ["HC-SO-012729", "HC-PO-009554"]);
});

test("commas, spaces and newlines all separate, and blanks are dropped", () => {
  const scope = parseDocScope(" HC-SO-1 ,, HC-PO-2 \n HC-GR-3 ");
  assert.deepEqual([...scope].sort(), ["HC-GR-3", "HC-PO-2", "HC-SO-1"]);
});

test("a scope entry matches EXACTLY — never as a prefix", () => {
  const scope = parseDocScope("HC-SO-01020");
  assert.deepEqual(docsInScope(["HC-SO-010209"], scope), []);
});

test("a document not in the scope is dropped, and the scope is case-insensitive", () => {
  const scope = parseDocScope("hc-so-012729");
  assert.deepEqual(docsInScope(["HC-SO-012729", "HC-PO-009554"], scope), ["HC-SO-012729"]);
});

/* ── THE SIX 2026-09-08 BUILDS NAME BOTH HALVES OF THEIR SOFA ───────────────
 * These six exist BECAUSE the purchase order and the sales order describe
 * different builds — `HC-PO-009554` held `9058-1S` while `HC-SO-012729` held a
 * three-piece L. Writing only the sales side leaves the purchase side holding
 * the lead piece alone, which is the half-write `docs/bugs/0719` refuses and
 * which `HC-SO-013320` already cost this lane once (its entry had to be
 * amended on 2026-09-07 to add `HC-PO-010008`).
 *
 * The general check above ("no two builds give the same document different
 * pieces") CANNOT see this: it keys on the document number, and a sales order
 * and its purchase order are different numbers. Nothing in the data says they
 * are the same sofa. So the pair is pinned BY HAND, exactly as the 1ELT test
 * above pins its own pair, and for the same reason.
 *
 * The purchase counterpart of each was read out of the committed book snapshot
 * `data/ac-reconcile-truth.json.gz` — a PO line whose `fromSoDtlKey` names the
 * sales line's DtlKey — not guessed from the numbering.
 */
test("each of the owner's six 2026-09-08 builds names its sales order AND its purchase order", () => {
  const PAIRS = [
    ["HC-SO-010287", "HC-PO-010085"],
    ["HC-SO-012128", "HC-PO-009467"],
    ["HC-SO-011207", "HC-PO-009830"],
    ["HC-SO-010209", "HC-PO-009587"],
    ["HC-SO-012729", "HC-PO-009554"],
  ];
  const { builds } = loadCorrections(DATA);
  for (const [so, po] of PAIRS) {
    const hit = builds.filter((b) => (b.docs || []).includes(so));
    assert.ok(hit.length, `${so}: the owner ruled this build on 2026-09-08 and no entry carries it`);
    for (const b of hit) {
      assert.ok(
        (b.docs || []).includes(po),
        `${b.source} ${so}: its purchase order ${po} is not on the entry, so an apply corrects the sales ` +
          `side alone and leaves ${po} holding the lead piece by itself (docs/bugs/0719)`,
      );
    }
  }
});
