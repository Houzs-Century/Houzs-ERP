import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageAcks, ReadByLine } from "./mail-acks";
import { MobileMessageAcks, MobileReadBy } from "../../mobile/MobileMailAcks";

const { apiPost, invalidate } = vi.hoisted(() => ({ apiPost: vi.fn(), invalidate: vi.fn() }));

vi.mock("../../api/client", () => ({ api: { get: vi.fn(), post: apiPost } }));
vi.mock("../../lib/queryClient", () => ({ queryClient: { invalidateQueries: invalidate } }));
vi.mock("../../hooks/useQuery", () => ({
  buildQueryKey: (key: string) => ["uq", key],
  useQuery: () => ({ data: [], loading: false, error: null, reload: vi.fn() }),
}));
vi.mock("../../hooks/useToast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

afterEach(() => {
  cleanup();
  apiPost.mockReset();
  invalidate.mockReset();
});

const acks = [
  { userId: 1, name: "Rita", ackedAt: "2026-10-16T02:00:00Z", overdue: false },
  { userId: 2, name: "Sam", ackedAt: null, overdue: true },
  { userId: 3, name: "Tan", ackedAt: null, overdue: false },
];

const readers = {
  members: [
    { userId: 1, name: "Olive", readAt: "2026-10-16T02:00:00Z" },
    { userId: 2, name: "Colin", readAt: null },
  ],
  others: [],
};

describe("DEV-03 P2 acknowledgement on the desktop thread", () => {
  it("shows who acknowledged and who still owes it", () => {
    render(<MessageAcks acks={acks} onAcked={vi.fn()} />);
    expect(screen.getByText("Acknowledged 1 of 3")).toBeTruthy();
    expect(screen.getByText("Sam (overdue)")).toBeTruthy();
    expect(screen.getByText("Tan (waiting)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Acknowledge/ })).toBeNull();
  });

  it("the recipient's button acknowledges the request and refreshes the pending list", async () => {
    apiPost.mockResolvedValue({ ok: true });
    const onAcked = vi.fn();
    render(<MessageAcks ackRequestId="msg-9" onAcked={onAcked} />);
    expect(screen.getByText("The sender asked you to acknowledge this email.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Acknowledge/ }));
    });
    expect(apiPost).toHaveBeenCalledWith("/api/mail-center/messages/msg-9/ack", {});
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["uq", "/api/mail-center/acks/pending"] });
    expect(onAcked).toHaveBeenCalled();
  });

  it("read-by counts the mailbox's people, and stays hidden for a one-person mailbox", () => {
    const { rerender } = render(<ReadByLine readers={readers} />);
    expect(screen.getByText("Read by 1 of 2")).toBeTruthy();
    rerender(<ReadByLine readers={{ members: [readers.members[0]], others: [] }} />);
    expect(screen.queryByText(/Read by/)).toBeNull();
  });
});

describe("DEV-03 P2 acknowledgement on the phone", () => {
  it("lists the same states and posts the same acknowledgement", async () => {
    apiPost.mockResolvedValue({ ok: true });
    const onAcked = vi.fn();
    render(<MobileMessageAcks acks={acks} ackRequestId="msg-7" onAcked={onAcked} />);
    expect(screen.getByText("Acknowledged 1 of 3")).toBeTruthy();
    expect(screen.getByText("Sam (overdue)")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    });
    expect(apiPost).toHaveBeenCalledWith("/api/mail-center/messages/msg-7/ack", {});
    expect(onAcked).toHaveBeenCalled();
  });

  it("names who has not read the thread yet", () => {
    render(<MobileReadBy readers={readers} />);
    expect(screen.getByText(/Read by 1 of 2/)).toBeTruthy();
    expect(screen.getByText(/not yet: Colin/)).toBeTruthy();
  });
});
