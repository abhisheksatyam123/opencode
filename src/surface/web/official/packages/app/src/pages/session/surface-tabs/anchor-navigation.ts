export function safeDecode(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

export function anchorSlug(text: string) {
  return text
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 _-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

function anchorSlugMatches(value: string, needleSlug: string) {
  const valueSlug = anchorSlug(value)
  if (valueSlug === needleSlug) return true
  if (needleSlug.startsWith("user-content-") && valueSlug === needleSlug.slice("user-content-".length)) return true
  if (valueSlug.startsWith("user-content-") && valueSlug.slice("user-content-".length) === needleSlug) return true
  return false
}

function normalizeLinkPath(path: string) {
  return path.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+/g, "/")
}

function baseName(path: string) {
  const normalized = normalizeLinkPath(path)
  const index = normalized.lastIndexOf("/")
  return index === -1 ? normalized : normalized.slice(index + 1)
}

function stripQuery(path: string) {
  return path.split("?")[0] ?? ""
}

export function localAnchorFromHref(hrefRaw: string, currentPath?: string) {
  let href = hrefRaw.trim()
  if (!href) return
  if (href.startsWith("#")) return safeDecode(href.slice(1))
  if (href.startsWith("//")) return

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) {
    let url: URL
    try {
      url = new URL(href, typeof window === "undefined" ? undefined : window.location.href)
    } catch {
      return
    }
    if (typeof window !== "undefined" && url.origin !== window.location.origin) return
    href = `${url.pathname}${url.search}${url.hash}`
  }

  const hashIndex = href.indexOf("#")
  if (hashIndex === -1) return
  const path = stripQuery(href.slice(0, hashIndex))
  const anchor = safeDecode(href.slice(hashIndex + 1))
  if (!anchor) return
  if (!path) return anchor
  if (!currentPath) return

  const normalizedPath = normalizeLinkPath(safeDecode(path))
  const normalizedCurrent = normalizeLinkPath(currentPath)
  if (normalizedPath === normalizedCurrent) return anchor
  if (!normalizedPath.includes("/") && normalizedPath === baseName(normalizedCurrent)) return anchor
}

export function findAnchorElement(root: HTMLElement, anchor: string) {
  const needle = safeDecode(anchor).trim()
  if (!needle) return
  const needleSlug = anchorSlug(needle)
  for (const element of Array.from(root.querySelectorAll<HTMLElement>("[id], [name]"))) {
    const id = element.getAttribute("id")
    const name = element.getAttribute("name")
    const decodedID = id ? safeDecode(id) : ""
    const decodedName = name ? safeDecode(name) : ""
    if (decodedID === needle || decodedName === needle) return element
    if (
      (decodedID && anchorSlugMatches(decodedID, needleSlug)) ||
      (decodedName && anchorSlugMatches(decodedName, needleSlug))
    ) {
      return element
    }
  }
  for (const heading of Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"))) {
    if (anchorSlugMatches(heading.textContent ?? "", needleSlug)) return heading
  }
}
