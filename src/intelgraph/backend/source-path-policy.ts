const ROM_SOURCE_SEGMENT = /(^|\/)(wlan_proc\/wlan\/protocol)\/rom\/[^/]+\/(?:orig|patch)\/src\//

export function isIntelGraphPrimarySourcePath(file?: string | null) {
  if (!file) return true
  return canonicalizeIntelGraphSourcePath(file) === file.replace(/\\/g, "/")
}

export function canonicalizeIntelGraphSourcePath(file?: string | null) {
  if (!file) return file ?? undefined
  const normalized = file.replace(/\\/g, "/")
  const canonical = normalized.replace(ROM_SOURCE_SEGMENT, "$1$2/src/")
  return canonical.replace(/_patch(\.[ch](?:pp|xx|\+\+)?|\.cc)$/i, "$1")
}

export function canonicalizeIntelGraphSymbol(symbol: string) {
  return symbol.replace(/___RAM$/u, "")
}
