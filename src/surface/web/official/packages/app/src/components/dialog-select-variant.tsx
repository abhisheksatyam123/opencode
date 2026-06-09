import { Component, createMemo } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"

type VariantOption = {
  id: string
  label: string
}

export const DialogSelectVariant: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const local = useLocal()

  const items = createMemo<VariantOption[]>(() => [
    { id: "default", label: language.t("common.default") },
    ...local.model.variant.list().map((variant) => ({ id: variant, label: variant })),
  ])

  const current = createMemo(() => {
    const selected = local.model.variant.current() ?? "default"
    return items().find((item) => item.id === selected)
  })

  return (
    <Dialog
      title={language.t("command.model.variant.choose")}
      description={language.t("command.model.variant.choose.description")}
    >
      <List
        search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
        key={(item) => item?.id ?? ""}
        items={items}
        current={current()}
        filterKeys={["label", "id"]}
        sortBy={(a, b) => a.label.localeCompare(b.label)}
        onSelect={(item) => {
          if (!item) return
          local.model.variant.set(item.id === "default" ? undefined : item.id)
          dialog.close()
        }}
      >
        {(item) => <span class="w-full truncate">{item.label}</span>}
      </List>
    </Dialog>
  )
}
