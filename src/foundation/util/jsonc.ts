import { type ParseError as JsoncParseError, printParseErrorCode } from "jsonc-parser"

export function formatJsoncParseErrorMessage(text: string, errors: JsoncParseError[]) {
  const lines = text.split("\n")
  const errorDetails = errors
    .map((error) => {
      const beforeOffset = text.substring(0, error.offset).split("\n")
      const line = beforeOffset.length
      const column = beforeOffset[beforeOffset.length - 1].length + 1
      const problemLine = lines[line - 1]

      const location = `${printParseErrorCode(error.error)} at line ${line}, column ${column}`
      if (!problemLine) return location

      return `${location}\n   Line ${line}: ${problemLine}\n${"".padStart(column + 9)}^`
    })
    .join("\n")

  return `\n--- JSONC Input ---\n${text}\n--- Errors ---\n${errorDetails}\n--- End ---`
}
