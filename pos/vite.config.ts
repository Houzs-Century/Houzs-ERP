/* Houzs POS build. The app is a static SPA on Cloudflare Pages; /api goes to
 * the Worker through the Pages Function in functions/api (same origin, no
 * CORS in production). In dev the proxy below plays that role.
 *
 * The shared business modules are the ERP frontend's vendored copies
 * (frontend/src/vendor/shared), reached through the @shared alias — one
 * source, no third copy for the mirror and duplicate audits to chase.
 *
 * The service worker (public/sw.js) precaches the built shell: after the
 * bundle is written, the emitted file list and a per-build id are stamped
 * into dist/sw.js, so a new deploy is a new cache and an old one is purged. */
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const buildId = Date.now().toString(36);

function listFiles(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...listFiles(full, rel));
    else out.push(rel);
  }
  return out;
}

function swPrecache(): Plugin {
  return {
    name: "houzs-pos-sw-precache",
    closeBundle() {
      const dist = path.join(root, "dist");
      const sw = path.join(dist, "sw.js");
      if (!existsSync(sw)) return;
      const files = listFiles(dist).filter((f) => f !== "sw.js" && !f.startsWith("_") && !f.endsWith(".map")).map((f) => `/${f.replace(/\\/g, "/")}`);
      const src = readFileSync(sw, "utf8").replace("__SW_BUILD_ID__", buildId).replace("__SW_PRECACHE__", JSON.stringify(files));
      writeFileSync(sw, src);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, "");
  const target = env.VITE_DEV_API_PROXY_TARGET || "https://autocount-sync-api.houzs-erp.workers.dev";
  return {
    plugins: [react(), swPrecache()],
    define: { __POS_VERSION__: JSON.stringify(`${process.env.npm_package_version ?? "0.0.0"}+${buildId}`) },
    resolve: { alias: { "@shared": path.resolve(root, "../frontend/src/vendor/shared") } },
    server: {
      port: 5174,
      fs: { allow: [root, path.resolve(root, "../frontend/src/vendor/shared")] },
      proxy: { "/api": { target, changeOrigin: true, secure: true } },
    },
    build: { sourcemap: false, target: "es2020" },
    test: { environment: "node", include: ["src/**/*.test.ts"] },
  };
});
