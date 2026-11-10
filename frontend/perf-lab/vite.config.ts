import react from "@vitejs/plugin-react";
import { defineConfig, type UserConfig } from "vite";
import { fileURLToPath } from "node:url";
import appConfig from "../vite.config";

/* The app's own resolve.alias (@2990s/*, the SCM vendor shims), so a scenario
   that renders a vendored SCM component (dp-board) resolves imports exactly as
   the app does; a second alias list is how lab-only drift starts. */
export default defineConfig(async (env) => {
  const app = (await (appConfig as unknown as (e: typeof env) => Promise<UserConfig> | UserConfig)(env));
  return {
    root: fileURLToPath(new URL(".", import.meta.url)),
    plugins: [react()],
    resolve: {
      alias: app.resolve?.alias,
      dedupe: ["react", "react-dom"],
    },
    server: {
      host: "127.0.0.1",
      port: 4174,
      strictPort: true,
    },
  };
});
