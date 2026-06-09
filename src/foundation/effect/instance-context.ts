import { Context } from "./context"
import { Filesystem } from "../filesystem"

export interface InstanceContext {
  directory: string
  worktree: string
  project: any
}

const context = Context.create<InstanceContext>("instance")

export const InstanceContextStorage = {
  use: context.use,
  provide: context.provide,
  get current() {
    return context.use()
  },
  get directory() {
    return context.use().directory
  },
  get worktree() {
    return context.use().worktree
  },
  get project() {
    return context.use().project
  },
  bind<F extends (...args: any[]) => any>(fn: F): F {
    const ctx = context.use()
    return ((...args: any[]) => context.provide(ctx, () => fn(...args))) as F
  },
  restore<R>(ctx: InstanceContext, fn: () => R): R {
    return context.provide(ctx, fn)
  },
  containsPath(filepath: string) {
    const ctx = context.use()
    if (Filesystem.contains(ctx.directory, filepath)) return true
    if (ctx.worktree === "/") return false
    return Filesystem.contains(ctx.worktree, filepath)
  },
}
