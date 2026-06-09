import type { Argv } from "yargs"
import type { Session as SDKSession, Message, Part } from "@opencode-ai/sdk/v2"
import { Session } from "@/process/session"
import { MessageV2 } from "@/process/session/message-v2"
import { cmd } from "@/surface/cli/cmd/cmd"
import { bootstrap } from "@/surface/cli/bootstrap"
import { Database } from "@/storage/db"
import { SessionTable, MessageTable, PartTable } from "@/process/session/session.sql"
import { Instance } from "@/config/project/instance"
import { ShareNext } from "@/surface/share/share-next"
import { EOL } from "os"
import { Filesystem } from "@/foundation/util/filesystem"
// gap-abort-followup-3: bound the share-data fetch with a timeout
// so a slow share endpoint can't hang `opencode import` forever.
import { abortAfter } from "@/foundation/util/abort"

/** Discriminated union returned by the ShareNext API (GET /api/shares/:id/data) */
export type ShareData =
  | { type: "session"; data: SDKSession }
  | { type: "message"; data: Message }
  | { type: "part"; data: Part }
  | { type: "session_diff"; data: unknown }
  | { type: "model"; data: unknown }

/** Extract share ID from a share URL like https://opncd.ai/share/abc123 */
export function parseShareUrl(url: string): string | null {
  const match = url.match(/^https?:\/\/[^/]+\/share\/([a-zA-Z0-9_-]+)$/)
  return match ? match[1] : null
}

export function shouldAttachShareAuthHeaders(shareUrl: string, accountBaseUrl: string): boolean {
  try {
    return new URL(shareUrl).origin === new URL(accountBaseUrl).origin
  } catch {
    return false
  }
}

/**
 * Transform ShareNext API response (flat array) into the nested structure for local file storage.
 *
 * The API returns a flat array: [session, message, message, part, part, ...]
 * Local storage expects: { info: session, messages: [{ info: message, parts: [part, ...] }, ...] }
 *
 * This groups parts by their messageID to reconstruct the hierarchy before writing to disk.
 */
export function transformShareData(shareData: ShareData[]): {
  info: SDKSession
  messages: Array<{ info: Message; parts: Part[] }>
} | null {
  const sessionItem = shareData.find((d) => d.type === "session")
  if (!sessionItem) return null

  const messageMap = new Map<string, Message>()
  const partMap = new Map<string, Part[]>()

  for (const item of shareData) {
    if (item.type === "message") {
      messageMap.set(item.data.id, item.data)
    } else if (item.type === "part") {
      if (!partMap.has(item.data.messageID)) {
        partMap.set(item.data.messageID, [])
      }
      partMap.get(item.data.messageID)!.push(item.data)
    }
  }

  if (messageMap.size === 0) return null

  return {
    info: sessionItem.data,
    messages: Array.from(messageMap.values()).map((msg) => ({
      info: msg,
      parts: partMap.get(msg.id) ?? [],
    })),
  }
}

export const ImportCommand = cmd({
  command: "import <file>",
  describe: "import session data from JSON file or URL",
  builder: (yargs: Argv) => {
    return yargs.positional("file", {
      describe: "path to JSON file or share URL",
      type: "string",
      demandOption: true,
    })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      let exportData:
        | {
            info: SDKSession
            messages: Array<{
              info: Message
              parts: Part[]
            }>
          }
        | undefined

      const isUrl = args.file.startsWith("http://") || args.file.startsWith("https://")

      if (isUrl) {
        const slug = parseShareUrl(args.file)
        if (!slug) {
          const baseUrl = await ShareNext.url()
          process.stdout.write(`Invalid URL format. Expected: ${baseUrl}/share/<slug>`)
          process.stdout.write(EOL)
          return
        }

        const parsed = new URL(args.file)
        const baseUrl = parsed.origin
        const req = await ShareNext.request()
        const headers = shouldAttachShareAuthHeaders(args.file, req.baseUrl) ? req.headers : {}

        const dataPath = req.api.data(slug)
        // gap-abort-followup-3: 30s timeout per share-data fetch.
        // Share data can be moderately large (full session export)
        // so 30s gives slow connections / large sessions room while
        // still capping the worst-case hang.
        const aborter1 = abortAfter(30_000)
        let response = await fetch(`${baseUrl}${dataPath}`, {
          headers,
          signal: aborter1.signal,
        }).finally(() => aborter1.clearTimeout())

        if (!response.ok && dataPath !== `/api/share/${slug}/data`) {
          const aborter2 = abortAfter(30_000)
          response = await fetch(`${baseUrl}/api/share/${slug}/data`, {
            headers,
            signal: aborter2.signal,
          }).finally(() => aborter2.clearTimeout())
        }

        if (!response.ok) {
          process.stdout.write(`Failed to fetch share data: ${response.statusText}`)
          process.stdout.write(EOL)
          return
        }

        const shareData: ShareData[] = await response.json()
        const transformed = transformShareData(shareData)

        if (!transformed) {
          process.stdout.write(`Share not found or empty: ${slug}`)
          process.stdout.write(EOL)
          return
        }

        exportData = transformed
      } else {
        exportData = await Filesystem.readJson<NonNullable<typeof exportData>>(args.file).catch(() => undefined)
        if (!exportData) {
          process.stdout.write(`File not found: ${args.file}`)
          process.stdout.write(EOL)
          return
        }
      }

      if (!exportData) {
        process.stdout.write(`Failed to read session data`)
        process.stdout.write(EOL)
        return
      }

      const info = Session.Info.parse({
        ...exportData.info,
        projectID: Instance.project.id,
      })
      const row = Session.toRow(info)
      Database.use((db) =>
        db
          .insert(SessionTable)
          .values(row)
          .onConflictDoUpdate({ target: SessionTable.id, set: { project_id: row.project_id } })
          .run(),
      )

      for (const msg of exportData.messages) {
        const msgInfo = MessageV2.Info.parse(msg.info)
        const { id, sessionID: _, ...msgData } = msgInfo
        Database.use((db) =>
          db
            .insert(MessageTable)
            .values({
              id,
              session_id: row.id,
              time_created: msgInfo.time?.created ?? Date.now(),
              data: msgData,
            })
            .onConflictDoNothing()
            .run(),
        )

        for (const part of msg.parts) {
          const partInfo = MessageV2.Part.parse(part)
          const { id: partId, sessionID: _s, messageID, ...partData } = partInfo
          Database.use((db) =>
            db
              .insert(PartTable)
              .values({
                id: partId,
                message_id: messageID,
                session_id: row.id,
                data: partData,
              })
              .onConflictDoNothing()
              .run(),
          )
        }
      }

      process.stdout.write(`Imported session: ${exportData.info.id}`)
      process.stdout.write(EOL)
    })
  },
})
