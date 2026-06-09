import { Server } from "@/surface/server/server"
import { cmd } from "@/surface/cli/cmd/cmd"
import { withNetworkOptions, resolveNetworkOptions } from "@/surface/cli/network"
import { Flag } from "@/foundation/flag/flag"
import { Log } from "@/foundation/util/log"
import { Workspace } from "@/bus/control-plane/workspace"
import { Project } from "@/config/project/project"
import { Installation } from "@/init/installation"
// gap-29-followup-4: Hyperlink.create wraps HTTP URLs in OSC 8 escape
// sequences so users on supported terminals (iTerm2, kitty, wezterm,
// ghostty, vscode, warp, mintty, gnome-terminal/VTE, Windows Terminal)
// can click the URL to open the running server in their browser.
// Plain-text fallback is the URL itself, so unsupported terminals are
// unaffected.
import { Hyperlink } from "@/foundation/util/hyperlink"
import { type PermissionMode } from "@/config/types"

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  handler: async (args) => {
    const opts = await resolveNetworkOptions(args)
    if (!opts.password && !opts.noAuth) {
      console.log("Warning: server auth is disabled; server is unsecured.")
    }
    const server = await Server.listen({
      ...opts,
      permissionMode: opts.permissionMode as PermissionMode,
    })
    const serverUrl = `http://${server.hostname}:${server.port}`
    console.log(`opencode server listening on ${Hyperlink.create(serverUrl)}`)
    if (opts.password && !Flag.OPENCODE_SERVER_PASSWORD && !opts.noAuth) {
      console.log(`Write token: ${opts.password}`)
      if (opts.readPassword && !Flag.OPENCODE_SERVER_READ_PASSWORD) console.log(`Read token: ${opts.readPassword}`)
    }
    console.log(`opencode logs: ${Log.file()}`)

    await new Promise(() => {})
    await server.stop()
  },
})
