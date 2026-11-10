import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allowNextUnload,
  confirmLeaving,
  holdLeaveGuard,
  leaveGuardActive,
  resetLeaveGuardForTests,
  setLeaveGuardAsker,
  shouldBlockUnload,
} from "./leaveGuard";
import { leavesPlace } from "./leaveGuardPlace";

afterEach(() => resetLeaveGuardForTests());

describe("leavesPlace", () => {
  it("another path is leaving; a trailing slash is not", () => {
    expect(leavesPlace({ pathname: "/scm/grns/new", search: "" }, { pathname: "/scm/grns" })).toBe(true);
    expect(leavesPlace({ pathname: "/scm/grns/new", search: "" }, { pathname: "/scm/grns/new/" })).toBe(false);
  });

  it("a query change is the same place unless a holder named that parameter", () => {
    const from = { pathname: "/scm/credit-notes", search: "?form=new" };
    expect(leavesPlace(from, { pathname: "/scm/credit-notes", search: "" })).toBe(false);
    const release = holdLeaveGuard(["form"]);
    expect(leavesPlace(from, { pathname: "/scm/credit-notes", search: "" })).toBe(true);
    expect(leavesPlace(from, { pathname: "/scm/credit-notes", search: "?form=new&type=debit" })).toBe(false);
    release();
  });
});

describe("confirmLeaving", () => {
  it("nothing held: yes, without asking", async () => {
    const ask = vi.fn(async () => false);
    setLeaveGuardAsker(ask);
    expect(await confirmLeaving()).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("two callers at once share one question; leaving drops every holder", async () => {
    let answer: (v: boolean) => void = () => {};
    const ask = vi.fn(() => new Promise<boolean>((r) => { answer = r; }));
    setLeaveGuardAsker(ask);
    holdLeaveGuard();
    holdLeaveGuard();
    const a = confirmLeaving();
    const b = confirmLeaving();
    answer(true);
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(leaveGuardActive()).toBe(false);
  });

  it("staying keeps the holders", async () => {
    setLeaveGuardAsker(async () => false);
    holdLeaveGuard();
    expect(await confirmLeaving()).toBe(false);
    expect(leaveGuardActive()).toBe(true);
  });
});

describe("shouldBlockUnload", () => {
  it("blocks while held, not after an announced reload", () => {
    expect(shouldBlockUnload()).toBe(false);
    holdLeaveGuard();
    expect(shouldBlockUnload()).toBe(true);
    allowNextUnload();
    expect(shouldBlockUnload()).toBe(false);
  });
});
