
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const here = resolve(__dirname);
const v2 = readFileSync(resolve(here, "PurchaseReturnDetailV2.tsx"), "utf8");
const editor = readFileSync(resolve(here, "PurchaseReturnDetail.tsx"), "utf8");

describe("PurchaseReturnDetailV2 ?edit=1 forward", () => {
  test("the read-only page lazy-loads the legacy editor", () => {
    expect(v2).toMatch(/lazy\(\(\) =>\s*import\("\.\/PurchaseReturnDetail"\)/);
    expect(v2).toContain('params.get("edit") === "1"');
    expect(v2).toContain("<PurchaseReturnDetailInlineEditor />");
  });

  test("the editor exists, is exported under the name the forward imports, and opens in edit mode from the flag", () => {
    expect(editor).toContain("export const PurchaseReturnDetail =");
    expect(editor).toContain("searchParams.get('edit') === '1'");
  });

  test("Edit is offered only for a POSTED return — the editor locks everything else", () => {
    expect(v2).toContain('const canEdit = eff === "posted"');
    expect(v2).not.toMatch(/\{\s*<Button variant="primary" icon=\{<Edit3 size=\{14\} \/>\} onClick=\{goEdit\}>Edit<\/Button>/);
  });
});
