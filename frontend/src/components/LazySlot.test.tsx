import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LazySlot } from "./LazySlot";
import { CURRENT_BUILD_ID } from "./RouteFallback";

vi.mock("../lib/errorReporter", () => ({ reportClientError: vi.fn() }));

function Boom({ message }: { message: string }): never {
  throw new Error(message);
}

const STALE = "Failed to fetch dynamically imported module: /assets3/MobileApp-x.js";

describe("LazySlot", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it("contains the crash so a SIBLING of the slot survives it", () => {
    sessionStorage.setItem(
      "chunk-recovered-at",
      JSON.stringify({ at: Date.now(), buildId: CURRENT_BUILD_ID, kind: "hard" }),
    );
    render(
      <div>
        <LazySlot resetKey="authgate:shell-mobile:" fallback={null}>
          <Boom message={STALE} />
        </LazySlot>
        <div>version banner</div>
      </div>,
    );
    expect(screen.getByText("This page could not load part of the app.")).toBeTruthy();
    expect(screen.getByText("version banner")).toBeTruthy();
  });

  it("clears the crash when resetKey changes, with no reload", () => {
    const view = render(
      <LazySlot resetKey="authgate:forgot:#forgot" fallback={null}>
        <Boom message="Cannot read properties of null (reading 'id')" />
      </LazySlot>,
    );
    expect(screen.getByText("Something went wrong loading this page.")).toBeTruthy();

    view.rerender(
      <LazySlot resetKey="authgate:login:" fallback={null}>
        <div>Sign in</div>
      </LazySlot>,
    );
    expect(screen.getByText("Sign in")).toBeTruthy();
    expect(screen.queryByText("Something went wrong loading this page.")).toBeNull();
  });

  it("puts Suspense INSIDE the boundary, so a rejected import is caught", () => {
    render(
      <LazySlot resetKey="x" fallback={<div>loading</div>}>
        <Boom message={STALE} />
      </LazySlot>,
    );
    expect(screen.queryByText("loading")).toBeNull();
  });
});
