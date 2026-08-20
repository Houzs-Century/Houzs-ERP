/* "IS THIS ME?" HAS ONE ANSWER, OR IT HAS AS MANY AS IT HAS SCREENS.
 *
 * `self-staff.ts` exists because three surfaces each wrote their own ladder for
 * resolving the signed-in person against the staff roster, and the answer
 * depended on which screen you were standing on. Its header records the
 * measurement that settled the order — on production 2026-08-12, 102 of 140
 * scm.staff rows carry `user_id` and only 18 carry an email, and `user_id` is
 * the key the BACKEND joins on.
 *
 * A fourth copy survived that consolidation: `SalesOrderDetail.tsx` still
 * matched bridge-staff-id, then email, then name — with no `user_id` rung at
 * all. So on the roster the module was written about, that ladder missed the
 * majority of people.
 *
 * WHAT THIS TEST GUARDS, precisely. Not "nobody may search staffList" — a page
 * looking up the salesperson the OPERATOR PICKED does exactly that, legitimately
 * and by id (`staffList.find((s) => s.id === form.salespersonId)`). That is a
 * different question with a different right answer.
 *
 * The duplication has a narrower fingerprint: matching a staff row by
 * lower-cased EMAIL or by lower-cased NAME. Nothing needs to do that except a
 * self-resolution ladder, and self-resolution has a shared home.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SHARED_HOME = "vendor/scm/lib/self-staff.ts";

function productionSources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return productionSources(path);
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) return [];
    return [path];
  });
}

describe("resolving the signed-in person to a staff row", () => {
  it("matches a staff row by email or name in exactly one place", () => {
    /* Comments stripped first — self-staff.ts's own header and this file
       describe the ladder in prose, and prose is not a call site. */
    const ladders = productionSources()
      .filter((path) => {
        const source = readFileSync(path, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/.*$/gm, "");
        /* A `staffList.find(` whose predicate reaches for a lower-cased email
           or name, in either spelling: the hand-rolled
           `(s.email ?? '').trim().toLowerCase()` and the shared module's own
           `lower(s.email)` helper. Verified to match SalesOrderDetail.tsx and
           self-staff.ts, and NOT to match the legitimate picked-salesperson
           lookups in SalesOrderNew / MobileNewSO / ConsignmentOrderNew, which
           key on `s.id === form.salespersonId`. */
        return /staffList\.find\([\s\S]{0,200}?\.(?:email|name)\b[\s\S]{0,120}?toLowerCase/.test(source)
          || /lower\(\w+\.(?:email|name)\)/.test(source);
      })
      .map((path) => relative(SRC, path).replaceAll("\\", "/"));

    expect(ladders).toEqual([SHARED_HOME]);
  });
});
