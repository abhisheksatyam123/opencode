import { Server } from "@/surface/server/server"
import { type PermissionMode } from "@/config/types"
import { UI } from "@/surface/cli/ui"
import { cmd } from "@/surface/cli/cmd/cmd"
import { withNetworkOptions, resolveNetworkOptions } from "@/surface/cli/network"
import { Flag } from "@/foundation/flag/flag"
// gap-29-followup-4: Hyperlink.create wraps HTTP URLs in OSC 8 escape
// sequences so users on supported terminals can click the URL to open
// the web interface in their browser.
import { Hyperlink } from "@/foundation/util/hyperlink"
import open from "open"
import { networkInterfaces } from "os"

function getNetworkIPs() {
  const nets = networkInterfaces()
  const results: string[] = []

  for (const name of Object.keys(nets)) {
    const net = nets[name]
    if (!net) continue

    for (const netInfo of net) {
      // Skip internal and non-IPv4 addresses
      if (netInfo.internal || netInfo.family !== "IPv4") continue

      // Skip Docker bridge networks (typically 172.x.x.x)
      if (netInfo.address.startsWith("172.")) continue

      results.push(netInfo.address)
    }
  }

  return results
}

export const WebCommand = cmd({
  command: "web",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "start opencode server and open web interface",
  handler: async (args) => {
    const opts = await resolveNetworkOptions(args)

    // Warn if no auth on non-loopback (should not happen with auto-token, but guard)
    if (!opts.password && !opts.noAuth && opts.hostname !== "127.0.0.1" && opts.hostname !== "localhost") {
      UI.println(UI.Style.TEXT_WARNING_BOLD + "!  " + "Server bound to non-loopback without auth; server is unsecured.")
    }

    // Warn if --no-auth is used with non-loopback hostname
    if (opts.noAuth && opts.hostname !== "127.0.0.1" && opts.hostname !== "localhost") {
      UI.println(UI.Style.TEXT_WARNING_BOLD + "⚠  " + "Auth disabled. Server is open to anyone on the network.")
    }

    const server = await Server.listen({
      port: opts.port,
      hostname: opts.hostname,
      mdns: opts.mdns,
      mdnsDomain: opts.mdnsDomain,
      cors: opts.cors,
      password: opts.password,
      readPassword: opts.readPassword,
      noAuth: opts.noAuth,
      username: opts.username,
      permissionMode: opts.permissionMode as PermissionMode,
    })

    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()

    if (opts.hostname === "0.0.0.0") {
      // Show localhost for local access
      const localhostUrl = `http://localhost:${server.port}`
      UI.println(
        UI.Style.TEXT_INFO_BOLD + "  Local access:      ",
        UI.Style.TEXT_NORMAL,
        Hyperlink.create(localhostUrl),
      )

      // Show network IPs for remote access
      const networkIPs = getNetworkIPs()
      if (networkIPs.length > 0) {
        for (const ip of networkIPs) {
          const networkUrl = `http://${ip}:${server.port}`
          UI.println(
            UI.Style.TEXT_INFO_BOLD + "  Network access:    ",
            UI.Style.TEXT_NORMAL,
            Hyperlink.create(networkUrl),
          )
        }
      }

      if (opts.mdns) {
        const mdnsDisplay = `${opts.mdnsDomain}:${server.port}`
        const mdnsUrl = `http://${mdnsDisplay}`
        UI.println(
          UI.Style.TEXT_INFO_BOLD + "  mDNS:              ",
          UI.Style.TEXT_NORMAL,
          Hyperlink.create(mdnsUrl, mdnsDisplay),
        )
      }

      // Print auto-generated token to stderr only (not structured logs) — AC-09
      if (opts.password && !Flag.OPENCODE_SERVER_PASSWORD && !opts.noAuth) {
        UI.println(UI.Style.TEXT_WARNING_BOLD + "  Write token:       ", UI.Style.TEXT_NORMAL, opts.password)
        if (opts.readPassword && !Flag.OPENCODE_SERVER_READ_PASSWORD) {
          UI.println(UI.Style.TEXT_WARNING_BOLD + "  Read token:        ", UI.Style.TEXT_NORMAL, opts.readPassword)
        }
        UI.println(
          UI.Style.TEXT_WARNING_BOLD +
            "⚠  " +
            "Server bound to non-loopback address. Ensure firewall rules are in place.",
        )
      }

      // Open localhost in browser
      open(localhostUrl.toString()).catch(() => {})
    } else {
      const displayUrl = server.url.toString()
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, Hyperlink.create(displayUrl))

      // Print auto-generated token to stderr only (not structured logs) — AC-09
      if (opts.password && !Flag.OPENCODE_SERVER_PASSWORD && !opts.noAuth) {
        UI.println(UI.Style.TEXT_WARNING_BOLD + "  Write token:       ", UI.Style.TEXT_NORMAL, opts.password)
        if (opts.readPassword && !Flag.OPENCODE_SERVER_READ_PASSWORD) {
          UI.println(UI.Style.TEXT_WARNING_BOLD + "  Read token:        ", UI.Style.TEXT_NORMAL, opts.readPassword)
        }
      }

      open(displayUrl).catch(() => {})
    }

    await new Promise(() => {})
    await server.stop()
  },
})
