import boundaries from "eslint-plugin-boundaries"
import importPlugin from "eslint-plugin-import"
import tsParser from "@typescript-eslint/parser"
import tsPlugin from "@typescript-eslint/eslint-plugin"

// Layer assignments (from module-catalogue + dependency-graph-v2):
// L0: foundation
// L1: bus, storage, filesystem
// L2: config, provider, permission, notes
// L3: process, tool
// L4: agent, workflow
// L5: surface, init
//
// Allow-matrix: L_n may import L_0..L_{n-1} only.
// No same-layer peer imports (e.g. bus ↛ storage, agent ↛ workflow).
// Composition root (src/index.ts, src/node.ts) is exempt.
//
// Patterns use **/src/<module>/** so they match both relative and absolute paths
// (needed for Linter.verify in tests where filenames are absolute).

export default [
  {
    // Match both relative (eslint CLI) and absolute (Linter.verify in tests) paths
    files: ["src/**/*.ts", "src/**/*.tsx", "**/src/**/*.ts", "**/src/**/*.tsx"],
    // Vendored third-party source: exclude from repo-owned lint remediation (F1 AC1-3).
    ignores: ["src/surface/web/official/packages/**", "**/src/surface/web/official/packages/**"],
    plugins: { boundaries, import: importPlugin, "@typescript-eslint": tsPlugin },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2024,
        sourceType: "module",
      },
    },
    settings: {
      "boundaries/elements": [
        { type: "foundation", pattern: "**/src/foundation/**" },
        { type: "bus", pattern: "**/src/bus/**" },
        { type: "storage", pattern: "**/src/storage/**" },
        { type: "filesystem", pattern: "**/src/filesystem/**" },
        { type: "config", pattern: "**/src/config/**" },
        { type: "provider", pattern: "**/src/provider/**" },
        { type: "permission", pattern: "**/src/permission/**" },
        { type: "notes", pattern: "**/src/notes/**" },
        { type: "process", pattern: "**/src/process/**" },
        { type: "tool", pattern: "**/src/tool/**" },
        { type: "agent", pattern: "**/src/agent/**" },
        { type: "workflow", pattern: "**/src/workflow/**" },
        { type: "surface", pattern: "**/src/surface/**" },
        { type: "init", pattern: "**/src/init/**" },
      ],
      // Composition root files are exempt from boundary rules
      "boundaries/ignore": ["**/src/index.ts", "**/src/node.ts"],
    },
    rules: {
      "import/no-internal-modules": [
        "error",
        {
          forbid: [
            "@/*/impl/**",
            "@/*/*/impl/**",
            "@/*/contract/**",
            "@/*/*/contract/**",
            "@/*/wiring/**",
            "@/*/*/wiring/**",
          ],
        },
      ],
      // Hardened: boundary violations are CI-blocking.
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          rules: [
            // L0 foundation: no deps — universally importable by all
            // L1 modules may import L0 only
            { from: { type: "bus" }, allow: { to: { type: ["foundation"] } } },
            { from: { type: "storage" }, allow: { to: { type: ["foundation"] } } },
            { from: { type: "filesystem" }, allow: { to: { type: ["foundation"] } } },

            // L2 modules may import L0 + L1
            { from: { type: "config" }, allow: { to: { type: ["foundation", "storage"] } } },
            { from: { type: "provider" }, allow: { to: { type: ["foundation", "config", "bus"] } } },
            { from: { type: "permission" }, allow: { to: { type: ["foundation", "config", "bus"] } } },
            { from: { type: "notes" }, allow: { to: { type: ["foundation", "filesystem", "storage"] } } },

            // L3 modules may import L0 + L1 + L2
            { from: { type: "process" }, allow: { to: { type: ["foundation", "bus", "storage", "config"] } } },
            {
              from: { type: "tool" },
              allow: { to: { type: ["foundation", "permission", "bus", "filesystem", "notes"] } },
            },

            // L4 modules may import L0 + L1 + L2 + L3
            {
              from: { type: "agent" },
              allow: { to: { type: ["foundation", "config", "provider", "tool", "notes", "bus", "permission"] } },
            },
            {
              from: { type: "workflow" },
              allow: { to: { type: ["foundation", "bus", "storage", "notes", "process", "agent"] } },
            },

            // L5 modules may import L0–L4
            {
              from: { type: "surface" },
              allow: {
                to: { type: ["foundation", "config", "bus", "agent", "workflow", "tool", "process", "provider"] },
              },
            },
            {
              from: { type: "init" },
              allow: { to: { type: ["foundation", "config", "storage", "provider", "surface", "workflow"] } },
            },
          ],
        },
      ],
    },
  },
]
