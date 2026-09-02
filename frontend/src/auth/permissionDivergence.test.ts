// ----------------------------------------------------------------------------
// permissionDivergence — the frontend gate and the backend gate must AGREE.
//
// This is the remainder of the audit PR #835 opened: sites where the client
// answered a permission question the server was already answering, and answered
// it differently. Each test below names ONE site, the API gate it must match,
// and the direction it was wrong in. Agreement is the entire point of the
// capability registry, and it must not be able to drift again — so it is pinned
// here rather than asserted in a comment.
//
// Source-scanning, for the reason soMaintenanceGate.test.ts states: these gates
// are inline in large components under concurrent edit, and rendering them would
// couple this test to routers, lazy boundaries and query clients, breaking for
// reasons that have nothing to do with the gate. What must not drift is WHICH
// KEY each site reads — which is exactly what the source says.
// ----------------------------------------------------------------------------

import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { CAPABILITY_KEYS } from "./capabilities";
import { stripComments } from "./sourceScan.testutil";

const HERE = dirname(fileURLToPath(import.meta.url));
const feSrc = (rel: string) => readFileSync(resolve(HERE, "..", rel), "utf8");
const beSrc = (rel: string) =>
  readFileSync(resolve(HERE, "..", "..", "..", "backend", "src", rel), "utf8");

/* ── ITEM 2 — Special Add-ons ──────────────────────────────────────────────
   `const canEdit = true` at module scope. Every user who reached the tab saw
   Edit / Delete / +New / inline price inputs, and every one of them 403'd on
   click. The widest possible divergence, in the direction that GRANTS. */
describe("SpecialAddonsTab — the editor is gated on the API's own write rule", () => {
  const FILE = "vendor/scm/components/SpecialAddonsTab.tsx";
  const KEY = "scm.config.write";

  test("the key is a real capability the backend ships", () => {
    expect(CAPABILITY_KEYS as readonly string[]).toContain(KEY);
  });

  test("the hardcoded `canEdit = true` is gone", () => {
    expect(stripComments(feSrc(FILE))).not.toMatch(/const\s+canEdit\s*=\s*true/);
  });

  test("BOTH managers resolve canEdit from the capability", () => {
    // Two components, one module — a single conversion would have left the
    // other half of the tab ungated.
    const hits = feSrc(FILE).match(/const\s+canEdit\s*=\s*useCapability\(/g) ?? [];
    expect(hits).toHaveLength(2);
  });

  test(`the capability read is ${KEY}`, () => {
    expect(feSrc(FILE)).toContain(`useCapability('${KEY}')`);
  });

  test("the backend gate it mirrors is still canWriteScmConfig", () => {
    // If someone changes /special-addons' gate, this fails and points at the
    // capability that has to move with it.
    const route = beSrc("scm/routes/special-addons.ts");
    expect(route).toContain("canWriteScmConfig");
    expect(route).toMatch(/if\s*\(!canWriteScmConfig\(c\)\)/);
  });

  test("it does NOT go through the vendor role bridge", () => {
    // lib/auth.ts collapses every caller to super_admin-or-sales off can('*') —
    // a THIRD answer to this question. Using it here would rebuild the drift.
    expect(feSrc(FILE)).not.toMatch(/from\s+['"]\.\.\/lib\/auth['"]/);
  });
});

/* ── ITEM 3 — the /assr/:id route ──────────────────────────────────────────
   Missing `allowSales` while its three siblings had it and while the API admits
   Sales. Wrong in the direction that DENIES: a sales rep opened the case list,
   clicked a case, and got Forbidden on a case the backend would have served.

   Owner 2026-07-23 changed the DETAIL route's shape: a non-director Sales rep is
   now REDIRECTED from the editable /assr/:id to the read-only /my-cases/:id
   ("sales agent 不应该有 edit case 功能"). The original invariant's GOAL — a rep is
   never Forbidden on a case the API would serve — still holds, but via a redirect
   rather than an inline allowSales guard, so the two are asserted separately. */
describe("/assr/:id — the route guard matches requireServiceCaseAccess", () => {
  test("the backend case-detail read really does admit Sales", () => {
    // Verify the premise before trusting it. Two things must hold: the endpoint
    // uses requireServiceCaseAccess, and that gate admits a rank-and-file rep.
    //
    // The MECHANISM of that second half has changed TWICE and the assertion moved
    // with it. It read `isSalesUser(user)` — Sales by job title — until a batch
    // of reps lost every case when a name-shaped signal missed; the gate then
    // ORed in the HOUZS company grant; and on 2026-09-03 that literal widened to
    // ANY company grant, because the ruling had replaced the TITLE and the
    // single-company literal was narrower than the rule (docs/bugs/0621-*).
    //
    // The INVARIANT is unchanged and is the only thing worth asserting: a rep
    // the API would serve is never Forbidden. So match the GRANT TERM, not which
    // company it names — pinning the company is what made this assertion need
    // editing on a change that did not alter the invariant at all.
    const assr = beSrc("routes/assr.ts");
    expect(assr).toMatch(/app\.get\(\s*["']\/:id\{\[0-9\]\+\}["']\s*,\s*requireServiceCaseAccess\(\)/);
    expect(assr).toMatch(/function canAccessServiceCases[\s\S]{0,600}holds\w*CompanyGrant\(c\)/);
    expect(assr).toMatch(/function requireServiceCaseAccess[\s\S]{0,400}canAccessServiceCases/);
  });

  test("the list + My Cases routes carry allowSales so a Sales rep isn't Forbidden", () => {
    const app = feSrc("App.tsx");
    // /assr/:id is asserted separately below — reps are redirected off it, not
    // guarded onto it, so it deliberately no longer carries an inline allowSales.
    for (const path of ["/assr", "/my-cases", "/my-cases/:id"]) {
      // Take the guard that follows each route declaration.
      const at = app.indexOf(`path="${path}"`);
      expect(at, `route ${path} disappeared`).toBeGreaterThan(-1);
      const block = app.slice(at, at + 900);
      const guard = block.slice(block.indexOf("<PageGuard"));
      expect(
        guard.slice(0, 200),
        `${path} lost allowSales — a Sales rep now hits Forbidden on a case the API would serve`,
      ).toContain("allowSales");
    }
  });

  test("/assr/:id redirects a non-director Sales rep to read-only My Cases, never Forbidden", () => {
    const app = feSrc("App.tsx");
    // The route delegates to SalesRepCaseDetailRoute instead of an inline guard.
    const at = app.indexOf(`path="/assr/:id"`);
    expect(at, "route /assr/:id disappeared").toBeGreaterThan(-1);
    // Wide window: the route element keeps the long historical allowSales note
    // before the <SalesRepCaseDetailRoute/> element it now renders.
    const block = app.slice(at, at + 1400);
    expect(
      block,
      "/assr/:id no longer delegates to SalesRepCaseDetailRoute",
    ).toContain("<SalesRepCaseDetailRoute");

    // That component must (a) redirect the non-director rep to /my-cases/:id — so
    // a rep is made read-only, never Forbidden — and (b) still admit ops + Sales
    // Directors to the editable detail via allowSales (fail direction preserved).
    const compAt = app.indexOf("function SalesRepCaseDetailRoute");
    expect(compAt, "SalesRepCaseDetailRoute definition missing").toBeGreaterThan(-1);
    const comp = app.slice(compAt, compAt + 600);
    expect(comp).toContain("isSalesNonDirector(user)");
    expect(comp).toContain("Navigate to={`/my-cases/${id}`}");
    expect(comp).toContain("allowSales");
  });

  /* THE OTHER HALF OF THE SAME RULE, and it was missing for 13 months.
     The redirect asserted above is DESKTOP. Mobile gates its Service tab on
     `allowed("/assr")` — whose own comment says Sales staff pass — and then
     mounted the FULL editable MobileServiceCase detail: stage select, Advance,
     Close, Archive, item quantities. `isSalesNonDirector` had exactly ONE mobile
     call site in the whole tree (MobilePMS) and it has nothing to do with cases.

     What that actually meant in production, read rather than assumed
     (backend/scripts/census-service-case-visibility.mjs §5, run 32395787958):
     32 active non-director Sales staff, ALL on the role "Sales Person",
     `service_cases.write` held by ZERO of them. So every one of those controls
     answered 403 — a screen of dead buttons, not an authorisation hole — while
     the two things a rep IS entitled to do (sales-comment, sales-nudge, both
     gated on requireServiceCaseAccess, not on write) had no mobile home at all.

     The predicate is IMPORTED on both surfaces. A mobile copy of "who is a rep"
     is the exact defect this whole file exists to pin. */
  test("mobile routes a non-director Sales rep to the READ-ONLY case detail too", () => {
    const mobile = feSrc("mobile/MobileServiceCase.tsx");
    expect(
      mobile,
      "mobile does not import isSalesNonDirector — the desktop rule has no mobile half",
    ).toContain("isSalesNonDirector");
    expect(
      mobile,
      "mobile no longer mounts the read-only detail for a rep",
    ).toContain("MobileMyCaseDetail");

    // The branch itself: the rep gets MobileMyCaseDetail, everyone else the
    // editable CaseDetail. Asserted on the component, not on a comment.
    const code = stripComments(mobile);
    const at = code.indexOf("export function MobileServiceCase");
    expect(at, "MobileServiceCase definition missing").toBeGreaterThan(-1);
    const comp = code.slice(at, at + 900);
    expect(comp).toMatch(/isSalesNonDirector\(user\)\s*\?\s*MobileMyCaseDetail\s*:\s*CaseDetail/);
  });

  test("mobile re-derives the cohort NOWHERE — it reads the one predicate", () => {
    /* The failure this forbids is a local re-derivation of "who is a sales
       rep" — a `/^sales/i` on the position or a `"sales"` substring on the
       department — which is how the desktop copy started and what
       salesAccess.ts's own header records folding back to one place.

       Scoped to the SALES words on purpose. A bare `department_name` ban was
       the first draft and it was a false positive: this screen legitimately
       reads `department_name` to filter the PIC picker to the Operation
       department, which has nothing to do with this cohort. A guard that
       matches a WORD rather than a rule reports about a system we do not run. */
    const mobile = stripComments(feSrc("mobile/MobileServiceCase.tsx"));
    expect(mobile).toMatch(
      /import\s*\{[^}]*isSalesNonDirector[^}]*\}\s*from\s*["']\.\.\/auth\/salesAccess["']/,
    );
    for (const rederivation of [/\/\^sales\/i/, /includes\(\s*["']sales["']\s*\)/i]) {
      expect(
        rederivation.test(mobile),
        `MobileServiceCase has re-derived the Sales cohort (${rederivation})`,
      ).toBe(false);
    }
  });

  test("the rep keeps the LIST and the create sheet — they may raise a case", () => {
    /* Read-only means the DETAIL, exactly as on desktop, where the board list
       stays reachable and only /assr/:id redirects. Gating the whole screen
       would take away the rep's create path, which the owner never asked for
       and which the standing "loosen, do not restrict" rule forbids. */
    const comp = stripComments(feSrc("mobile/MobileServiceCase.tsx"));
    const at = comp.indexOf("export function MobileServiceCase");
    const body = comp.slice(at, at + 1400);
    expect(body).toContain("<CaseList");
    expect(body).toContain("NewCaseSheet");
  });

  test("the read-only screen carries the comment + nudge thread, and both render a refusal", () => {
    /* Losing the ability to edit must not cost the rep the two things they were
       always allowed to do. The nudge has a REAL expected failure — the server
       rate-limits to one an hour and answers 429 — so a silent catch there is
       the "button does nothing" bug with a guaranteed trigger. */
    const screen = feSrc("mobile/MobileMyCaseDetail.tsx");
    expect(screen).toContain("/sales-comment");
    expect(screen).toContain("/sales-nudge");
    expect((screen.match(/onError:/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(stripComments(screen)).not.toContain("catch {}");
  });

  test("the read-only screen mounts NO write control", () => {
    /* The point of the screen. `transition` / `advance` / `archive` are the
       three the mobile editable detail exposes, and PATCH is how every field
       edit leaves. None of them may appear here. */
    const screen = stripComments(feSrc("mobile/MobileMyCaseDetail.tsx"));
    for (const forbidden of ["api.patch", "/transition", "/archive", "/items"]) {
      expect(
        screen.includes(forbidden),
        `the read-only rep screen calls ${forbidden}`,
      ).toBe(false);
    }
  });

  test("PageGuard resolves both cohorts from the SERVER, not a local mirror", () => {
    const guard = feSrc("auth/PageGuard.tsx");
    expect(guard).toContain('capability(user, "org.sales.staff")');
    expect(guard).toContain('capability(user, "org.salesDirector")');
    // The salesAccess mirrors stated the dept/position terms in the opposite
    // order and carried their own regex copy — a second answer to one question.
    expect(guard).not.toMatch(/from\s+["']\.\/salesAccess["']/);
  });

  test("both cohort keys are real capabilities", () => {
    for (const key of ["org.sales.staff", "org.salesDirector"]) {
      expect(CAPABILITY_KEYS as readonly string[]).toContain(key);
    }
  });
});

/* ── ITEM 5 — a failed read must not look like an empty list ───────────────
   `.catch(() => {})` on reference reads: a 403 left the crew/lorry pickers
   empty and silent, which is the same defect class as the `?? []` that made a
   403 render as an empty dropdown. */
describe("reference reads surface their failures", () => {
  /* SCOPE, stated so this list is not mistaken for coverage. SITES names the
     two files that had already broken; it is a REGRESSION pin on their specific
     recovery behaviour (setRefError and friends below), not a census. It cannot
     fail for the third file, and on 2026-08-13 there were 76 discarded-failure
     sites left across frontend/src and backend/src that all pass this suite.

     The tree-wide count is enforced elsewhere, because a filesystem scan of
     both trees cannot run in either vitest project:
         npm --prefix backend run audit:swallowed-reads
     per-file ceilings in backend/scripts/data/swallowed-read-baseline.json,
     wired into CI's backend-typecheck job. Add a site and that gate fails.
     See docs/bug-classes.md, class B. */
  const SITES: { file: string; label: string }[] = [
    { file: "pages/Projects.tsx", label: "crew + lorry reads, phase/attachment thumbnails" },
    { file: "pages/ServiceCases.tsx", label: "attachment lightbox" },
  ];

  for (const { file, label } of SITES) {
    test(`${file} (${label}) has no bare swallow left`, () => {
      expect(
        stripComments(feSrc(file)),
        `a bare .catch(() => {}) is back in ${file}`,
      ).not.toContain(".catch(() => {})");
    });
  }

  test("Projects.tsx renders the reference-read failure rather than an empty picker", () => {
    const text = feSrc("pages/Projects.tsx");
    // Two independent crew/lorry readers, each with its own surfaced error.
    expect((text.match(/setRefError\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((text.match(/\{refError && \(/g) ?? []).length).toBe(2);
  });

  test("the ServiceCases lightbox no longer sits on Loading forever", () => {
    const text = feSrc("pages/ServiceCases.tsx");
    expect(text).toContain("setLoadError(");
    expect(text).toContain("This attachment couldn't be opened");
  });
});
