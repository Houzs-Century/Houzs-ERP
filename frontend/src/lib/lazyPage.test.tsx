import { describe, expect, it, vi } from "vitest";
import { Suspense, type ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { lazyPage, preloadElementChunks, whenPageChunksSettled } from "./lazyPage";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const Hello = () => <p>hello</p>;

describe("lazyPage", () => {
  it("preload and render share one download", async () => {
    const factory = vi.fn(() => Promise.resolve({ default: Hello }));
    const Page = lazyPage(factory);
    void Page.preload();
    render(<Suspense fallback={null}><Page /></Suspense>);
    expect(await screen.findByText("hello")).toBeTruthy();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("a failed load is retried by the next caller, not replayed", async () => {
    const factory = vi
      .fn<() => Promise<{ default: typeof Hello }>>()
      .mockRejectedValueOnce(new Error("Failed to fetch dynamically imported module"))
      .mockResolvedValueOnce({ default: Hello });
    const Page = lazyPage(factory);
    await expect(Page.preload()).rejects.toThrow(/dynamically imported/);
    await expect(Page.preload()).resolves.toEqual({ default: Hello });
    expect(factory).toHaveBeenCalledTimes(2);
  });
});

describe("preloadElementChunks", () => {
  it("starts the shell AND the page nested inside a guard, in the same tick", () => {
    const shell = vi.fn(() => Promise.resolve({ default: Hello }));
    const page = vi.fn(() => Promise.resolve({ default: Hello }));
    const Shell = lazyPage(shell);
    const Page = lazyPage(page);
    const Guard = ({ children }: { children: ReactNode }) => <>{children}</>;
    preloadElementChunks(
      <Guard>
        <div>
          <Shell>
            <Page />
          </Shell>
        </div>
      </Guard>,
    );
    expect(shell).toHaveBeenCalledTimes(1);
    expect(page).toHaveBeenCalledTimes(1);
  });

  it("swallows a failed preload, and the failure still counts as settled", async () => {
    const Page = lazyPage(() => Promise.reject(new Error("gone")));
    expect(() => preloadElementChunks(<Page />)).not.toThrow();
    await whenPageChunksSettled();
  });
});

describe("whenPageChunksSettled", () => {
  it("waits for an in-flight page chunk", async () => {
    const d = deferred<{ default: typeof Hello }>();
    const Page = lazyPage(() => d.promise);
    void Page.preload();
    let settled = false;
    const wait = whenPageChunksSettled().then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false);
    d.resolve({ default: Hello });
    await wait;
    expect(settled).toBe(true);
  });

  it("gives up waiting on a chunk that never answers", async () => {
    const Page = lazyPage(() => new Promise<{ default: typeof Hello }>(() => {}));
    void Page.preload();
    await whenPageChunksSettled(10);
  });
});
