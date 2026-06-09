export namespace Locale {
  export function titlecase(str: string) {
    return str.replace(/\b\w/g, (c) => c.toUpperCase())
  }

  export function time(input: number): string {
    const date = new Date(input)
    return date.toLocaleTimeString(undefined, { timeStyle: "short" })
  }

  export function datetime(input: number): string {
    const date = new Date(input)
    const localTime = time(input)
    const localDate = date.toLocaleDateString()
    return `${localTime} · ${localDate}`
  }

  export function todayTimeOrDateTime(input: number): string {
    const date = new Date(input)
    const now = new Date()
    const isToday =
      date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()

    if (isToday) {
      return time(input)
    } else {
      return datetime(input)
    }
  }

  export function number(num: number): string {
    if (num >= 1000000) {
      return (num / 1000000).toFixed(1) + "M"
    } else if (num >= 1000) {
      return (num / 1000).toFixed(1) + "K"
    }
    return num.toString()
  }

  export function duration(input: number) {
    if (input < 1000) {
      return `${input}ms`
    }
    if (input < 60000) {
      return `${(input / 1000).toFixed(1)}s`
    }
    if (input < 3600000) {
      const minutes = Math.floor(input / 60000)
      const seconds = Math.floor((input % 60000) / 1000)
      return `${minutes}m ${seconds}s`
    }
    if (input < 86400000) {
      const hours = Math.floor(input / 3600000)
      const minutes = Math.floor((input % 3600000) / 60000)
      return `${hours}h ${minutes}m`
    }
    const hours = Math.floor(input / 3600000)
    const days = Math.floor((input % 3600000) / 86400000)
    return `${days}d ${hours}h`
  }

  export function truncate(str: string, len: number): string {
    if (str.length <= len) return str
    return str.slice(0, len - 1) + "…"
  }

  export function truncateMiddle(str: string, maxLength: number = 35): string {
    if (str.length <= maxLength) return str

    const ellipsis = "…"
    const keepStart = Math.ceil((maxLength - ellipsis.length) / 2)
    const keepEnd = Math.floor((maxLength - ellipsis.length) / 2)

    return str.slice(0, keepStart) + ellipsis + str.slice(-keepEnd)
  }

  export function pluralize(count: number, singular: string, plural: string): string {
    const template = count === 1 ? singular : plural
    return template.replace("{}", count.toString())
  }

  // ─── POSIX locale resolver (parity gap-25) ────────────────────────
  //
  // PROVENANCE: ported from
  // `instructkr-claude-code/src/utils/formatBriefTimestamp.ts`
  // (the `getLocale()` helper). Adapted to opencode's `Locale`
  // namespace and renamed to avoid the `getLocale` collision with
  // future i18n APIs.
  //
  // Bun/V8's `toLocaleString(undefined)` ignores POSIX env vars on
  // macOS, so we have to convert them to BCP 47 ourselves. Resolution
  // order: `LC_ALL > LC_TIME > LANG`. Returns `undefined` for empty,
  // `C`, `POSIX`, or invalid tags so the existing `toLocaleString`
  // calls fall back to system default unchanged.
  let cachedResolvedLocale: string | undefined | null = null

  /**
   * Resolve the user's locale from POSIX env vars to a BCP 47 tag.
   * Cached for the process lifetime — env vars don't change at
   * runtime. Returns `undefined` when no usable locale is found
   * so callers can pass it directly to `toLocaleString(locale, ...)`
   * for system-default behaviour.
   */
  export function resolved(): string | undefined {
    if (cachedResolvedLocale !== null) return cachedResolvedLocale ?? undefined
    const raw = process.env["LC_ALL"] || process.env["LC_TIME"] || process.env["LANG"] || ""
    if (!raw || raw === "C" || raw === "POSIX") {
      cachedResolvedLocale = undefined
      return undefined
    }
    // Strip codeset (.UTF-8) and modifier (@euro), replace _ with -
    const base = raw.split(".")[0]!.split("@")[0]!
    if (!base) {
      cachedResolvedLocale = undefined
      return undefined
    }
    const tag = base.replaceAll("_", "-")
    // Validate by trying to construct an Intl locale — invalid tags throw
    try {
      new Intl.DateTimeFormat(tag)
      cachedResolvedLocale = tag
      return tag
    } catch {
      cachedResolvedLocale = undefined
      return undefined
    }
  }

  /**
   * Test-only: clear the cached locale so the next `resolved()` call
   * re-reads `process.env`. Used by tests that override env vars per
   * test case.
   */
  export function clearResolvedCache(): void {
    cachedResolvedLocale = null
  }

  // ─── Brief / messaging-app-style timestamp (parity gap-25) ────────
  //
  // PROVENANCE: ported from
  // `instructkr-claude-code/src/utils/formatBriefTimestamp.ts`. Same
  // 3-tier scaling rule:
  //
  //   - same day:      "1:30 PM" (hour + minute only)
  //   - within 6 days: "Sunday, 4:15 PM" (weekday + time)
  //   - older:         "Sunday, Feb 20, 4:30 PM" (weekday + month + day + time)
  //
  // Adapted to take a `number` (epoch ms) instead of an ISO string,
  // matching the rest of opencode's Locale.* helpers. Falls back to
  // `Locale.datetime(input)` on an invalid timestamp to keep the
  // signature total — no throws.
  //
  // The `now` parameter is injectable for tests so the 3-tier
  // boundary checks are deterministic.

  /**
   * Format an epoch-ms timestamp like a chat app: terse for today,
   * weekday-relative within a week, full date for older. Locale-aware
   * via `Locale.resolved()`. `now` is injectable for tests.
   */
  export function briefTimestamp(input: number, now: Date = new Date()): string {
    const d = new Date(input)
    if (Number.isNaN(d.getTime())) {
      return ""
    }

    const locale = resolved()
    const dayDiff = startOfDayMs(now) - startOfDayMs(d)
    const daysAgo = Math.round(dayDiff / 86_400_000)

    if (daysAgo === 0) {
      return d.toLocaleTimeString(locale, {
        hour: "numeric",
        minute: "2-digit",
      })
    }

    if (daysAgo > 0 && daysAgo < 7) {
      return d.toLocaleString(locale, {
        weekday: "long",
        hour: "numeric",
        minute: "2-digit",
      })
    }

    return d.toLocaleString(locale, {
      weekday: "long",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
  }

  function startOfDayMs(d: Date): number {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
}
