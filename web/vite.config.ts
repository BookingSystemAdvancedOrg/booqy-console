/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { helpCorpusPlugin } from "./scripts/help-corpus.mjs";

export default defineConfig({
  plugins: [react(), helpCorpusPlugin()],
  server: { port: 5173, strictPort: true }, // 5173 is an allowed sign-in callback outside prod
  build: { sourcemap: false },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
