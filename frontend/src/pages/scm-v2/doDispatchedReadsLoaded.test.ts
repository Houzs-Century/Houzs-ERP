/* THE DELIVERY ORDER'S `DISPATCHED` READS "Loaded" — EVERYWHERE, AND ONLY AS A
 * LABEL.
 *
 * The owner, 2026-08-26, asked where dispatch actually sits: 「dispatch就是出发
 * 了啊?」. On the three-scan flow he settled the same week it is not departure —
 * the storekeeper's scan writes DISPATCHED when the goods go ON the lorry, and
 * DEPARTURE is the driver's next scan (IN_TRANSIT). "Shipped" claimed the truck
 * had left, so the word is now **Loaded**.
 *
 * THE STORED VALUE DOES NOT CHANGE AND MUST NOT. Postgres enum labels are
 * permanent, `scm.do_status` has carried `DISPATCHED` since the beginning, and
 * every report, export and AutoCount read goes to the stored value. This is the
 * same option A as the 2026-08-21 "Confirmed" sweep: change the WORD, never the
 * column. The first test below is what stops a later tidy-up "finishing the job"
 * by renaming the value.
 *
 * WHY A SOURCE SCAN AND NOT THREE UNIT ASSERTIONS.
 * `docs/modules/document-status-vocabulary.md` records that SIXTEEN list and
 * detail pages declare their own `{ tone, label }` map instead of reading
 * `status-pill.ts`, and calls that root fix OPEN. So a unit test over the
 * canonical map proves nothing about the other fifteen, and the previous sweep
 * aligned them BY HAND — which is precisely how `DISPATCHED` came to read
 * "Shipped" on the list and "Dispatched" on the detail page at the same time.
 * The scan is the only assertion that covers a page nobody has written yet.
 *
 * WHAT IS DELIBERATELY NOT COVERED: the SALES ORDER's own `SHIPPED` status. It
 * is a different document with a different enum, its chip was folded into
 * Delivered separately (#2655), and `frontend/src/mobile/MobileSalesOrders.tsx`
 * still lists it — stale for its own reasons, not this one. The scan keys on the
 * token DISPATCHED, so it cannot reach that chip.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { statusLabel } from "../../vendor/scm/lib/status-pill";
import { DO_STATUSES } from "../../vendor/shared/do-shipped-states";
import { statusFor } from "./do-list-status";

describe("the stored value is untouched", () => {
  it("scm.do_status still has DISPATCHED, and no member called LOADED-the-label", () => {
    expect(DO_STATUSES as readonly string[]).toContain("DISPATCHED");
    /* The eight members, from the shared declaration the backend enforces. A
       relabel that quietly added a ninth would be the bug 0530 shape: a status
       literal the enum does not define is a 22P02 and a 400, not a miss. */
    /* eslint-disable no-restricted-syntax -- the literal eight, on purpose: deriving them from DO_STATUSES would assert it against itself */
    expect([...DO_STATUSES].sort()).toEqual([
      "CANCELLED", "DELIVERED", "DISPATCHED", "DRAFT",
      "INVOICED", "IN_TRANSIT", "LOADED", "SIGNED",
    ]);
    /* eslint-enable no-restricted-syntax */
  });
});

describe("the word on screen", () => {
  it("the canonical map reads Loaded", () => {
    expect(statusLabel("do", "DISPATCHED")).toBe("Loaded");
  });

  it("the delivery-order list reads Loaded, and keeps its own bucket", () => {
    expect(statusFor("dispatched").label).toBe("Loaded");
    expect(statusFor("dispatched").bucket).toBe("dispatched");
  });

  /* LOADED reads "Confirmed" and that is the reason DISPATCHED could not simply
     take the obvious word from its own value: the two would collide. Pinned so
     the pair is read together. */
  it("LOADED still reads Confirmed, so the two words do not collide", () => {
    expect(statusLabel("do", "LOADED")).toBe("Confirmed");
    expect(statusFor("loaded").label).toBe("Confirmed");
  });
});

// ── The scan ────────────────────────────────────────────────────────────────

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function productionSources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return productionSources(path);
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) return [];
    return [path];
  });
}

describe("no surface still calls the delivery order's DISPATCHED 'Shipped'", () => {
  /* THE OLD WORD WAS NOT ONE WORD, which is why the pattern below is a small
     alternation rather than a single literal. On 2026-08-26 the same stored
     value read "Shipped" on the list, the pill and the consignment note, and
     "Dispatched" on the delivery-order detail page, and the mobile shell's
     button verb was "Dispatch". All four are refused now. Case matters: the
     STORED literal `"DISPATCHED"` is upper-case and must keep travelling
     freely, so `Dispatch` with a lower-case tail cannot match it. */
  it("no line names DISPATCHED beside a Shipped / Dispatch-shaped label", () => {
    /* Comments are stripped first. This file, status-pill.ts, row-menus.ts and
       DeliveryOrderDetailV2.tsx all EXPLAIN the old word in prose, and
       documentation of a correction must not read as the defect — the same
       reason do-status-evidence.test.tsx strips before scanning. */
    const offenders = productionSources().flatMap((path) => {
      const source = readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      return source
        .split("\n")
        .map((line, i) => [line, i + 1] as const)
        .filter(([line]) => /DISPATCHED/i.test(line) && /['"`](Shipped|Dispatch)/.test(line))
        .map(([line, n]) => `${relative(SRC, path).replaceAll("\\", "/")}:${n}: ${line.trim()}`);
    });

    expect(offenders).toEqual([]);
  });
});
