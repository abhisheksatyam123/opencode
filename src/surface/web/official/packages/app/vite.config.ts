import { fileURLToPath } from "node:url"
import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "vite"
import desktopPlugin from "./vite.js"

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./dist/**",
          filesToDeleteAfterUpload: "./dist/**/*.map",
        },
      })
    : false

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [desktopPlugin, sentry] as any,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
  },
  build: {
    target: "esnext",
    sourcemap: true,
    // Keep initial route chunks below the default Vite budget while allowing
    // known lazy third-party WASM/language chunks that cannot be split further.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/packages/ui/src/context/marked")) return "ui-marked"
          if (id.includes("/packages/ui/src/pierre/")) return "ui-diff"
          if (id.includes("/packages/ui/src/components/")) return "ui-components"
          if (id.includes("/packages/ui/src/")) return "ui-core"
          if (id.includes("/packages/core/src/")) return "opencode-core"
          if (id.includes("node_modules/@kobalte/")) return "vendor-kobalte"
          if (
            id.includes("node_modules/solid-js/") ||
            id.includes("node_modules/@solidjs/") ||
            id.includes("node_modules/@solid-primitives/")
          )
            return "vendor-solid"
          if (id.includes("node_modules/effect/")) return "vendor-effect"
          if (id.includes("node_modules/@tanstack/")) return "vendor-query"
        },
      },
    },
  },
})
