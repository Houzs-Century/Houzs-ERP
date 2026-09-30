/* Stock transfer rows say which WAY the stock moved (owner 2026-09-30).
 *
 * Symptom: one event's Stock Out (jpg) + Stock In (pdf) records both wore an
 * OUT badge — the owner read them as "two stock outs".
 * Cause: the mobile Floor-plans card pools BOTH tasks' attachments but the
 * row badge was the hardcoded literal OUT.
 * Fix: each pooled attachment carries the direction of the task it is
 * attached to, and the badge renders that.
 *
 * Source-scanned, not rendered — FloorPlans is inline in MobilePMS.tsx (the
 * established shape for this file; see projectActionGates.test.ts header).
 * The same scan pins the sibling 2026-09-30 rule: EVERY plan tile carries its
 * checklist task, so an editor always gets the upload button (3D / 2D /
 * Unfilled used to have no upload path on the phone at all).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "MobilePMS.tsx"), "utf8");
const code = src
  .split(/\r?\n/)
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join("\n");

describe("mobile stock transfer records", () => {
  it("derive IN vs OUT from the task each file is attached to", () => {
    // The pooled list maps item_id -> direction off the task title…
    expect(code).toContain('/^stock\\s*in/i.test((it.title || "").trim()) ? "IN" : "OUT"');
    // …and the row badge renders that direction, never a hardcoded OUT.
    expect(code).toContain("{a.dir}");
    expect(code).not.toMatch(/rbadge[^\n]*\}\}>OUT<\/span>/);
  });
});

describe("mobile floor-plan tiles", () => {
  it("every tile carries its checklist task, so editors always get Upload", () => {
    // One generic upload path (startPlanUpload) + a task on ALL five tiles —
    // 3D / 2D / Unfilled included, which used to have no upload wiring.
    expect(code).toContain("startPlanUpload");
    for (const task of ["task: displayItem", "task: threeDItem", "task: twoDItem", "task: blankItem", "task: filledItem"]) {
      expect(code).toContain(task);
    }
    // The button is gated on the viewer's write right and the task existing.
    expect(code).toContain("{canWrite && t.task && (");
  });
});
