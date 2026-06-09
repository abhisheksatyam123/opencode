import { defineConfig } from "vitest/config"
import path from "node:path"
import { fileURLToPath } from "node:url"

const dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(dirname, "src"),
      "@opencode-ai/util": path.resolve(dirname, "src/foundation/vendor/util/index.ts"),
      "@opencode-ai/util/": path.resolve(dirname, "src/foundation/vendor/util/"),
      "@opencode-ai/plugin": path.resolve(dirname, "src/foundation/vendor/plugin/index.ts"),
      "@opencode-ai/plugin/tool": path.resolve(dirname, "src/foundation/vendor/plugin/tool.ts"),
      "@opencode-ai/sdk": path.resolve(dirname, "src/foundation/vendor/sdk/index.ts"),
      "@opencode-ai/sdk/": path.resolve(dirname, "src/foundation/vendor/sdk/"),
      "@opencode-ai/intelgraph": path.resolve(dirname, "vendor/intelgraph/src/index.ts"),
      "@intelgraph": path.resolve(dirname, "vendor/intelgraph/src"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "src/surface/web/**", "vendor/**"],
    passWithNoTests: true,
    coverage: {
      reporter: ["text", "lcov", "json-summary"],
    },
  },
})
