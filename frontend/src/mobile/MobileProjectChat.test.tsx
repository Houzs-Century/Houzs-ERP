/* The phone chat reads GET /api/projects/:id/activity, which answers
   { data: [...] } (backend/src/routes/projects.ts). HC-0239: it read
   `activity` instead, so every chat showed "Chat (0)" and a rep re-sent the
   same report five times. */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, test, vi } from "vitest";

const get = vi.fn<(path: string) => Promise<unknown>>();
const post = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
vi.mock("../api/client", () => ({
  api: { get: (path: string) => get(path), post: (path: string, body: unknown) => post(path, body) },
}));
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: 31, name: "Zack" }, can: (permission: string) => permission === "projects.chat" }),
}));

const { MobileProjectChat } = await import("./MobileProjectChat");

const noteRow = (id: number, note: string) => ({
  id, action: "note", note, user_id: 31, user_name: "Zack", created_at: "2026-11-17T12:00:00Z",
});

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MobileProjectChat projectId={364} onPosted={() => {}} />
    </QueryClientProvider>,
  );

describe("MobileProjectChat", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
  });

  test("lists the chat messages the activity endpoint returns under data, without the system rows", async () => {
    get.mockResolvedValueOnce({
      data: [
        { id: 1, action: "stage_change", note: null, user_id: 1, user_name: "Owner", created_at: "2026-11-10T00:00:00Z" },
        noteRow(2, "Zanotti@Bighome\nTotal:RM110,981"),
      ],
    });
    mount();
    await waitFor(() => expect(screen.getByText("Chat (1)")).toBeTruthy());
    expect(get).toHaveBeenCalledWith("/api/projects/364/activity");
    expect(screen.getByText(/Total:RM110,981/)).toBeTruthy();
    expect(screen.queryByText("No messages yet.")).toBeNull();
  });

  test("shows a sent message once the server has it", async () => {
    get.mockResolvedValueOnce({ data: [] });
    mount();
    await waitFor(() => expect(screen.getByText("No messages yet.")).toBeTruthy());

    post.mockResolvedValueOnce({ ok: true });
    get.mockResolvedValueOnce({ data: [noteRow(3, "13/11 - RM35,315")] });
    fireEvent.change(screen.getByPlaceholderText(/paste the evening report/), { target: { value: "13/11 - RM35,315" } });
    fireEvent.click(screen.getByLabelText("Send"));

    await waitFor(() => expect(screen.getByText("Chat (1)")).toBeTruthy());
    expect(post).toHaveBeenCalledWith("/api/projects/364/notes", { note: "13/11 - RM35,315" });
    expect(screen.getByText("13/11 - RM35,315")).toBeTruthy();
  });

  test("keeps the Sending… copy on screen until the reload has the message, so the chat never looks empty after a send", async () => {
    get.mockResolvedValueOnce({ data: [] });
    mount();
    await waitFor(() => expect(screen.getByText("No messages yet.")).toBeTruthy());

    let finishReload: (value: unknown) => void = () => {};
    post.mockResolvedValueOnce({ ok: true });
    get.mockReturnValueOnce(new Promise((resolve) => { finishReload = resolve; }));
    fireEvent.change(screen.getByPlaceholderText(/paste the evening report/), { target: { value: "15/11 - RM29,376" } });
    fireEvent.click(screen.getByLabelText("Send"));

    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Sending…")).toBeTruthy();
    expect(screen.queryByText("No messages yet.")).toBeNull();

    finishReload({ data: [noteRow(4, "15/11 - RM29,376")] });
    await waitFor(() => expect(screen.queryByText("Sending…")).toBeNull());
    expect(screen.getByText("Chat (1)")).toBeTruthy();
  });

  test("a chat that fails to load says so, instead of looking empty", async () => {
    get.mockRejectedValueOnce(new Error("Network error"));
    mount();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Couldn't load the chat (Network error)"));
    expect(screen.queryByText("No messages yet.")).toBeNull();
  });

  test("tells the sender their report is saved when the reload keeps returning the old list, so they don't resend", async () => {
    // Owner 2026-11-19: this is the Zack-posts-5-times regression — the server
    // stored the paste, but every refetch returned the empty list, so the
    // optimistic bubble disappeared into "No messages yet." and the rep hit
    // Send again, and again.
    get.mockResolvedValueOnce({ data: [] });
    mount();
    await waitFor(() => expect(screen.getByText("No messages yet.")).toBeTruthy());

    post.mockResolvedValueOnce({ ok: true });
    get.mockResolvedValue({ data: [] });
    fireEvent.change(screen.getByPlaceholderText(/paste the evening report/), { target: { value: "13/11 - RM35,315" } });
    fireEvent.click(screen.getByLabelText("Send"));

    await waitFor(
      () => expect(screen.getByText(/Saved — the chat will refresh in a moment/)).toBeTruthy(),
      { timeout: 5000 },
    );
    expect(screen.queryByText("Sending…")).toBeNull();
  });
});
