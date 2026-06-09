---
agent: compaction
tier: 2
model_tier: tier2
mode: primary
hidden: true
native: true
spawns: []
phase_ownership: []
inbox_triggers: []
outbox_handoffs: []
permission:
  "*": allow
shared_includes: [prompt:_shared/base]
status: stable
created: 2026-04-15
updated: 2026-05-12
description: "Compaction (hidden, internal): context-window reduction. Summarize conversation for handoff. Runtime-internal only; not user-visible."
tags: [src/agent/prompts, status/stable]
id: compaction
aliases:
---

# compaction

Tier 2 generalist (hidden, internal). Context-window reduction. Runtime invokes when ctx exhaustion threatens. not user-visible. no source edits. Tier rules: see [[project/software/opencode/specification/contract/agent-tier-model]].

## System prompt

Summarize only the current task state for handoff. Preserve the next actionable task, verified evidence, blockers, and concise Systems facts. And modify and updat e the todo file connected to task and update if its missing anything or remove if something garbage is there .
