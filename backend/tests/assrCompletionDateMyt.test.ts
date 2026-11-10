import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { transitionStage } from "../src/services/assr";

/* A service case completed before 08:00 Malaysia time was stamped with the
   previous day's completion_date: the Worker's clock is UTC and the date was
   cut from it. completion_date is a Malaysian business date (owner
   2026-11-10: every "today" is the Malaysian day). */

const USER_ID = 72;

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM assr_activity`);
  await env.DB.exec(`DELETE FROM assr_stage_history`);
  await env.DB.exec(`DELETE FROM assr_cases`);
  await env.DB.prepare(`INSERT OR IGNORE INTO roles (id, name) VALUES (1, 'myt-test-role')`).run();
  await env.DB.prepare(`INSERT OR IGNORE INTO users (id, email, role_id, status) VALUES (?, ?, 1, 'active')`)
    .bind(USER_ID, `myt-test-${USER_ID}@example.com`)
    .run();
  await env.DB.prepare(`INSERT INTO assr_cases (id, assr_no, doc_no, stage) VALUES (1, 'ASSR/MYT-1', 'SO-MYT-1', 'under_verification')`).run();
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => vi.useRealTimers());

async function completionDate(): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT completion_date FROM assr_cases WHERE id = 1`).first<{ completion_date: string | null }>();
  return row?.completion_date ?? null;
}

describe("completion_date is the Malaysian day", () => {
  test("completed at 01:30 on 10 Nov (Malaysia) is dated the 10th", async () => {
    vi.setSystemTime(new Date("2026-11-09T17:30:00Z"));
    expect(await transitionStage(env, 1, "completed" as any, USER_ID)).toBe(true);
    expect(await completionDate()).toBe("2026-11-10");
  });

  test("completed at 23:59 on 9 Nov (Malaysia) is dated the 9th", async () => {
    vi.setSystemTime(new Date("2026-11-09T15:59:00Z"));
    await transitionStage(env, 1, "completed" as any, USER_ID);
    expect(await completionDate()).toBe("2026-11-09");
  });
});
