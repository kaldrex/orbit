import { defineConfig } from "vitest/config";

export default defineConfig({
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
