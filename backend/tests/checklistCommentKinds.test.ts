/* Every `kind` the code WRITES into project_checklist_comments is a kind both
   type declarations ADMIT — and the two declarations agree with each other.

   WHY THIS EXISTS. On 2026-08-14 `main` could not deploy. PR #2184 added two
   history kinds, `upload` and `remove`, and wrote them from routes/projects.ts as
   raw SQL:

       INSERT INTO project_checklist_comments (item_id, kind, body, user_id)
       VALUES (?, 'upload', ?, ?)

   That statement never passes through `addChecklistComment`, the ONE typed entry
   point for this column, so the backend compiled while emitting two values no
   type in the repo admitted. The frontend then filtered them out of the Remarks
   column — correctly, and at the owner's instruction — and `tsc -b` reported the
   filters as comparisons that can never be true:

       error TS2367: types '"note" | "approve" | "reject" | "amend"' and
       '"upload"' have no overlap

   Eight of those. `frontend` is a REQUIRED status check, so `main` went red and
   the Deploy run reported `frontend: failure` with `backend: skipped` — which
   CLAUDE.md says to treat as a failed deploy. Nothing reached production between
   #2184 merging and this fix.

   The class, and why prose would not have stopped it: the column's type is
   declared in two files and written from a third that consults neither. Nothing
   connected them, so the drift was invisible until an UNRELATED expression
   happened to compare against a missing value. Without that filter the two kinds
   would still be undeclared today and no gate would have said a word.

   CLAUDE.md: "A BUG-HISTORY entry with no test attached is unfixed."

   `.test.ts` and not `.test.mjs` DELIBERATELY: classify-tests.mjs walks
   `.test.ts` only until #2180 lands, so a `.mjs` here would be collected by
   neither vitest project and would silently never run. */
import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/* ANCHORED on the declaring construct, never on "the first `kind:` in the file".
   Projects.tsx has an unrelated `kind: "income" | "cost"` 56 lines earlier, and
   the first draft of this guard read THAT and refused with "only 2 kinds parsed".
   It refused rather than passing, which is the property that matters — but an
   anchor is what makes it right. */
const DECLARATIONS: Array<{ rel: string; anchor: string }> = [
  { rel: "backend/src/services/projects.ts", anchor: "export async function addChecklistComment(" },
  { rel: "frontend/src/pages/Projects.tsx", anchor: "interface ChecklistComment {" },
];

/* Files that may INSERT into the table. A writer this list does not know about is
   the exact hole #2184 fell through, so adding one here is part of adding one. */
const WRITERS = ["backend/src/routes/projects.ts", "backend/src/services/projects.ts"];

/** The `kind` union declared at `anchor`, as a Set. */
function declaredKinds(rel: string, anchor: string): Set<string> {
  const src = read(rel);
  const at = src.indexOf(anchor);
  assert.ok(at >= 0, `${rel}: anchor \`${anchor}\` is gone. If the declaration moved, this guard has to move with it — it is not passing.`);
  const m = /\bkind\??:\s*((?:"[a-z_]+"\s*\|\s*)+"[a-z_]+")/.exec(src.slice(at));
  assert.ok(m, `${rel}: no \`kind: "a" | "b"\` union after \`${anchor}\` — reading the wrong shape, not passing.`);
  return new Set((m[1].match(/"[a-z_]+"/g) ?? []).map((q) => q.slice(1, -1)));
}

/** Every kind literal written as raw SQL into project_checklist_comments. */
function writtenKinds(): Set<string> {
  const found = new Set<string>();
  for (const rel of WRITERS) {
    for (const stmt of read(rel).matchAll(
      /INSERT\s+INTO\s+project_checklist_comments[\s\S]{0,300}?VALUES\s*\(([^)]*)\)/gi,
    )) {
      for (const lit of stmt[1].matchAll(/'([a-z_]+)'/g)) found.add(lit[1]);
    }
  }
  return found;
}

test("the guard can see both declarations — it cannot pass by reading nothing", () => {
  for (const { rel, anchor } of DECLARATIONS) {
    const kinds = declaredKinds(rel, anchor);
    assert.ok(kinds.size >= 5, `${rel}: only ${kinds.size} kinds parsed — the extraction is broken, not the code.`);
  }
  assert.ok(
    /INSERT\s+INTO\s+project_checklist_comments/i.test(read(WRITERS[0])),
    `${WRITERS[0]} no longer inserts into project_checklist_comments. If the writer moved, this guard has to move with it.`,
  );
});

test("every kind written as raw SQL is admitted by BOTH type declarations", () => {
  const written = writtenKinds();
  assert.ok(written.size > 0, "no raw-SQL kind literal found at all — the pattern stopped matching, which is not a pass.");

  for (const { rel, anchor } of DECLARATIONS) {
    const declared = declaredKinds(rel, anchor);
    const missing = [...written].filter((k) => !declared.has(k)).sort();
    assert.deepEqual(
      missing,
      [],
      `${rel} does not admit ${missing.map((k) => `"${k}"`).join(", ")}, which the code WRITES. ` +
        "A raw INSERT bypasses the typed helper, so this drifts silently until an unrelated " +
        "comparison against the missing value fails the build — which cost a deploy outage on 2026-08-14.",
    );
  }
});

test("the two declarations are the same set", () => {
  const [be, fe] = DECLARATIONS.map((d) => [...declaredKinds(d.rel, d.anchor)].sort());
  assert.deepEqual(
    be,
    fe,
    "the two copies of this union disagree. They describe ONE database column; " +
      "whichever is narrower will reject a value the other writes.",
  );
});
