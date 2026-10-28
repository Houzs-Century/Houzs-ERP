/* ONE SYSTEM, TWO ORGANISATIONS — the gate, and the proof it bites.

   THE RULE (owner, 2026-08-18): "两个公司不是用着同一个系统吗？他们只是
   Multi-Organization 关系而已啊." One system, one set of behaviours, two
   organisations' DATA. A company may have its own documents, its own numbering
   prefix, its own branding, and a small number of rules the owner stated
   himself. It may not have different CAPABILITIES by accident.

   WHY A GATE. The reported bug was a "Transfer to Sales Invoice" button that
   existed for one organisation and not the other. Nobody wrote a company branch
   to make that happen — two hand-typed status lists did it, and the difference
   only showed up because the two organisations' deliveries carry different
   statuses. The lesson that generalises is not "look for company branches"; it
   is that a per-company difference is cheap to introduce and expensive to
   notice. The allowlist makes introducing one cost a sentence and a name.

   WHAT THIS FILE PINS, and why each is here rather than trusted:

     1. THE GATE PASSES on the tree as committed. Otherwise the CI step is
        failing for a reason nobody has looked at.
     2. THE GATE FAILS on a planted branch, and passes once it is gone. This is
        the whole test. A gate nobody has watched fail may be scanning nothing —
        check-trgm-coverage.mjs sat in this repo with BOTH exit paths at exit 0
        and in no workflow at all, and read as a pass for weeks. The plant goes
        in a temp directory OUTSIDE the source tree, so proving the gate never
        requires writing a company branch into backend/src.
     3. THE GATE DOES NOT FIRE ON ORDINARY SCOPING. `scopeToCompany` and
        `.eq('company_id', id)` are the system working correctly and appear in
        four figures' worth of lines. A gate that reported them would be
        switched off in a week, which is how the previous generation of checks
        in this repo died.
     4. EVERY ALLOWLIST ENTRY NAMES A DECIDER. An allowlist of bare paths is a
        mute button. The owner's position is that a per-company difference is
        legitimate only where he set it, so `whoSetIt` is not decoration.
     5. THE STEP IS STILL WIRED. Two sessions found `pretest`-orphaned checks on
        the same afternoon here; a check that cannot run reports nothing and
        reads as a pass. Named in ci.yml and in package.json, asserted. */
import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "backend", "scripts", "check-company-divergence.mjs");
const ALLOWLIST = path.join(ROOT, "backend", "scripts", "data", "company-divergence-allowlist.json");

function run(extraRoot?: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, "--strict"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: extraRoot ? { ...process.env, COMPANY_DIVERGENCE_EXTRA_ROOT: extraRoot } : process.env,
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

/* Each of these SPAWNS the checker, which walks ~1,450 source files. Vitest
   defaults to 5s per test and the walk alone can exceed that on a loaded
   machine — a timeout here would read as the gate being broken. */
const SPAWN_TIMEOUT_MS = 120_000;

describe("the per-company divergence gate", () => {
  test("passes on the tree as committed", { timeout: SPAWN_TIMEOUT_MS }, () => {
    const { code, out } = run();
    expect(out).toContain("source files scanned");
    expect(code, out.slice(-3000)).toBe(0);
  });

  /* THE NON-VACUITY PROOF. Exit 2 is the script's own self-test failing and must
     never be confused with a caught violation — a checker that cannot run is not
     a checker that found nothing. */
  test("FAILS on a planted company branch, and passes again once it is gone", { timeout: SPAWN_TIMEOUT_MS }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "company-divergence-gate-"));
    try {
      const planted = path.join(dir, "PlantedRule.ts");
      fs.writeFileSync(
        planted,
        "export function canExportLedger(companyId: number): boolean {\n"
        + "  return companyId === 1;\n"
        + "}\n",
      );
      const bad = run(dir);
      expect(bad.code, `expected a FAILURE, got:\n${bad.out.slice(-3000)}`).toBe(1);
      expect(bad.out).toContain("NOT REVIEWED");
      expect(bad.out).toContain("companyId === 1");
      expect(bad.out).toContain("company-id-literal");

      fs.rmSync(planted);
      const good = run(dir);
      expect(good.code, good.out.slice(-3000)).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /* A SECOND PLANT, in the shape the literal-only sweep MISSED. A rule scoped by
     doc-number prefix names no company and no id, and that is exactly how the
     SO-PO edit lock is confined to one organisation. If this ever stops failing,
     the gate has quietly narrowed back to the grep it was meant to improve on. */
  test("FAILS on a rule scoped by doc-number prefix, which names no company", { timeout: SPAWN_TIMEOUT_MS }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "company-divergence-prefix-"));
    try {
      fs.writeFileSync(
        path.join(dir, "PlantedPrefixRule.ts"),
        "import { isMirroredDocNo } from './companyScope';\n"
        + "export const locked = (d: string) => isMirroredDocNo(d);\n",
      );
      const { code, out } = run(dir);
      expect(code, `expected a FAILURE, got:\n${out.slice(-3000)}`).toBe(1);
      expect(out).toContain("company-doc-prefix");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /* The other half of honest. Ordinary company SCOPING is the system working —
     it is what stops one organisation reading the other's rows — and there are
     thousands of those lines. If the gate fired on them the report would be
     unreadable and somebody would delete it rather than the divergence. */
  test("does NOT fire on ordinary company scoping", { timeout: SPAWN_TIMEOUT_MS }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "company-divergence-ok-"));
    try {
      fs.writeFileSync(
        path.join(dir, "HonestScope.ts"),
        "export function load(sb: any, c: any, companyId: number) {\n"
        + "  const scoped = scopeToCompany(sb.from('delivery_orders').select('id'), c);\n"
        + "  const pinned = sb.from('warehouses').select('id').eq('company_id', companyId);\n"
        + "  const co = requireActiveCompanyId(c);\n"
        + "  return { scoped, pinned, co, row: { company_id: companyId } };\n"
        + "}\n",
      );
      const { code, out } = run(dir);
      expect(code, out.slice(-3000)).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /* A TYPE test is not a company branch. Three `typeof x.companyCode === 'string'`
     coercions live in this tree and reporting them would train people to skim. */
  test("does NOT fire on a typeof companyCode coercion", { timeout: SPAWN_TIMEOUT_MS }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "company-divergence-typeof-"));
    try {
      fs.writeFileSync(
        path.join(dir, "HonestCoerce.ts"),
        "export const read = (j: any) => ({\n"
        + "  companyCode: typeof j.companyCode === 'string' ? j.companyCode : null,\n"
        + "});\n",
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
    reviewed: Array<{ file: string; text: string; why: string; whoSetIt: string }>;
  };

  test("every entry names a file, the line, a reason and a decider", () => {
    expect(doc.reviewed.length).toBeGreaterThan(0);
    for (const e of doc.reviewed) {
      expect(typeof e.file, JSON.stringify(e)).toBe("string");
      expect(typeof e.text, JSON.stringify(e)).toBe("string");
      expect(e.why.trim().length, `${e.file}: the reason is too short to be one`).toBeGreaterThan(30);
      expect(e.why, `${e.file}: placeholder reason`).not.toMatch(/^TODO|\bTBD\b|^n\/?a$/i);
      expect(e.whoSetIt.trim().length, `${e.file}: no decider named`).toBeGreaterThan(4);
      expect(e.whoSetIt, `${e.file}: placeholder decider`).not.toMatch(/^TODO|\bTBD\b/i);
    }
  });

  /* "Historical" and "legacy" are not people. The whole point of `whoSetIt` is
     that the owner's test for a legitimate per-company difference is whether a
     person decided it — an entry that answers "it has always been like that" is
     an unreviewed divergence wearing a review's clothes. */
  test("a decider is a person or a stated design, never 'legacy'", () => {
    for (const e of doc.reviewed) {
      expect(e.whoSetIt, `${e.file}: '${e.whoSetIt}' names nobody`)
        .not.toMatch(/^\s*(historical|legacy|unknown|it has always|inherited)\b/i);
    }
  });

  test("no duplicate entries — a second copy is a second mute button", () => {
    const keys = doc.reviewed.map((e) => `${e.file} ${e.text.trim().replace(/\s+/g, " ")}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  /* THE TWO REAL CAPABILITY DIFFERENCES stay on the list explicitly. Both are
     owner rulings, and both are the kind a later sweep would "fix" into symmetry
     if the list did not say out loud that they are deliberate. If either file
     stops appearing, somebody has changed an owner rule. */
  test("the two owner-set capability differences are still recorded", () => {
    const files = new Set(doc.reviewed.map((e) => e.file));
    expect(files, "the mobile-build-is-HOUZS-only rule left the allowlist")
      .toContain("frontend/src/auth/AuthGate.tsx");
    expect(files, "the 2990-only SO-PO edit lock left the allowlist")
      .toContain("backend/src/scm/lib/so-po-lock.ts");
    // …and the deposit threshold, the owner's most-quoted per-company rule.
    expect(files, "the per-company deposit threshold left the allowlist")
      .toContain("backend/src/scm/shared/order-rules.ts");
  });
});

describe("the gate is still wired", () => {
  test("package.json runs the script with --strict", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "backend", "package.json"), "utf8"));
    expect(pkg.scripts["audit:company-divergence"]).toContain("check-company-divergence.mjs");
    expect(pkg.scripts["audit:company-divergence"]).toContain("--strict");
  });

  test("ci.yml runs it inside the REQUIRED backend-typecheck job", () => {
    const ci = fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).toContain("npm run audit:company-divergence");
    // …and in that job specifically, not in some optional one added later.
    const backendJob = ci.slice(ci.indexOf("backend-typecheck:"), ci.indexOf("backend-tests:"));
    expect(backendJob).toContain("npm run audit:company-divergence");
  });
});
