/* ONE DATE FORMAT, ONE PLACE THAT WRITES IT — the gate, and the proof it bites.

   THE RULE (owner, 2026-08-18: "全套系统的 date format 没有统一"). Every date a
   user reads is DD/MM/YYYY; every timestamp is DD/MM/YYYY HH:mm; both come from
   `fmtDate` / `fmtDateTime` in `vendor/shared/format.ts` and nowhere else.

   WHY A GATE. The rule was already written down twice — in `lib/utils.ts` ("no
   'Jun'/'Jul' month names anywhere on the desktop app") and in
   `shared/format.ts` ("System-wide canonical display format") — and was then
   re-derived by hand about thirty more times in four other spellings. The owner
   was shown a screen with two of them on it. A rule that lives in prose gets
   reproduced; writing it down a third time would have been the move that
   already failed twice.

   WHAT THIS FILE PINS, and why each one is here rather than trusted:

     1. THE GATE PASSES on the tree as committed. Otherwise the CI step is
        failing for a reason nobody has looked at.
     2. THE GATE FAILS on a planted format. This is the whole test. A gate
        nobody has watched fail is a gate that may be scanning nothing —
        `check-trgm-coverage.mjs` sat in this repo with BOTH exit paths at exit
        0 and in no workflow at all, and read as a pass for weeks. The plant
        goes in a temp directory OUTSIDE the source tree
        (DATE_FORMAT_EXTRA_ROOT), so proving the gate never requires writing a
        second date format into frontend/src.
     3. IT DOES NOT FIRE ON MONEY. `fmtCenti` is `toLocaleString('en-MY', …)`
        and this repo has ~40 `count.toLocaleString()` calls. A gate that cries
        wolf is a gate somebody switches off — which is how the previous
        generation of checks here died.
     4. THE ALLOWLIST CARRIES REASONS. An allowlist of bare paths is a mute
        button. Each entry must say something a person could argue with.
     5. THE STEP IS STILL WIRED. A check that cannot run reports nothing and
        reads as a pass. Named in ci.yml and in package.json, asserted. */
import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "backend", "scripts", "check-date-formatting.mjs");
const ALLOWLIST = path.join(ROOT, "backend", "scripts", "data", "date-format-allowlist.json");

function run(extraRoot?: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, "--strict"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: extraRoot ? { ...process.env, DATE_FORMAT_EXTRA_ROOT: extraRoot } : process.env,
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

/* Each of these SPAWNS the checker, which walks ~1,400 source files. Vitest
   defaults to 5s per test and the walk alone can exceed that on a loaded
   machine — a timeout here would read as the gate being broken. */
const SPAWN_TIMEOUT_MS = 120_000;

describe("the one-date-format gate", () => {
  test("passes on the tree as committed", { timeout: SPAWN_TIMEOUT_MS }, () => {
    const { code, out } = run();
    expect(out).toContain("source files scanned");
    expect(code, out.slice(-3000)).toBe(0);
  });

  /* THE NON-VACUITY PROOF. Exit 2 is the script's own self-test failing and
     must never be confused with a caught violation — a checker that cannot run
     is not a checker that found nothing. The planted line is the literal string
     from the owner's screenshot: `toLocaleDateString('en-US', { month: 'short' })`
     renders "Aug 16, 2026". */
  test("FAILS on a planted second date format, and passes again once it is gone", { timeout: SPAWN_TIMEOUT_MS }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "date-format-gate-"));
    try {
      const planted = path.join(dir, "PlantedHeader.tsx");
      fs.writeFileSync(
        planted,
        "export const when = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });\n",
      );
      const bad = run(dir);
      expect(bad.code, `expected a FAILURE, got:\n${bad.out.slice(-3000)}`).toBe(1);
      expect(bad.out).toContain("NOT REVIEWED");
      expect(bad.out).toContain("toLocaleDateString");

      fs.rmSync(planted);
      const good = run(dir);
      expect(good.code, good.out.slice(-3000)).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("FAILS on a planted native date input — the OS-locale bug itself", { timeout: SPAWN_TIMEOUT_MS }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "date-format-gate-input-"));
    try {
      fs.writeFileSync(
        path.join(dir, "PlantedField.tsx"),
        'export const F = () => <input type="date" value={iso} onChange={(e) => set(e.target.value)} />;\n',
      );
      const { code, out } = run(dir);
      expect(code, `expected a FAILURE, got:\n${out.slice(-3000)}`).toBe(1);
      expect(out).toContain("raw-date-input");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /* THE SECOND OS-LOCALE INPUT TYPE. `<input type="datetime-local">` renders
     its date half in the OS locale by the same mechanism as type="date", and
     the raw-date-input rule does NOT catch it — `["']date["']` needs the quote
     straight after "date". So the 2026-06-18 fix and the #2390 sweep that
     finished it both passed over this type completely, and the delivery-
     planning drawer kept native Arrival and Departure fields directly above a
     DateField Shipout Date: one drawer, two spellings. Planting it here is
     what stops that being rediscovered a third time. */
  test("FAILS on a planted native datetime-local input — the same bug, the type the date rule cannot see", { timeout: SPAWN_TIMEOUT_MS }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "date-format-gate-dtl-"));
    try {
      const planted = path.join(dir, "PlantedArrival.tsx");
      fs.writeFileSync(
        planted,
        'export const F = () => <input type="datetime-local" value={form.arrivalAt} onChange={(e) => set(e.target.value)} />;\n',
      );
      const bad = run(dir);
      expect(bad.code, `expected a FAILURE, got:\n${bad.out.slice(-3000)}`).toBe(1);
      expect(bad.out).toContain("NOT REVIEWED");
      expect(bad.out).toContain("raw-datetime-input");

      fs.rmSync(planted);
      const good = run(dir);
      expect(good.code, good.out.slice(-3000)).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /* The wrapper-prop spelling. Five components in this tree take a `type` prop
     and route it onward, so the same bug can arrive on a line with no `<input`
     token on it at all — which is exactly how the 26 reviewed date entries are
     written. */
  test("FAILS on a datetime-local passed as a wrapper prop, not just on a literal <input>", { timeout: SPAWN_TIMEOUT_MS }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "date-format-gate-dtl-prop-"));
    try {
      fs.writeFileSync(
        path.join(dir, "PlantedWrapper.tsx"),
        'export const F = () => <Field label="Arrival" type="datetime-local" value={v} onChange={set} />;\n',
      );
      const { code, out } = run(dir);
      expect(code, `expected a FAILURE, got:\n${out.slice(-3000)}`).toBe(1);
      expect(out).toContain("raw-datetime-input");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /* THE DYNAMIC SPELLING, and the reason this case exists at all. A native date
     input survived BOTH the 2026-06-18 DateField build and the #2390 sweep that
     converted all 175 of them and shipped this gate — because it was written
     `type={f.type === "date" ? "date" : "text"}`, an EXPRESSION, and every rule
     here keyed on a quote straight after `type=`. Three passes over the same
     tree, and the one input none of them could see. */
  test("FAILS on a computed input type — the spelling that survived both previous sweeps", { timeout: SPAWN_TIMEOUT_MS }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "date-format-gate-dyn-"));
    try {
      const planted = path.join(dir, "PlantedDynamic.tsx");
      fs.writeFileSync(
        planted,
        'export const F = () => <input type={f.type === "date" ? "date" : "text"} value={v} onChange={onC} />;\n',
      );
      const bad = run(dir);
      expect(bad.code, `expected a FAILURE, got:\n${bad.out.slice(-3000)}`).toBe(1);
      expect(bad.out).toContain("computed-date-input-type");

      fs.rmSync(planted);
      const good = run(dir);
      expect(good.code, good.out.slice(-3000)).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /* THE TYPE DECIDED A LINE ABOVE THE INPUT. `const type = … ? "date" : "text"`
     then `type={type}` — invisible to the computed rule, which needs the literal
     inside the braces. This is the shape UdfCell.tsx took, and it was USER
     REACHABLE: "date" is a first-class UdfFieldType, so anyone who added a date
     column to a table got a native OS-locale input in the grid. It survived the
     June build, the sweep of all 175, and both rules above it. */
  test("FAILS on an input type decided in a variable — the UdfCell shape", { timeout: SPAWN_TIMEOUT_MS }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "date-format-gate-var-"));
    try {
      const planted = path.join(dir, "PlantedVariable.tsx");
      fs.writeFileSync(
        planted,
        'export const F = () => { const type = f.type === "date" ? "date" : "text"; return <input type={type} value={v} />; };\n',
      );
      const bad = run(dir);
      expect(bad.code, `expected a FAILURE, got:\n${bad.out.slice(-3000)}`).toBe(1);
      expect(bad.out).toContain("date-input-type-in-a-variable");

      fs.rmSync(planted);
      const good = run(dir);
      expect(good.code, good.out.slice(-3000)).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /* The computed rule keys on `type=` + a BRACE. A colon (object literal, TS
     annotation) and a comparison (`===`) must stay silent, or the file that
     motivated the rule would fail on five other lines and the rule would be
     unusable. */
  test("does NOT fire on a `type:` annotation, an object literal, or a `f.type === \"date\"` comparison", { timeout: SPAWN_TIMEOUT_MS }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "date-format-gate-dyn-ok-"));
    try {
      fs.writeFileSync(
        path.join(dir, "HonestTypes.tsx"),
        [
          'type EditField = { key: string; value: any; type: "text" | "textarea" | "date" | "select" };',
          'const v = f.type === "date" ? isoDateOnly(f.value) : f.value;',
          'export const shown = (f: EditField) => (f.type === "date" ? dm(f.value) : f.value);',
          "const fields = [{ key: 'k', label: 'L', value: v, type: 'date' }];",
          'export const T = () => <input type={type ?? "text"} value={v} onChange={onC} />;',
        ].join("\n") + "\n",
      );
      const { code, out } = run(dir);
      expect(code, out.slice(-3000)).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /* WHERE THE RULE DELIBERATELY STOPS, pinned so it reads as a decision rather
     than an oversight — and so that changing it has to be deliberate too.
     type="time" / "month" / "week" are OS-locale rendered as well, but none of
     them puts a day number next to a month number, which is the only way a
     date gets MISREAD. 14:30 and 2:30 PM are the same minute. */
  test("does NOT fire on time, month or week inputs — the types with no day/month ambiguity", { timeout: SPAWN_TIMEOUT_MS }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "date-format-gate-scope-"));
    try {
      fs.writeFileSync(
        path.join(dir, "OtherTypes.tsx"),
        [
          'export const T = () => <input type="time" value={timePart} onChange={onT} />;',
          'export const M = () => <input type="month" value={filters.month} onChange={onM} />;',
          'export const W = () => <input type="week" value={w} onChange={onW} />;',
        ].join("\n") + "\n",
      );
      const { code, out } = run(dir);
      expect(code, out.slice(-3000)).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /* The other half of honest. Money is `toLocaleString('en-MY', …)` and row
     counts are `n.toLocaleString()`; there are ~40 of the second kind. If the
     gate fired on those, the next person would delete the gate rather than the
     format. */
  test("does not fire on money, row counts, or an ISO value", { timeout: SPAWN_TIMEOUT_MS }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "date-format-gate-ok-"));
    try {
      fs.writeFileSync(
        path.join(dir, "Honest.tsx"),
        [
          "export const rm = (n: number) => `RM ${(n / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 })}`;",
          "export const rows = (n: number) => n.toLocaleString();",
          "export const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);",
          "export const shown = (iso: string) => fmtDate(iso);",
        ].join("\n") + "\n",
      );
      const { code, out } = run(dir);
      expect(code, out.slice(-3000)).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the reviewed allowlist", () => {
  const doc = JSON.parse(fs.readFileSync(ALLOWLIST, "utf8")) as {
    reviewed: Array<{ file: string; text: string; why: string }>;
  };

  test("every entry names a file, the line, and a reason", () => {
    expect(doc.reviewed.length).toBeGreaterThan(0);
    for (const e of doc.reviewed) {
      expect(typeof e.file, JSON.stringify(e)).toBe("string");
      expect(typeof e.text, JSON.stringify(e)).toBe("string");
      // Long enough to be a sentence. A placeholder is not a review.
      expect(e.why.trim().length, `${e.file}: the reason is too short to be one`).toBeGreaterThan(30);
      expect(e.why, `${e.file}: placeholder reason`).not.toMatch(/^TODO|\bTBD\b|^n\/?a$/i);
    }
  });

  test("no duplicate entries — a second copy is a second mute button", () => {
    const keys = doc.reviewed.map((e) => `${e.file} ${e.text.trim().replace(/\s+/g, " ")}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  /* A deferral with nobody's name on it is how these become permanent. */
  test("a DEFERRED entry says who has to decide", () => {
    const deferred = doc.reviewed.filter((x) => /DEFERRED/i.test(x.why));
    expect(deferred.length).toBeGreaterThan(0);
    for (const e of deferred) {
      expect(e.why, `${e.file}: deferred to nobody`).toMatch(/owner|he\b|him\b|whoever owns|Nico|Nick/i);
    }
  });
});

describe("the gate is still wired", () => {
  test("package.json runs the script with --strict", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "backend", "package.json"), "utf8"));
    expect(pkg.scripts["audit:date-format"]).toContain("check-date-formatting.mjs");
    expect(pkg.scripts["audit:date-format"]).toContain("--strict");
  });

  test("ci.yml runs it inside the REQUIRED backend-typecheck job", () => {
    const ci = fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).toContain("npm run audit:date-format");
    // …and in that job specifically, not in some optional one added later.
    const backendJob = ci.slice(ci.indexOf("backend-typecheck:"), ci.indexOf("backend-tests:"));
    expect(backendJob).toContain("npm run audit:date-format");
  });
});
