import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
vi.mock("../api/client", () => ({ api: { post: (...a: unknown[]) => post(...a) } }));

const {
  requirePasswordChange,
  requirePasswordChangeConfirmText,
  requirePasswordChangeDoneText,
} = await import("./requirePasswordChange");

beforeEach(() => post.mockReset());

describe("requirePasswordChange", () => {
  it("posts to the member's endpoint and returns how many sessions ended", async () => {
    post.mockResolvedValue({ ok: true, sessions_ended: 3 });
    expect(await requirePasswordChange(42)).toBe(3);
    expect(post).toHaveBeenCalledWith("/api/users/42/require-password-change");
  });

  it("reads a missing count as zero rather than NaN", async () => {
    post.mockResolvedValue({ ok: true });
    expect(await requirePasswordChange("7")).toBe(0);
  });

  it("tells the admin the member is signed out and PIN sign-in is untouched", () => {
    const t = requirePasswordChangeConfirmText("a@b.test");
    expect(t).toContain("a@b.test");
    expect(t).toContain("signed out on every device");
    expect(t).toContain("Crew PIN sign-in is not affected");
  });

  it("pluralises the session count", () => {
    expect(requirePasswordChangeDoneText("a@b.test", 1)).toContain("1 session ended");
    expect(requirePasswordChangeDoneText("a@b.test", 2)).toContain("2 sessions ended");
  });
});
