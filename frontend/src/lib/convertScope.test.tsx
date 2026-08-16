import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONVERT_LINKS,
  convertToLink,
  readConvertScope,
  UnrecognisedScopeNotice,
} from "./convertScope";

afterEach(cleanup);

/* The contract these tests pin exists because eight of the ten convert pickers
   never read the parameter their callers sent, and two callers spelled it
   differently from what the destination read (?fromGrn= vs grnId=). Both
   failures are invisible when each site invents its own string, so the string
   lives in ONE table and both sides derive from it. */

describe("convertToLink — the caller half", () => {
  it("names the parameter from the table, not from the call site", () => {
    expect(convertToLink("doToSi", "do-1")).toBe("/scm/sales-invoices/from-do?doId=do-1");
    expect(convertToLink("grnToPi", "grn-1")).toBe("/scm/purchase-invoices/from-grn?grnId=grn-1");
    expect(convertToLink("soToDo", "HC-SO-1")).toBe("/scm/delivery-orders/from-so?soDocNo=HC-SO-1");
  });

  /* The exact bug: the GRN screens sent ?fromGrn= to a page reading grnId. */
  it("sends a Purchase Return the name that page actually reads", () => {
    expect(convertToLink("grnToPr", "grn-1")).toBe("/scm/purchase-returns/new?grnId=grn-1");
    expect(convertToLink("grnToPr", "grn-1")).not.toContain("fromGrn");
  });

  it("carries many sources as one comma list (the PO list's bulk convert)", () => {
    expect(convertToLink("poToGrn", ["po-1", "po-2"]))
      .toBe("/scm/grns/from-po?poId=po-1%2Cpo-2");
  });

  it("drops the query string entirely when there is nothing to scope to", () => {
    expect(convertToLink("poToGrn", [])).toBe("/scm/grns/from-po");
    expect(convertToLink("poToGrn", "  ")).toBe("/scm/grns/from-po");
  });

  it("round-trips through readConvertScope for every pair in the table", () => {
    for (const pair of Object.keys(CONVERT_LINKS) as (keyof typeof CONVERT_LINKS)[]) {
      const url = new URL(`http://x${convertToLink(pair, ["a", "b"])}`);
      const scope = readConvertScope(pair, url.searchParams, []);
      expect([...scope.keys].sort()).toEqual(["a", "b"]);
      expect(scope.unknown).toEqual([]);
    }
  });
});

describe("readConvertScope — the destination half", () => {
  it("an absent parameter is an empty scope, which means the FULL picker", () => {
    const scope = readConvertScope("doToSi", new URLSearchParams(""), []);
    expect(scope.keys.size).toBe(0);
    expect(scope.unknown).toEqual([]);
  });

  it("reports a parameter it does not understand instead of dropping it", () => {
    const scope = readConvertScope("grnToPr", new URLSearchParams("fromGrn=grn-1"), ["poId"]);
    expect(scope.keys.size).toBe(0);
    expect(scope.unknown).toEqual(["fromGrn"]);
  });

  it("does not report the other parameters the screen declared", () => {
    const scope = readConvertScope("poToGrn", new URLSearchParams("poId=po-1&appendToGrn=g1"), [
      "appendToGrn",
    ]);
    expect([...scope.keys]).toEqual(["po-1"]);
    expect(scope.unknown).toEqual([]);
  });

  it("ignores blanks inside the list rather than scoping to an empty key", () => {
    const scope = readConvertScope("poToGrn", new URLSearchParams("poId=po-1,,%20,po-2"), []);
    expect([...scope.keys].sort()).toEqual(["po-1", "po-2"]);
  });
});

describe("UnrecognisedScopeNotice — the loud half", () => {
  it("renders nothing when every parameter was understood", () => {
    const { container } = render(<UnrecognisedScopeNotice unknown={[]} />);
    expect(container.textContent).toBe("");
  });

  it("names the parameter and says it was NOT applied", () => {
    render(<UnrecognisedScopeNotice unknown={["fromGrn"]} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("fromGrn");
    expect(alert.textContent).toContain("NOT been applied");
  });
});

/* The guard that keeps the table the ONLY spelling.
 *
 * A convention people have to remember is the thing that failed here — five
 * call sites invented `?do=`, `?grn=`, `?so=` and two more sent `?fromGrn=` to
 * a page reading `grnId`. So no site may hand-write a query onto a convert
 * path: it has to come from convertToLink(), where the name is written once.
 * A new hand-built link fails HERE, naming the file and the parameter.
 */
describe("no site hand-builds a convert link", () => {
  // Parameters on a convert path that are NOT a source scope, so they are
  // legitimately hand-written. `appendToGrn` names an existing DESTINATION GRN
  // to append the picked lines into — the opposite direction to a scope.
  const NON_SCOPE_PARAMS: Record<string, readonly string[]> = {
    "/scm/grns/from-po": ["appendToGrn"],
  };
  // This module writes the table; these two suites deliberately write the OLD
  // spellings to prove they are REPORTED rather than honoured.
  const EXEMPT = [
    "src/lib/convertScope.tsx",
    "src/lib/convertScope.test.tsx",
    "src/pages/scm-v2/convert-scope-pickers.test.tsx",
  ];

  // Resolved from THIS file, not process.cwd(): the scan must find the same
  // tree whichever directory vitest was launched from.
  const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const APP = resolve(SRC, "..");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(e)) out.push(p);
    }
    return out;
  };

  it("every scope parameter on a convert path comes from convertToLink", () => {
    const paths = [...new Set(Object.values(CONVERT_LINKS).map((l) => l.path))];
    const offences: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(APP, file).replace(/\\/g, "/");
      if (EXEMPT.includes(rel)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const path of paths) {
          // Only a QUOTED occurrence is a link; the same text in prose is a
          // comment describing one.
          const re = new RegExp(`['"\`]${path}\\?([A-Za-z_][A-Za-z0-9_]*)=`, "g");
          for (const m of line.matchAll(re)) {
            if ((NON_SCOPE_PARAMS[path] ?? []).includes(m[1])) continue;
            offences.push(`${rel}:${i + 1} hand-writes ${path}?${m[1]}=`);
          }
        }
      });
    }
    expect(offences).toEqual([]);
  });
});
