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
      "tests/unit/**/*.test.{js,ts}",
      "tests/integration/**/*.test.{js,ts}",
      "packages/**/*.test.{js,ts}",
    ],
    exclude: ["**/node_modules/**"],
    testTimeout: 15_000,
    environment: "node",
  },
});
