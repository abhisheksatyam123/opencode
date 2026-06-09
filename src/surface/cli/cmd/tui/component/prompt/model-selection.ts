export type PromptModelSelection = { providerID: string; modelID: string }

type MaybePromptModelSelection = PromptModelSelection | undefined

type LiveSubagentModel = {
  providerID?: string
  modelID?: string
}

export function selectActivePromptModel(input: {
  sessionHasParent: boolean
  scopedModel?: MaybePromptModelSelection
  localModel?: MaybePromptModelSelection
  liveSubagentModel?: LiveSubagentModel
}): MaybePromptModelSelection {
  const live = input.liveSubagentModel
  if (input.sessionHasParent && live?.providerID && live?.modelID) {
    return { providerID: live.providerID, modelID: live.modelID }
  }
  return input.scopedModel ?? input.localModel
}
