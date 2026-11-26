import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), postForm: vi.fn(), fetchBlobUrl: vi.fn(), baseUrl: "" },
}));
vi.mock("../../api/client", () => ({ api }));

import { Meetings } from "./index";
import { MobileMeetings } from "../../mobile/MobileMeetings";

const day = (h: number, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
const ROOM = { id: 1, name: "Boardroom", location: "Head office", floor: "Level 2", seats: 12, equipment: ["TV"], open_days: [0, 1, 2, 3, 4, 5, 6], open_from: 7, open_to: 23, color: "#0b8043", buffer_min: 15, max_hours: 4, advance_days: 90, active: true, closures: [] };
const PEOPLE = [
  { key: "lim@x", name: "Lim", email: "lim@x", company: "Houzs Century", department: "Management" },
  { key: "adrian@x", name: "Adrian", email: "adrian@x", company: "Houzs Century", department: "Sales" },
  { key: "ivy@x", name: "Ivy", email: "ivy@x", company: "Hookka", department: "Purchasing" },
];
const MEETING = { id: 7, title: "Weekly sales review", start: day(10), end: day(11), roomId: 1, organizer: "lim@x", bookedBy: "lim@x", attendees: ["adrian@x"], notes: "", video: { type: "none", url: "" }, reminders: [{ min: 15, ch: ["erp"] }], status: "scheduled", startedAt: null, endedAt: null, seriesId: null, createdIn: "HC", linkId: null, guest: null };

function serve(canManage: boolean) {
  api.get.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/meetings/bootstrap")) return { me: "lim@x", canManage, rooms: [ROOM], people: PEOPLE, unread: 2 };
    if (path.startsWith("/api/meetings/calendar")) return { meetings: [MEETING] };
    if (path.startsWith("/api/meetings/mine")) return { meetings: [MEETING], notifications: [{ id: 1, meetingId: 7, text: "Ivy invited you to Supplier call.", at: day(9), read: false }] };
    if (path.startsWith("/api/meetings/links")) return { links: [{ id: 3, code: "hc-abc123", name: "Showroom visits", rooms: [1], length: 60, days: [1, 2, 3], from: 10, to: 17, until: null, hosts: ["lim@x"], createdIn: "HC", active: true, createdBy: "lim@x", booked: 2 }] };
    if (path.startsWith("/api/meetings/log")) return { log: [{ at: day(8), who: "lim@x", text: "Added room Boardroom" }] };
    if (path.startsWith("/api/meetings/meetings/7")) return { meeting: MEETING, history: [{ at: day(8), who: "lim@x", text: "booked it" }], files: [] };
    throw new Error(`unexpected ${path}`);
  });
  api.post.mockResolvedValue({});
}

const withQuery = (ui: ReactNode) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>;
const open = (url: string) => render(withQuery(<MemoryRouter initialEntries={[url]}><Meetings /></MemoryRouter>));

beforeEach(() => {
  for (const f of [api.get, api.post, api.patch, api.postForm, api.fetchBlobUrl]) f.mockReset();
});
afterEach(() => cleanup());

describe("Meetings", () => {
  it("draws the hub's meetings and opens one with its people and history", async () => {
    serve(false);
    open("/meetings?view=day");
    const ev = await screen.findByRole("button", { name: /Weekly sales review/ });
    fireEvent.keyDown(ev, { key: "Enter" });
    const dlg = await screen.findByRole("dialog", { name: "Meeting details" });
    expect(within(dlg).getByText(/Adrian/)).toBeTruthy();
    await waitFor(() => expect(within(dlg).getByText(/History · 1/)).toBeTruthy());
    expect(within(dlg).getByRole("button", { name: "Start meeting" })).toBeTruthy();
  });

  it("a booking conflict opens the dialog from the 409 body and never drops anyone", async () => {
    serve(false);
    const conflict = { error: "conflict", conflict: { room: null, people: [{ key: "adrian@x", meeting: { id: 9, title: "Supplier visit", start: Date.parse(day(13, 30)), end: Date.parse(day(15)) } }], rules: [] }, suggestTime: day(15), suggestRooms: [] };
    api.post.mockRejectedValueOnce(Object.assign(new Error("conflict"), { status: 409, rawBody: JSON.stringify(conflict) }));
    open("/meetings?view=week");
    fireEvent.click((await screen.findAllByRole("button", { name: /Book a room/ }))[0]);
    const editor = await screen.findByRole("dialog", { name: "Meeting" });
    fireEvent.change(within(editor).getByLabelText("Title"), { target: { value: "Q4 planning" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    const dlg = await screen.findByRole("dialog", { name: "Can't book" });
    expect(within(dlg).getByText("Adrian is already booked")).toBeTruthy();
    expect(within(dlg).getByText(/Adrian is in Supplier visit from 1:30pm to 3pm/)).toBeTruthy();
    expect(within(dlg).queryByRole("button", { name: /Leave .* out/ })).toBeNull();
    expect(within(dlg).getByRole("button", { name: /Move to 3pm/ })).toBeTruthy();
    expect(api.post.mock.calls[0][0]).toBe("/api/meetings/meetings");
    expect(api.post.mock.calls[0][1]).toMatchObject({ title: "Q4 planning", organizer: "lim@x" });
  });

  it("rooms: edit only with Manage meeting rooms", async () => {
    serve(false);
    open("/meetings?tab=rooms");
    expect(await screen.findByText("Boardroom")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "+ Add room" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Change log" })).toBeNull();
    cleanup();
    serve(true);
    open("/meetings?tab=rooms");
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dlg = await screen.findByRole("dialog", { name: "Room" });
    expect(within(dlg).getByDisplayValue("Boardroom")).toBeTruthy();
  });

  it("guest links show this ERP's address, my meetings show notifications, the log lists changes", async () => {
    serve(true);
    open("/meetings?tab=links");
    expect(await screen.findByText(`${window.location.origin}/book/hc-abc123`)).toBeTruthy();
    expect(screen.getByText("no end date")).toBeTruthy();
    cleanup();
    serve(true);
    open("/meetings?tab=mine");
    expect(await screen.findByText("Ivy invited you to Supplier call.")).toBeTruthy();
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/meetings/notifications/read"));
    cleanup();
    serve(true);
    open("/meetings?tab=log");
    expect(await screen.findByText(/Added room Boardroom/)).toBeTruthy();
    cleanup();
    serve(true);
    open("/meetings?tab=email");
    expect(await screen.findByText(/Email is on/)).toBeTruthy();
  });

  it("month, rooms and list views draw the same meeting; the phone uses the same page", async () => {
    for (const v of ["month", "rooms", "list"]) {
      serve(false);
      open(`/meetings?view=${v}`);
      expect(await screen.findAllByText(/Weekly sales review/)).not.toHaveLength(0);
      cleanup();
    }
    serve(false);
    render(withQuery(<MemoryRouter initialEntries={["/meetings"]}><MobileMeetings onBack={() => undefined} /></MemoryRouter>));
    expect(await screen.findByText("Meetings")).toBeTruthy();
  });
});
