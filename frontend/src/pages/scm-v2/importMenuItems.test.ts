// HC-0003: an "Import from file" menu item must open something. DO, DR, PI, PR,
// SI and SO used to navigate to `?import=1` / `?tab=import`, which no page read,
// so the click did nothing. Owner ruling: import is PO lines only for now
// (tasks/HANDOFF-exports-import-money-2026-09-15.md). Source scan, like
// auth/soMaintenanceGate.test.ts: the item and its handler live in big list pages.

import { expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const pages = readdirSync(HERE).filter((f) => f.endsWith(".tsx") && !f.includes(".test."));
const src = (f: string) => readFileSync(join(HERE, f), "utf8");
// A page that offers the item must also read the param it navigates to.
const readsImportParam = (s: string) => /\.get\(\s*["']import["']\s*\)/.test(s);

test("every list offering 'Import from file' handles it", () => {
  const dead = pages.filter((f) => src(f).includes("Import from file") && !readsImportParam(src(f)));
  expect(dead).toEqual([]);
});

test("PO keeps its line import", () => {
  const po = src("PurchaseOrdersListV2.tsx");
  expect(po).toContain("PoLineImportModal");
  expect(readsImportParam(po)).toBe(true);
});
