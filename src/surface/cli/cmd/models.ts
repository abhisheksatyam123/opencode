import type { Argv } from "yargs"
import { Instance } from "@/config/project/instance"
import { Provider } from "@/provider/provider"
import { ProviderID } from "@/provider/schema"
import { ModelsDev } from "@/provider/models"
import { cmd } from "@/surface/cli/cmd/cmd"
import { UI } from "@/surface/cli/ui"
import { EOL } from "os"
import { emitError, makeYargsFailHandler, type SubcmdSpec } from "@/surface/cli/cmd/_help"

const MODELS_SPEC: SubcmdSpec = {
  name: "models",
  summary: "List available models across configured providers.",
  usage: "models [<provider>] [--verbose] [--refresh]",
  optional: [
    { flag: "<provider>", desc: "Filter to a single provider ID (e.g. anthropic, openai)" },
    { flag: "--verbose", desc: "Include model metadata (costs, context limits)" },
    { flag: "--refresh", desc: "Refresh the models cache from models.dev before listing" },
  ],
  examples: ["models", "models anthropic", "models --verbose", "models --refresh"],
  seeAlso: ["providers", "account"],
}

export const ModelsCommand = cmd({
  command: "models [provider]",
  describe: MODELS_SPEC.summary,
  builder: (yargs: Argv) => {
    return yargs
      .positional("provider", {
        describe: "provider ID to filter models by",
        type: "string",
        array: false,
      })
      .option("verbose", {
        describe: "use more verbose model output (includes metadata like costs)",
        type: "boolean",
      })
      .option("refresh", {
        describe: "refresh the models cache from models.dev",
        type: "boolean",
      })
      .fail(makeYargsFailHandler(MODELS_SPEC))
  },
  handler: async (args) => {
    if (args.refresh) {
      await ModelsDev.refresh(true)
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Models cache refreshed" + UI.Style.TEXT_NORMAL)
    }

    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const providers = await Provider.list()

        function printModels(providerID: ProviderID, verbose?: boolean) {
          const provider = providers[providerID]
          const sortedModels = Object.entries(provider.models).sort(([a], [b]) => a.localeCompare(b))
          for (const [modelID, model] of sortedModels) {
            process.stdout.write(`${providerID}/${modelID}`)
            process.stdout.write(EOL)
            if (verbose) {
              process.stdout.write(JSON.stringify(model, null, 2))
              process.stdout.write(EOL)
            }
          }
        }

        if (args.provider) {
          const provider = providers[ProviderID.make(args.provider)]
          if (!provider) {
            emitError(
              MODELS_SPEC,
              `provider not found: ${args.provider}`,
              `models <provider>   — run \`opencode providers\` to list configured providers`,
            )
          }

          printModels(ProviderID.make(args.provider), args.verbose)
          return
        }

        const providerIDs = Object.keys(providers).sort((a, b) => {
          const aIsOpencode = a.startsWith("opencode")
          const bIsOpencode = b.startsWith("opencode")
          if (aIsOpencode && !bIsOpencode) return -1
          if (!aIsOpencode && bIsOpencode) return 1
          return a.localeCompare(b)
        })

        for (const providerID of providerIDs) {
          printModels(ProviderID.make(providerID), args.verbose)
        }
      },
    })
  },
})
