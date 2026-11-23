/* The no-login booking page: the person with the link picks the day, the room and the time range,
 * sees only when each room is taken (never what or by whom), books with their details, and lands on
 * a private confirmation address they can cancel from. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../lib/requestCorrelation", () => ({ correlatedFetch: fetchMock }));

import { MeetingBook } from "./MeetingBook";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const TOKEN = "a".repeat(64);
const MY = 8 * 3600_000;
const myDay = (t: number) => new Date(t + MY).toISOString().slice(0, 10);
const todayWd = new Date(`${myDay(Date.now())}T12:00:00+08:00`).getUTCDay();
// Every day but today, so the first day offered is tomorrow whatever the clock says.
const DAYS = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== todayWd);
const tomorrow = myDay(Date.now() + 86400_000);
const LINK = {
  code: "hc-abc123", name: "Supplier visits", length: 120, maxMinutes: 120, days: DAYS, from: 8, to: 20, until: null, audience: "anyone",
  rooms: [{ id: 1, name: "Boardroom", seats: 12, location: "Head office", floor: "Level 2", equipment: ["TV"] }, { id: 2, name: "Room 1", seats: 4, location: "Head office", floor: "", equipment: [] }],
};

beforeEach(() => {
  fetchMock.mockReset();
  window.history.replaceState(null, "", "/book/hc-abc123");
});
afterEach(() => cleanup());

describe("MeetingBook", () => {
  it("picks a room and a time range, books, and moves to the private confirmation address", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/public/meetings/links/hc-abc123")) return json({ link: LINK, companies: [{ name: "Hookka", departments: ["Purchasing"] }] });
      if (url.includes("/day?day=")) return json({ day: tomorrow, open: true, rooms: [{ id: 1, closed: null, busy: [{ start: `${tomorrow}T08:00:00+08:00`, end: `${tomorrow}T10:30:00+08:00` }] }, { id: 2, closed: null, busy: [] }] });
      if (url.endsWith("/book") && init?.method === "POST") return json({ ok: true, token: TOKEN, booking: { code: "MTG-0042", title: "Intro", people: 3, start: `${tomorrow}T10:30:00+08:00`, end: `${tomorrow}T11:30:00+08:00`, room: { name: "Boardroom", floor: "Level 2", location: "Head office" } } }, 201);
      throw new Error(url);
    });
    render(<MeetingBook />);
    expect(await screen.findByText("Book a meeting room")).toBeTruthy();
    // Taken times show as "Booked" with no title and no name.
    expect((await screen.findAllByText("Booked")).length).toBe(1);
    fireEvent.change(screen.getByLabelText("Company"), { target: { value: "__other" } });
    fireEvent.change(screen.getByLabelText("Your company name"), { target: { value: "ABC Trading" } });
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Mr Lee" } });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "+60 12 345 6789" } });
    fireEvent.change(screen.getByLabelText("Email (for the confirmation)"), { target: { value: "lee@example.com" } });
    fireEvent.change(screen.getByLabelText("Meeting title"), { target: { value: "Intro" } });
    fireEvent.click(screen.getByRole("button", { name: "More people" }));
    // A tap on the room picks its first free hour (10:30, after the 08:00-10:30 booking).
    fireEvent.click(screen.getByRole("button", { name: /^Boardroom/ }));
    expect((screen.getByLabelText("From") as HTMLSelectElement).value).toBe(String(10 * 60 + 30));
    fireEvent.click(screen.getByRole("button", { name: "Book room" }));
    expect(await screen.findByText("Booked. You are confirmed.")).toBeTruthy();
    expect(screen.getByText("MTG-0042")).toBeTruthy();
    expect(window.location.search).toBe(`?b=${TOKEN}`);
    const body = JSON.parse(String(fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/book"))![1].body));
    expect(body).toEqual({
      name: "Mr Lee", phone: "+60 12 345 6789", email: "lee@example.com", company: "ABC Trading", department: "",
      title: "Intro", people: 3, roomId: 1, start: `${tomorrow}T10:30:00+08:00`, end: `${tomorrow}T11:30:00+08:00`,
    });
  });

  it("says what is still needed, and warns when the picked time is taken", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/links/hc-abc123")) return json({ link: LINK, companies: [] });
      if (url.includes("/day?day=")) return json({ day: tomorrow, open: true, rooms: [{ id: 1, closed: null, busy: [{ start: `${tomorrow}T10:00:00+08:00`, end: `${tomorrow}T11:00:00+08:00` }] }, { id: 2, closed: null, busy: [] }] });
      throw new Error(url);
    });
    render(<MeetingBook />);
    await screen.findByRole("button", { name: /^Boardroom/ });
    expect((screen.getByRole("button", { name: "Book room" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(/Still needed: your company, your name/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /^Boardroom/ }));
    fireEvent.change(screen.getByLabelText("From"), { target: { value: String(10 * 60) } });
    expect(await screen.findByText(/Boardroom is booked 10:00-11:00/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use Room 1" }));
    expect(screen.queryByText(/Boardroom is booked/)).toBeNull();
  });

  it("a guest can cancel from the confirmation address", async () => {
    window.history.replaceState(null, "", `/book/hc-abc123?b=${TOKEN}`);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith(`/bookings/${TOKEN}`)) return json({ booking: { code: "MTG-0042", title: "Intro", people: 3, start: `${tomorrow}T10:00:00+08:00`, end: `${tomorrow}T11:00:00+08:00`, cancelled: false, room: "Boardroom", floor: "Level 2", location: "Head office" } });
      if (url.endsWith(`/bookings/${TOKEN}/cancel`)) return json({ ok: true });
      throw new Error(url);
    });
    render(<MeetingBook />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel this booking" }));
    await waitFor(() => expect(screen.getByText("Booking cancelled")).toBeTruthy());
  });

  it("a dead link says so", async () => {
    fetchMock.mockResolvedValue(json({ error: "This booking link is not active." }, 404));
    render(<MeetingBook />);
    expect(await screen.findByText("This booking link is not active")).toBeTruthy();
    // The hub's own sentence repeats the heading; it is shown once, not twice.
    expect(document.body.textContent.match(/not active/gi)?.length).toBe(1);
  });
});
