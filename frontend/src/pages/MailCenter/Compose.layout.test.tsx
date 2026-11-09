// New email footer (owner 2026-11-09): the controls wrapped into two-line slabs of
// uneven height. Pins the layout contract: one-line labels, Attach + Needs
// acknowledgement on the left, Cancel / Save draft / Send on the right, and no
// "Sent from" line repeating the From field.
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock("../../hooks/useQuery", () => ({
  buildQueryKey: (key: string) => ["uq", key],
  useQuery: () => ({
    data: [{ id: "a1", address: "lim@houzscentury.com", label: "Lim", active: true }],
    loading: false, error: null, reload: vi.fn(),
  }),
}));
vi.mock("../../hooks/useToast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ user: { email_alias: "lim@houzscentury.com" } }) }));

import { ComposeDialog } from "./Compose";

afterEach(cleanup);

describe("New email footer", () => {
  it("keeps every control on one line, grouped left and right, without the Sent from line", () => {
    render(<MemoryRouter><ComposeDialog open onClose={() => {}} /></MemoryRouter>);
    const send = screen.getByRole("button", { name: /send/i });
    const cancel = screen.getByRole("button", { name: /cancel/i });
    const draft = screen.getByRole("button", { name: /save draft/i });
    const attach = screen.getByRole("button", { name: /attach/i });
    const ack = screen.getByText("Needs acknowledgement").closest("label")!;

    for (const el of [send, cancel, draft, attach, ack]) expect(el.className).toContain("whitespace-nowrap");
    expect(send.parentElement).toBe(cancel.parentElement);
    expect(draft.parentElement).toBe(cancel.parentElement);
    expect(attach.parentElement).toBe(ack.parentElement);
    expect(attach.parentElement).not.toBe(send.parentElement);
    expect(screen.queryByText(/^Sent from/)).toBeNull();
    expect(screen.getByRole("dialog").className).toContain("max-w-2xl");
  });
});
