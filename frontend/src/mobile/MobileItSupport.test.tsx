import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), postForm: vi.fn(), fetchBlobUrl: vi.fn() },
}));
vi.mock("../api/client", () => ({ api }));

import { MobileItSupport } from "./MobileItSupport";
import { destinationScreen, PROFILE_ORG_ITEMS } from "./MobileApp";
import { resolveMobileRoute } from "./mobileRoute";
import { withoutUnconnectedItSupport } from "../hooks/useItSupportConnected";

const ROW = {
  code: "HC-0001", type: "bug", priority: "high", status: "waiting_reporter", title: "Delivery order will not save",
  created_at: "2026-10-12T02:00:00.000Z", updated_at: "2026-10-12T03:00:00.000Z", assignee_name: "Samuel", unread: true,
};
const detail = (status: string) => ({
  ticket: {
    code: "HC-0001", type: "bug", priority: "high", status, title: "Delivery order will not save",
    description: "After choosing the lorry", assignee_name: "Samuel",
    created_at: "2026-10-12T02:00:00.000Z", updated_at: "2026-10-12T03:00:00.000Z",
  },
  events: [
    { id: 1, kind: "created", author_kind: "reporter", author_name: "Aina", body: null, from_value: null, to_value: null,
      created_at: "2026-10-12T02:00:00.000Z", attachments: [] },
    { id: 2, kind: "comment", author_kind: "developer", author_name: "Samuel", body: "Which lorry was it?", from_value: null,
      to_value: null, created_at: "2026-10-12T02:20:00.000Z", attachments: [] },
  ],
});

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  api.postForm.mockReset();
  api.fetchBlobUrl.mockReset();
});
afterEach(() => cleanup());

describe("IT Support on a phone — reaching it", () => {
  it("/it-support opens the phone screen, not the desktop-only dead end", () => {
    expect(destinationScreen("/it-support", "IT Support")).toEqual({ t: "it-support" });
    const row = { to: "/it-support", label: "IT Support" };
    expect(resolveMobileRoute("/it-support", [row], [row])).toEqual({ t: "menu", to: "/it-support", label: "IT Support" });
  });

  it("is a Profile row, dropped where IT Support is not connected, as on desktop", () => {
    expect(PROFILE_ORG_ITEMS.some((it) => it.to === "/it-support")).toBe(true);
    expect(withoutUnconnectedItSupport(PROFILE_ORG_ITEMS, false).some((it) => it.to === "/it-support")).toBe(false);
    expect(withoutUnconnectedItSupport(PROFILE_ORG_ITEMS, true).some((it) => it.to === "/it-support")).toBe(true);
  });
});

describe("IT Support on a phone — my requests", () => {
  it("lists the caller's requests with the unread mark and the state in the reporter's words", async () => {
    api.get.mockResolvedValue({ tickets: [ROW] });
    render(<MobileItSupport onBack={() => {}} />);
    expect(await screen.findByText("Delivery order will not save")).toBeTruthy();
    expect(api.get.mock.calls[0][0]).toBe("/api/it-support/tickets");
    expect(api.get.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(screen.getByText("New reply")).toBeTruthy();
    expect(screen.getByText("Waiting for you")).toBeTruthy();
  });

  it("a list that failed to load is a failure with the server's sentence, never an empty list", async () => {
    api.get.mockRejectedValueOnce(new Error("IT Support is not connected on this system yet. Please tell IT directly for now."));
    render(<MobileItSupport onBack={() => {}} />);
    expect(await screen.findByText("We couldn't load your IT requests.")).toBeTruthy();
    expect(screen.getByText(/not connected on this system yet/)).toBeTruthy();
    expect(screen.queryByText("Nothing sent to IT yet.")).toBeNull();
    api.get.mockResolvedValueOnce({ tickets: [] });
    fireEvent.click(screen.getByText("Retry"));
    expect(await screen.findByText("Nothing sent to IT yet.")).toBeTruthy();
  });

  it("Back leaves the screen from the list, and returns to the list from a request", async () => {
    const onBack = vi.fn();
    api.get.mockResolvedValueOnce({ tickets: [ROW] }).mockResolvedValue(detail("waiting_reporter"));
    render(<MobileItSupport onBack={onBack} />);
    fireEvent.click(await screen.findByText("Delivery order will not save"));
    expect(await screen.findByText("Which lorry was it?")).toBeTruthy();
    fireEvent.click(screen.getByText(/All my requests/));
    expect(onBack).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByText(/Back/));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("IT Support on a phone — report, reply, confirm", () => {
  it("refuses a blank title without calling the server, then sends the form and opens the new request", async () => {
    api.get.mockResolvedValueOnce({ tickets: [] }).mockResolvedValue(detail("open"));
    api.postForm.mockResolvedValue({ code: "HC-0007" });
    render(<MobileItSupport onBack={() => {}} />);
    await screen.findByText("Nothing sent to IT yet.");
    fireEvent.click(screen.getByText("Report a problem"));
    fireEvent.click(screen.getByText("Send to IT"));
    expect(await screen.findByText("Say in a few words what the problem is.")).toBeTruthy();
    expect(api.postForm).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText("The delivery order will not save"), { target: { value: "Cannot print DO" } });
    fireEvent.click(screen.getByText("Send to IT"));
    await waitFor(() => expect(api.postForm).toHaveBeenCalledTimes(1));
    const [path, form] = api.postForm.mock.calls[0] as [string, FormData];
    expect(path).toBe("/api/it-support/tickets");
    expect(form.get("title")).toBe("Cannot print DO");
    expect(form.get("type")).toBe("bug");
    expect(form.get("priority")).toBe("medium");
    expect(await screen.findByText("IT request")).toBeTruthy();
  });

  it("a reply is sent and the request reloads; Done can be confirmed", async () => {
    api.get.mockResolvedValueOnce({ tickets: [ROW] }).mockResolvedValue(detail("resolved"));
    api.postForm.mockResolvedValue({ ok: true });
    api.post.mockResolvedValue({ ok: true });
    render(<MobileItSupport onBack={() => {}} />);
    fireEvent.click(await screen.findByText("Delivery order will not save"));
    await screen.findByText("Which lorry was it?");

    fireEvent.change(screen.getByLabelText("Reply to IT"), { target: { value: "Lorry 3" } });
    fireEvent.click(screen.getByText("Send reply"));
    await waitFor(() => expect(api.postForm).toHaveBeenCalledWith("/api/it-support/tickets/HC-0001/replies", expect.any(FormData)));

    fireEvent.click(await screen.findByText("Yes, it is fixed"));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/it-support/tickets/HC-0001/confirm"));
  });
});
