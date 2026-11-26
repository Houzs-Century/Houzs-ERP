import { describe, expect, it } from "vitest";
import {
  bestRoom, busySentences, daysLabel, directoryTree, draftBody, emptyDraft, guestLinkUrl, inUsualHours, layoutDay, meetingColor, nextStart, occupancy, readConflict,
  type Meeting, type Person, type Room,
} from "./meetings";

const room = (o: Partial<Room> = {}): Room => ({
  id: 1, name: "Boardroom", location: "Head office", floor: "Level 2", seats: 12, equipment: [], open_days: [1, 2, 3, 4, 5], open_from: 9, open_to: 18,
  color: "#0b8043", buffer_min: 0, max_hours: 0, advance_days: 0, active: true, closures: [], ...o,
});
const at = (d: string, h: number, m = 0) => new Date(`${d}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`).getTime();
const meeting = (o: Partial<Meeting>): Meeting => ({
  id: 1, title: "M", start: new Date(at("2026-11-23", 10)).toISOString(), end: new Date(at("2026-11-23", 11)).toISOString(), roomId: 1, organizer: "lim@x", bookedBy: "lim@x",
  attendees: [], notes: "", video: { type: "none", url: "" }, reminders: [], status: "scheduled", startedAt: null, endedAt: null, seriesId: null, createdIn: "HC", linkId: null, guest: null, ...o,
});

describe("meetings helpers", () => {
  it("lays overlapping meetings side by side and gives later ones their own cluster", () => {
    const out = layoutDay([{ start: 0, end: 60 }, { start: 30, end: 90 }, { start: 100, end: 120 }]);
    expect(out.map((o) => [o.lane, o.lanes])).toEqual([[0, 2], [1, 2], [0, 1]]);
    expect(out[2].cluster).not.toBe(out[0].cluster);
  });

  it("knows the room's usual hours; overtime is outside them", () => {
    const r = room();
    expect(inUsualHours(r, at("2026-11-23", 10), at("2026-11-23", 11))).toBe(true);
    expect(inUsualHours(r, at("2026-11-23", 18), at("2026-11-23", 20))).toBe(false);
    expect(inUsualHours(r, at("2026-11-22", 10), at("2026-11-22", 11))).toBe(false);
  });

  it("occupancy counts only usual hours and shows after hours apart", () => {
    const week = at("2026-11-22", 0);
    const o = occupancy(room(), [
      meeting({ id: 1 }),
      meeting({ id: 2, start: new Date(at("2026-11-23", 19)).toISOString(), end: new Date(at("2026-11-23", 21)).toISOString() }),
      meeting({ id: 3, roomId: 2 }),
    ], week);
    expect(o).toEqual({ bookings: 2, percent: 2, usedHours: 1, openHours: 45, afterHours: 2 });
  });

  it("colours by room, by company, or by me", () => {
    const people = new Map<string, Person>([["lim@x", { key: "lim@x", name: "Lim", email: "lim@x", company: "Hookka", department: "Sales" }]]);
    const m = meeting({});
    expect(meetingColor(m, "room", "lim@x", [room()], people, ["Hookka"])).toBe("#0b8043");
    expect(meetingColor(m, "company", "lim@x", [room()], people, ["Houzs Century", "Hookka"])).toBe("#e67c00");
    expect(meetingColor(m, "me", "lim@x", [room()], people, [])).toBe("var(--meet-mine)");
    expect(meetingColor(m, "me", "someone@x", [room()], people, [])).toBe("#9aa0a6");
    expect(meetingColor(meeting({ guest: { name: "G", phone: "1", email: "g@x", company: "" } }), "company", "x", [], people, ["Hookka"])).toBe("#616161");
  });

  it("reads a 409 as a conflict and says who is busy when", () => {
    const err = Object.assign(new Error("x"), { status: 409, rawBody: JSON.stringify({ error: "conflict", conflict: { room: null, people: [{ key: "adrian@x", meeting: { id: 3, title: "Supplier visit", start: at("2026-11-23", 13, 30), end: at("2026-11-23", 15) } }], rules: [] }, suggestTime: null, suggestRooms: [] }) });
    const c = readConflict(err);
    expect(c?.conflict.people).toHaveLength(1);
    const people = new Map<string, Person>([["adrian@x", { key: "adrian@x", name: "Adrian", email: null, company: "", department: "" }]]);
    expect(busySentences(c!.conflict, people)).toEqual(["Adrian is in Supplier visit from 1:30pm to 3pm."]);
    expect(readConflict(Object.assign(new Error("x"), { status: 500, rawBody: "{}" }))).toBeNull();
    expect(readConflict(Object.assign(new Error("x"), { status: 409, rawBody: "{\"error\":\"idempotency_in_flight\"}" }))).toBeNull();
  });

  it("sends the hub only what it takes, and no repeat end without a repeat", () => {
    const d = { ...emptyDraft("lim@x", at("2026-11-23", 10), at("2026-11-23", 11), 1), attendees: ["lim@x", "hana@x"], repeatUntil: "2026-12-31", videoType: "none" as const, videoUrl: "https://x" };
    const b = draftBody(d);
    expect(b.attendees).toEqual(["hana@x"]);
    expect(b.repeatUntil).toBeNull();
    expect(b.videoUrl).toBe("");
    expect(b.title).toBe("(No title)");
  });

  it("starts a new booking at the next half hour, or tomorrow 9am after 6pm", () => {
    expect(nextStart(at("2026-11-23", 10, 10), at("2026-11-23", 0))).toBe(at("2026-11-23", 10, 30));
    expect(nextStart(at("2026-11-23", 19), at("2026-11-23", 0))).toBe(at("2026-11-24", 9));
    expect(nextStart(at("2026-11-23", 10), at("2026-11-25", 0))).toBe(at("2026-11-25", 9));
  });

  it("groups the directory by company and department", () => {
    const t = directoryTree([
      { key: "a", name: "Zoe", email: null, company: "Hookka", department: "Sales" },
      { key: "b", name: "Amir", email: null, company: "Hookka", department: "Sales" },
      { key: "c", name: "Lim", email: null, company: "Houzs Century", department: "" },
    ]);
    expect(t.map((x) => x.company)).toEqual(["Hookka", "Houzs Century"]);
    expect(t[0].departments[0].people.map((p) => p.name)).toEqual(["Amir", "Zoe"]);
    expect(t[1].departments[0].name).toBe("No department");
  });

  it("labels days and builds the guest link on this ERP's address", () => {
    expect(daysLabel([1, 2, 3, 4, 5])).toBe("Mon - Fri");
    expect(daysLabel([2, 4])).toBe("Tue, Thu");
    expect(guestLinkUrl("https://erp.houzscentury.com/", "hc-abc123")).toBe("https://erp.houzscentury.com/book/hc-abc123");
  });
});

describe("bestRoom (owner 2026-11-24: smallest free room that fits)", () => {
  it("picks the smallest free room with enough seats, skips taken and inactive ones", () => {
    const rooms = [room({ id: 1, name: "Big", seats: 12 }), room({ id: 2, name: "Small", seats: 4 }), room({ id: 3, name: "Tiny", seats: 2, active: false }), room({ id: 4, name: "Mid", seats: 6 })];
    expect(bestRoom(rooms, 2, new Set())?.name).toBe("Small");
    expect(bestRoom(rooms, 2, new Set([2]))?.name).toBe("Mid");
    expect(bestRoom(rooms, 5, new Set())?.name).toBe("Mid");
    expect(bestRoom(rooms, 20, new Set())).toBeNull();
  });
});
