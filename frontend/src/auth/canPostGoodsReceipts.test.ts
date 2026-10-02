/* Posting a GRN is separate from operating one (owner 2026-10-01): the
   storekeeper drafts and scans racks, the purchaser posts. */
import { describe, expect, it } from "vitest";
import type { AuthUser } from "../types";
import { canPostGoodsReceipts } from "./salesAccess";

const user = (over: Partial<AuthUser>): AuthUser => ({ permissions: [], position_capabilities: [], ...over } as unknown as AuthUser);

describe("canPostGoodsReceipts", () => {
  it("is true only with the Post GRN capability", () => {
    expect(canPostGoodsReceipts(user({ position_capabilities: ["scm.grn.post"] }))).toBe(true);
    expect(canPostGoodsReceipts(user({ position_capabilities: ["scm.do.load"] }))).toBe(false);
    expect(canPostGoodsReceipts(null)).toBe(false);
  });

  it("admits a wildcard caller, whose session carries no capability rows", () => {
    expect(canPostGoodsReceipts(user({ permissions: ["*"] }))).toBe(true);
  });
});
