import { readFile, stat } from "node:fs/promises"
import { extname, isAbsolute, relative, resolve, sep } from "node:path"

export type AugmentableIntelGraphNode = {
  id: string
  label?: string
  kind: string
  file_path: string | null
  line: number | null
  end_line: number | null
  line_count: number | null
  exported: boolean
  doc: string | null
  owning_class: string | null
  signature?: string | null
  tags?: string[]
  confidence?: number
  metrics?: Record<string, number>
  source?: "indexed" | "manual" | "derived"
}

export type AugmentableIntelGraphEdge = {
  id?: string
  src: string
  dst: string
  kind: string
  label?: string
  direction?: "incoming" | "outgoing" | "both"
  direct?: boolean
  depth?: number
  path_id?: string
  confidence?: number
  tags?: string[]
  manual?: boolean
  resolution_kind: string | null
  metadata: Record<string, unknown> | null
}

export type AugmentableIntelGraphJson = {
  workspace: string
  snapshot_id: number
  nodes: AugmentableIntelGraphNode[]
  edges: AugmentableIntelGraphEdge[]
  total_nodes: number
  total_edges: number
}

type CFunctionBody = {
  node: AugmentableIntelGraphNode
  name: string
  file: string
  params: string
  body: string
}

const C_FUNCTION_RE =
  /^\s*(?:static\s+|inline\s+|extern\s+|__\w+\s+)*(?:[A-Za-z_][\w\s*]+\s+)+([A-Za-z_]\w*)\s*\(([^;{}]*)\)\s*\{/gm
const C_SOURCE_EXTS = new Set([".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".hh", ".hxx"])

function normalizeRel(path: string) {
  return path.split(sep).join("/")
}

function inside(root: string, path: string) {
  const rel = relative(root, path)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function edgeId(src: string, dst: string, kind: string) {
  return `${kind}:${src}->${dst}`
}

function nodeLabel(id: string) {
  const [name] = id.split("@")
  return name || id.split("#").pop() || id
}

function normalizeEdge(edge: AugmentableIntelGraphEdge): AugmentableIntelGraphEdge {
  return {
    ...edge,
    id: edge.id ?? edgeId(edge.src, edge.dst, edge.kind),
    label: edge.label ?? edge.kind.replace(/_/g, " "),
    resolution_kind: edge.resolution_kind ?? null,
    metadata: edge.metadata ?? null,
  }
}

function findMatchingBrace(text: string, open: number) {
  let depth = 0
  for (let index = open; index < text.length; index++) {
    const char = text[index]
    if (char === "{") depth++
    if (char === "}") {
      depth--
      if (depth === 0) return index
    }
  }
  return -1
}

function parameterNames(params: string) {
  return params
    .split(",")
    .map((param) => param.replace(/\/\*.*?\*\//g, " ").trim())
    .map((param) => {
      const fnPointer = param.match(/\(\s*\*\s*([A-Za-z_]\w*)\s*\)/)
      if (fnPointer?.[1]) return fnPointer[1]
      const match = param.match(/([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?$/)
      return match?.[1] ?? ""
    })
    .filter(Boolean)
}

function splitArguments(text: string) {
  const args: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === "(" || char === "{" || char === "[") depth++
    else if (char === ")" || char === "}" || char === "]") depth--
    else if (char === "," && depth === 0) {
      args.push(text.slice(start, index).trim())
      start = index + 1
    }
  }
  const last = text.slice(start).trim()
  if (last) args.push(last)
  return args
}

function graphFilePath(root: string, value: string) {
  const file = value.match(/@(.+):(\d+)$/)?.[1] ?? value
  if (!C_SOURCE_EXTS.has(extname(file).toLowerCase())) return null
  const full = isAbsolute(file) ? file : resolve(root, file)
  return inside(root, full) ? full : null
}

async function graphCFiles(root: string, graph: AugmentableIntelGraphJson): Promise<string[]> {
  const candidates = new Set<string>()
  for (const node of graph.nodes) {
    if (node.file_path) {
      const full = graphFilePath(root, node.file_path)
      if (full) candidates.add(full)
    }
    const full = graphFilePath(root, node.id)
    if (full) candidates.add(full)
  }
  for (const edge of graph.edges) {
    const src = graphFilePath(root, edge.src)
    const dst = graphFilePath(root, edge.dst)
    if (src) candidates.add(src)
    if (dst) candidates.add(dst)
  }

  const files: string[] = []
  for (const file of [...candidates].sort()) {
    const info = await stat(file).catch(() => null)
    if (info?.isFile()) files.push(file)
  }
  return files
}

export async function augmentCRelationships<TGraph extends AugmentableIntelGraphJson>(
  workspaceRoot: string,
  graph: TGraph,
): Promise<TGraph> {
  const root = resolve(workspaceRoot)
  const nodes = [...graph.nodes]
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const nodesByName = new Map<string, AugmentableIntelGraphNode>()
  const functionsByFile = new Map<string, AugmentableIntelGraphNode[]>()
  const preferNode = (name: string, candidate: AugmentableIntelGraphNode) => {
    const current = nodesByName.get(name)
    if (!current) {
      nodesByName.set(name, candidate)
      return
    }
    const currentExt = extname(current.file_path ?? "").toLowerCase()
    const candidateExt = extname(candidate.file_path ?? "").toLowerCase()
    const currentHeader = currentExt === ".h" || currentExt === ".hpp" || currentExt === ".hh" || currentExt === ".hxx"
    const candidateSource =
      candidateExt === ".c" || candidateExt === ".cc" || candidateExt === ".cpp" || candidateExt === ".cxx"
    if (currentHeader && candidateSource) nodesByName.set(name, candidate)
  }

  for (const node of nodes) {
    if (node.kind !== "function" && node.kind !== "api") continue
    const name = node.label ?? nodeLabel(node.id)
    preferNode(name, node)
    if (!node.file_path) continue
    const file = normalizeRel(isAbsolute(node.file_path) ? relative(root, node.file_path) : node.file_path)
    if (!functionsByFile.has(file)) functionsByFile.set(file, [])
    functionsByFile.get(file)!.push(node)
  }

  const bodies: CFunctionBody[] = []
  const fieldRegistrations = new Map<string, AugmentableIntelGraphNode>()
  const files = await graphCFiles(root, graph)
  if (!files.length) return graph

  for (const fullPath of files) {
    const file = normalizeRel(relative(root, fullPath))
    const fileNodes = functionsByFile.get(file) ?? []
    const text = await readFile(fullPath, "utf8").catch(() => "")
    if (!text) continue
    const nodeByName = new Map(fileNodes.map((node) => [node.label ?? nodeLabel(node.id), node]))
    for (const match of text.matchAll(/\.\s*([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)/g)) {
      const field = match[1]
      const target = match[2]
      const targetNode = target ? nodesByName.get(target) : undefined
      if (field && targetNode) fieldRegistrations.set(field, targetNode)
    }
    for (const match of text.matchAll(C_FUNCTION_RE)) {
      const name = match[1]
      if (!name) continue
      const line = text.slice(0, match.index).split(/\r?\n/).length
      const id = `${name}@${file}:${line}`
      let node = nodeById.get(id) ?? nodeByName.get(name)
      if (!node || node.file_path !== file || node.line !== line) {
        node = {
          id,
          label: name,
          kind: "function",
          file_path: file,
          line,
          end_line: null,
          line_count: null,
          exported: false,
          doc: null,
          owning_class: null,
          source: "indexed",
          tags: [],
          confidence: 1,
          metrics: {},
        }
        if (!nodeById.has(id)) {
          nodeById.set(id, node)
          nodes.push(node)
        }
      }
      preferNode(name, node)
      const open = text.indexOf("{", match.index)
      const close = open >= 0 ? findMatchingBrace(text, open) : -1
      if (open < 0 || close < 0) continue
      bodies.push({ node, name, file, params: match[2] ?? "", body: text.slice(open + 1, close) })
    }
  }

  const bodiesByName = new Map(bodies.map((body) => [body.name, body]))
  const seen = new Set(graph.edges.map((edge) => edge.id ?? edgeId(edge.src, edge.dst, edge.kind)))
  const edges = [...graph.edges]
  const addEdge = (
    src: AugmentableIntelGraphNode,
    dst: AugmentableIntelGraphNode,
    kind: string,
    resolution_kind: string,
  ) => {
    const id = edgeId(src.id, dst.id, kind)
    if (seen.has(id)) return
    seen.add(id)
    edges.push(
      normalizeEdge({
        id,
        src: src.id,
        dst: dst.id,
        kind,
        resolution_kind,
        metadata: { derived_by: "intelgraph-callback-compat" },
        confidence: 0.8,
        tags: [kind, "callback"],
      }),
    )
  }

  for (const caller of bodies) {
    for (const call of caller.body.matchAll(/\b([A-Za-z_]\w*)\s*\(([^;{}]*)\)/g)) {
      const calleeName = call[1]
      if (!calleeName) continue
      const callee = bodiesByName.get(calleeName)
      const directTarget = callee?.node ?? nodesByName.get(calleeName)
      if (directTarget && directTarget.id !== caller.node.id) addEdge(caller.node, directTarget, "calls", "source_call")
      const args = splitArguments(call[2] ?? "")
      for (const arg of args) {
        const target = nodesByName.get(arg.replace(/^&/, "").trim())
        if (!target || !callee) continue
        addEdge(caller.node, target, "registers_callback", "callback_registration")
        addEdge(caller.node, target, "data_flow_source", "callback_argument_flow")
        const params = parameterNames(callee.params)
        if (params.some((param) => new RegExp(`\\b${param}\\s*\\(`).test(callee.body))) {
          addEdge(callee.node, target, "runtime_calls", "callback_dispatch")
          addEdge(callee.node, target, "indirect_calls", "callback_dispatch")
        }
      }
    }
    for (const fieldCall of caller.body.matchAll(/(?:->|\.)\s*([A-Za-z_]\w*)\s*\(/g)) {
      const target = fieldCall[1] ? fieldRegistrations.get(fieldCall[1]) : undefined
      if (!target) continue
      addEdge(caller.node, target, "runtime_calls", "struct_callback_dispatch")
      addEdge(caller.node, target, "indirect_calls", "struct_callback_dispatch")
    }
  }

  return {
    ...graph,
    nodes,
    edges,
    total_nodes: Math.max(graph.total_nodes, nodes.length),
    total_edges: Math.max(graph.total_edges, edges.length),
  }
}
