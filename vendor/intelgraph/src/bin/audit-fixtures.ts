/**
 * CLI for generating WLAN fixture completeness audit reports.
 *
 * Usage:
 *   npm run audit:fixtures                            # default table format
 *   npm run audit:fixtures -- --format=json           # JSON output
 *   npm run audit:fixtures -- --format=markdown       # markdown table
 *   npm run audit:fixtures -- --min-score=80          # filter >= 80% completeness
 */

import { generateCompletenessAudit, formatAuditReport, formatAuditReportJson, formatAuditReportMarkdown } from "../fixtures/completeness-audit.js"
import fs from "fs/promises"
import path from "path"

interface CliOptions {
  format: "table" | "json" | "markdown"
  minScore?: number
  output?: string
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2)
  const options: CliOptions = {
    format: "table",
  }

  for (const arg of args) {
    if (arg.startsWith("--format=")) {
      const format = arg.replace("--format=", "")
      if (["table", "json", "markdown"].includes(format)) {
        options.format = format as "table" | "json" | "markdown"
      }
    } else if (arg.startsWith("--min-score=")) {
      options.minScore = parseInt(arg.replace("--min-score=", ""), 10)
    } else if (arg.startsWith("--output=")) {
      options.output = arg.replace("--output=", "")
    }
  }

  return options
}

async function main() {
  const options = parseArgs()

  try {
    console.log("Generating WLAN fixture completeness audit...")

    let report = await generateCompletenessAudit("test/fixtures/c/wlan/api")

    // Filter by min-score if specified
    if (options.minScore !== undefined) {
      report.per_api_scores = report.per_api_scores.filter(
        (s) => s.completeness_score >= options.minScore!,
      )
    }

    // Format and output
    let output: string
    if (options.format === "json") {
      output = formatAuditReportJson(report)
    } else if (options.format === "markdown") {
      output = formatAuditReportMarkdown(report)
    } else {
      output = formatAuditReport(report)
    }

    console.log("\n" + output)

    // Write to file if specified
    if (options.output) {
      await fs.writeFile(options.output, output, "utf-8")
      console.log(`\n✓ Report written to ${options.output}`)
    } else {
      // Always write JSON output to test/fixtures/completeness-audit.json
      const jsonPath = path.join("test/fixtures/completeness-audit.json")
      const fullReport = formatAuditReportJson(report)
      await fs.writeFile(jsonPath, fullReport, "utf-8")
      console.log(`\n✓ JSON report written to ${jsonPath}`)
    }

    process.exit(0)
  } catch (error) {
    console.error("Audit generation failed:", error)
    process.exit(1)
  }
}

main()
