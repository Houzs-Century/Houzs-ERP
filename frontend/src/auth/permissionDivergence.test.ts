
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
    for (const path of ["/assr", "/my-cases", "/my-cases/:id"]) {
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
    const at = app.indexOf(`path="/assr/:id"`);
    expect(at, "route /assr/:id disappeared").toBeGreaterThan(-1);
    const block = app.slice(at, at + 1400);
    expect(
      block,
      "/assr/:id no longer delegates to SalesRepCaseDetailRoute",
    ).toContain("<SalesRepCaseDetailRoute");

    const compAt = app.indexOf("function SalesRepCaseDetailRoute");
    expect(compAt, "SalesRepCaseDetailRoute definition missing").toBeGreaterThan(-1);
    const comp = app.slice(compAt, compAt + 600);
    expect(comp).toContain("isSalesNonDirector(user)");
    expect(comp).toContain("Navigate to={`/my-cases/${id}`}");
    expect(comp).toContain("allowSales");
  });

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

    const code = stripComments(mobile);
    const at = code.indexOf("export function MobileServiceCase");
    expect(at, "MobileServiceCase definition missing").toBeGreaterThan(-1);
    const comp = code.slice(at, at + 900);
    expect(comp).toMatch(/isSalesNonDirector\(user\)\s*\?\s*MobileMyCaseDetail\s*:\s*CaseDetail/);
  });

  test("mobile re-derives the cohort NOWHERE — it reads the one predicate", () => {
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
    const comp = stripComments(feSrc("mobile/MobileServiceCase.tsx"));
    const at = comp.indexOf("export function MobileServiceCase");
    const body = comp.slice(at, at + 1400);
    expect(body).toContain("<CaseList");
    expect(body).toContain("NewCaseSheet");
  });

  test("the read-only screen carries the comment + nudge thread, and both render a refusal", () => {
    const screen = feSrc("mobile/MobileMyCaseDetail.tsx");
    expect(screen).toContain("/sales-comment");
    expect(screen).toContain("/sales-nudge");
    expect((screen.match(/onError:/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(stripComments(screen)).not.toContain("catch {}");
  });

  test("the read-only screen mounts NO write control", () => {
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
    expect(guard).not.toMatch(/from\s+["']\.\/salesAccess["']/);
  });

  test("both cohort keys are real capabilities", () => {
    for (const key of ["org.sales.staff", "org.salesDirector"]) {
      expect(CAPABILITY_KEYS as readonly string[]).toContain(key);
    }
  });
});

describe("reference reads surface their failures", () => {
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
    expect((text.match(/setRefError\(/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect((text.match(/\{refError && \(/g) ?? []).length).toBe(1);
  });

  test("the ServiceCases lightbox no longer sits on Loading forever", () => {
    const text = feSrc("pages/ServiceCases.tsx");
    expect(text).toContain("setLoadError(");
    expect(text).toContain("This attachment couldn't be opened");
  });
});
