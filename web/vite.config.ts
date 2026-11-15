/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { helpCorpusPlugin } from "./scripts/help-corpus.mjs";
import { WHATS_NEW, latestN } from "./src/whatsNew.ts";

/**
 * "What's new": embeds the highest n as __WHATS_NEW_N__ and writes the whole
 * list as whats-new.json to dist (the deploy uploads it with no-cache). In
 * dev the dev server serves the same file.
 */
function whatsNewPlugin(): Plugin {
  const json = JSON.stringify({ entries: WHATS_NEW });
  return {
    name: "booqy-whats-new",
    config: () => ({ define: { __WHATS_NEW_N__: JSON.stringify(latestN(WHATS_NEW)) } }),
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "whats-new.json", source: json });
    },
    configureServer(server) {
      server.middlewares.use("/whats-new.json", (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-cache");
        res.end(json);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), helpCorpusPlugin(), whatsNewPlugin()],
  server: { port: 5173, strictPort: true }, // 5173 is an allowed sign-in callback outside prod
  build: { sourcemap: false },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
