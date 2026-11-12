import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const openLoadedTab = vi.fn(async () => undefined);
vi.mock("../../lib/openLoadedTab", () => ({ openLoadedTab: (...args: unknown[]) => openLoadedTab(...(args as [])) }));

import { ToastProvider } from "../../hooks/useToast";
import { ThreadList } from "./Inbox";

type ThreadListProps = Parameters<typeof ThreadList>[0];

const fileNames = ["img0.jpeg", "img2.jpeg", "PO-2611-136-R1.pdf"];

const row = (attachmentCount: number) =>
  ({
    id: "t1",
    subject: "Revise PO 2611-136 R1",
    counterpartyEmail: "supplier@example.com",
    counterpartyName: "Supplier",
    mailboxAddress: "sim@example.com",
    lastMessageAt: "2026-11-10T09:04:00Z",
    lastSnippet: "Please refer to the revisions",
    messageCount: 1,
    unread: false,
    starred: false,
    labels: [],
    trashedAt: null,
    status: "open",
    hasOutbound: true,
    hasAttachment: attachmentCount > 0,
    attachmentCount,
    attachments: fileNames.slice(0, attachmentCount).map((filename, index) => ({
      id: `att-${index}`,
      filename,
      contentType: filename.endsWith(".pdf") ? "application/pdf" : "image/jpeg",
    })),
    lastDirection: "outbound",
    createdAt: "2026-11-10T09:04:00Z",
  }) as ThreadListProps["threads"][number];

const mount = (thread: ReturnType<typeof row>, density: "comfortable" | "compact", onOpen = vi.fn()) =>
  render(
    <ToastProvider>
      <ThreadList
        threads={[thread]}
        loading={false}
        activeId={null}
        folder={"inbox" as ThreadListProps["folder"]}
        density={density as ThreadListProps["density"]}
        selectedIds={new Set()}
        colorMap={new Map()}
        onToggleSelect={vi.fn()}
        onOpen={onOpen}
        onInjectTest={vi.fn()}
        onRowAction={vi.fn()}
      />
    </ToastProvider>,
  );

afterEach(() => {
  cleanup();
  openLoadedTab.mockClear();
});

describe("inbox row attachment mark", () => {
  it.each(["comfortable", "compact"] as const)("shows a paperclip on a %s row with a file", (density) => {
    mount(row(1), density);
    expect(screen.getByRole("img", { name: "Has attachment" })).toBeTruthy();
  });

  it("shows no paperclip and no file chips on a row without files", () => {
    mount(row(0), "comfortable");
    expect(screen.queryByRole("img", { name: "Has attachment" })).toBeNull();
    expect(screen.queryByRole("button", { name: /img0\.jpeg/ })).toBeNull();
  });
});

describe("inbox row file chips", () => {
  it.each(["comfortable", "compact"] as const)("names the first files and counts the rest on a %s row", (density) => {
    mount({ ...row(3), attachmentCount: 5 }, density);
    for (const filename of fileNames) {
      expect(screen.getByRole("button", { name: filename })).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "2 more files, open the conversation" }).textContent).toBe("+2");
  });

  it("opens the file without opening the conversation", () => {
    const onOpen = vi.fn();
    mount(row(3), "compact", onOpen);
    fireEvent.click(screen.getByRole("button", { name: "PO-2611-136-R1.pdf" }));
    expect(openLoadedTab).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("shows no count chip when every file is named", () => {
    mount(row(3), "comfortable");
    expect(screen.queryByRole("button", { name: /more files/ })).toBeNull();
  });
});
