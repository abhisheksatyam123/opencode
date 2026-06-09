#!/usr/bin/env bun

import path from "node:path"
import { existsSync } from "node:fs"
import { networkInterfaces } from "node:os"

const args = process.argv.slice(2)
const root = path.resolve(import.meta.dir, "..")
const officialAppDir = path.join(root, "src/surface/web/official/packages/app")
const indexEntry = path.join(root, "src/index.ts")
const bunBin = process.execPath
const inferredWorkspaceRoot = (() => {
  const cwd = process.cwd()
  const normalized = cwd.replaceAll("\\", "/")
  const marker = "/qprojects/"
  const markerIndex = normalized.indexOf(marker)
  if (markerIndex === -1) return undefined
  return normalized.slice(0, markerIndex) || "/"
})()

const uiOptionNames = new Set(["--port", "--hostname", "--api-port", "--api-hostname", "--workspace-root"])
const wildcardHosts = new Set(["0.0.0.0", "::", "::0"])

const optionValue = (input: string[], name: string) => {
  for (let index = 0; index < input.length; index++) {
    const item = input[index]
    if (item === name) return input[index + 1]
    if (item.startsWith(`${name}=`)) return item.slice(name.length + 1)
  }
  return undefined
}

interface OptionRead {
  matched: boolean
  value?: string
  skipNext: boolean
}

const emptyOptionRead: OptionRead = { matched: false, skipNext: false }
const optionTokenValue = (item: string, name: string) =>
  item.startsWith(`${name}=`) ? item.slice(name.length + 1) : undefined
const isOptionValue = (value: string | undefined): value is string => Boolean(value && !value.startsWith("--"))

const followingOptionValue = (input: string[], index: number) => {
  const next = input[index + 1]
  return isOptionValue(next) ? { value: next, skipNext: true } : { skipNext: false }
}

const readOption = (input: string[], index: number, name: string): OptionRead => {
  const item = input[index]
  const inlineValue = optionTokenValue(item, name)
  if (inlineValue !== undefined) return { matched: true, value: inlineValue, skipNext: false }
  if (item === name) return { matched: true, ...followingOptionValue(input, index) }
  return emptyOptionRead
}

const scanOptions = (input: string[], name: string, visit: (option: OptionRead, item: string) => void) => {
  for (let index = 0; index < input.length; index++) {
    const option = readOption(input, index, name)
    visit(option, input[index])
    if (option.skipNext) index++
  }
}

const optionValues = (input: string[], name: string) => {
  const out: string[] = []
  scanOptions(input, name, (option) => {
    if (option.value !== undefined) out.push(option.value)
  })
  return out
}

const hasOption = (input: string[], name: string) =>
  input.includes(name) || input.some((item) => item.startsWith(`${name}=`))

const pushOptionValues = (out: string[], input: string[], name: string) => {
  for (const value of optionValues(input, name)) out.push(name, value)
}

const dropOption = (input: string[], name: string) => {
  const out: string[] = []
  scanOptions(input, name, (option, item) => {
    if (!option.matched) out.push(item)
  })
  return out
}

const hasMdns = args.includes("--mdns")
const hasExplicitHostname = hasOption(args, "--hostname")
const uiHost = optionValue(args, "--hostname") ?? (hasMdns && !hasExplicitHostname ? "0.0.0.0" : "127.0.0.1")
const uiPort = optionValue(args, "--port") ?? "3002"
const apiHost = optionValue(args, "--api-hostname") ?? uiHost
const defaultApiPort = /^\d+$/.test(uiPort) ? String(Number(uiPort) + 1) : "4097"
const apiPort = optionValue(args, "--api-port") ?? defaultApiPort
const workspaceRoot = optionValue(args, "--workspace-root") ?? inferredWorkspaceRoot ?? process.cwd()

const localIpv4Addresses = () =>
  Object.values(networkInterfaces())
    .flatMap((values) => values ?? [])
    .filter((info) => !info.internal && info.family === "IPv4")
    .map((info) => info.address)

const defaultCorsOrigins = (() => {
  const hosts = wildcardHosts.has(uiHost)
    ? ["localhost", "127.0.0.1", ...localIpv4Addresses()]
    : ["localhost", "127.0.0.1", uiHost]
  return new Set(hosts.map((host) => `http://${host}:${uiPort}`))
})()

async function forwardToCli(input: string[]) {
  const child = Bun.spawn([bunBin, "run", "--conditions=browser", indexEntry, ...input], {
    cwd: root,
    stdio: ["inherit", "inherit", "inherit"],
    env: process.env,
  })
  const code = await child.exited
  process.exit(code)
}

if (args[0] !== "web" || !existsSync(path.join(officialAppDir, "package.json"))) {
  await forwardToCli(args)
}

const rawWebArgs = args.slice(1)
const userCorsOrigins = new Set(optionValues(rawWebArgs, "--cors"))

const backendArgs = ["run", "--conditions=browser", indexEntry, "serve", "--hostname", apiHost, "--port", apiPort]
if (hasOption(rawWebArgs, "--mdns")) backendArgs.push("--mdns")
pushOptionValues(backendArgs, rawWebArgs, "--mdns-domain")
pushOptionValues(backendArgs, rawWebArgs, "--permission-mode")
pushOptionValues(backendArgs, rawWebArgs, "--log-level")
if (hasOption(rawWebArgs, "--print-logs")) backendArgs.push("--print-logs")
if (hasOption(rawWebArgs, "--pure")) backendArgs.push("--pure")
if (hasOption(rawWebArgs, "--no-auth")) backendArgs.push("--no-auth=true")
for (const origin of userCorsOrigins) backendArgs.push("--cors", origin)
for (const origin of defaultCorsOrigins) {
  if (userCorsOrigins.has(origin)) continue
  backendArgs.push("--cors", origin)
}

const frontendArgs = ["dev", "--host", uiHost, "--port", uiPort]

const frontendEnv: NodeJS.ProcessEnv = {
  ...process.env,
  VITE_OPENCODE_SERVER_PORT: apiPort,
}

if (apiHost !== "0.0.0.0") {
  frontendEnv.VITE_OPENCODE_SERVER_HOST = apiHost
}

console.error(`[dev-web] backend: http://${apiHost}:${apiPort}`)
console.error(`[dev-web] workspace-root: ${workspaceRoot}`)
console.error(`[dev-web] cors-origins: ${Array.from(defaultCorsOrigins).join(", ")}`)
console.error(`[dev-web] frontend: http://${uiHost}:${uiPort}`)
console.error("[dev-web] press Ctrl+C to stop both")

const backend = Bun.spawn([bunBin, ...backendArgs], {
  cwd: workspaceRoot,
  stdio: ["inherit", "inherit", "inherit"],
  env: process.env,
})

const frontend = Bun.spawn([bunBin, ...frontendArgs], {
  cwd: officialAppDir,
  stdio: ["inherit", "inherit", "inherit"],
  env: frontendEnv,
})

let closed = false
let receivedSignal = false
const shutdown = () => {
  if (closed) return
  closed = true
  backend.kill()
  frontend.kill()
}

const handleSignal = () => {
  receivedSignal = true
  shutdown()
  setTimeout(() => process.exit(0), 100)
}

process.once("SIGINT", handleSignal)
process.once("SIGTERM", handleSignal)

const winner = await Promise.race([
  backend.exited.then((code) => ({ who: "backend" as const, code })),
  frontend.exited.then((code) => ({ who: "frontend" as const, code })),
])

shutdown()

if (winner.who === "backend") {
  await frontend.exited
} else {
  await backend.exited
}

process.exit(receivedSignal ? 0 : winner.code)
