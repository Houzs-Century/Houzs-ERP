import { describe, it, expect } from "vitest";
import { isHyperdriveUrl } from "./pg";

// A missed Hyperdrive host gets TLS + a 10s connect cap against a socket that
// does not speak TLS: every DB call times out and every signed-in page 500s.
describe("isHyperdriveUrl", () => {
  it("detects the old and the new Hyperdrive binding hosts", () => {
    expect(isHyperdriveUrl("postgresql://u:PASSWORD@abc.hyperdrive.local:5432/postgres")).toBe(true);
    expect(isHyperdriveUrl("postgresql://u:PASSWORD@0123abcd.workers.alt:5432/postgres")).toBe(true);
    expect(isHyperdriveUrl("postgresql://u:PASSWORD@0123abcd.workers.alt/postgres")).toBe(true);
  });

  it("does not treat direct Supabase hosts as Hyperdrive", () => {
    expect(
      isHyperdriveUrl("postgresql://postgres.ref:PASSWORD@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres"),
    ).toBe(false);
    expect(isHyperdriveUrl("postgresql://postgres:PASSWORD@db.ref.supabase.co:5432/postgres")).toBe(false);
  });
});
