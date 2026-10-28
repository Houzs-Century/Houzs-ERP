/* The project stage tracker turns a bullet green from a checklist item's state.
 * A gated document (3D Design, Display Floor Plan, Stock In/Out records) is
 * finished by being APPROVED — there is no separate "mark done" on it — so its
 * `status` stays 'pending' while `review_status` becomes 'approved'. Reading
 * status alone left an approved task's bullet red for months (owner 2026-09-23,
 * KL ZANOTTI REX). `itemComplete` is the rule the tracker and the section
 * progress now share, matching the backend's My-Pending gate.
 *
 * FAILS ON THE PRE-FIX CODE — approved-but-pending returned false.
 */
import { describe, it, expect } from "vitest";
import { itemComplete } from "./projects/checklistDone";

describe("itemComplete — approved counts as done", () => {
  it("is complete when status is done", () => {
    expect(itemComplete({ status: "done", review_status: null })).toBe(true);
  });
  it("is complete when status is N/A", () => {
    expect(itemComplete({ status: "na", review_status: null })).toBe(true);
  });
  it("is complete when APPROVED even though status is still pending", () => {
    // The exact stuck row: uploaded + approved, status never flipped to done.
    expect(itemComplete({ status: "pending", review_status: "approved" })).toBe(true);
  });
  it("is NOT complete while only submitted for review", () => {
    expect(itemComplete({ status: "pending", review_status: "pending_review" })).toBe(false);
  });
  it("is NOT complete when pending with no review", () => {
    expect(itemComplete({ status: "pending", review_status: null })).toBe(false);
  });
  it("is NOT complete when rejected", () => {
    expect(itemComplete({ status: "pending", review_status: "rejected" })).toBe(false);
  });
});
