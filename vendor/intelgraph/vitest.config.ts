import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    globalSetup: ["./test/test-setup.ts"],
    setupFiles: ["./test/test-setup-per-worker.ts"],
    include: ["test/**/*.test.ts"],
    exclude: ["test/e2e/**/*", "test/manual/**/*"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: false, isolate: true },
    },
    typecheck: {
      tsconfig: "./tsconfig.test.json",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/config/**/*",
        "src/errors/**/*",
      ],
    },
  },
})
