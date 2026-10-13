import { defineConfig } from "vitest/config";

/**
 * Plain Node suite: memory-store logic runs against real SQLite (node:sqlite) with an injected
 * mock repo. No workerd pool, no assert-workerd — this package has no workerd tests in v1.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/*.test.ts"],
  },
});
