#!/usr/bin/env node
/**
 * bridge.ts — Standalone TCP↔stdio bridge for language servers.
 *
 * This script is spawned as a DETACHED daemon by daemon.ts. It:
 *   1. Spawns a language server as a child process (stdio pipes)
 *   2. Creates a TCP server on the given port
 *   3. On each incoming TCP connection, pipes the socket ↔ server stdio
 *   4. Writes the server PID back to the state file so IntelGraph can
 *      track it for liveness checks
 *   5. Exits when the server exits (IntelGraph detects stale state on next start)
 *
 * CLI args:
 *   --port <number>        TCP port to listen on (required)
 *   --root <path>          Workspace root (for state file update + server cwd)
 *   --server <path>        Path to language server binary
 *   --server-args <args>   Comma-separated extra args for language server
 *   --clangd <path>        (Deprecated alias for --server)
 *   --clangd-args <args>   (Deprecated alias for --server-args)
 *   --log <path>           Log file path
 *
 * This file is bundled separately as dist/bridge.js.
 */

import { createServer, type Socket } from "net"
import { spawn } from "child_process"
import { appendFileSync, writeFileSync, readFileSync, existsSync } from "fs"
import path from "path"

// ── Argument parsing ──────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): {
  port: number
  root: string
  serverBin: string
  serverArgs: string[]
  logFile: string
} {
  const args = argv.slice(2)
  let port = 0
  let root = process.cwd()
  let serverBin = "clangd"
  let serverArgs: string[] = []
  let logFile = "/tmp/intelgraph-bridge.log"

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === "--port") port = parseInt(args[++i] ?? "0", 10)
    else if (a.startsWith("--port=")) port = parseInt(a.slice(7), 10)
    else if (a === "--root") root = args[++i] ?? root
    else if (a.startsWith("--root=")) root = a.slice(7)
    else if (a === "--server") serverBin = args[++i] ?? serverBin
    else if (a.startsWith("--server=")) serverBin = a.slice(9)
    else if (a === "--clangd") serverBin = args[++i] ?? serverBin
    else if (a.startsWith("--clangd=")) serverBin = a.slice(9)
    else if (a === "--server-args") serverArgs = (args[++i] ?? "").split(",").filter(Boolean)
    else if (a.startsWith("--server-args=")) serverArgs = a.slice(14).split(",").filter(Boolean)
    else if (a === "--clangd-args") serverArgs = (args[++i] ?? "").split(",").filter(Boolean)
    else if (a.startsWith("--clangd-args=")) serverArgs = a.slice(14).split(",").filter(Boolean)
    else if (a === "--log") logFile = args[++i] ?? logFile
    else if (a.startsWith("--log=")) logFile = a.slice(6)
  }

  if (!port) throw new Error("--port is required")
  return { port, root, serverBin, serverArgs, logFile }
}

// ── JSON Logger ───────────────────────────────────────────────────────────────

let _logFile = "/tmp/intelgraph-bridge.log"

function initLog(file: string): void {
  _logFile = file
  logJson("INFO", "Bridge starting", { pid: process.pid, logFile: file })
}

function logJson(level: string, message: string, data?: Record<string, any>): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    component: "BRIDGE",
    message,
    pid: process.pid,
    ...data,
  }
  const line = JSON.stringify(entry) + "\n"
  try {
    appendFileSync(_logFile, line)
  } catch {
    // ignore write errors
  }
  // Also write human-readable to stderr for debugging
  process.stderr.write(`${entry.timestamp} [${level}] [BRIDGE] ${message}\n`)
}

function logError(message: string, err: any): void {
  logJson("ERROR", message, {
    error: err?.message ?? String(err),
    stack: err?.stack,
  })
}

// ── State file update ─────────────────────────────────────────────────────────

// Match the daemon's stateFilePath() lookup without importing daemon/index.ts;
// the bridge is built as a separate dist bundle.
const STATE_FILE = ".intelgraph-state.json"

function resolveStateFile(root: string): string {
  return path.join(root, STATE_FILE)
}

function updateStateServerPid(root: string, serverPid: number): void {
  const stateFile = resolveStateFile(root)
  try {
    const text = readFileSync(stateFile, "utf8")
    const state = JSON.parse(text)
    state.serverPid = serverPid
    writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8")
    logJson("INFO", "Updated state file with server PID", { stateFile, serverPid })
  } catch (err) {
    logError("Failed to update state file", err)
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { port, root, serverBin, serverArgs, logFile } = parseArgs(process.argv)
  initLog(logFile)

  const defaultArgs = [
    "--background-index",
    "--clang-tidy=false",
    "--completion-style=detailed",
    "--header-insertion=never",
    "--log=error",
  ]
  const finalArgs = serverArgs.length > 0 ? serverArgs : defaultArgs

  logJson("INFO", "Spawning language server process", {
    serverBin,
    serverArgs: finalArgs,
    cwd: root,
  })

  // ── Spawn language server ────────────────────────────────────────────────────────────
  const server = spawn(serverBin, finalArgs, {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  })

  if (!server.pid) {
    logError("Failed to spawn language server (no PID)", new Error("No PID assigned"))
    process.exit(1)
  }

  logJson("INFO", "Language server spawned", { serverPid: server.pid })

  // Update state file with server PID so IntelGraph can track it
  updateStateServerPid(root, server.pid)

  // Forward language server stderr to our log
  server.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trimEnd()
    logJson("DEBUG", "Language server stderr", { text })
  })

  server.on("error", (err) => {
    logError("Language server process error", err)
  })

  server.on("exit", (code, signal) => {
    logJson("WARN", "Language server exited — bridge shutting down", { code, signal })
    tcpServer.close()
    process.exit(0)
  })

  // ── TCP server ──────────────────────────────────────────────────────────────
  //
  // Each incoming connection gets its own bidirectional pipe to the server's stdio.
  // Since a language server is typically a single-session server (one JSON-RPC connection), we only
  // allow one active connection at a time. A new connection replaces the old one.

  let activeSocket: Socket | null = null
  let connectionCount = 0

  const tcpServer = createServer((socket: Socket) => {
    connectionCount++
    const connId = connectionCount
    const remote = `${socket.remoteAddress}:${socket.remotePort}`
    const local = `${socket.localAddress}:${socket.localPort}`
    logJson("INFO", "New TCP connection", { connId, remote, local })

    // If there's an existing connection, destroy it (IntelGraph reconnected)
    if (activeSocket && !activeSocket.destroyed) {
      logJson("INFO", "Replacing previous TCP connection", { connId })
      activeSocket.destroy()
    }
    activeSocket = socket

    socket.on("error", (err) => {
      logJson("WARN", "TCP socket error", { connId, remote, error: err.message })
    })

    socket.on("close", (hadError) => {
      logJson("INFO", "TCP connection closed", { connId, remote, local, hadError })
      if (activeSocket === socket) activeSocket = null
    })

    // Pipe: TCP socket → language server stdin
    socket.on("data", (chunk: Buffer) => {
      if (!server.stdin?.writable) {
        logJson("WARN", "Language server stdin not writable — dropping data", { connId, bytes: chunk.length })
        return
      }
      server.stdin.write(chunk, (err) => {
        if (err) {
          logJson("ERROR", "stdin write error", { connId, error: err.message })
        }
      })
    })

    // Pipe: language server stdout → TCP socket
    const onStdout = (chunk: Buffer) => {
      if (!socket.destroyed) {
        socket.write(chunk, (err) => {
          if (err) {
            logJson("ERROR", "socket write error", { connId, error: err.message })
          }
        })
      }
    }
    server.stdout?.on("data", onStdout)

    socket.on("close", () => {
      server.stdout?.removeListener("data", onStdout)
    })
  })

  tcpServer.on("error", (err) => {
    logError("TCP server error", err)
    process.exit(1)
  })

  await new Promise<void>((resolve) => {
    tcpServer.listen(port, "127.0.0.1", () => {
      logJson("INFO", "TCP bridge listening", { host: "127.0.0.1", port })
      resolve()
    })
  })

  // Keep the process alive
  process.on("SIGINT", () => {
    logJson("INFO", "SIGINT received — shutting down bridge", { port })
    tcpServer.close()
    server.kill()
    process.exit(0)
  })

  process.on("SIGTERM", () => {
    logJson("INFO", "SIGTERM received — shutting down bridge", { port })
    tcpServer.close()
    server.kill()
    process.exit(0)
  })
}

main().catch((err) => {
  process.stderr.write(`[bridge] Fatal: ${err}\n`)
  process.exit(1)
})
