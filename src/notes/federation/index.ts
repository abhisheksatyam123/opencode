/**
 * federation/index.ts — Stage 6 federation manifest verifier + fetcher + cache.
 *
 * Implements the L3 §provider-obligations + federation-manifest contract:
 *
 *   1. Fetch index.json per cfg.federation.<kind>.urls
 *   2. Parse manifest schema (zod)
 *   3. Verify ed25519 signature over canonical body
 *   4. For each card matching the calling kind, verify sha256, fetch body
 *      if absent or mismatch, cache to <vault>/cache/federation/<source>/cards/
 *   5. Apply permission_cap intersection on returned cards
 *   6. Return verified records + errors[] (never throws)
 *
 * Cache layout (per [[federation-manifest#Cache layout]]):
 *
 *   <vaultRoot>/cache/federation/
 *     <source_id>/
 *       index.json                  ← last-fetched manifest
 *       index.json.meta             ← { etag, last_modified, fetched_at, version }
 *       cards/
 *         <kind>/<name>             ← filename = card name; verified against sha256
 *
 * Closed-enum vocabulary (carve-out class B for V.2 audit):
 *   - FEDERATION_KINDS: agent / skill / command / policy / workflow
 *   - LoadError reasons: schema.invalid / signature.invalid / signature.unsigned /
 *     trust.unknown / trust.invalid / sha256.mismatch / network.unavailable /
 *     manifest.expired / manifest.downgrade / version.too-old / kind.unknown
 *
 * Engine boot is NOT blocked by federation failures (invariant I7); errors
 * surface via `errors()` for diagnostics.
 */
import { createPublicKey, verify as cryptoVerify, createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import { FileWatcher } from "@/filesystem/file/watcher"
import * as path from "node:path"
import z from "zod"
import { vaultPath } from "@/notes/root"
import { Canonical } from "@/notes/federation/canonical"
import { Log } from "@/foundation/util/log"
import { Bus } from "@/bus"
import type { Config } from "@/config/config"

export namespace Federation {
  const log = Log.create({ service: "federation" })

  const staleMap = new Map<string, Date>()
  const refreshing = new Set<string>()
  let watcherStarted = false

  function clearStale(sourceId: string): void {
    staleMap.delete(sourceId)
  }

  export function __resetWatcherForTesting(): void {
    watcherStarted = false
    staleMap.clear()
    refreshing.clear()
  }

  async function dropInMemoryCache(sourceId: string): Promise<void> {
    await pruneSource(sourceId)
  }

  async function markStale(sourceId: string): Promise<void> {
    staleMap.set(sourceId, new Date())
    await dropInMemoryCache(sourceId)
  }

  async function maybeRefreshStaleSource(sourceId: string, opts: FetchOptions): Promise<FetchResult | undefined> {
    if (refreshing.has(sourceId)) return undefined
    refreshing.add(sourceId)
    try {
      const refreshed = await fetchKind(opts)
      const ok = refreshed.sources.some((source) => source.source_id === sourceId && source.status !== "skipped")
      if (ok) {
        await dropInMemoryCache(sourceId)
        clearStale(sourceId)
      }
      return refreshed
    } finally {
      refreshing.delete(sourceId)
    }
  }

  export function startWatcher(): void {
    if (process.env["OPENCODE_HOT_RELOAD"] === "0") return
    if (watcherStarted) return
    watcherStarted = true
    const root = federationRoot()
    try {
      Bus.subscribe(FileWatcher.Event.Updated, (evt) => {
        const rel = path.relative(root, evt.properties.file)
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return
        const sourceId = rel.split(path.sep)[0]
        if (!sourceId) return
        markStale(sourceId).catch((err) => {
          log.warn("federation.cache.invalidate.failed", { sourceId, err: String(err) })
        })
      })
    } catch (err) {
      watcherStarted = false
      log.warn("federation.cache.watch.start.failed", { dir: root, err: String(err) })
    }
  }

  /** The 5 closed-enum federation kinds. Single source of truth (B-class). */
  export const FEDERATION_KINDS = ["agent", "skill", "command", "policy", "workflow"] as const
  export type Kind = (typeof FEDERATION_KINDS)[number]

  // ------------------------------------------------------------------
  // Manifest schema (federation-manifest §manifest-schema)
  // ------------------------------------------------------------------

  export const PublisherSchema = z.object({
    name: z.string().optional(),
    url: z.string().optional(),
    key_id: z.string().optional(),
  })

  export const SignatureSchema = z.object({
    algorithm: z.literal("ed25519"),
    key_id: z.string().min(1),
    value: z.string(), // base64 — empty during canonical computation
  })

  export const CardSchema = z.object({
    kind: z.string(),
    name: z.string().min(1),
    path: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/i, "sha256 must be a 64-character lowercase hex string"),
    size_bytes: z.number().int().nonnegative().optional(),
    permissions_requested: z.unknown().optional(),
    min_engine: z.string().optional(),
  })
  export type Card = z.infer<typeof CardSchema>

  export const ManifestSchema = z.object({
    manifest_version: z.string(),
    source_id: z.string().min(1),
    source_url: z.string().min(1),
    publisher: PublisherSchema.optional(),
    version: z.string(),
    min_engine: z.string().optional(),
    kinds: z.array(z.string()),
    cards: z.array(CardSchema),
    signature: SignatureSchema,
    issued_at: z.string(),
    expires_at: z.string().optional(),
  })
  export type Manifest = z.infer<typeof ManifestSchema>

  // ------------------------------------------------------------------
  // LoadError shape (mirrors L3 §validation-policy structured-error contract)
  // ------------------------------------------------------------------

  export type LoadErrorReason =
    | "schema.invalid"
    | "signature.invalid"
    | "signature.unsigned"
    | "trust.unknown"
    | "trust.invalid"
    | "sha256.mismatch"
    | "network.unavailable"
    | "manifest.expired"
    | "manifest.downgrade"
    | "version.too-old"
    | "kind.unknown"

  export interface LoadError {
    source: string
    sourceUrl?: string
    cardName?: string
    reason: LoadErrorReason
    detail: string
  }

  // ------------------------------------------------------------------
  // Verified card record returned to L3 callers
  // ------------------------------------------------------------------

  export interface VerifiedCard {
    /** Canonical card name (matches manifest.cards[].name). */
    name: string
    /** Federation source id for provenance + override resolution. */
    source: string
    /** Kind this card binds to. */
    kind: Kind
    /** Absolute path to the verified card body in the federation cache. */
    bodyPath: string
    /** Card body bytes (UTF-8 text — markdown). */
    body: string
    /** sha256 of body, hex-lowercase, post-verification. */
    sha256: string
    /** Optional `min_engine` semver from card frontmatter. */
    minEngine?: string
  }

  // ------------------------------------------------------------------
  // Public API: load + accessors
  // ------------------------------------------------------------------

  interface CacheMeta {
    etag?: string
    last_modified?: string
    fetched_at: string
    version: string
  }

  /** Plug-point so tests can inject deterministic HTTP. */
  export interface FetchAdapter {
    head(url: string): Promise<{ etag?: string; last_modified?: string; status: number }>
    get(
      url: string,
      headers?: Record<string, string>,
    ): Promise<{ status: number; body: string; etag?: string; last_modified?: string }>
    getBytes(url: string): Promise<{ status: number; body: Uint8Array }>
  }

  /** Default adapter using global fetch (Node 18+ / Bun). */
  export const defaultFetchAdapter: FetchAdapter = {
    async head(url) {
      const res = await fetch(url, { method: "HEAD" })
      return {
        status: res.status,
        etag: res.headers.get("etag") ?? undefined,
        last_modified: res.headers.get("last-modified") ?? undefined,
      }
    },
    async get(url, headers) {
      const res = await fetch(url, { headers })
      const body = await res.text()
      return {
        status: res.status,
        body,
        etag: res.headers.get("etag") ?? undefined,
        last_modified: res.headers.get("last-modified") ?? undefined,
      }
    },
    async getBytes(url) {
      const res = await fetch(url)
      const buf = new Uint8Array(await res.arrayBuffer())
      return { status: res.status, body: buf }
    },
  }

  // ------------------------------------------------------------------
  // Cache helpers (per federation-manifest §Cache layout)
  // ------------------------------------------------------------------

  function federationRoot(): string {
    // Single subtree under <vaultRoot>/cache/federation/ (vaultPath.cache())
    return vaultPath.cache("federation")
  }

  function sourceRoot(sourceId: string): string {
    // Sanitise source_id to a filesystem-safe slug — alphanumeric + '-' + '_'.
    const slug = sourceId.replace(/[^a-zA-Z0-9._-]/g, "_")
    return path.join(federationRoot(), slug)
  }

  function cardPath(sourceId: string, kind: Kind, name: string): string {
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "_") + ".md"
    return path.join(sourceRoot(sourceId), "cards", kind, safeName)
  }

  async function readCacheMeta(sourceId: string): Promise<CacheMeta | undefined> {
    try {
      const buf = await fs.readFile(path.join(sourceRoot(sourceId), "index.json.meta"), "utf-8")
      return JSON.parse(buf) as CacheMeta
    } catch {
      return undefined
    }
  }

  async function writeCacheMeta(sourceId: string, meta: CacheMeta): Promise<void> {
    const dir = sourceRoot(sourceId)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "index.json.meta"), JSON.stringify(meta, null, 2), "utf-8")
  }

  async function readCachedManifest(sourceId: string): Promise<string | undefined> {
    try {
      return await fs.readFile(path.join(sourceRoot(sourceId), "index.json"), "utf-8")
    } catch {
      return undefined
    }
  }

  async function writeCachedManifest(sourceId: string, body: string): Promise<void> {
    const dir = sourceRoot(sourceId)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "index.json"), body, "utf-8")
  }

  // ------------------------------------------------------------------
  // sha256 + ed25519 primitives
  // ------------------------------------------------------------------

  export function sha256Hex(buf: Uint8Array | string): string {
    const h = createHash("sha256")
    h.update(typeof buf === "string" ? Buffer.from(buf, "utf-8") : Buffer.from(buf))
    return h.digest("hex")
  }

  /**
   * Build the canonical body for signature verification: copy of manifest with
   * signature.value cleared. Per federation-manifest §Signature verification.
   */
  export function canonicalBody(manifest: Manifest): Uint8Array {
    const copy = {
      ...manifest,
      signature: { ...manifest.signature, value: "" },
    }
    return Canonical.bytes(copy)
  }

  /**
   * Decode a base64 ed25519 raw 32-byte public key into a node:crypto KeyObject.
   * Wraps the raw bytes in a SPKI DER prefix so `createPublicKey` accepts them.
   *
   * SPKI prefix for ed25519: 30 2a 30 05 06 03 2b 65 70 03 21 00
   * (see RFC 8410 §4 + RFC 5280 §4.1).
   */
  export function publicKeyFromKeyId(keyId: string) {
    // Format: "ed25519/<base64>"
    const m = keyId.match(/^ed25519\/(.+)$/)
    if (!m) throw new Error("key_id must start with 'ed25519/' — got " + keyId)
    const raw = Buffer.from(m[1], "base64")
    if (raw.length !== 32) throw new Error("ed25519 raw key must be 32 bytes — got " + raw.length)
    const SPKI_PREFIX = Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00])
    const der = Buffer.concat([SPKI_PREFIX, raw])
    return createPublicKey({ key: der, format: "der", type: "spki" })
  }

  /** Verify ed25519 signature over canonical body. Returns true on match. */
  export function verifySignature(manifest: Manifest): boolean {
    if (!manifest.signature?.value) return false
    try {
      const pubKey = publicKeyFromKeyId(manifest.signature.key_id)
      const body = canonicalBody(manifest)
      const sig = Buffer.from(manifest.signature.value, "base64")
      return cryptoVerify(null, body, pubKey, sig)
    } catch (err) {
      log.warn("signature verify threw", { err: String(err) })
      return false
    }
  }

  // ------------------------------------------------------------------
  // Permission cap intersection (federation-manifest §Trust model I5)
  // ------------------------------------------------------------------

  /**
   * Intersect a card's permission map with a cap. The cap is a deny-by-default
   * filter: any key NOT in the cap is removed from the card; any value in the
   * card that the cap downgrades (e.g. "*" → ["rg:*"]) wins the more-restrictive
   * setting.
   *
   * Implementation note: Permission shapes differ per kind (Agent has
   * cardPerm.* PermissionRule, others have inline string caps). We treat the
   * cap as a positive allowlist + intersection by string-set semantics.
   *
   * Returns a NEW object — never mutates inputs.
   */
  export function applyPermissionCap<T extends Record<string, unknown> | undefined>(
    cardPerm: T,
    cap: Config.Permission | undefined,
  ): T {
    if (!cardPerm || !cap) return cardPerm
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(cardPerm)) {
      // If cap omits this key, the cap effectively denies — drop it.
      if (!(key in cap)) continue
      const cardVal = (cardPerm as Record<string, unknown>)[key]
      const capVal = (cap as Record<string, unknown>)[key]
      // Action-only ("allow"/"deny"/"ask") — intersect by precedence:
      // "deny" cap wins, "ask" cap wins over "allow".
      if (typeof cardVal === "string" && typeof capVal === "string") {
        out[key] = mostRestrictive(cardVal, capVal)
      } else if (Array.isArray(capVal) && typeof cardVal === "string") {
        // Card said "*"/string — cap narrows to allowlist; cap wins.
        out[key] = capVal
      } else if (Array.isArray(cardVal) && Array.isArray(capVal)) {
        out[key] = intersectStringArrays(cardVal as string[], capVal as string[])
      } else {
        // Fall through — copy the cap's stricter shape verbatim.
        out[key] = capVal
      }
    }
    return out as T
  }

  function mostRestrictive(a: string, b: string): string {
    const order: Record<string, number> = { deny: 0, ask: 1, allow: 2 }
    const ai = order[a] ?? 1
    const bi = order[b] ?? 1
    return ai <= bi ? a : b
  }

  function intersectStringArrays(a: string[], b: string[]): string[] {
    const setB = new Set(b)
    return a.filter((x) => setB.has(x))
  }

  // ------------------------------------------------------------------
  // Trust model (federation-manifest §Trust model + invariants I1, I3)
  // ------------------------------------------------------------------

  export function isTrustedKey(keyId: string, fed: Config.Federation | undefined): boolean {
    if (!fed?.trust) return false
    return Object.prototype.hasOwnProperty.call(fed.trust, keyId)
  }

  // ------------------------------------------------------------------
  // The fetch+verify pipeline
  // ------------------------------------------------------------------

  export interface FetchOptions {
    cfg: { federation?: Config.Federation } | undefined
    kind: Kind
    /** Optional adapter override (tests inject deterministic HTTP). */
    fetchAdapter?: FetchAdapter
    /** Engine version for min_engine gating. Defaults to "1.0.0". */
    engineVersion?: string
    /** Disable network entirely (cache-only resolution). */
    offline?: boolean
  }

  export interface FetchResult {
    cards: ReadonlyArray<VerifiedCard>
    errors: ReadonlyArray<LoadError>
    /** Per-source manifest cache state for tests + telemetry. */
    sources: ReadonlyArray<{
      source_id: string
      source_url: string
      status: "fresh" | "cached" | "rejected" | "skipped"
    }>
  }

  export async function fetchKind(opts: FetchOptions): Promise<FetchResult> {
    const fed = opts.cfg?.federation
    const fetchAdapter = opts.fetchAdapter ?? defaultFetchAdapter
    const errors: LoadError[] = []
    const cards: VerifiedCard[] = []
    const sources: Array<{
      source_id: string
      source_url: string
      status: "fresh" | "cached" | "rejected" | "skipped"
    }> = []

    const kindConfig = fed?.[opts.kind]
    const urls = kindConfig?.urls ?? []
    const disabled = new Set(kindConfig?.disabled ?? [])

    if (urls.length === 0) return { cards, errors, sources: [] }

    for (const url of urls) {
      try {
        const result = await loadOneSource({
          url,
          kind: opts.kind,
          fed,
          fetchAdapter,
          offline: opts.offline ?? false,
          engineVersion: opts.engineVersion ?? "1.0.0",
          disabled,
        })
        sources.push({ source_id: result.sourceId, source_url: url, status: result.status })
        for (const card of result.cards) {
          // permission_cap intersection happens in the consumer (it knows the
          // shape of cardPerm). Federation surfaces the cap on the cfg side
          // and the body bytes on this side; consumers wire them together.
          cards.push(card)
        }
        for (const err of result.errors) errors.push(err)
      } catch (err) {
        errors.push({
          source: url,
          sourceUrl: url,
          reason: "network.unavailable",
          detail: "uncaught error during loadOneSource: " + String(err),
        })
      }
    }

    return { cards, errors, sources }
  }

  // ------------------------------------------------------------------
  // Internal: per-source load
  // ------------------------------------------------------------------

  interface LoadOneOpts {
    url: string
    kind: Kind
    fed: Config.Federation | undefined
    fetchAdapter: FetchAdapter
    offline: boolean
    engineVersion: string
    disabled: Set<string>
  }

  async function loadOneSource(opts: LoadOneOpts): Promise<{
    sourceId: string
    status: "fresh" | "cached" | "rejected" | "skipped"
    cards: VerifiedCard[]
    errors: LoadError[]
  }> {
    const { url, kind, fed, fetchAdapter, offline, engineVersion, disabled } = opts
    const errors: LoadError[] = []
    const cards: VerifiedCard[] = []

    // Try cache-first to derive sourceId for early disabled-check; if no
    // cache exists yet, we have to fetch the manifest to learn its source_id.
    let cachedBody: string | undefined
    let manifestText: string
    let status: "fresh" | "cached" | "rejected" | "skipped" = "fresh"

    if (offline) {
      // Walk every existing source dir under cache/federation/<*>/index.json
      // and find one whose source_url matches; if missing, error out.
      const found = await findCachedSourceByUrl(url)
      if (found && staleMap.has(found.source_id)) {
        const refreshed = await maybeRefreshStaleSource(found.source_id, {
          cfg: { federation: fed },
          kind,
          fetchAdapter,
          engineVersion,
          offline: false,
        })
        if (refreshed) return extractSingleSourceResult(refreshed, found.source_id, url)
      }
      if (!found) {
        errors.push({ source: url, sourceUrl: url, reason: "network.unavailable", detail: "offline + no cache" })
        return { sourceId: url, status: "skipped", cards, errors }
      }
      manifestText = found.body
      status = "cached"
    } else {
      // Online: fetch index.json.
      try {
        const r = await fetchAdapter.get(url)
        if (r.status >= 200 && r.status < 300) {
          manifestText = r.body
        } else {
          // Network failure — fall back to last-known cache if any.
          const last = await findCachedSourceByUrl(url)
          if (last && staleMap.has(last.source_id)) {
            const refreshed = await maybeRefreshStaleSource(last.source_id, {
              cfg: { federation: fed },
              kind,
              fetchAdapter,
              engineVersion,
              offline: false,
            })
            if (refreshed) return extractSingleSourceResult(refreshed, last.source_id, url)
          }
          if (last) {
            errors.push({
              source: last.source_id,
              sourceUrl: url,
              reason: "network.unavailable",
              detail: "HTTP " + r.status + " — serving cached manifest",
            })
            manifestText = last.body
            status = "cached"
          } else {
            errors.push({ source: url, sourceUrl: url, reason: "network.unavailable", detail: "HTTP " + r.status })
            return { sourceId: url, status: "skipped", cards, errors }
          }
        }
      } catch (err) {
        const last = await findCachedSourceByUrl(url)
        if (last && staleMap.has(last.source_id)) {
          const refreshed = await maybeRefreshStaleSource(last.source_id, {
            cfg: { federation: fed },
            kind,
            fetchAdapter,
            engineVersion,
            offline: false,
          })
          if (refreshed) return extractSingleSourceResult(refreshed, last.source_id, url)
        }
        if (last) {
          errors.push({
            source: last.source_id,
            sourceUrl: url,
            reason: "network.unavailable",
            detail: "fetch threw: " + String(err) + " — serving cached manifest",
          })
          manifestText = last.body
          status = "cached"
        } else {
          errors.push({
            source: url,
            sourceUrl: url,
            reason: "network.unavailable",
            detail: "fetch threw: " + String(err),
          })
          return { sourceId: url, status: "skipped", cards, errors }
        }
      }
    }
    cachedBody = manifestText

    // Parse + schema-validate.
    let manifestRaw: unknown
    try {
      manifestRaw = JSON.parse(manifestText)
    } catch (err) {
      errors.push({ source: url, sourceUrl: url, reason: "schema.invalid", detail: "invalid JSON: " + String(err) })
      return { sourceId: url, status: "rejected", cards, errors }
    }
    const parsed = ManifestSchema.safeParse(manifestRaw)
    if (!parsed.success) {
      errors.push({
        source: url,
        sourceUrl: url,
        reason: "schema.invalid",
        detail: parsed.error.issues.map((i) => `${i.path.join("@/notes/federation")}: ${i.message}`).join("; "),
      })
      return { sourceId: url, status: "rejected", cards, errors }
    }
    const manifest = parsed.data

    if (disabled.has(manifest.source_id)) {
      return { sourceId: manifest.source_id, status: "skipped", cards, errors }
    }

    // Trust check.
    const trusted = isTrustedKey(manifest.signature.key_id, fed)
    if (!trusted && !fed?.tofu) {
      errors.push({
        source: manifest.source_id,
        sourceUrl: url,
        reason: "trust.unknown",
        detail: "key " + manifest.signature.key_id + " not pinned in cfg.federation.trust",
      })
      return { sourceId: manifest.source_id, status: "rejected", cards, errors }
    }
    if (!manifest.signature.value) {
      errors.push({
        source: manifest.source_id,
        sourceUrl: url,
        reason: "signature.unsigned",
        detail: "signature.value is empty",
      })
      return { sourceId: manifest.source_id, status: "rejected", cards, errors }
    }
    if (!verifySignature(manifest)) {
      errors.push({
        source: manifest.source_id,
        sourceUrl: url,
        reason: "signature.invalid",
        detail: "ed25519 verify failed for key_id " + manifest.signature.key_id,
      })
      return { sourceId: manifest.source_id, status: "rejected", cards, errors }
    }

    // Expiry / downgrade gates.
    if (manifest.expires_at) {
      const exp = Date.parse(manifest.expires_at)
      if (Number.isFinite(exp) && Date.now() > exp) {
        errors.push({
          source: manifest.source_id,
          sourceUrl: url,
          reason: "manifest.expired",
          detail: "expires_at=" + manifest.expires_at + " < now",
        })
        return { sourceId: manifest.source_id, status: "rejected", cards, errors }
      }
    }
    if (!fed?.allow_downgrade) {
      const prevMeta = await readCacheMeta(manifest.source_id)
      if (prevMeta && compareSemverLoose(manifest.version, prevMeta.version) < 0) {
        errors.push({
          source: manifest.source_id,
          sourceUrl: url,
          reason: "manifest.downgrade",
          detail: `manifest version ${manifest.version} < cached ${prevMeta.version} (set cfg.federation.allow_downgrade=true to allow)`,
        })
        return { sourceId: manifest.source_id, status: "rejected", cards, errors }
      }
    }
    if (manifest.min_engine && compareSemverLoose(engineVersion, manifest.min_engine) < 0) {
      errors.push({
        source: manifest.source_id,
        sourceUrl: url,
        reason: "version.too-old",
        detail: `engine ${engineVersion} < manifest.min_engine ${manifest.min_engine}`,
      })
      return { sourceId: manifest.source_id, status: "rejected", cards, errors }
    }

    // Persist manifest + meta.
    if (status === "fresh") {
      await writeCachedManifest(manifest.source_id, cachedBody)
      await writeCacheMeta(manifest.source_id, {
        fetched_at: new Date().toISOString(),
        version: manifest.version,
      })
    }

    // Load each matching card.
    const baseUrl = url.endsWith("/") ? url : url.replace(/[^/]+$/, "")
    const sourceBase = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/"
    for (const cardSpec of manifest.cards) {
      if (cardSpec.kind !== kind) continue

      // Per-card min_engine gate.
      if (cardSpec.min_engine && compareSemverLoose(engineVersion, cardSpec.min_engine) < 0) {
        errors.push({
          source: manifest.source_id,
          sourceUrl: url,
          cardName: cardSpec.name,
          reason: "version.too-old",
          detail: `engine ${engineVersion} < card.min_engine ${cardSpec.min_engine}`,
        })
        continue
      }

      const dest = cardPath(manifest.source_id, kind, cardSpec.name)
      let bodyBytes: Uint8Array | undefined

      if (staleMap.has(manifest.source_id)) {
        const refreshed = await maybeRefreshStaleSource(manifest.source_id, {
          cfg: { federation: fed },
          kind,
          fetchAdapter,
          engineVersion,
          offline: false,
        })
        if (refreshed) return extractSingleSourceResult(refreshed, manifest.source_id, url)
      }

      // Cache check: if cached file's sha256 matches, reuse; else (re)fetch.
      try {
        const onDisk = await fs.readFile(dest)
        if (sha256Hex(onDisk) === cardSpec.sha256.toLowerCase()) {
          bodyBytes = onDisk
        }
      } catch {
        // not in cache yet
      }

      if (!bodyBytes && !offline) {
        try {
          const cardUrl = new URL(cardSpec.path, sourceBase).href
          const r = await fetchAdapter.getBytes(cardUrl)
          if (r.status >= 200 && r.status < 300) {
            bodyBytes = r.body
          } else {
            errors.push({
              source: manifest.source_id,
              sourceUrl: url,
              cardName: cardSpec.name,
              reason: "network.unavailable",
              detail: "card HTTP " + r.status,
            })
            continue
          }
        } catch (err) {
          errors.push({
            source: manifest.source_id,
            sourceUrl: url,
            cardName: cardSpec.name,
            reason: "network.unavailable",
            detail: "card fetch threw: " + String(err),
          })
          continue
        }
      }

      if (!bodyBytes) {
        errors.push({
          source: manifest.source_id,
          sourceUrl: url,
          cardName: cardSpec.name,
          reason: "network.unavailable",
          detail: "card body unavailable (offline + no cache)",
        })
        continue
      }

      // Per-card sha256 verification (invariant I2).
      const actualSha = sha256Hex(bodyBytes)
      if (actualSha !== cardSpec.sha256.toLowerCase()) {
        errors.push({
          source: manifest.source_id,
          sourceUrl: url,
          cardName: cardSpec.name,
          reason: "sha256.mismatch",
          detail: `expected ${cardSpec.sha256} got ${actualSha}`,
        })
        continue
      }

      // Persist verified body to cache.
      try {
        await fs.mkdir(path.dirname(dest), { recursive: true })
        await fs.writeFile(dest, bodyBytes)
      } catch (err) {
        log.warn("federation card cache-write failed", { dest, err: String(err) })
      }

      cards.push({
        name: cardSpec.name,
        source: manifest.source_id,
        kind,
        bodyPath: dest,
        body: new TextDecoder("utf-8").decode(bodyBytes),
        sha256: actualSha,
        minEngine: cardSpec.min_engine,
      })
    }

    return { sourceId: manifest.source_id, status, cards, errors }
  }

  function extractSingleSourceResult(
    result: FetchResult,
    sourceId: string,
    sourceUrl: string,
  ): {
    sourceId: string
    status: "fresh" | "cached" | "rejected" | "skipped"
    cards: VerifiedCard[]
    errors: LoadError[]
  } {
    const status = result.sources.find((source) => source.source_id === sourceId)?.status ?? "skipped"
    const cards = result.cards.filter((card) => card.source === sourceId) as VerifiedCard[]
    const errors = result.errors.filter((err) => err.source === sourceId || err.sourceUrl === sourceUrl) as LoadError[]
    return { sourceId, status, cards, errors }
  }

  // ------------------------------------------------------------------
  // Cache iteration
  // ------------------------------------------------------------------

  async function findCachedSourceByUrl(url: string): Promise<{ source_id: string; body: string } | undefined> {
    try {
      const root = federationRoot()
      const entries = await fs.readdir(root)
      for (const entry of entries) {
        const indexPath = path.join(root, entry, "index.json")
        try {
          const body = await fs.readFile(indexPath, "utf-8")
          const parsed = JSON.parse(body) as Partial<Manifest>
          if (parsed?.source_url === url) {
            return { source_id: parsed.source_id ?? entry, body }
          }
        } catch {
          // skip unreadable / non-manifest entries
        }
      }
    } catch {
      // root doesn't exist
    }
    return undefined
  }

  /**
   * Manual prune — remove all federation cache. Surfaced via
   * `opencode federation prune` CLI subcommand (out of scope for I6.3 but
   * exposed here as the registry-side primitive).
   */
  export async function pruneAll(): Promise<{ removed: string[] }> {
    const root = federationRoot()
    const removed: string[] = []
    try {
      const entries = await fs.readdir(root)
      for (const e of entries) {
        const p = path.join(root, e)
        await fs.rm(p, { recursive: true, force: true })
        removed.push(p)
      }
    } catch {
      // root doesn't exist — nothing to prune
    }
    return { removed }
  }

  /** Remove the cache subtree for a single source_id. */
  export async function pruneSource(sourceId: string): Promise<boolean> {
    try {
      await fs.rm(sourceRoot(sourceId), { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  }

  // ------------------------------------------------------------------
  // Loose semver compare (sufficient for monotonic version gates)
  // ------------------------------------------------------------------

  export function compareSemverLoose(a: string, b: string): number {
    const pa = parseSemver(a)
    const pb = parseSemver(b)
    for (let i = 0; i < 3; i++) {
      if (pa[i] < pb[i]) return -1
      if (pa[i] > pb[i]) return 1
    }
    return 0
  }

  function parseSemver(v: string): [number, number, number] {
    const parts = v.split("@/notes/federation").map((s) => Number.parseInt(s.replace(/[^0-9].*$/, ""), 10))
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0]
  }

  // ------------------------------------------------------------------
  // Path helpers (exported for tests)
  // ------------------------------------------------------------------

  export const Paths = {
    root: federationRoot,
    sourceRoot,
    cardPath,
  }
}
