/* The no-login booking page: a guest sees free times as ranges, books with their
 * details, and lands on a private confirmation address they can cancel from. It
 * never asks for, or shows, anyone else's meetings. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../lib/requestCorrelation", () => ({ correlatedFetch: fetchMock }));

import { MeetingBook } from "./MeetingBook";
import { addDays, atHour, startOfDay } from "../lib/meetings";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const TOKEN = "a".repeat(64);
const tomorrow = () => new Date(atHour(addDays(startOfDay(Date.now()), 1), 15));

beforeEach(() => {
  fetchMock.mockReset();
  window.history.replaceState(null, "", "/book/hc-abc123");
});
afterEach(() => cleanup());

describe("MeetingBook", () => {
  it("shows free times as ranges, books, and moves to the private confirmation address", async () => {
    const s = tomorrow();
    const e = new Date(s.getTime() + 3600_000);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/public/meetings/links/hc-abc123")) return json({ link: { code: "hc-abc123", name: "Showroom visits", length: 60, days: [0, 1, 2, 3, 4, 5, 6], from: 10, to: 17, until: null, location: "Head office" } });
      if (url.includes("/slots?day=")) return json({ slots: [{ start: s.toISOString(), end: e.toISOString() }] });
      if (url.endsWith("/book") && init?.method === "POST") return json({ ok: true, token: TOKEN, booking: { code: "MTG-0042", start: s.toISOString(), end: e.toISOString(), room: { name: "Boardroom", floor: "Level 2", location: "Head office" } } }, 201);
      throw new Error(url);
    });
    render(<MeetingBook />);
    expect(await screen.findByText("Book: Showroom visits")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "3pm - 4pm" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Mr Lee" } });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "+60 12 345 6789" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "lee@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /^Book / }));
    expect(await screen.findByText("You are booked")).toBeTruthy();
    expect(screen.getByText("MTG-0042")).toBeTruthy();
    expect(window.location.search).toBe(`?b=${TOKEN}`);
    const body = JSON.parse(String(fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/book"))![1].body));
    expect(body).toEqual({ start: s.toISOString(), name: "Mr Lee", phone: "+60 12 345 6789", email: "lee@example.com", company: "" });
  });

  it("a guest can cancel from the confirmation address", async () => {
    window.history.replaceState(null, "", `/book/hc-abc123?b=${TOKEN}`);
    const s = tomorrow();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith(`/bookings/${TOKEN}`)) return json({ booking: { code: "MTG-0042", start: s.toISOString(), end: new Date(s.getTime() + 3600_000).toISOString(), cancelled: false, room: "Boardroom", floor: "Level 2", location: "Head office" } });
      if (url.endsWith(`/bookings/${TOKEN}/cancel`)) return json({ ok: true });
      throw new Error(url);
    });
    render(<MeetingBook />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel booking" }));
    await waitFor(() => expect(screen.getByText("Booking cancelled")).toBeTruthy());
  });

  it("a dead link says so", async () => {
    fetchMock.mockResolvedValue(json({ error: "This booking link is not active." }, 404));
    render(<MeetingBook />);
    expect(await screen.findByText("This booking link is not active")).toBeTruthy();
    // The hub's own sentence repeats the heading; it is shown once, not twice.
    expect(document.body.textContent?.match(/not active/gi)?.length).toBe(1);
  });
});
