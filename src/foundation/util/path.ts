import path from "path"

export function hasHiddenSegment(filepath: string) {
  return path
    .resolve(filepath)
    .split(/[\\/]+/)
    .filter(Boolean)
    .some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..")
}
