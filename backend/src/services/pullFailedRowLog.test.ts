import { describe, expect, test, vi } from "vitest";

vi.mock("./autocount", async (orig) => ({
  ...(await orig<typeof import("./autocount")>()),
  AutoCountClient: class {
    async getSince() {
      return [{ DocNo: "SO-BAD", SalesLocation: "KL", LastModified: "2026-10-05 10:00:00" }];
    }
  },
}));

import { runPull } from "./pull";

describe("runPull failed-row log", () => {
  test("a failed upsert names the DocNo in the execution log", async () => {
    const logs: unknown[][] = [];
    const DB = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              run: async () => {
                if (sql.includes("execution_logs")) logs.push(args);
                else throw new Error("boom");
              },
              first: async () => null,
              all: async () => {
                throw new Error("boom");
              },
            };
          },
          first: async () => ({ value: "2026-10-03 00:15:54" }),
        };
      },
    };
    const res = await runPull({ DB } as never, "MANUAL", "filtered", null);
    expect(res.failed).toBe(1);
    expect(res.checkpointAdvanced).toBe(false);
    expect(String(logs[0][5])).toContain("Failed rows: SO-BAD: ");
  });
});
