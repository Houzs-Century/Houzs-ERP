/* ONE SYSTEM, TWO ORGANISATIONS — the two regressions this run actually fixed,
   pinned as SOURCE facts rather than as behaviour.

   Both are pinned by reading the file, which is unusual and deliberate. The
   defect in each case was not a wrong VALUE that a unit test could catch — it
   was a rule RE-TYPED instead of imported, in a file whose real behaviour needs
   a browser (a React page) or a live Postgres and a Supabase service key (the
   bulk importer). A test that cannot run against the real thing can still pin
   the one property that failed: that the declaration has exactly one home.

   Neither of these is a substitute for the mirror pin. check-shared-mirrors.mjs
   --strict already holds do-shipped-states.ts and its frontend twin byte
   identical; this file holds the CONSUMERS to using it. */
import { describe, test, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DO_SHIPPED_STATES, SI_TRANSFERABLE_DO_STATES } from "../src/scm/shared/do-shipped-states";
import { SO_PROCESSING_DATE_LEGACY_COLUMNS } from "../src/scm/shared/so-processing-date";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/* ── 1. THE REPORTED BUG ─────────────────────────────────────────────────────
   The owner: "你统一掉整个 Transfer DO to Sales Invoice 的那一个，为什么两间公司
   看到的东西却是不一样的？"

   Both desktop entry points to the DO→Sales-Invoice transfer gated the button
   on a hand-typed ["signed","delivered"] — a THIRD spelling of "this delivery
   has shipped", and the narrowest of the three. The server picker and the
   mobile wizard both used a wider predicate, and DeliveryOrderDetailV2 itself
   used the correct five-state list SIXTEEN LINES BELOW to lock a shipped DO's
   lines from editing. So one file knew a DISPATCHED delivery had shipped and
   refused to offer its transfer.

   It read as a per-company bug because it IS one in practice: the guard has no
   company term, and fires on one organisation only because that organisation's
   source system had no "delivered" step, so its deliveries sit at DISPATCHED.

   WHAT IS PINNED: the two files IMPORT the declaration and do not re-type it.
   A literal cannot drift from a constant it does not contain. */
const DO_TRANSFER_SURFACES = [
  "frontend/src/pages/scm-v2/DeliveryOrderDetailV2.tsx",
  "frontend/src/pages/scm-v2/MfgDeliveryOrdersListV2.tsx",
];

/* Comments in both files QUOTE the old literal in order to explain it, and that
   explanation is the most valuable thing on the page — stripping comments is
   what lets the pin coexist with it. Crude but sufficient: this only has to
   distinguish code from prose, not parse TypeScript. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");

describe("the DO→Sales-Invoice transfer is offered from ONE declaration", () => {
  /* WHAT CHANGED, AND WHY THE PIN MOVED WITH IT. This asserted a DIRECT
     `import { DO_SHIPPED_STATES }` in each page. The pages now ask
     vendor/scm/lib/do-next-step.ts instead — siTransferBlockReason(status)
     returns null or the sentence to show — and that module imports
     SI_TRANSFERABLE_DO_STATES from the same shared file. One more hop, the same
     single declaration, and the page no longer holds the rule at all.

     Pinning the direct import would now FAIL on the better architecture, which is
     the failure this suite exists to prevent in the other direction: a guard that
     pins the SHAPE of one correct answer rejects every other correct answer. What
     must stay true is that the decision REACHES the page from the shared
     declaration and is not re-typed there. */
  test.each(DO_TRANSFER_SURFACES)("%s takes the decision from do-next-step", (rel) => {
    const src = read(rel);
    expect(src, `${rel} no longer routes the SI transfer through do-next-step`)
      .toMatch(/import\s*\{[^}]*siTransferBlockReason[^}]*\}\s*from\s*['"][^'"]*do-next-step['"]/);
  });

  test("do-next-step takes it from the shared declaration, so the chain ends there", () => {
    const src = read("frontend/src/vendor/scm/lib/do-next-step.ts");
    expect(src, "do-next-step.ts no longer imports the shared declaration")
      .toMatch(/import\s*\{[^}]*SI_TRANSFERABLE_DO_STATES[^}]*\}\s*from\s*['"][^'"]*do-shipped-states['"]/);
    expect(stripComments(src), "do-next-step.ts re-typed the status list")
      .not.toMatch(/["']signed["']\s*,\s*["']delivered["']/i);
  });

  test.each(DO_TRANSFER_SURFACES)("%s does not re-type the status list", (rel) => {
    const code = stripComments(read(rel));
    /* The exact pair that shipped the bug, in either order and either quote
       style. Not a general "no status literal anywhere" rule — `canMarkSigned`
       legitimately lists the pre-signed states, and a test that forbade every
       status literal would be re-litigated and deleted. */
    expect(code, `${rel} has a hand-typed ["signed","delivered"] again`)
      .not.toMatch(/["']signed["']\s*,\s*["']delivered["']/i);
    expect(code, `${rel} has a hand-typed signed||delivered again`)
      .not.toMatch(/===\s*["']signed["']\s*\|\|[^\n]*===\s*["']delivered["']/i);
  });

  /* The five-state set is what the whole rest of the chain means by "shipped",
     and DISPATCHED being IN it is the entire fix — that is the state 2990's
     imported deliveries sit at, and the state at which the inventory OUT is
     written.

     LOADED IS THE CASE THAT PROVES THE TWO SETS ARE DIFFERENT QUESTIONS, and
     this comment used to get it wrong: it said LOADED "must not be invoiceable"
     because nothing has left the building. The owner ruled otherwise on
     2026-08-19 (#2485) — every CONFIRMED delivery may be invoiced — and the
     server had never refused one, so the stricter reading was this repo's
     opinion, not the business's. A LOADED delivery is therefore NOT shipped (no
     inventory OUT has been written; the ledger must not think otherwise) and IS
     invoiceable. Folding the two sets into one would have to break one of those
     two facts, which is why they are two constants. */
  test("LOADED is not a shipped state, but it IS invoiceable", () => {
    expect(DO_SHIPPED_STATES).toContain("DISPATCHED");
    expect(DO_SHIPPED_STATES).toContain("IN_TRANSIT");
    expect(DO_SHIPPED_STATES).not.toContain("LOADED");
    expect(DO_SHIPPED_STATES).not.toContain("DRAFT");
    // The stock question and the money question, on the same status, disagreeing
    // on purpose. DRAFT and CANCELLED are out of both.
    expect(SI_TRANSFERABLE_DO_STATES).toContain("LOADED");
    expect(SI_TRANSFERABLE_DO_STATES).not.toContain("DRAFT");
    expect(SI_TRANSFERABLE_DO_STATES).not.toContain("CANCELLED");
  });

  /* The list drawer's two buttons must not be mutually exclusive again. The bug
     was an if/else-IF chain: a DISPATCHED delivery matched "Mark signed" and
     RETURNED, so the transfer was never rendered — not disabled, absent. */
  /* The list drawer used to compute `shipped` itself from the shared constant.
     It no longer computes anything: main's two-fixed-slots rewrite moved BOTH
     questions into do-next-step.ts (doAdvanceStep for the status advance,
     siTransferBlockReason for the transfer) and the drawer renders what they
     return. The property this test protects is unchanged and is what the owner
     actually saw go wrong — the two buttons must be INDEPENDENT, never an
     if/else-if where a DISPATCHED row matches "Mark signed" and returns so the
     transfer is never rendered at all. */
  test("the list drawer asks do-next-step for both answers, independently", () => {
    const src = read("frontend/src/pages/scm-v2/MfgDeliveryOrdersListV2.tsx");
    expect(src, "the drawer no longer imports both decisions")
      .toMatch(/import\s*\{[^}]*doAdvanceStep[^}]*siTransferBlockReason[^}]*\}|import\s*\{[^}]*siTransferBlockReason[^}]*doAdvanceStep[^}]*\}/s);
    const code = stripComments(src);
    expect(code, "the two buttons are back in an if/else-if chain")
      .not.toMatch(/if\s*\([^)]*signed[^)]*\)[\s\S]{0,400}?else\s+if\s*\([^)]*(invoice|transfer)/i);
  });
});

/* ── 2. THE PROCESSING DATE THE BULK IMPORTER WOULD HAVE LOST ───────────────
   Migration 0286 renamed this side's `internal_expected_dd` to
   `processing_date`. The 2990 source is a separate repo on its own deploy
   schedule and still carries BOTH names — its LIVE column is
   `internal_expected_dd` and its `processing_date` is the dead twin migration
   0189 dropped here.

   migrate-2990-into-houzs.mjs matches columns BY NAME, so without a rename map
   it would have filled the ERP's live Processing Date from the source's DEAD
   column and dropped the real one. The live SO mirror was given this alias
   (SO_PROCESSING_DATE_LEGACY_COLUMNS); the bulk path never was — the same rule
   expressed at N call sites and present at N-1, which is this repo's most
   frequent defect shape.

   The script cannot be imported (it reads env and connects at module load), so
   this reads the source. Cross-checked against the shared constant so the two
   cannot drift apart silently: if somebody removes the legacy name there
   because 2990 has finally deployed, this test points at the importer too. */
describe("the 2990 bulk importer carries the Processing Date rename", () => {
  const src = read("backend/scripts/migrate-2990-into-houzs.mjs");

  /* BUILT FROM THE SHARED EXPORT, NOT HAND-TYPED. tests/soProcessingDateOneName
     .test.mjs forbids any script under backend/scripts from spelling the retired
     column in code — eleven of them once did, and because 42703 fails the WHOLE
     statement rather than one column, every one of those audits returned nothing
     and read as clean. So the map is derived from the one module entitled to
     hold the name, which also means it corrects itself on the day 2990 deploys
     and the legacy entry is removed there. */
  test("RENAME_COLS is derived from the shared declaration, not typed by hand", () => {
    expect(src).toMatch(/const\s+RENAME_COLS\s*=/);
    expect(src, "the migrator no longer imports the processing-date declaration")
      .toMatch(/from\s+["']\.\/lib\/so-processing-date\.mjs["']/);
    expect(src).toContain("SO_PROCESSING_DATE_LEGACY_COLUMNS");
    expect(src).toContain("SO_PROCESSING_DATE_COLUMN");
    expect(src, "the legacy names are not mapped onto the live column")
      .toMatch(/SO_PROCESSING_DATE_LEGACY_COLUMNS\.map\(\s*\(legacy\)\s*=>\s*\[legacy,\s*SO_PROCESSING_DATE_COLUMN\]/);
    // The retired spelling must NOT appear in the migrator's own code.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
    for (const legacy of SO_PROCESSING_DATE_LEGACY_COLUMNS) {
      expect(code, `${legacy} is hand-typed in the migrator again`)
        .not.toMatch(new RegExp(`\\b${legacy}\\b`));
    }
  });

  test("both sales-order tables are covered, not just the mfg one", () => {
    const block = src.slice(src.indexOf("const SO_RENAMES"), src.indexOf("const NO_CID"));
    expect(block).toContain("mfg_sales_orders");
    expect(block).toContain("consignment_sales_orders");
  });

  /* A rename must WIN over a same-named source column, or iteration order picks
     which of the two dates lands and nothing says which. This is the line that
     makes the live column beat the dead one. */
  test("a renamed destination is excluded from the name-matched set", () => {
    expect(src).toMatch(/renamedDest\s*=\s*new Set\(Object\.values\(rename\)\)/);
    expect(src).toMatch(/!\(c in rename\)\s*&&\s*!renamedDest\.has\(c\)/);
  });

  /* The shared constant is the authority on WHICH name is legacy. If it empties
     (2990 deployed, mirror re-delivered), the loop above vacuously passes — so
     assert it is non-empty here rather than letting a green run mean nothing. */
  test("the legacy-column list is not empty, or the check above proves nothing", () => {
    expect(SO_PROCESSING_DATE_LEGACY_COLUMNS.length).toBeGreaterThan(0);
  });
});
