import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^@tanstack\/react-virtual$/,
        replacement: fileURLToPath(
          new URL("../src/vendor/scm/lib/react-virtual-shim.ts", import.meta.url),
        ),
      },
    ],
    dedupe: ["react", "react-dom"],
  },
  server: {
    host: "127.0.0.1",
    port: 4174,
    strictPort: true,
  },
});
