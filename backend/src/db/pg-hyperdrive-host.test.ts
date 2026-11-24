import { describe, expect, it } from "vitest";
import { isHyperdriveUrl } from "./pg";

describe("isHyperdriveUrl", () => {
  it("recognises the old and new Hyperdrive binding hosts", () => {
    expect(isHyperdriveUrl("postgresql://u:p@abc123.hyperdrive.local:5432/postgres")).toBe(true);
    expect(isHyperdriveUrl("postgresql://u:p@3a94cdd690cc0ca65227ea4afd1361f4.workers.alt:5432/postgres")).toBe(true);
  });

  it("treats a direct Supabase pooler URL as not Hyperdrive", () => {
    expect(isHyperdriveUrl("postgresql://u:p@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres")).toBe(false);
  });
});
