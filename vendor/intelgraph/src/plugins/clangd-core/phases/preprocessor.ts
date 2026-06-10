/**
 * Helpers for suppressing symbols/calls that appear in preprocessor-disabled
 * C/C++ regions. Tree-sitter can still parse code inside `#if 0` blocks, and
 * some LSP responses may surface stale/disabled declarations; extraction must
 * treat those ranges as non-code for graph purposes.
 */

type ConditionalFrame = {
  parentActive: boolean
  active: boolean
  anyTaken: boolean
}

function expressionIsEnabled(raw: string) {
  const value = raw
    .replace(/\/\*.*?\*\//g, " ")
    .replace(/\/\/.*$/, "")
    .trim()
  if (!value) return true
  if (/^\(?\s*0\s*\)?(?:\s|$)/.test(value)) return false
  if (/^false\b/i.test(value)) return false
  return true
}

export function disabledPreprocessorLineSet(source: string) {
  const disabled = new Set<number>()
  const stack: ConditionalFrame[] = []
  const lines = source.split(/\r?\n/)
  const currentActive = () => stack.at(-1)?.active ?? true

  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1
    const text = lines[index] ?? ""
    const directive = text.match(/^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)$/)
    if (directive) {
      const keyword = directive[1]
      const rest = directive[2] ?? ""
      switch (keyword) {
        case "if": {
          const parentActive = currentActive()
          const branchEnabled = expressionIsEnabled(rest)
          stack.push({ parentActive, active: parentActive && branchEnabled, anyTaken: branchEnabled })
          break
        }
        case "ifdef":
        case "ifndef": {
          const parentActive = currentActive()
          stack.push({ parentActive, active: parentActive, anyTaken: true })
          break
        }
        case "elif": {
          const frame = stack.at(-1)
          if (frame) {
            const branchEnabled = expressionIsEnabled(rest)
            frame.active = frame.parentActive && !frame.anyTaken && branchEnabled
            frame.anyTaken = frame.anyTaken || branchEnabled
          }
          break
        }
        case "else": {
          const frame = stack.at(-1)
          if (frame) {
            frame.active = frame.parentActive && !frame.anyTaken
            frame.anyTaken = true
          }
          break
        }
        case "endif":
          stack.pop()
          break
      }
      continue
    }

    if (!currentActive()) disabled.add(lineNumber)
  }

  return disabled
}

export function isLineInDisabledPreprocessorRegion(disabledLines: Set<number>, line: number | undefined) {
  return typeof line === "number" && disabledLines.has(line)
}
