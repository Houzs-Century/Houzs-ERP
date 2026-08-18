import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileCrashBoundary } from "./MobileCrashBoundary";

vi.mock("../lib/errorReporter", () => ({ reportClientError: vi.fn() }));

function Boom({ message }: { message: string }): never {
  throw new Error(message);
}

describe("MobileCrashBoundary", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it("keeps a crashed screen from taking the whole shell down", () => {
    render(
      <MobileCrashBoundary resetKey="tab:orders" fallback={<div>loading</div>}>
        <Boom message="Cannot read properties of null (reading 'doc_no')" />
      </MobileCrashBoundary>,
    );
    expect(screen.getByText("Something went wrong loading this page.")).toBeTruthy();
  });

  it("clears the crash when the shell's own state key changes", () => {
    // The whole reason this exists rather than reusing RouteCrashBoundary:
    // MobileApp keeps `tab`/`screen` OUT of the URL, so a pathname key would
    // never change and the panel would sit there until a full reload.
    const view = render(
      <MobileCrashBoundary resetKey="tab:orders" fallback={<div>loading</div>}>
        <Boom message="Cannot read properties of null (reading 'doc_no')" />
      </MobileCrashBoundary>,
    );
    expect(screen.getByText("Something went wrong loading this page.")).toBeTruthy();

    view.rerender(
      <MobileCrashBoundary resetKey="tab:profile" fallback={<div>loading</div>}>
        <div>Profile</div>
      </MobileCrashBoundary>,
    );

    expect(screen.getByText("Profile")).toBeTruthy();
    expect(screen.queryByText("Something went wrong loading this page.")).toBeNull();
  });

  it("puts Suspense INSIDE the error boundary, not outside it", () => {
    // A lazy import that rejects throws on the render Suspense resumes, so a
    // boundary nested within the Suspense would never see it. Proven by the
    // panel appearing rather than the fallback sticking.
    render(
      <MobileCrashBoundary resetKey="tab:orders" fallback={<div>loading</div>}>
        <Boom message="Failed to fetch dynamically imported module: /assets3/MobileSODetail-x.js" />
      </MobileCrashBoundary>,
    );
    // Stale chunk with a spent ladder would show the panel; with a fresh ladder
    // it self-heals and shows the skeleton. Either way it is NOT the caller's
    // "loading" fallback, which is what an inverted nesting would leave on screen.
    expect(screen.queryByText("loading")).toBeNull();
  });
});

describe("the mobile shell actually uses it", () => {
  const shell = readFileSync(join(process.cwd(), "src/mobile/MobileApp.tsx"), "utf8");

  it("wraps every lazy slot, and keys them on state rather than the URL", () => {
    // Three slots: tab content, the overlay screens, and the announcement
    // pop-up — the last being a NON-route lazy that renders over open forms.
    expect(shell.match(/<MobileCrashBoundary/g)).toHaveLength(3);
    expect(shell).toContain("resetKey={`tab:${tab}`}");
    expect(shell).toContain("resetKey={`overlay:${screenKey}`}");
    expect(shell).toContain("resetKey={`ann:${screenKey}`}");
    // A bare <Suspense> here would be a lazy slot with no crash boundary again.
    expect(shell).not.toContain("<Suspense");
  });
});
