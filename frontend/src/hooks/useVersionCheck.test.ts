import { describe, expect, it } from "vitest";
import { assetHashFrom, latestBuildIdFrom } from "./useVersionCheck";

// The 2026-07-31 edge-poison outage moved build.assetsDir "assets" -> "assets2"
// -> "assets3" inside an hour. This hook had "/assets/" hard-coded, so it
// stopped detecting new builds the moment the namespace moved — silently, on
// the exact deploy where a "reload for the new version" prompt mattered most.
// These pin the parse to the SHAPE of a hashed entry module, never to a name.
describe("useVersionCheck entry-chunk parsing", () => {
  const html = (src: string) =>
    `<!doctype html><html><head>` +
    `<link rel="modulepreload" href="/assets3/react-vendor-CNN4Jg4e.js">` +
    `<script type="module" crossorigin src="${src}"></script>` +
    `</head><body></body></html>`;

  it("reads the entry hash from any assetsDir name", () => {
    for (const dir of ["assets", "assets2", "assets3", "static"]) {
      expect(assetHashFrom(`https://erp.houzscentury.com/${dir}/index-AbC123.js`)).toBe(
        "index-AbC123.js",
      );
      expect(latestBuildIdFrom(html(`/${dir}/index-AbC123.js`))).toBe("index-AbC123.js");
    }
  });

  it("does not mistake the host for the asset directory", () => {
    expect(assetHashFrom("https://erp.houzscentury.com/assets3/index-AbC123.js")).toBe(
      "index-AbC123.js",
    );
    expect(assetHashFrom("http://localhost:5173/assets3/index-AbC123.js")).toBe(
      "index-AbC123.js",
    );
  });

  it("skips the check in dev instead of guessing wrong", () => {
    // The dev server serves the un-hashed source entry and nested prebundles;
    // neither is a build id, and returning null makes the hook a no-op.
    expect(assetHashFrom("http://localhost:5173/src/main.tsx")).toBeNull();
    expect(assetHashFrom("http://localhost:5173/node_modules/.vite/deps/react.js")).toBeNull();
    expect(latestBuildIdFrom(`<script type="module" src="/src/main.tsx"></script>`)).toBeNull();
  });

  it("takes the entry script, not a modulepreload link", () => {
    // A preload hash differs from the entry's, so matching one would report a
    // new build on every single poll.
    expect(latestBuildIdFrom(html("/assets3/index-AbC123.js"))).toBe("index-AbC123.js");
  });

  it("returns null when the html has no module entry at all", () => {
    expect(latestBuildIdFrom("<!doctype html><html><body>nothing</body></html>")).toBeNull();
  });
});
