#!/usr/bin/env bun
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"

import { createClient } from "@hey-api/openapi-ts"

function findOpencodeRoot(start: string): string {
  let current = start
  while (true) {
    if (
      existsSync(path.join(current, "package.json")) &&
      existsSync(path.join(current, "script/dev.ts")) &&
      existsSync(path.join(current, "src/index.ts"))
    ) {
      return current
    }

    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  throw new Error(`Unable to locate opencode repo root from ${start}`)
}

function escapeJsonPointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1")
}

function toPascalName(value: string): string {
  const words = value
    .replaceAll("@/", " ")
    .split(/[^A-Za-z0-9]+/g)
    .filter(Boolean)
  const name = words.map((word) => word.slice(0, 1).toUpperCase() + word.slice(1)).join("")
  return /^[A-Za-z_]/.test(name) ? name : `Schema${name}`
}

async function normalizeSchemaRefs(file: string): Promise<void> {
  // Hono/OpenAPI schema names can include module paths (for example `Event@/bus...`).
  // Those names are valid component keys, but several OpenAPI tooling paths treat
  // `/` as a JSON pointer separator unless both keys and refs are normalized.
  const spec = await Bun.file(file).json()
  const schemas = spec?.components?.schemas
  if (!schemas || typeof schemas !== "object") return

  const used = new Set<string>()
  const rename = new Map<string, string>()
  for (const name of Object.keys(schemas)) {
    let next = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : toPascalName(name)
    const base = next
    let suffix = 2
    while (used.has(next)) next = `${base}${suffix++}`
    used.add(next)
    if (next !== name) rename.set(name, next)
  }
  if (rename.size === 0) return

  const normalizedSchemas: Record<string, unknown> = {}
  for (const [name, schema] of Object.entries(schemas)) {
    normalizedSchemas[rename.get(name) ?? name] = schema
  }
  spec.components.schemas = normalizedSchemas

  const replacements = new Map<string, string>()
  for (const [oldName, newName] of rename) {
    replacements.set(`#/components/schemas/${oldName}`, `#/components/schemas/${newName}`)
    replacements.set(`#/components/schemas/${escapeJsonPointerSegment(oldName)}`, `#/components/schemas/${newName}`)
  }
  if ("Todo" in normalizedSchemas && !("__schema0" in normalizedSchemas)) {
    // z.lazy recursion in the Todo schema can leave an internal placeholder ref.
    replacements.set("#/components/schemas/__schema0", "#/components/schemas/Todo")
  }

  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit)
    if (!value || typeof value !== "object") return value
    const obj = value as Record<string, unknown>
    for (const [key, child] of Object.entries(obj)) {
      if (key === "$ref" && typeof child === "string") obj[key] = replacements.get(child) ?? child
      else obj[key] = visit(child)
    }
    return obj
  }

  visit(spec)
  await Bun.write(file, JSON.stringify(spec, null, 2))
}

const opencode = findOpencodeRoot(dir)
const openapiPath = path.join(dir, "openapi.json")

await $`bun dev generate > ${openapiPath}`.cwd(opencode)
await normalizeSchemaRefs(openapiPath)

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "OpencodeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
await $`rm -rf dist`
await $`bun tsc`
await $`rm openapi.json`
