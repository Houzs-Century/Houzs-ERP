import { describe, it, expect } from "vitest";
import { shouldAutoCompleteOnPhoto } from "./autoCompleteJob";

const base = {
  sourceType: "project" as const,
  completed: false,
  busy: false,
  issueOn: false,
  alreadyFired: false,
  gateOk: true,
};

describe("shouldAutoCompleteOnPhoto — fair setup/dismantle auto-completes on photo upload", () => {
  it("auto-completes a project setup/dismantle stop once its photos are up", () => {
    expect(shouldAutoCompleteOnPhoto(base)).toBe(true);
  });

  // The whole point of the change: the office sees booth photos on the project
  // without the driver pressing Complete.
  it("waits for the completion gate (needs at least one uploaded photo)", () => {
    expect(shouldAutoCompleteOnPhoto({ ...base, gateOk: false })).toBe(false);
  });

  it("does NOT auto-complete a manual DP job or a service-case leg", () => {
    expect(shouldAutoCompleteOnPhoto({ ...base, sourceType: "dp" })).toBe(false);
    expect(shouldAutoCompleteOnPhoto({ ...base, sourceType: "assr" })).toBe(false);
  });

  it("does nothing once the stop is already completed", () => {
    expect(shouldAutoCompleteOnPhoto({ ...base, completed: true })).toBe(false);
  });

  it("holds off while a request is already in flight", () => {
    expect(shouldAutoCompleteOnPhoto({ ...base, busy: true })).toBe(false);
  });

  // A "completed with issue" report is carried by the manual button so the
  // issue is not dropped; auto-complete steps aside for it.
  it("steps aside while the crew is filing an issue", () => {
    expect(shouldAutoCompleteOnPhoto({ ...base, issueOn: true })).toBe(false);
  });

  // One auto attempt per screen: a transient failure must not hammer /complete.
  it("fires only once — a second attempt waits for the manual button", () => {
    expect(shouldAutoCompleteOnPhoto({ ...base, alreadyFired: true })).toBe(false);
  });
});
