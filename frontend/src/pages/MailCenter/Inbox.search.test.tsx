import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadList } from "./Inbox";

afterEach(cleanup);

describe("MailCenter search transition", () => {
  it("does not expose an older query row while the next query is loading", () => {
    render(
      <ThreadList
        threads={[
          {
            id: "old-query-row",
            subject: "Old A1 result",
            counterpartyEmail: "customer@example.com",
            counterpartyName: "Customer",
            mailboxAddress: "sales@example.com",
            lastMessageAt: "2026-07-20T08:00:00Z",
            lastSnippet: "Old query snippet",
            messageCount: 1,
            unread: false,
            starred: false,
            labels: [],
            status: "open",
            hasOutbound: false,
            lastDirection: "inbound",
            createdAt: "2026-07-20T08:00:00Z",
          } as any,
        ]}
        loading
        activeId={null}
        folder={"inbox" as any}
        density={"comfortable" as any}
        selectedIds={new Set()}
        colorMap={new Map()}
        onToggleSelect={vi.fn()}
        onOpen={vi.fn()}
        onInjectTest={vi.fn()}
        onRowAction={vi.fn()}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain("Loading");
    expect(screen.queryByText("Old A1 result")).toBeNull();
  });
});
