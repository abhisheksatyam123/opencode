/** @type {import('dependency-cruiser').IConfiguration} */
const path = require("node:path")
const { scanForExemptedDirs } = require("./tools/boundary/owner-port-marker.cjs")

// Pre-scan filesystem for `src/(shared|utils|common)/**` dirs that carry a
// VALID owner-port.json marker (5-check decision flow per
// doc/project/specification/contract/owner-port-marker-spec.md).
//
// The rule below flags every file under those banned roots EXCEPT the marker
// itself and except files whose dirname is in the exempted set.
//
// Why pre-scan: dep-cruiser's `forbidden` rules are declarative path-matchers
// and cannot natively express schema validation. The sibling helper at
// tools/boundary/owner-port-marker.cjs encodes the schema + 5-check flow.
const repoRoot = __dirname
const { exemptedDirsAbs, invalidDirsAbs } = scanForExemptedDirs(repoRoot)

if (invalidDirsAbs.length) {
  // Surface check 2-5 failures (attempted-but-invalid markers) at config load.
  // dep-cruiser will treat the dir as still-banned (no exemption granted).
  for (const { error, check } of invalidDirsAbs) {
    // eslint-disable-next-line no-console
    console.warn(`[dependency-cruiser] owner-port-marker check ${check} FAILED — ${error}`)
  }
}

// Build a `pathNot` regex that matches: the marker file itself, or any path
// that lives inside an exempted directory tree. Empty list → match marker file
// only (rule fires on every banned-dir non-marker file).
const exemptedRelDirs = exemptedDirsAbs.map((d) => path.relative(repoRoot, d).replace(/\\/g, "/"))
const exemptedAlternation = exemptedRelDirs.map((d) => `^${d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|$)`).join("|")
const NO_SHARED_PATH_NOT = "(/owner-port\\.json$)" + (exemptedAlternation ? `|(${exemptedAlternation})` : "")

const LAYER = "(?:foundation|infrastructure|platform|runtime|domain|interface|support)"
const MODULE_ROOT = `(?:${LAYER}/[^/]+)`

module.exports = {
  forbidden: [
    // README invariant #1: L0 primitives are leaves.
    // Foundation may not depend on any higher layer, including support.
    {
      name: "strict-L0-foundation-no-upward",
      severity: "error",
      from: { path: "^src/foundation/" },
      to: { path: "^src/(?:infrastructure|platform|runtime|domain|interface|support)/" },
    },

    // README invariant #1: L1 infrastructure depends only on L0 plus support.
    {
      name: "strict-L1-infrastructure-only-L0-support",
      severity: "error",
      from: { path: "^src/infrastructure/" },
      to: { path: "^src/(?:platform|runtime|domain|interface)/" },
    },

    // README invariant #1: L2 platform depends only on L0/L1 plus support.
    {
      name: "strict-L2-platform-only-L0-L1-support",
      severity: "error",
      from: { path: "^src/platform/" },
      to: { path: "^src/(?:runtime|domain|interface)/" },
    },

    // Legacy layer alias retained for boundary contract tests.
    // Historical L2 modules (config|provider|permission|notes) must not reach
    // L3+ modules (agent|workflow|surface|init). Phase 4.1 keeps config/provider
    // wired to moved init boot helpers + ShareNext until port extraction lands.
    {
      name: "L2-no-L3-imports-config-provider",
      severity: "error",
      from: { path: "^src/(config|provider)" },
      to: {
        path: "^src/(agent|workflow|surface|init)",
        pathNot: "^src/init/(?:auth|installation|npm)/|^src/surface/(?:share/share-next|command/index)\\.ts$",
      },
    },
    {
      name: "L2-no-L3-imports-permission-notes",
      severity: "error",
      from: { path: "^src/(permission|notes)" },
      to: { path: "^src/(agent|workflow|surface|init)" },
    },

    // README invariant #1: L4 domain must not depend on L5 interface.
    // README invariant #1: L3 runtime depends only on L0/L1/L2 plus support.
    {
      name: "strict-L3-runtime-only-L0-L2-support",
      severity: "error",
      from: { path: "^src/runtime/" },
      to: { path: "^src/(?:domain|interface)/" },
    },

    {
      name: "strict-L4-domain-only-L0-L3-support",
      severity: "error",
      from: { path: "^src/domain/" },
      to: { path: "^src/interface/" },
    },

    // Peer-layer imports forbidden for L1 singletons, with the current storage
    // -> filesystem index dependency explicitly documented as a temporary port gap.
    {
      name: "no-peer-L1-bus-storage-filesystem",
      severity: "error",
      from: { path: "^src/infrastructure/bus/" },
      to: { path: "^src/infrastructure/(?:storage|filesystem)/" },
    },
    {
      name: "no-peer-L1-storage-bus",
      severity: "error",
      from: { path: "^src/infrastructure/storage/" },
      to: { path: "^src/infrastructure/(?:bus|filesystem)/", pathNot: "^src/infrastructure/filesystem/index\\.ts$" },
    },
    {
      name: "no-peer-L1-filesystem-bus-storage",
      severity: "error",
      from: { path: "^src/infrastructure/filesystem/" },
      to: { path: "^src/infrastructure/(?:bus|storage)/" },
    },

    // Concrete adapter imports are forbidden outside composition roots.
    // Allowed roots: src/index.ts, src/node.ts (don’t match this rule) and src/init/**.
    {
      name: "no-adapter-imports",
      severity: "error",
      from: { path: "^src/(?!init/)([^/]+)/" },
      to: {
        path: "^src/[^/]+/(?:adapter\\.ts|adapters/)",
        pathNot: "^src/$1/",
      },
    },

    // Duplication-policy enforcement (Test Strategy 3.3 / [[duplication-over-coupling-contract]] §Rule 3,
    // [[owner-port-marker-spec]] 5-check decision flow, [[dip-hierarchy-boundary-contract]] forbidden-patterns row 7).
    // Banned: ^src/(shared|utils|common)(/|$). Exception: dir contains a valid
    // owner-port.json (schema-validated by tools/boundary/owner-port-marker.cjs at
    // config load time; exempted dir absolute paths fed into pathNot below).
    {
      name: "no-shared-without-owner-port",
      severity: "error",
      comment:
        "Banned shared/utils/common dir without valid owner-port.json marker. " +
        "Add marker per doc/project/specification/contract/owner-port-marker-spec.md " +
        "or relocate code into the owning module.",
      from: {},
      to: { path: "^src/(shared|utils|common)(/|$)", pathNot: NO_SHARED_PATH_NOT },
    },

    // README invariant #2: contract-purity. Contract files may not import
    // impl/wiring internals from any module. Module root is now
    // `src/<layer>/<module>`.
    {
      name: "contract-purity",
      severity: "error",
      comment: "README invariant #2: contract/** cannot depend on impl/** or wiring/**.",
      from: { path: `^src/${MODULE_ROOT}/contract/` },
      to: { path: `^src/${MODULE_ROOT}/(?:impl|wiring)/` },
    },

    // README invariant #3: impl-privacy. Concrete impl/** is private to its own module.
    {
      name: "impl-privacy",
      severity: "error",
      comment: "README invariant #3: cross-module imports into impl/** are forbidden.",
      from: { path: `^src/(${MODULE_ROOT})/` },
      to: {
        path: `^src/${MODULE_ROOT}/impl/`,
        pathNot: "^src/$1/",
      },
    },

    // README invariant #4: barrel-only-cross-module for modules already split
    // into contract/wiring. Flat pre-split module files are handled by the P5.11
    // follow-up rather than hidden behind stale one-segment false positives.
    {
      name: "barrel-only-cross-module",
      severity: "error",
      comment: "README invariant #4: cross-module imports must not reach directly into contract/** or wiring/**.",
      from: { path: `^src/(${MODULE_ROOT})/` },
      to: {
        path: `^src/${MODULE_ROOT}/(?:contract|wiring)/`,
        pathNot: "^src/$1/",
      },
    },

    // Submodule + sub-submodule privacy rules. These now treat
    // `src/<layer>/<module>` as the parent module, not `src/<layer>`.
    {
      name: "no-sibling-submodule-concrete-import",
      severity: "error",
      comment: "submodule-node-contract AC3: sibling submodule MUST NOT import peer adapter/internal files.",
      from: { path: `^src/(${MODULE_ROOT})/([^/]+)/` },
      to: {
        path: "^src/$1/[^/]+/(?:adapter\\.ts|adapters/|internal/)",
        pathNot: "^src/$1/$2/",
      },
    },
    {
      name: "no-sibling-sub-submodule-reach-in",
      severity: "error",
      comment: "sub-submodule-node-contract AC2: sibling sub-submodule reach-in forbidden unconditionally.",
      from: { path: `^src/(${MODULE_ROOT})/([^/]+)/([^/]+)/` },
      to: {
        path: "^src/$1/$2/[^/]+/",
        pathNot: "^src/$1/$2/$3/",
      },
    },
    {
      name: "no-external-submodule-reach-in",
      severity: "error",
      comment:
        "External modules must reach nested submodules via their nearest published parent. " +
        "Flat module files are temporarily allowed until the README 3-tier split finishes. " +
        "foundation/vendor/ and .txt content imports are exempt.",
      from: { path: `^src/(${MODULE_ROOT})/` },
      to: {
        path: `^src/${MODULE_ROOT}/[^/]+/.+`,
        pathNot: "^src/$1/|/(?:port|schema|index)\\.ts$|^src/foundation/vendor/|\\.txt$",
      },
    },
    {
      name: "no-parent-index-adapter-reexport",
      severity: "error",
      comment: "submodule-node-contract: parent index.ts must not re-export submodule adapters.",
      from: { path: `^src/(${MODULE_ROOT})/index\\.ts$` },
      to: { path: "^src/$1/[^/]+/(?:adapter\\.ts|adapters/)" },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: "tsconfig.json",
    },
    reporterOptions: {
      text: {
        highlightFocused: true,
      },
    },
  },
}
