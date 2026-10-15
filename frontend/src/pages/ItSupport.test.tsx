import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), postForm: vi.fn(), fetchBlobUrl: vi.fn() },
}));
vi.mock("../api/client", () => ({ api }));

import { ItSupport } from "./ItSupport";

const ROW = {
  code: "HC-0001", type: "bug", priority: "high", status: "waiting_reporter", title: "Delivery order will not save",
  created_at: "2026-10-12T02:00:00.000Z", updated_at: "2026-10-12T03:00:00.000Z", assignee_name: "Samuel", unread: true,
};
const detail = (status: string, extra: object[] = []) => ({
  ticket: {
    code: "HC-0001", type: "bug", priority: "high", status, title: "Delivery order will not save",
    description: "After choosing the lorry", assignee_name: "Samuel",
    created_at: "2026-10-12T02:00:00.000Z", updated_at: "2026-10-12T03:00:00.000Z",
  },
  events: [
    { id: 1, kind: "created", author_kind: "reporter", author_name: "Aina", body: null, from_value: null, to_value: null,
      created_at: "2026-10-12T02:00:00.000Z",
      attachments: [{ id: 9, event_id: 1, filename: "shot.png", mime: "image/png", size: 10 }] },
    { id: 2, kind: "assign", author_kind: "developer", author_name: "Samuel", body: null, from_value: null, to_value: "Samuel",
      created_at: "2026-10-12T02:10:00.000Z", attachments: [] },
    { id: 3, kind: "comment", author_kind: "developer", author_name: "Samuel", body: "Which lorry was it?", from_value: null,
      to_value: null, created_at: "2026-10-12T02:20:00.000Z", attachments: [] },
    { id: 4, kind: "status", author_kind: "developer", author_name: "Samuel", body: null, from_value: "in_progress",
      to_value: status, created_at: "2026-10-12T02:21:00.000Z", attachments: [] },
    ...extra,
  ],
});

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.pathname + loc.search}</output>;
}
const open = (url: string) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[url]}>
        <ItSupport />
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  api.postForm.mockReset();
  api.fetchBlobUrl.mockReset();
  // The picture previews; jsdom has no object URLs.
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => cleanup());

describe("IT Support — my requests", () => {
  it("lists the caller's requests, marks the unread one, and opens one by URL", async () => {
    api.get.mockResolvedValue({ tickets: [ROW, { ...ROW, code: "HC-0002", title: "Add a column", status: "open", assignee_name: null, unread: false }] });
    open("/it-support");
    expect(await screen.findByText("Delivery order will not save")).toBeTruthy();
    expect(api.get.mock.calls[0][0]).toBe("/api/it-support/tickets");
    // A signal is passed so the read cache is bypassed: IT may have just replied.
    expect(api.get.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(screen.getByText("New reply")).toBeTruthy();
    expect(screen.getByText("Waiting for you")).toBeTruthy();
    expect(screen.getByText("Not picked up yet")).toBeTruthy();
    fireEvent.click(screen.getByText("Add a column"));
    expect(screen.getByTestId("where").textContent).toBe("/it-support?request=HC-0002");
  });

  it("All / Active / Resolved: counts from every request, the tab kept in the URL", async () => {
    const done = { ...ROW, code: "HC-0003", title: "Printer offline", status: "closed", unread: false };
    api.get.mockResolvedValue({ tickets: [ROW, done] });
    open("/it-support");
    expect(await screen.findByText("Printer offline")).toBeTruthy();
    expect(screen.getAllByText("High")).toHaveLength(2);
    fireEvent.click(screen.getByText("Resolved"));
    expect(screen.getByTestId("where").textContent).toBe("/it-support?tab=resolved");
    expect(screen.queryByText("Delivery order will not save")).toBeNull();
    expect(screen.getByText("Printer offline")).toBeTruthy();
    fireEvent.click(screen.getByText("Active"));
    expect(screen.getByText("Delivery order will not save")).toBeTruthy();
    expect(screen.queryByText("Printer offline")).toBeNull();
  });

  it("says nothing was sent only when the server answered with nothing", async () => {
    api.get.mockResolvedValue({ tickets: [] });
    open("/it-support");
    expect(await screen.findByText("Nothing sent to IT yet.")).toBeTruthy();
    fireEvent.click(screen.getAllByText("Report a problem")[1]);
    expect(screen.getByTestId("where").textContent).toBe("/it-support?new=1");
  });

  it("a list that failed to load is shown as a failure, with the server's sentence, and can be retried", async () => {
    api.get.mockRejectedValueOnce(new Error("IT Support is not connected on this system yet. Please tell IT directly for now."));
    open("/it-support");
    expect(await screen.findByText("We couldn't load your IT requests.")).toBeTruthy();
    expect(screen.getByText(/not connected on this system yet/)).toBeTruthy();
    expect(screen.queryByText("Nothing sent to IT yet.")).toBeNull();
    api.get.mockResolvedValue({ tickets: [ROW] });
    fireEvent.click(screen.getByText("Retry"));
    expect(await screen.findByText("Delivery order will not save")).toBeTruthy();
  });
});

describe("IT Support — report a problem", () => {
  it("refuses a blank title without calling the server", async () => {
    open("/it-support?new=1");
    fireEvent.click(screen.getByText("Send"));
    expect(await screen.findByText("Say in a few words what the problem is.")).toBeTruthy();
    expect(api.postForm).not.toHaveBeenCalled();
  });

  it("sends the form with the page it came from and opens the new request", async () => {
    api.postForm.mockResolvedValue({ code: "HC-0007" });
    api.get.mockResolvedValue(detail("open"));
    open("/it-support?new=1&from=%2Fscm%2Fdelivery-orders");
    fireEvent.change(screen.getByPlaceholderText("The delivery order will not save"), { target: { value: "  Printer is offline " } });
    fireEvent.change(screen.getByLabelText(/^Details/), { target: { value: "Since this morning" } });
    fireEvent.change(screen.getByDisplayValue("Medium"), { target: { value: "high" } });
    fireEvent.change(screen.getByDisplayValue("Something is not working"), { target: { value: "development" } });
    const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [new File(["x"], "shot.png", { type: "image/png" })] } });
    expect(screen.getByLabelText("Preview shot.png")).toBeTruthy();
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/it-support?request=HC-0007"));
    const [path, form] = api.postForm.mock.calls[0] as [string, FormData];
    expect(path).toBe("/api/it-support/tickets");
    expect(form.get("title")).toBe("Printer is offline");
    expect(form.get("description")).toBe("Since this morning");
    expect(form.get("priority")).toBe("high");
    expect(form.get("type")).toBe("development");
    expect(form.get("page_url")).toBe("/scm/delivery-orders");
    expect(Number.isNaN(Date.parse(String(form.get("occurred_at"))))).toBe(false);
    expect((form.getAll("files") as File[]).map((f) => f.name)).toEqual(["shot.png"]);
    // Who is reporting is the server's business, never the form's.
    expect(form.get("reporter_name")).toBeNull();
  });

  it("shows the server's refusal and keeps what was typed; a file over 10 MB or a sixth file is refused here", async () => {
    api.postForm.mockRejectedValue(new Error("IT Support could not be reached. Please try again in a moment."));
    open("/it-support?new=1");
    const title = screen.getByPlaceholderText("The delivery order will not save") as HTMLInputElement;
    fireEvent.change(title, { target: { value: "Printer" } });
    const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
    const big = new File(["x"], "video.mp4", { type: "video/mp4" });
    Object.defineProperty(big, "size", { value: 11 * 1024 * 1024 });
    fireEvent.change(picker, { target: { files: [big] } });
    expect(screen.getByText("video.mp4 is larger than 10 MB.")).toBeTruthy();
    const six = Array.from({ length: 6 }, (_, i) => new File(["x"], `s${i}.png`, { type: "image/png" }));
    fireEvent.change(picker, { target: { files: six } });
    expect(screen.getByText("Attach at most 5 files.")).toBeTruthy();
    fireEvent.change(picker, { target: { files: [six[0]] } });
    fireEvent.click(screen.getByLabelText("Remove s0.png"));
    expect(screen.queryByLabelText("Preview s0.png")).toBeNull();

    fireEvent.click(screen.getByText("Send"));
    expect(await screen.findByText(/could not be reached/)).toBeTruthy();
    expect(title.value).toBe("Printer");
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.getByTestId("where").textContent).toBe("/it-support");
  });

  it("takes a dropped file and a pasted screenshot, refuses a file IT cannot open, and previews a picture", () => {
    open("/it-support?new=1");
    const zone = screen.getByText(/Drop files here/).closest("label") as HTMLLabelElement;
    fireEvent.drop(zone, { dataTransfer: { types: ["Files"], files: [new File(["x"], "notes.docx", { type: "application/msword" })] } });
    expect(screen.getByText("notes.docx is not a picture, MP4 or MOV video, or PDF.")).toBeTruthy();
    fireEvent.drop(zone, { dataTransfer: { types: ["Files"], files: [new File(["x"], "clip.mp4", { type: "video/mp4" })] } });
    expect(screen.getByLabelText("Remove clip.mp4")).toBeTruthy();

    const paste = new Event("paste", { bubbles: true, cancelable: true });
    const shot = new File(["x"], "image.png", { type: "image/png" });
    Object.defineProperty(paste, "clipboardData", { value: { items: [{ kind: "file", getAsFile: () => shot }] } });
    fireEvent(document, paste);
    expect(screen.getByLabelText("Preview image.png")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Preview image.png"));
    expect(screen.getByRole("dialog", { name: "image.png" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("IT Support — one request", () => {
  it("shows IT's reply and the state in the reporter's words; a reply is sent and the page reloads", async () => {
    api.get.mockResolvedValue(detail("waiting_reporter"));
    api.postForm.mockResolvedValue({ ok: true, status: "in_progress" });
    open("/it-support?request=HC-0001");
    expect(await screen.findByText("Which lorry was it?")).toBeTruthy();
    expect(api.get.mock.calls[0][0]).toBe("/api/it-support/tickets/HC-0001");
    expect(screen.getByText("Something is not working · High · Handled by Samuel")).toBeTruthy();
    expect(screen.getByText("gave it to Samuel")).toBeTruthy();
    expect(screen.getByText("changed it to Waiting for you")).toBeTruthy();
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.queryByText("Yes, it is fixed")).toBeNull();

    fireEvent.click(screen.getByText("Send reply"));
    expect(await screen.findByText("Write a reply or attach a file.")).toBeTruthy();
    expect(api.postForm).not.toHaveBeenCalled();

    const box = screen.getByLabelText("Reply to IT") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: " Lorry WXY 1234 " } });
    fireEvent.click(screen.getByText("Send reply"));
    await waitFor(() => expect(api.postForm).toHaveBeenCalledTimes(1));
    const [path, form] = api.postForm.mock.calls[0] as [string, FormData];
    expect(path).toBe("/api/it-support/tickets/HC-0001/replies");
    expect(form.get("body")).toBe("Lorry WXY 1234");
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(box.value).toBe(""));
  });

  it("done: the fix can be confirmed; a refusal is shown, not swallowed", async () => {
    api.get.mockResolvedValue(detail("resolved"));
    api.post.mockRejectedValueOnce(new Error("IT has not marked this request as done yet, so there is nothing to confirm."));
    open("/it-support?request=HC-0001");
    fireEvent.click(await screen.findByText("Yes, it is fixed"));
    expect(await screen.findByText(/nothing to confirm/)).toBeTruthy();

    api.post.mockResolvedValue({ ok: true, status: "closed" });
    api.get.mockResolvedValue(detail("closed"));
    fireEvent.click(screen.getByText("Yes, it is fixed"));
    expect(await screen.findByText("This request is closed. If the problem is back, report it again.")).toBeTruthy();
    expect(api.post.mock.calls[1][0]).toBe("/api/it-support/tickets/HC-0001/confirm");
    expect(screen.queryByLabelText("Reply to IT")).toBeNull();
  });

  it("opens a file through the authorised blob fetch, and says so when it cannot", async () => {
    api.get.mockResolvedValue(detail("in_progress"));
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    api.fetchBlobUrl.mockResolvedValueOnce("blob:test");
    open("/it-support?request=HC-0001");
    fireEvent.click(await screen.findByText("shot.png"));
    await waitFor(() => expect(opened).toHaveBeenCalledWith("blob:test", "_blank", "noopener"));
    expect(api.fetchBlobUrl).toHaveBeenCalledWith("/api/it-support/attachments/9", "image/png");

    api.fetchBlobUrl.mockRejectedValueOnce(new Error("That file could not be found."));
    fireEvent.click(screen.getByText("shot.png"));
    expect(await screen.findByText("That file could not be found.")).toBeTruthy();
    opened.mockRestore();
  });

  it("a request that failed to load says so and retries; an unknown state from the hub is shown as spelled", async () => {
    api.get.mockRejectedValueOnce(new Error("That IT request could not be found."));
    open("/it-support?request=HC-0404");
    expect(await screen.findByText("We couldn't open this IT request.")).toBeTruthy();
    expect(screen.getByText("That IT request could not be found.")).toBeTruthy();

    api.get.mockResolvedValue(detail("escalated", [
      { id: 5, kind: "assign", author_kind: "developer", author_name: "Samuel", body: null, from_value: "Samuel", to_value: null,
        created_at: "2026-10-12T02:30:00.000Z", attachments: [] },
      { id: 6, kind: "status", author_kind: "system", author_name: "System", body: null, from_value: null, to_value: null,
        created_at: "2026-10-12T02:31:00.000Z", attachments: [] },
    ]));
    fireEvent.click(screen.getByText("Retry"));
    expect(await screen.findByText("changed it to escalated")).toBeTruthy();
    expect(screen.getByText("took it off the person handling it")).toBeTruthy();
    expect(screen.getByText("changed it to a new state")).toBeTruthy();
    fireEvent.click(screen.getByText("All my requests"));
    expect(screen.getByTestId("where").textContent).toBe("/it-support");
  });
});
