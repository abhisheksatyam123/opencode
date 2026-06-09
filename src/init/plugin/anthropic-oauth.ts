import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { createHash, randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { Auth } from "@/init/auth"
import { Log } from "@/foundation/util/log"

const log = Log.create({ service: "plugin.anthropic-oauth" })

// OAuth constants — same as Claude Code CLI
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize"
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const SUCCESS_URL = "https://platform.claude.com/oauth/code/success?app=claude-code"
const SCOPES = ["user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"]

// Claude Code version to mimic — read from installed claude binary or use a known version
const CLAUDE_CLI_VERSION = "2.1.104"

// Path to Claude Code's credential store
const CLAUDE_CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json")

// Token refresh buffer — refresh 5 minutes before expiry
const REFRESH_BUFFER_MS = 5 * 60 * 1000

// In-flight refresh deduplication
let refreshPromise: Promise<{ access: string; refresh: string; expires: number }> | null = null

// Track whether we've already attempted to import Claude Code tokens this session
let claudeTokensImported = false

// Track whether OAuth is active (used by hooks)
let oauthActive = false

// Stable session ID for X-Claude-Code-Session-Id header
const sessionId = randomBytes(16).toString("hex")

// --- PKCE Crypto ---

function base64URLEncode(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function generateCodeVerifier(): string {
  return base64URLEncode(randomBytes(32))
}

function generateCodeChallenge(verifier: string): string {
  return base64URLEncode(createHash("sha256").update(verifier).digest())
}

function generateState(): string {
  return base64URLEncode(randomBytes(32))
}

// --- Claude Code Token Import ---

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken: string
    refreshToken: string
    expiresAt: number
    scopes?: string[]
    subscriptionType?: string
    rateLimitTier?: string
  }
}

async function readClaudeCodeCredentials(): Promise<ClaudeCredentials | undefined> {
  try {
    const raw = await readFile(CLAUDE_CREDENTIALS_PATH, "utf-8")
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

async function importClaudeCodeTokens(): Promise<boolean> {
  if (claudeTokensImported) return false
  claudeTokensImported = true

  const existing = await Auth.get("anthropic")
  if (existing?.type === "oauth") {
    oauthActive = true
    return false
  }

  const creds = await readClaudeCodeCredentials()
  if (!creds?.claudeAiOauth) return false

  const { accessToken, refreshToken, expiresAt } = creds.claudeAiOauth
  if (!accessToken || !refreshToken) return false

  log.info("importing oauth tokens from claude code credentials")

  await Auth.set("anthropic", {
    type: "oauth",
    access: accessToken,
    refresh: refreshToken,
    expires: expiresAt,
  })

  oauthActive = true
  return true
}

// --- Token Exchange & Refresh ---

async function exchangeCodeForTokens(
  code: string,
  state: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number; scope?: string }> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
      state,
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Token exchange failed (${response.status}): ${text}`)
  }

  return response.json()
}

async function refreshAccessToken(refreshToken: string): Promise<{ access: string; refresh: string; expires: number }> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      scope: SCOPES.join(" "),
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Token refresh failed (${response.status}): ${text}`)
  }

  const data = (await response.json()) as {
    access_token: string
    refresh_token?: string
    expires_in: number
  }

  return {
    access: data.access_token,
    refresh: data.refresh_token ?? refreshToken,
    expires: Date.now() + data.expires_in * 1000,
  }
}

function isTokenExpired(expiresAt: number): boolean {
  if (expiresAt <= 0) return false
  return Date.now() + REFRESH_BUFFER_MS >= expiresAt
}

async function syncToClaudeCodeStore(refreshed: { access: string; refresh: string; expires: number }): Promise<void> {
  try {
    const creds = await readClaudeCodeCredentials()
    if (creds?.claudeAiOauth) {
      creds.claudeAiOauth.accessToken = refreshed.access
      creds.claudeAiOauth.refreshToken = refreshed.refresh
      creds.claudeAiOauth.expiresAt = refreshed.expires
      await writeFile(CLAUDE_CREDENTIALS_PATH, JSON.stringify(creds), { mode: 0o600 })
    }
  } catch {
    // Best-effort sync
  }
}

async function tryRecoverFromClaudeCodeStore(currentAccess: string): Promise<string | null> {
  try {
    const creds = await readClaudeCodeCredentials()
    if (!creds?.claudeAiOauth) {
      log.warn("claude code credential store has no claudeAiOauth block")
      return null
    }
    const { accessToken, refreshToken, expiresAt } = creds.claudeAiOauth
    if (!accessToken || accessToken === currentAccess) return null
    if (expiresAt && Date.now() + REFRESH_BUFFER_MS >= expiresAt) {
      log.warn("claude code credential store token is also expired")
      return null
    }
    // Claude Code CLI has a different (presumably fresher) token — adopt it
    log.info("recovered oauth token from claude code credential store")
    await Auth.set("anthropic", {
      type: "oauth",
      access: accessToken,
      refresh: refreshToken,
      expires: expiresAt,
    })
    return accessToken
  } catch (err) {
    log.warn("failed to recover from claude code credential store", { error: err })
    return null
  }
}

/**
 * Get the latest valid OAuth access token, refreshing if needed.
 * Called on every API request by the fetch wrapper in provider.ts.
 * Returns null if no OAuth token is available or refresh fails.
 */
export async function getLatestAuthToken(): Promise<string | null> {
  if (!oauthActive) return null

  const info = await Auth.get("anthropic")
  if (!info || info.type !== "oauth") return null

  if (!isTokenExpired(info.expires)) {
    return info.access
  }

  // Token is expired. Try cross-process recovery first — the Claude Code
  // CLI may already hold a fresh token, and using it avoids burning our
  // refresh token on a request that would also rotate it server-side.
  const recoveredFirst = await tryRecoverFromClaudeCodeStore(info.access)
  if (recoveredFirst) return recoveredFirst

  // No fresh CC token — attempt refresh ourselves
  try {
    if (!refreshPromise) {
      refreshPromise = refreshAccessToken(info.refresh).finally(() => {
        refreshPromise = null
      })
    }
    const refreshed = await refreshPromise
    await Auth.set("anthropic", {
      type: "oauth",
      access: refreshed.access,
      refresh: refreshed.refresh,
      expires: refreshed.expires,
    })
    await syncToClaudeCodeStore(refreshed)
    return refreshed.access
  } catch (err) {
    log.warn("token refresh failed, re-checking claude code credential store", { error: err })
    // Race fallback: CC may have refreshed during our failed attempt
    const recovered = await tryRecoverFromClaudeCodeStore(info.access)
    if (recovered) return recovered
    log.error("oauth token expired and refresh failed — re-authenticate with provider auth", { error: err })
    return null
  }
}

/**
 * Read the currently stored OAuth access token without any refresh or
 * recovery. Used by the 401 retry handler to identify which token failed.
 */
export async function getCurrentAuthToken(): Promise<string | null> {
  if (!oauthActive) return null
  const info = await Auth.get("anthropic")
  if (!info || info.type !== "oauth") return null
  return info.access
}

/**
 * Force-refresh the OAuth token after a 401 error. Re-reads from the
 * credential store first in case another process already refreshed.
 * Returns the new access token, or null on failure.
 */
export async function forceRefreshAuthToken(failedToken: string): Promise<string | null> {
  if (!oauthActive) return null

  // Re-read auth — another request may have already refreshed
  const info = await Auth.get("anthropic")
  if (!info || info.type !== "oauth") return null
  // If caller provided a real failed token and auth now holds a different
  // access token, another request already rotated — use that.
  if (failedToken && info.access !== failedToken) return info.access

  // Check if Claude Code CLI has a newer token (cross-process recovery).
  // Compare against whichever token we just read — not the caller's empty string.
  const recovered = await tryRecoverFromClaudeCodeStore(info.access)
  if (recovered) return recovered

  // Force refresh — bypass expiration check
  try {
    if (!refreshPromise) {
      refreshPromise = refreshAccessToken(info.refresh).finally(() => {
        refreshPromise = null
      })
    }
    const refreshed = await refreshPromise
    await Auth.set("anthropic", {
      type: "oauth",
      access: refreshed.access,
      refresh: refreshed.refresh,
      expires: refreshed.expires,
    })
    await syncToClaudeCodeStore(refreshed)
    return refreshed.access
  } catch (err) {
    log.error("force token refresh failed after 401", { error: err })
    return null
  }
}

// --- Local Callback Server ---

function startCallbackServer(): Promise<{
  port: number
  waitForCode: (expectedState: string) => Promise<string>
  close: () => void
}> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer()
    let codeResolver: ((code: string) => void) | null = null
    let codeRejecter: ((err: Error) => void) | null = null

    server.on("request", (req, res) => {
      const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`)

      if (url.pathname !== "/callback") {
        res.writeHead(404)
        res.end()
        return
      }

      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")

      if (!code) {
        res.writeHead(400)
        res.end("Authorization code not found")
        codeRejecter?.(new Error("No authorization code received"))
        return
      }

      // Redirect browser to success page
      res.writeHead(302, { Location: SUCCESS_URL })
      res.end()

      codeResolver?.({ code, state } as any)
    })

    server.once("error", (err) => {
      reject(new Error(`Failed to start OAuth callback server: ${err.message}`))
    })

    server.listen(0, "localhost", () => {
      const address = server.address() as AddressInfo
      const port = address.port

      resolve({
        port,
        waitForCode(expectedState: string): Promise<string> {
          return new Promise<string>((res, rej) => {
            codeResolver = (result: any) => {
              if (result.state !== expectedState) {
                rej(new Error("Invalid state parameter — possible CSRF attack"))
                return
              }
              res(result.code)
            }
            codeRejecter = rej
          })
        },
        close() {
          server.removeAllListeners()
          server.close()
        },
      })
    })
  })
}

// --- Plugin ---

export async function AnthropicOAuthPlugin(_input: PluginInput): Promise<Hooks> {
  // On plugin init, try to import tokens from Claude Code's credential store.
  // This lets users who already authenticated with `claude auth login` use
  // opencode without re-authenticating.
  await importClaudeCodeTokens().catch((err) => {
    log.warn("failed to import claude code credentials", { error: err })
  })

  return {
    auth: {
      provider: "anthropic",
      async loader(getAuth) {
        const info = await getAuth()
        if (!info || info.type !== "oauth") {
          oauthActive = false
          return {}
        }

        oauthActive = true

        // Token refresh: check if the current token needs refreshing
        if (isTokenExpired(info.expires)) {
          const token = await getLatestAuthToken()
          if (!token) {
            // Refresh failed completely — don't send a known-bad token
            log.error("oauth token expired and all refresh attempts failed")
            return {}
          }
          return { authToken: token }
        }

        // Return authToken — the fetch wrapper in provider.ts dynamically
        // refreshes via getLatestAuthToken() on each request, so even if
        // this token goes stale the request will still use a fresh one.
        return { authToken: info.access }
      },
      methods: [
        {
          type: "oauth" as const,
          label: "Login with Claude subscription (Max/Pro/Team)",
          async authorize() {
            const codeVerifier = generateCodeVerifier()
            const codeChallenge = generateCodeChallenge(codeVerifier)
            const state = generateState()

            const server = await startCallbackServer()
            const redirectUri = `http://localhost:${server.port}/callback`

            const authUrl = new URL(AUTHORIZE_URL)
            authUrl.searchParams.set("code", "true")
            authUrl.searchParams.set("client_id", CLIENT_ID)
            authUrl.searchParams.set("response_type", "code")
            authUrl.searchParams.set("redirect_uri", redirectUri)
            authUrl.searchParams.set("scope", SCOPES.join(" "))
            authUrl.searchParams.set("code_challenge", codeChallenge)
            authUrl.searchParams.set("code_challenge_method", "S256")
            authUrl.searchParams.set("state", state)

            return {
              url: authUrl.toString(),
              instructions: "Authorize opencode in your browser to use your Claude subscription",
              method: "auto" as const,
              async callback() {
                try {
                  const authCode = await server.waitForCode(state)

                  const tokens = await exchangeCodeForTokens(authCode, state, codeVerifier, redirectUri)

                  const expiresAt = Date.now() + tokens.expires_in * 1000

                  oauthActive = true

                  return {
                    type: "success" as const,
                    refresh: tokens.refresh_token,
                    access: tokens.access_token,
                    expires: expiresAt,
                  }
                } catch (err) {
                  log.error("anthropic oauth callback failed", { error: err })
                  return { type: "failed" as const }
                } finally {
                  server.close()
                }
              },
            }
          },
        },
      ],
    },

    // Inject Claude Code identity headers when using OAuth for Anthropic
    "chat.headers": async (incoming, output) => {
      if (!oauthActive) return
      if (incoming.model.providerID !== "anthropic") return

      output.headers["User-Agent"] = `claude-cli/${CLAUDE_CLI_VERSION} (ext, cli)`
      output.headers["x-app"] = "cli"
      output.headers["X-Claude-Code-Session-Id"] = sessionId
    },
  }
}
