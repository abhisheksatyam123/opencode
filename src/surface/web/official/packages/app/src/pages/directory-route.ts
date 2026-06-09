import { pathKey } from "@/utils/path-key"

export function shouldRewriteDirectoryRoute(requestedDirectory: string, resolvedDirectory: string | undefined) {
  if (!resolvedDirectory) return false
  // Preserve the explicit project/workspace selected by the URL. A stale child sync store can briefly
  // expose the previously-open project path; rewriting here sends new-session prompts to the wrong project.
  return pathKey(requestedDirectory) !== pathKey(resolvedDirectory) ? false : requestedDirectory !== resolvedDirectory
}
