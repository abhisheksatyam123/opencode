import { defineConfig } from "vitest/config"

/**
 * Fast, stateless config for the port-contract suite. Keep it
 * self-contained:
 *   - no globalSetup / setupFiles (the main config spins up workspace
 *     state; contracts don't need any of that)
 *   - :memory: SQLite only — no disk writes
 *   - testTimeout tight to keep the CI gate honest
 *
 * Usage:
 *   bun run test:contracts
 *   npx vitest --config vitest.contracts.config.ts <filter>
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/contracts/**/*.test.ts"],
    testTimeout: 5_000,
    hookTimeout: 5_000,
    pool: "threads",
    typecheck: {
      tsconfig: "./tsconfig.test.json",
    },
  },
})
