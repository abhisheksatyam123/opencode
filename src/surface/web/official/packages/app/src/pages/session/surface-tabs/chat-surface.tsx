import { ResizeHandle, type ResizeHandleProps } from "@opencode-ai/ui/resize-handle"
import { NewSessionView } from "@/components/session"
import { SessionComposerRegion } from "@/pages/session/composer"
import { MessageTimeline } from "@/pages/session/message-timeline"
import { Match, Show, Switch, type ComponentProps } from "solid-js"

type TimelineProps = ComponentProps<typeof MessageTimeline>
type ComposerProps = ComponentProps<typeof SessionComposerRegion>

export type ChatSurfaceProps = {
  inactive: boolean
  pointerInactive: boolean
  hidden: boolean
  transition: boolean
  width: string
  sessionID?: string
  messagesReady: boolean

  timelineMobileChanges: TimelineProps["mobileChanges"]
  timelineMobileFallback: TimelineProps["mobileFallback"]
  timelineActions: TimelineProps["actions"]
  timelineScroll: TimelineProps["scroll"]
  onResumeScroll: TimelineProps["onResumeScroll"]
  setScrollRef: TimelineProps["setScrollRef"]
  onScheduleScrollState: TimelineProps["onScheduleScrollState"]
  onAutoScrollHandleScroll: TimelineProps["onAutoScrollHandleScroll"]
  onMarkScrollGesture: TimelineProps["onMarkScrollGesture"]
  hasScrollGesture: TimelineProps["hasScrollGesture"]
  onUserScroll: TimelineProps["onUserScroll"]
  onTurnBackfillScroll: TimelineProps["onTurnBackfillScroll"]
  onAutoScrollInteraction: TimelineProps["onAutoScrollInteraction"]
  centered: TimelineProps["centered"]
  setContentRef: TimelineProps["setContentRef"]
  turnStart: TimelineProps["turnStart"]
  historyMore: TimelineProps["historyMore"]
  historyLoading: TimelineProps["historyLoading"]
  onLoadEarlier: TimelineProps["onLoadEarlier"]
  renderedUserMessages: TimelineProps["renderedUserMessages"]
  anchor: TimelineProps["anchor"]

  composerState: ComposerProps["state"]
  composerReady: ComposerProps["ready"]
  inputRef: ComposerProps["inputRef"]
  newSessionWorktree: ComposerProps["newSessionWorktree"]
  onNewSessionWorktreeReset: ComposerProps["onNewSessionWorktreeReset"]
  onComposerSubmit: ComposerProps["onSubmit"]
  composerFollowup: ComposerProps["followup"]
  composerRevert: ComposerProps["revert"]
  setPromptDockRef: ComposerProps["setPromptDockRef"]

  reviewResizeOpen: boolean
  reviewResizeSize: ResizeHandleProps["size"]
  onReviewResizeStart: () => void
  onReviewResize: ResizeHandleProps["onResize"]
}

export function ChatSurface(props: ChatSurfaceProps) {
  return (
    <div
      aria-hidden={props.inactive}
      inert={props.inactive}
      classList={{
        "@container relative shrink-0 flex flex-col min-h-0 h-full bg-background-stronger flex-1 md:flex-none": true,
        "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
          props.transition,
        "pointer-events-none": props.pointerInactive,
        hidden: props.hidden,
      }}
      style={{
        width: props.width,
      }}
    >
      <div class="flex-1 min-h-0 overflow-hidden">
        <Switch>
          <Match when={props.sessionID}>
            <Show when={props.messagesReady}>
              <MessageTimeline
                mobileChanges={props.timelineMobileChanges}
                mobileFallback={props.timelineMobileFallback}
                actions={props.timelineActions}
                scroll={props.timelineScroll}
                onResumeScroll={props.onResumeScroll}
                setScrollRef={props.setScrollRef}
                onScheduleScrollState={props.onScheduleScrollState}
                onAutoScrollHandleScroll={props.onAutoScrollHandleScroll}
                onMarkScrollGesture={props.onMarkScrollGesture}
                hasScrollGesture={props.hasScrollGesture}
                onUserScroll={props.onUserScroll}
                onTurnBackfillScroll={props.onTurnBackfillScroll}
                onAutoScrollInteraction={props.onAutoScrollInteraction}
                centered={props.centered}
                setContentRef={props.setContentRef}
                turnStart={props.turnStart}
                historyMore={props.historyMore}
                historyLoading={props.historyLoading}
                onLoadEarlier={props.onLoadEarlier}
                renderedUserMessages={props.renderedUserMessages}
                anchor={props.anchor}
              />
            </Show>
          </Match>
          <Match when={true}>
            <NewSessionView worktree={props.newSessionWorktree} />
          </Match>
        </Switch>
      </div>

      <SessionComposerRegion
        state={props.composerState}
        ready={props.composerReady}
        centered={props.centered}
        inputRef={props.inputRef}
        newSessionWorktree={props.newSessionWorktree}
        onNewSessionWorktreeReset={props.onNewSessionWorktreeReset}
        onSubmit={props.onComposerSubmit}
        followup={props.composerFollowup}
        revert={props.composerRevert}
        setPromptDockRef={props.setPromptDockRef}
      />

      <Show when={props.reviewResizeOpen}>
        <div onPointerDown={() => props.onReviewResizeStart()}>
          <ResizeHandle
            direction="horizontal"
            size={props.reviewResizeSize}
            min={450}
            max={typeof window === "undefined" ? 1000 : window.innerWidth * 0.45}
            onResize={props.onReviewResize}
          />
        </div>
      </Show>
    </div>
  )
}
