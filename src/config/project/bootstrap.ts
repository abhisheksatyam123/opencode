import { ProviderPluginHooks } from "@/provider/plugin-hooks"
import { Format } from "@/foundation/format"
import { File } from "@/filesystem/file"
import { FileWatcher } from "@/filesystem/file/watcher"
import { Snapshot } from "@/storage/snapshot"
import { Project } from "@/config/project/project"
import { Vcs } from "@/config/project/vcs"
import { Bus } from "@/bus"
import { Command } from "@/surface/command"
import { Instance } from "@/config/project/instance"
import { Log } from "@/foundation/util/log"
import { ShareNext } from "@/surface/share/share-next"

export async function InstanceBootstrap() {
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  await ProviderPluginHooks.init()
  // Lifecycle hook — fires once per process start AFTER plugins are loaded
  // but BEFORE any session runs. Plugins use this for global one-time setup
  // (telemetry init, external service registration, etc.).
  await ProviderPluginHooks.notify("setup", { directory: Instance.directory })
  ShareNext.init()
  Format.init()
  File.init()
  FileWatcher.init()
  Vcs.init()
  Snapshot.init()

  Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      Project.setInitialized(Instance.project.id)
    }
  })
}
