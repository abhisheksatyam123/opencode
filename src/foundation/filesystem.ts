import { relative } from "path"

export namespace Filesystem {
  export function contains(parent: string, child: string) {
    return !relative(parent, child).startsWith("..")
  }

  export function overlaps(a: string, b: string) {
    const relA = relative(a, b)
    const relB = relative(b, a)
    return !relA || !relA.startsWith("..") || !relB || !relB.startsWith("..")
  }
}
