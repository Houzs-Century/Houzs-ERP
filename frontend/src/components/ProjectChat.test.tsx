import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectChat, type ActivityRow } from "./ProjectChat";

const { apiGet, apiPost, reload } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  reload: vi.fn(),
}));

/* The sales-report layer needs the app's QueryClient and dialogs and is not
   what these polling tests are about (projectChatSalesReport.test.tsx is); a
   stub keeps it out of the request counts. */
vi.mock("./projectChatSalesReport", () => ({
  useChatSalesReport: () => ({ footerFor: () => null, afterSend: async () => {} }),
}));
vi.mock("../api/client", () => ({
  api: { get: apiGet, post: apiPost },
}));

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: 7 } }),
}));

vi.mock("../hooks/useNotifications", () => ({
  useNotifications: () => ({ reload }),
}));

vi.mock("./Avatar", () => ({
  Avatar: () => <div data-testid="avatar" />,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function row(id: number, note: string, createdAt: string): ActivityRow {
  return {
    id,
    action: "note",
    from_value: null,
    to_value: null,
    note,
    user_id: 8,
    user_name: "Teammate",
    created_at: createdAt,
  };
}

const toast = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
};

function renderChat(projectId = 1) {
  return render(
    <ProjectChat
      projectId={projectId}
      canPost={false}
      toast={toast as never}
    />,
  );
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ProjectChat polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiGet.mockReset();
    apiPost.mockReset().mockResolvedValue({ ok: true });
    reload.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("retries the full history after the initial request fails", async () => {
    apiGet
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        data: [row(1, "Recovered message", "2026-07-20T10:00:00.000Z")],
      });

    renderChat();
    await flushPromises();

    expect(screen.getByText("Unable to load messages. Retrying…")).toBeTruthy();
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(apiGet.mock.calls[0][0]).toBe("/api/projects/1/activity");

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Recovered message")).toBeTruthy();
    expect(apiGet).toHaveBeenCalledTimes(2);
    expect(apiGet.mock.calls[1][0]).toBe("/api/projects/1/activity");
  });

  it("never overlaps interval requests", async () => {
    const first = deferred<{ data: ActivityRow[] }>();
    apiGet
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ data: [] });

    renderChat();
    await flushPromises();
    expect(apiGet).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(9000));
    expect(apiGet).toHaveBeenCalledTimes(1);

    first.resolve({
      data: [row(2, "First response", "2026-07-20T10:01:00.000Z")],
    });
    await flushPromises();

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });

    expect(apiGet).toHaveBeenCalledTimes(2);
    expect(apiGet.mock.calls[1][0]).toContain("/api/projects/1/activity?since=");
  });

  it("aborts the old project request and ignores its late response", async () => {
    const oldProject = deferred<{ data: ActivityRow[] }>();
    const newProject = deferred<{ data: ActivityRow[] }>();
    apiGet.mockImplementation((path: string) =>
      path.startsWith("/api/projects/1/") ? oldProject.promise : newProject.promise,
    );

    const view = renderChat(1);
    await flushPromises();
    const oldSignal = apiGet.mock.calls[0][1].signal as AbortSignal;

    view.rerender(
      <ProjectChat projectId={2} canPost={false} toast={toast as never} />,
    );
    await flushPromises();
    expect(oldSignal.aborted).toBe(true);

    newProject.resolve({
      data: [row(3, "Current project", "2026-07-20T10:02:00.000Z")],
    });
    await flushPromises();
    expect(screen.getByText("Current project")).toBeTruthy();

    oldProject.resolve({
      data: [row(4, "Stale project", "2026-07-20T10:03:00.000Z")],
    });
    await flushPromises();

    expect(screen.queryByText("Stale project")).toBeNull();
    expect(screen.getByText("Current project")).toBeTruthy();
  });
});
