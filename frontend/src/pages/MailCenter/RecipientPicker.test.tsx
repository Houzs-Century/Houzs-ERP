import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecipientPicker, type MailDirectory } from "./RecipientPicker";
import { addRecipients } from "./mail-recipients";

const person = (id: number, name: string, email: string, position = "", department = "Sales") => ({
  key: `user:${id}`,
  userId: id,
  name,
  email,
  position,
  department,
});

const dir: MailDirectory = {
  me: person(1, "Tan Mei Ling", "tan.ling@houzscentury.com"),
  department: [
    person(2, "Lim Wei Jie", "lim.jie@houzscentury.com", "Sales Executive"),
    { key: "mailbox:sales@houzscentury.com", userId: null, name: "Sales team", email: "sales@houzscentury.com", position: "Shared mailbox", department: "Sales" },
  ],
  team: [person(3, "Ahmad Zaki", "ahmad.zaki@houzscentury.com")],
  managers: [person(4, "Chew Boon Hock", "chew.hock@houzscentury.com", "Sales Director")],
  everyone: [],
};

vi.mock("../../api/client", () => ({ api: { get: vi.fn() } }));
vi.mock("../../hooks/useQuery", () => ({ useQuery: () => ({ data: dir, loading: false, error: null, reload: vi.fn() }) }));

afterEach(cleanup);

describe("DEV-03 P4 recipient picker", () => {
  it("adds the ticked people to To from the tab they were picked on", () => {
    const onPick = vi.fn();
    render(<RecipientPicker open onClose={vi.fn()} onPick={onPick} already={["", "", ""]} />);
    expect(screen.getByText("Sales team")).toBeTruthy();
    fireEvent.click(screen.getByText("Lim Wei Jie"));
    fireEvent.click(screen.getByRole("tab", { name: /My managers/ }));
    fireEvent.click(screen.getByText("Chew Boon Hock"));
    expect(screen.getByText("2 picked")).toBeTruthy();
    fireEvent.click(screen.getByText("Add to To"));
    expect(onPick).toHaveBeenCalledWith(["lim.jie@houzscentury.com", "chew.hock@houzscentury.com"], "to");
  });

  it("someone already on the email shows ticked and cannot be picked again", () => {
    render(<RecipientPicker open onClose={vi.fn()} onPick={vi.fn()} already={["Lim.Jie@houzscentury.com", "", ""]} />);
    const box = screen.getByText("Lim Wei Jie").closest("label")?.querySelector("input");
    expect(box?.checked).toBe(true);
    expect(box?.disabled).toBe(true);
    expect(screen.getByText(/already on this email/)).toBeTruthy();
  });

  it("search narrows the tab and says when no one matches", () => {
    render(<RecipientPicker open onClose={vi.fn()} onPick={vi.fn()} already={[]} />);
    fireEvent.change(screen.getByLabelText("Search people"), { target: { value: "executive" } });
    expect(screen.getByText("Lim Wei Jie")).toBeTruthy();
    expect(screen.queryByText("Sales team")).toBeNull();
    fireEvent.change(screen.getByLabelText("Search people"), { target: { value: "zzz" } });
    expect(screen.getByText("No one matches.")).toBeTruthy();
  });

  it("an empty tab says why", () => {
    render(<RecipientPicker open onClose={vi.fn()} onPick={vi.fn()} already={[]} />);
    fireEvent.click(screen.getByRole("tab", { name: /Everyone/ }));
    expect(screen.getByText("No one to pick yet.")).toBeTruthy();
  });
});

describe("addRecipients", () => {
  it("appends to what was typed and skips anyone already there", () => {
    expect(addRecipients("", ["a@x.com"])).toBe("a@x.com");
    expect(addRecipients("a@x.com, ", ["A@x.com", "b@x.com"])).toBe("a@x.com, b@x.com");
    expect(addRecipients("a@x.com; c@x.com", ["b@x.com", "b@x.com"])).toBe("a@x.com; c@x.com, b@x.com");
    expect(addRecipients("a@x.com", ["a@x.com"])).toBe("a@x.com");
  });
});
