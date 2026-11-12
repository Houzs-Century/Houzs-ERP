/* The inbox row shows the clock for a message from TODAY and the date for an
   older one. "Today" is the Malaysian day: at 01:30 on 10 Nov (Malaysia), a
   message from 23:30 on the 9th is yesterday's, even on a machine whose clock
   zone is UTC, where both instants share 9 Nov. Run with TZ=UTC to see it. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadList } from "./Inbox";

type ThreadListProps = Parameters<typeof ThreadList>[0];

const row = (lastMessageAt: string) =>
  ({
    id: "t1",
    subject: "Quote request",
    counterpartyEmail: "customer@example.com",
    counterpartyName: "Customer",
    mailboxAddress: "sales@example.com",
    lastMessageAt,
    lastSnippet: "snippet",
    messageCount: 1,
    unread: false,
    starred: false,
    labels: [],
    status: "open",
    hasOutbound: false,
    attachmentCount: 0,
    attachments: [],
    lastDirection: "inbound",
    createdAt: lastMessageAt,
  }) as unknown as ThreadListProps["threads"][number];

const mount = (lastMessageAt: string) =>
  render(
    <ThreadList
      threads={[row(lastMessageAt)]}
      loading={false}
      activeId={null}
      folder={"inbox" as ThreadListProps["folder"]}
      density={"comfortable" as ThreadListProps["density"]}
      selectedIds={new Set()}
      colorMap={new Map()}
      onToggleSelect={vi.fn()}
      onOpen={vi.fn()}
      onInjectTest={vi.fn()}
      onRowAction={vi.fn()}
    />,
  );

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T17:30:00Z")); // 01:30 on 10 Nov in Malaysia
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("inbox row time judges 'today' by the Malaysian day", () => {
  it("a message from 23:30 on the 9th (Malaysia) shows its date, not a clock", () => {
    mount("2026-11-09T15:30:00Z");
    expect(screen.getByText("2026/11/09")).toBeTruthy();
    expect(screen.queryByText("23:30")).toBeNull();
  });

  it("a message from 00:10 on the 10th (Malaysia) is today's and shows its clock", () => {
    mount("2026-11-09T16:10:00Z");
    expect(screen.getByText("00:10")).toBeTruthy();
  });
});
