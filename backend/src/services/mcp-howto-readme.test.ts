import { describe, it, expect } from "vitest";
import { readRepoFile, WRITE_MODE, writeRepoFile } from "../../scripts/lib/frontend-honesty.mjs";
import { howtoReadme } from "./mcp-howto-readme";

const FILE = "docs/modules/how-to-guides.md";

describe("docs/modules/how-to-guides.md", () => {
  it("matches the guide data", () => {
    const want = howtoReadme();
    if (WRITE_MODE) writeRepoFile(FILE, want);
    expect(readRepoFile(FILE), "regenerate: HOWTO_WRITE=1 npx vitest run --config vitest.light.config.mts src/services/mcp-howto-readme.test.ts").toBe(want);
  });
});
