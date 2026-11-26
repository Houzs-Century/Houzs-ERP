// GET /api/notifications is bounded (routes/notifications.ts): "unread" means
// unread within the last UNREAD_WINDOW_DAYS, and every read runs under a
// statement timeout. Pinned here: the window's first day, and that both reads
// carry the window and the timeout (the endpoint itself needs Postgres).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { UNREAD_WINDOW_DAYS, readMarkStamp, unreadWindowStart } from "../src/routes/notifications";

describe("unread window", () => {
  it("starts UNREAD_WINDOW_DAYS before now, as a bare date", () => {
    const now = Date.parse("2026-11-10T03:00:00Z");
    expect(UNREAD_WINDOW_DAYS).toBe(30);
    expect(unreadWindowStart(now)).toBe("2026-10-11");
    expect(unreadWindowStart(now, 1)).toBe("2026-11-09");
  });

  it("compares correctly against both stored created_at shapes", () => {
    const start = unreadWindowStart(Date.parse("2026-11-10T03:00:00Z"));
    expect("2026-10-11 00:00:01" >= start).toBe(true);
    expect("2026-10-11T00:00:01.000Z" >= start).toBe(true);
    expect("2026-10-10 23:59:59" >= start).toBe(false);
  });

  it("both reads carry the window and run under the statement timeout", () => {
    const src = readFileSync(resolve(__dirname, "../src/routes/notifications.ts"), "utf8");
    expect(src.match(/gte\(project_activity\.created_at, windowStart\)/g)?.length).toBe(2);
    expect(src).toContain("SET LOCAL statement_timeout");
    expect(src).toContain("bounded(feedRead), bounded(unreadRead)");
  });
});

// Mark all read left the badge up: last_read_at was "YYYY-MM-DD HH:MM:SS", the
// activity default is "YYYY-MM-DDTHH:MM:SSZ", and " " < "T", so every row from
// the same day still compared as newer than the read.
describe("read mark stamp", () => {
  const unread = (createdAt: string, lastReadAt: string) => createdAt > lastReadAt;

  it("clears activity from earlier the same day, keeps later activity unread", () => {
    const stamp = readMarkStamp(Date.parse("2026-11-26T10:00:00.456Z"));
    expect(stamp).toBe("2026-11-26T10:00:00Z");
    expect(unread("2026-11-26T09:59:59Z", stamp)).toBe(false);
    expect(unread("2026-11-26T10:00:00Z", stamp)).toBe(false);
    expect(unread("2026-11-26T10:00:01Z", stamp)).toBe(true);
    expect(unread("2026-11-26 09:59:59", stamp)).toBe(false);
  });

  it("POST /projects/:id/read writes the stamp, not datetime('now')", () => {
    const src = readFileSync(resolve(__dirname, "../src/routes/projects.ts"), "utf8");
    const route = src.slice(src.indexOf('app.post("/:id/read"'), src.indexOf("// ── Archive / restore"));
    expect(route).toContain("readMarkStamp(Date.now())");
    expect(route).not.toContain("datetime('now')");
  });
});
