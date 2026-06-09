#!/usr/bin/env bun

import path from "path"
import fs from "fs/promises"
import { parse as parseJsonc, printParseErrorCode, type ParseError as JsoncParseError } from "jsonc-parser"
import { Config } from "../src/config/config"

const inputPath = process.argv[2] ?? path.join(process.cwd(), "opencode.json")
const resolvedPath = path.resolve(inputPath)

function formatJsoncErrors(text: string, errors: JsoncParseError[]) {
  const lines = text.split("\n")
  return errors
    .map((e) => {
      const beforeOffset = text.substring(0, e.offset).split("\n")
      const line = beforeOffset.length
      const column = beforeOffset[beforeOffset.length - 1].length + 1
      const problemLine = lines[line - 1]
      const err = `${printParseErrorCode(e.error)} at line ${line}, column ${column}`
      if (!problemLine) return err
      return `${err}\n  ${problemLine}\n  ${"".padStart(column - 1)}^`
    })
    .join("\n")
}

async function main() {
  const text = await fs.readFile(resolvedPath, "utf8")
  const parseErrors: JsoncParseError[] = []
  const json = parseJsonc(text, parseErrors, { allowTrailingComma: true })
  if (parseErrors.length > 0) {
    console.error(`Invalid JSON/JSONC in ${resolvedPath}`)
    console.error(formatJsoncErrors(text, parseErrors))
    process.exit(1)
  }

  const parsed = Config.ModelRoutingConfigContractSchema.safeParse(json)
  if (!parsed.success) {
    console.error(`Model routing contract validation failed for ${resolvedPath}`)
    for (const issue of parsed.error.issues) {
      const where = issue.path.length ? issue.path.join(".") : "(root)"
      console.error(`- ${where}: ${issue.message}`)
    }
    process.exit(1)
  }

  console.log(`Model routing contract validation passed: ${resolvedPath}`)
}

await main()
