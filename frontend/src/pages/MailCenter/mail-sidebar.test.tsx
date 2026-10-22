import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MyMailboxNav, VisibilityPanel } from "./mail-sidebar";
import { defaultPersonalLocalPart } from "./mail-personal";

const vis = {
  level: "personal",
  manage: false,
  myAddress: "tan.ling@houzscentury.com",
  mailboxes: [
    { address: "tan.ling@houzscentury.com", label: "Tan", reach: "own" },
    { address: "sales@houzscentury.com", label: "Sales", reach: "granted" },
  ],
  sendFrom: ["tan.ling@houzscentury.com", "sales@houzscentury.com"],
};

vi.mock("../../api/client", () => ({ api: { get: vi.fn() } }));
vi.mock("../../hooks/useQuery", () => ({ useQuery: () => ({ data: vis, loading: false, error: null, reload: vi.fn() }) }));

afterEach(cleanup);

describe("DEV-03 P3 My mailbox", () => {
  it("opens the person's own inbox, Sent by me and Drafts", () => {
    const onPick = vi.fn();
    render(<MyMailboxNav folder="inbox" mailbox="tan.ling@houzscentury.com" unread={() => 2} drafts={1} onPick={onPick} />);
    expect(screen.getByText("My mailbox")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    fireEvent.click(screen.getByText("Sent by me"));
    expect(onPick).toHaveBeenCalledWith("sentbyme", "tan.ling@houzscentury.com");
    fireEvent.click(screen.getByText("Inbox"));
    expect(onPick).toHaveBeenLastCalledWith("inbox", "tan.ling@houzscentury.com");
  });

  it("What may I see lists each mailbox with how it is reached", () => {
    render(<VisibilityPanel />);
    fireEvent.click(screen.getByText("What may I see"));
    expect(screen.getByText("Your own and shared mailboxes.")).toBeTruthy();
    expect(screen.getByText("Yours")).toBeTruthy();
    expect(screen.getByText("Shared with you")).toBeTruthy();
    expect(screen.getByText("You can send from these 2 addresses.")).toBeTruthy();
  });

  it("the invite form's default address matches the server rule", () => {
    expect(defaultPersonalLocalPart("Nur Aina Binti Rahman")).toBe("nur.rahman");
    expect(defaultPersonalLocalPart("  José  Ng ")).toBe("jose.ng");
    expect(defaultPersonalLocalPart("陈")).toBeNull();
  });
});
