import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadList } from "./Inbox";

type ThreadListProps = Parameters<typeof ThreadList>[0];

const row = (hasAttachment: boolean) =>
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
    hasAttachment,
    lastDirection: "outbound",
    createdAt: "2026-11-10T09:04:00Z",
  }) as ThreadListProps["threads"][number];

const mount = (hasAttachment: boolean, density: "comfortable" | "compact") =>
  render(
    <ThreadList
      threads={[row(hasAttachment)]}
      loading={false}
      activeId={null}
      folder={"inbox" as ThreadListProps["folder"]}
      density={density as ThreadListProps["density"]}
      selectedIds={new Set()}
      colorMap={new Map()}
      onToggleSelect={vi.fn()}
      onOpen={vi.fn()}
      onInjectTest={vi.fn()}
      onRowAction={vi.fn()}
    />,
  );

afterEach(cleanup);

describe("inbox row attachment mark", () => {
  it.each(["comfortable", "compact"] as const)("shows a paperclip on a %s row with a file", (density) => {
    mount(true, density);
    expect(screen.getByRole("img", { name: "Has attachment" })).toBeTruthy();
  });

  it("shows no paperclip on a row without files", () => {
    mount(false, "comfortable");
    expect(screen.queryByRole("img", { name: "Has attachment" })).toBeNull();
  });
});
