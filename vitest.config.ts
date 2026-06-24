import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@opencode-ai/util": path.resolve(__dirname, "./src/foundation/vendor/util"),
      "@opencode-ai/plugin": path.resolve(__dirname, "./src/foundation/vendor/plugin"),
      "@opencode-ai/sdk": path.resolve(__dirname, "./src/foundation/vendor/sdk"),
    },
  },
})
