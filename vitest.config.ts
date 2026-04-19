import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  test: {
    include: [
      "tests/unit/**/*.test.{js,ts,mjs}",
      "tests/integration/**/*.test.{js,ts,mjs}",
      "packages/**/*.test.{js,ts,mjs}",
    ],
    exclude: ["**/node_modules/**"],
    testTimeout: 15_000,
    environment: "node",
  },
});
