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
    render(
      <MobileCrashBoundary resetKey="tab:orders" fallback={<div>loading</div>}>
        <Boom message="Failed to fetch dynamically imported module: /assets3/MobileSODetail-x.js" />
      </MobileCrashBoundary>,
    );
    expect(screen.queryByText("loading")).toBeNull();
  });
});

describe("the mobile shell actually uses it", () => {
  const shell = readFileSync(join(process.cwd(), "src/mobile/MobileApp.tsx"), "utf8");

  it("wraps every lazy slot, and keys them on state rather than the URL", () => {
    expect(shell.match(/<MobileCrashBoundary/g)).toHaveLength(3);
    expect(shell).toContain("resetKey={`tab:${tab}`}");
    expect(shell).toContain("resetKey={`overlay:${screenKey}`}");
    expect(shell).toContain("resetKey={`ann:${screenKey}`}");
    expect(shell).not.toContain("<Suspense");
  });
});
