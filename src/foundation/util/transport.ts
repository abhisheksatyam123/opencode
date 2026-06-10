import { Log } from "./log"

/**
 * Transport-layer helpers for HTTPS proxy + custom CA + mTLS support.
 *
 * Reads standard env vars (HTTPS_PROXY / HTTP_PROXY / NO_PROXY /
 * NODE_EXTRA_CA_CERTS) plus opencode-specific OPENCODE_CLIENT_CERT /
 * OPENCODE_CLIENT_KEY for mTLS. Returns BunFetchRequestInit-compatible
 * `proxy` + `tls` options that get spread into the existing custom-fetch
 * wrapper at provider.ts:1551 so all provider SDKs egress through the
 * corporate transport.
 *
 * Driven by the qpilot/qgenie corporate-proxy use case — see
 * project_qpilot_qgenie_providers.md.
 */
export namespace Transport {
  const log = Log.create({ service: "util.transport" })

  export interface TransportOptions {
    proxy?: string
    tls?: {
      ca?: string
      cert?: string
      key?: string
      rejectUnauthorized?: boolean
    }
  }

  export function getProxyURL(targetURL?: string): string | undefined {
    const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
    if (!proxy) return undefined
    if (!targetURL) return proxy

    const noProxy = process.env.NO_PROXY ?? process.env.no_proxy
    if (!noProxy) return proxy

    let host: string
    try {
      host = new URL(targetURL).hostname
    } catch {
      return proxy
    }

    const entries = noProxy
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0)

    const lcHost = host.toLowerCase()
    for (const entry of entries) {
      if (entry === "*") return undefined
      if (entry.startsWith("*.")) {
        const suffix = entry.slice(2)
        if (lcHost === suffix || lcHost.endsWith("." + suffix)) return undefined
        continue
      }
      if (lcHost === entry || lcHost.endsWith("." + entry)) return undefined
    }
    return proxy
  }

  let _caCertCache: { path: string; content: string | undefined } | undefined

  export function getCACerts(): string | undefined {
    const path = process.env.NODE_EXTRA_CA_CERTS
    if (!path) {
      _caCertCache = undefined
      return undefined
    }
    if (_caCertCache && _caCertCache.path === path) {
      return _caCertCache.content
    }
    try {
      const fs = require("fs") as typeof import("fs")
      const content = fs.readFileSync(path, "utf8")
      _caCertCache = { path, content }
      return content
    } catch (err) {
      log.warn("failed to read NODE_EXTRA_CA_CERTS", { path, error: String(err) })
      _caCertCache = { path, content: undefined }
      return undefined
    }
  }

  let _mtlsCache: { certPath: string; keyPath: string; cert: string; key: string } | undefined

  export function getMTLSConfig(): { cert: string; key: string } | undefined {
    const certPath = process.env.OPENCODE_CLIENT_CERT
    const keyPath = process.env.OPENCODE_CLIENT_KEY
    if (!certPath || !keyPath) {
      _mtlsCache = undefined
      return undefined
    }
    if (_mtlsCache && _mtlsCache.certPath === certPath && _mtlsCache.keyPath === keyPath) {
      return { cert: _mtlsCache.cert, key: _mtlsCache.key }
    }
    try {
      const fs = require("fs") as typeof import("fs")
      const cert = fs.readFileSync(certPath, "utf8")
      const key = fs.readFileSync(keyPath, "utf8")
      _mtlsCache = { certPath, keyPath, cert, key }
      return { cert, key }
    } catch (err) {
      log.warn("failed to read OPENCODE_CLIENT_CERT/OPENCODE_CLIENT_KEY", {
        certPath,
        keyPath,
        error: String(err),
      })
      _mtlsCache = undefined
      return undefined
    }
  }

  export function buildTransportOptions(targetURL?: string): TransportOptions | undefined {
    const proxy = getProxyURL(targetURL)
    const ca = getCACerts()
    const mtls = getMTLSConfig()

    const tls: TransportOptions["tls"] | undefined =
      ca || mtls
        ? {
            ...(ca ? { ca } : {}),
            ...(mtls ? { cert: mtls.cert, key: mtls.key } : {}),
          }
        : undefined

    if (proxy === undefined && tls === undefined) return undefined
    return {
      ...(proxy !== undefined ? { proxy } : {}),
      ...(tls !== undefined ? { tls } : {}),
    }
  }
}
