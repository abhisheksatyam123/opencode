/**
 * ts-core/extractor.ts — TypeScript / JavaScript extractor plugin.
 *
 * Walks .ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs files in a workspace,
 * parses each one with tree-sitter (typescript or tsx grammar), and
 * yields:
 *
 *   - SymbolFact: one per top-level function, class, interface,
 *     type alias, namespace, plus class methods. Kind reflects the
 *     TS-shaped categories added in contracts/common.ts.
 *   - SymbolFact (kind: 'module'): one per file, canonical_name is
 *     the workspace-relative path. Anchors imports/contains edges.
 *   - EdgeFact (kind: 'contains'): module → declared symbol.
 *   - EdgeFact (kind: 'imports'): module → imported module.
 *     Resolution is path-based (relative + absolute), not LSP-based,
 *     so external npm packages show up as bare module names.
 *   - EdgeFact (kind: 'calls'): caller function → callee identifier.
 *     Resolution is intra-file: we record the syntactic name of the
 *     callee, not its declaration site.
 *   - EdgeFact (kind: 'extends' / 'implements'): class/interface
 *     inheritance edges by name.
 *
 * No LSP server is required. tree-sitter-typescript is the only
 * runtime dependency, and we use ctx.workspace.walkFiles for
 * traversal and ctx.ripgrep for fast filename pre-scans when needed.
 *
 * Capabilities declared: symbols, types, direct-calls.
 *
 * appliesTo: matches workspaces that contain a package.json or
 * tsconfig.json at the root. Plain JS projects without either still
 * work via the explicit `--plugin ts-core` selector.
 */

import { existsSync, readdirSync, statSync } from "node:fs"
import { join, relative, dirname, resolve as resolvePath } from "node:path"
import { defineExtractor } from "../../intelligence/extraction/contract.js"
import type {
  Capability,
  WorkspaceProbe,
} from "../../intelligence/extraction/contract.js"
import type { ExtractionContext } from "../../intelligence/extraction/context.js"
import type { Fact } from "../../intelligence/extraction/facts.js"
import type {
  TsNode,
  SupportedLanguage,
} from "../../intelligence/extraction/services/treesitter-service.js"
import type { SymbolRow } from "../../intelligence/contracts/common.js"

const CAPABILITIES: Capability[] = ["symbols", "types", "direct-calls"]

const TS_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const

// Skip these directories during file walk — they generate noise and
// blow up the symbol count without adding signal.
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  ".git",
  "coverage",
  ".vitest",
  "tmp",
])

const tsCoreExtractor = defineExtractor({
  metadata: {
    name: "ts-core",
    version: "0.1.0",
    description:
      "TypeScript / JavaScript extractor: modules, symbols, imports, calls, inheritance. Uses tree-sitter, no LSP required.",
    capabilities: CAPABILITIES,
    appliesTo: (probe: WorkspaceProbe) => {
      // Active when the workspace looks like a TS/JS project. The
      // common markers are package.json/tsconfig.json/etc., but we
      // also do a one-level filesystem scan as a fallback for source
      // snapshots that don't ship a manifest (e.g. openclaude, which
      // is a security research mirror).
      const root = probe.workspaceRoot
      if (
        existsSync(join(root, "package.json")) ||
        existsSync(join(root, "tsconfig.json")) ||
        existsSync(join(root, "deno.json")) ||
        existsSync(join(root, "bun.lock")) ||
        existsSync(join(root, "bun.lockb"))
      ) {
        return true
      }
      // Fallback: shallow scan of root + ./src for any .ts/.tsx file.
      return hasTsFilesShallow(root) || hasTsFilesShallow(join(root, "src"))
    },
  },

  async *extract(ctx) {
    const workspaceRoot = ctx.workspaceRoot

    const files = await ctx.workspace.walkFiles({
      extensions: TS_EXTENSIONS,
      limit: 5000,
      skipDir: (name) => name.startsWith(".") || SKIP_DIRS.has(name),
    })
    ctx.metrics.count("ts.files-discovered", files.length)
    ctx.log.info("ts-core: discovered files", { count: files.length })

    for (const file of files) {
      if (ctx.signal.aborted) return
      const language: SupportedLanguage =
        ctx.treesitter.inferLanguage(file) === "tsx" ? "tsx" : "typescript"

      const tStart = Date.now()
      const tree = await ctx.treesitter.parseFile(file, language)
      ctx.metrics.timing("ts.parseFile", Date.now() - tStart)
      if (!tree) {
        ctx.metrics.count("ts.parse-failed")
        continue
      }

      const moduleName = workspaceRelativePath(workspaceRoot, file)
      const moduleNodeName = `module:${moduleName}`

      // Always emit a module symbol so imports + contains edges can
      // anchor to it even when no top-level declarations are found.
      // We set name = the full qualified id because the underlying
      // graph-rows.symbolNode() builder uses qualifiedName ?? name as
      // the canonical_name; setting both to the FQ id avoids collisions
      // when two files declare the same local symbol.
      const moduleEndLine = tree.rootNode.endPosition.row + 1
      yield ctx.symbol({
        payload: {
          kind: "module",
          name: moduleNodeName,
          qualifiedName: moduleNodeName,
          location: { filePath: file, line: 1, column: 1 },
          metadata: {
            language,
            modulePath: moduleName,
            endLine: moduleEndLine,
            lineCount: moduleEndLine,
          },
        },
      })

      yield* extractFromTree({
        ctx,
        tree,
        file,
        language,
        moduleNodeName,
        workspaceRoot,
      })
    }
  },
})

export default tsCoreExtractor

// ---------------------------------------------------------------------------
// Internal walk helpers
// ---------------------------------------------------------------------------

interface WalkArgs {
  ctx: ExtractionContext
  tree: { rootNode: TsNode }
  file: string
  language: SupportedLanguage
  moduleNodeName: string
  workspaceRoot: string
}

/**
 * Per-file resolver state. Built incrementally as the AST walk visits
 * import_statements and declarations. Used to resolve call_expression
 * callees from a bare local name to a fully-qualified module symbol.
 *
 * Resolution order for a bare identifier `greetUser`:
 *   1. namedImports.get("greetUser") → cross-file FQ name
 *   2. defaultImports.get("greetUser") → that module's default export
 *   3. localSymbols.has("greetUser") → this file's declaration
 *   4. fallback: bare identifier (current behavior)
 *
 * For member expressions like `util.format`:
 *   1. namespaceImports.get("util") → resolved to module:path
 *   2. → emit dst as `${that-module}#format`
 *   3. else → emit `format` (lossy fallback)
 *
 * Imports always appear at the top of TS files in document order, so
 * by the time we walk into function bodies the resolver is fully
 * populated.
 */
interface FileResolver {
  /** `import { foo, bar as baz } from "./x"` → foo → module:x#foo, baz → module:x#bar */
  namedImports: Map<string, string>
  /** `import x from "./y"` → x → module:y (we can't recover the original export name) */
  defaultImports: Map<string, string>
  /** `import * as ns from "./z"` → ns → module:z (whole-module reference) */
  namespaceImports: Map<string, string>
  /** Locally declared top-level symbols, populated as the walk progresses. */
  localSymbols: Set<string>
  /**
   * Top-level typed variables → FQ name of their type. Populated when
   * a global_var declaration is walked. Lets `const x: Foo = ...` followed
   * by `x.method()` resolve to `${FooFq}.method` (kind=var-member).
   */
  varTypes: Map<string, string>
  /**
   * Stack of parameter scopes — one map per enclosing function/method
   * frame. Populated on entering a function and popped on leaving.
   * Lookups walk the stack top-down so the innermost binding wins.
   * Lets `function f(x: Foo) { x.bar() }` resolve x.bar() to
   * `${FooFq}.bar` (kind=param-member).
   */
  paramTypeStack: Array<Map<string, string>>
}

async function* extractFromTree(args: WalkArgs): AsyncGenerator<Fact> {
  const { ctx, tree, file, moduleNodeName, workspaceRoot } = args

  // Track function/method scopes so we can attribute call_expression
  // sites to their enclosing declaration.
  const scopeStack: Array<{ name: string; node: TsNode }> = []
  // Track enclosing class/interface scope so methods can be qualified
  // as `Class.method` and their contains edges anchor to the class
  // instead of the module. The stack stores LOCAL names; the FQ class
  // id is recomputed at use sites as `${moduleNodeName}#${local}`.
  const classStack: string[] = []
  const seenSymbols = new Set<string>()

  const resolver: FileResolver = {
    namedImports: new Map(),
    defaultImports: new Map(),
    namespaceImports: new Map(),
    localSymbols: new Set(),
    varTypes: new Map(),
    paramTypeStack: [],
  }

  // Pre-pass: collect every top-level declaration name into the
  // resolver's localSymbols set BEFORE the recursive walk begins. This
  // mirrors TypeScript's hoisting semantics — `function foo(b: Bar)`
  // followed later by `class Bar {}` should still resolve `Bar` to the
  // local class. Without this pass, type references on signatures emit
  // before the class declaration is reached, missing local resolutions.
  prepopulateLocalSymbols(tree.rootNode, resolver)

  // Pre-pass: collect JSDoc comments preceding top-level declarations.
  // Map keys are local declaration names; values are the raw doc text.
  // The main walk attaches these via metadata.doc when emitting
  // non-member symbols.
  const topLevelDocs = collectTopLevelDocs(tree.rootNode)

  // Walk the tree in document order so we can push/pop scope based on
  // node start/end positions. We use the iterative walkTree generator
  // and a parallel scope stack keyed by endIndex.

  function maybeEnterScope(node: TsNode): { name: string; kind: SymbolRow["kind"] } | null {
    switch (node.type) {
      case "function_declaration":
      case "generator_function_declaration": {
        const nameNode = node.childForFieldName("name")
        if (nameNode) return { name: nameNode.text, kind: "function" }
        return null
      }
      case "method_definition": {
        const nameNode = node.childForFieldName("name")
        if (nameNode) return { name: nameNode.text, kind: "method" }
        return null
      }
      case "function_expression":
      case "arrow_function": {
        // Anonymous unless assigned to a variable; pick up the name
        // from a parent variable_declarator if present.
        const parent = node.parent
        if (parent && parent.type === "variable_declarator") {
          const id = parent.childForFieldName("name")
          if (id) return { name: id.text, kind: "function" }
        }
        if (parent && parent.type === "pair") {
          const key = parent.childForFieldName("key")
          if (key) return { name: key.text, kind: "function" }
        }
        return null
      }
      default:
        return null
    }
  }

  // ── Single recursive walk ────────────────────────────────────────────────

  async function* visit(node: TsNode): AsyncGenerator<Fact> {
    // Symbol declarations
    const declared = extractDeclaration(node)
    if (declared) {
      const { name, kind } = declared
      // Methods are qualified with their enclosing class/interface so
      // `Greeter.greet` and a top-level `greet` don't collide. The
      // contains edge for a method points from the class, not the module.
      const enclosingClass = classStack.length
        ? classStack[classStack.length - 1]
        : null
      const isMember = kind === "method" && enclosingClass !== null
      const localName = isMember ? `${enclosingClass}.${name}` : name
      const canonicalName = `${moduleNodeName}#${localName}`
      const containsSrc = isMember
        ? `${moduleNodeName}#${enclosingClass}`
        : moduleNodeName

      // Track for intra-file resolution. Methods are NOT bare-callable
      // (you write `this.method()` not `method()`), so we skip adding
      // them to the resolver — otherwise a top-level `format()` call
      // would falsely resolve to a same-named method.
      if (!isMember) {
        resolver.localSymbols.add(name)
      }

      if (!seenSymbols.has(canonicalName)) {
        seenSymbols.add(canonicalName)
        // Compute span for size-aware visualization. endLine is on
        // payload.metadata since SourceLocation only has line/column.
        const endLine = node.endPosition.row + 1
        const startLine = node.startPosition.row + 1
        const lineCount = endLine - startLine + 1
        // Detect exported declarations: the declaration node's parent
        // is export_statement when written as `export class Foo {}`,
        // `export function foo() {}`, etc. Methods inside exported
        // classes are not themselves "exported" (the class is); we
        // skip the check for members.
        const exported = !isMember && isExportedDeclaration(node)
        const baseMeta: Record<string, unknown> = isMember
          ? { localName: name, owningClass: enclosingClass }
          : { localName: name }
        if (exported) baseMeta.exported = true
        // D59: attach JSDoc preceding top-level declarations.
        // Methods (members) inherit no doc — interfaces/classes use
        // their own docstring, not their methods'.
        if (!isMember) {
          const doc = topLevelDocs.get(name)
          if (doc) baseMeta.doc = doc
        }
        yield ctx.symbol({
          payload: {
            kind,
            // graph-rows.symbolNode() uses qualifiedName ?? name as
            // canonical_name. We set BOTH to the FQ id so two files
            // declaring the same local symbol don't collide.
            name: canonicalName,
            qualifiedName: canonicalName,
            location: locationOf(file, node),
            metadata: {
              ...baseMeta,
              endLine,
              lineCount,
            },
          },
        })
        // contains edge: module → symbol, OR class → method
        yield ctx.edge({
          payload: {
            edgeKind: "contains",
            srcSymbolName: containsSrc,
            dstSymbolName: canonicalName,
            confidence: 1,
            derivation: "clangd",
            sourceLocation: {
              sourceFilePath: file,
              sourceLineNumber: node.startPosition.row + 1,
            },
          },
        })

        // extends / implements edges
        if (kind === "class" || kind === "interface") {
          for (const inheritEdge of extractInheritanceEdges(
            node,
            canonicalName,
            file,
            resolver,
            moduleNodeName,
          )) {
            yield ctx.edge({ payload: inheritEdge })
          }
        }

        // references_type edges: walk parameter and return type
        // annotations on this function/method and emit one edge per
        // resolved type. Built-in types (Promise, string, …) miss the
        // resolver and are dropped to avoid noise.
        if (kind === "function" || kind === "method") {
          for (const ref of extractTypeReferences(
            node,
            canonicalName,
            resolver,
            moduleNodeName,
            file,
          )) {
            yield ctx.edge({ payload: ref })
          }
        }

        // Generic constraint references: `<T extends Bar>` should
        // emit a references_type edge from this declaration to Bar.
        // Applies to function, method, class, interface, typedef.
        if (
          kind === "function" ||
          kind === "method" ||
          kind === "class" ||
          kind === "interface" ||
          kind === "typedef"
        ) {
          for (const ref of extractGenericConstraintReferences(
            node,
            canonicalName,
            resolver,
            moduleNodeName,
            file,
          )) {
            yield ctx.edge({ payload: ref })
          }
        }

        // Class field and interface property type references. Emit one
        // references_type edge per resolved type from the class/interface
        // FQ name. Built-ins (predefined_type) are auto-dropped because
        // they're not type_identifier nodes.
        if (kind === "class" || kind === "interface") {
          for (const ref of extractFieldTypeReferences(
            node,
            canonicalName,
            resolver,
            moduleNodeName,
            file,
          )) {
            yield ctx.edge({ payload: ref })
          }

          // Field nodes: emit one symbol per public_field_definition /
          // property_signature so the data-flow story has explicit
          // field nodes to attach reads_field / writes_field edges to
          // in a later phase. Each field also gets a contains edge
          // from the parent class/interface, mirroring the
          // class → method shape.
          // Phase 3b rollup: collect every distinct target type that
          // any field on this class/interface points at, then emit one
          // `aggregates` edge per target. Lets consumers ask "what
          // types does Vault depend on" with one query instead of
          // walking N fields and de-duping client-side.
          const aggregatedTargets = new Set<string>()

          for (const fieldDecl of extractFieldDeclarations(
            node,
            name,
            moduleNodeName,
            file,
          )) {
            if (seenSymbols.has(fieldDecl.canonicalName)) continue
            seenSymbols.add(fieldDecl.canonicalName)
            yield ctx.symbol({
              payload: {
                kind: "field",
                name: fieldDecl.canonicalName,
                qualifiedName: fieldDecl.canonicalName,
                location: {
                  filePath: file,
                  line: fieldDecl.line,
                },
                metadata: {
                  localName: fieldDecl.localName,
                  owningClass: name,
                  declaredOn: kind, // "class" or "interface"
                  ...(fieldDecl.exported ? { exported: true } : {}),
                },
              },
            })
            yield ctx.edge({
              payload: {
                edgeKind: "contains",
                srcSymbolName: canonicalName,
                dstSymbolName: fieldDecl.canonicalName,
                confidence: 1,
                derivation: "clangd",
                sourceLocation: {
                  sourceFilePath: file,
                  sourceLineNumber: fieldDecl.line,
                },
              },
            })
            // Phase 3a: per-field type edges with containment metadata.
            // Each field also emits one or more field_of_type edges
            // pointing at the resolved target type(s), tagged with
            // how the field contains them (direct, array, optional,
            // promise, map, etc.). Built-ins (string, number, …)
            // are dropped because they don't resolve.
            for (const typeEdge of extractFieldTypeEdges(
              fieldDecl.memberNode,
              fieldDecl.canonicalName,
              resolver,
              moduleNodeName,
              file,
            )) {
              yield ctx.edge({ payload: typeEdge })
              // Phase 3b: roll up the target into the per-class set.
              // Self-references (a class with a field of its own type)
              // are kept — they're meaningful (recursive structures).
              aggregatedTargets.add(typeEdge.dstSymbolName)
            }
          }

          // Emit one aggregates edge per distinct target type. The
          // source line is the class/interface declaration since
          // there's no single field to anchor it to.
          const classDeclLine = node.startPosition.row + 1
          for (const target of aggregatedTargets) {
            yield ctx.edge({
              payload: {
                edgeKind: "aggregates",
                srcSymbolName: canonicalName,
                dstSymbolName: target,
                confidence: 0.95,
                derivation: "clangd",
                sourceLocation: {
                  sourceFilePath: file,
                  sourceLineNumber: classDeclLine,
                },
                metadata: {
                  resolved: true,
                  rolledUpFrom: "field_of_type",
                },
              },
            })
          }
        }

        // Phase 3d: enum variants. TS enums are nominal — variants
        // are bare names with optional literal values, no payloads.
        // Each variant becomes its own enum_variant node contained
        // by the enum, and its literal value (if any) is recorded
        // in metadata.value.
        if (kind === "enum") {
          for (const variant of extractTsEnumVariants(
            node,
            name,
            moduleNodeName,
          )) {
            if (seenSymbols.has(variant.canonicalName)) continue
            seenSymbols.add(variant.canonicalName)
            yield ctx.symbol({
              payload: {
                kind: "enum_variant",
                name: variant.canonicalName,
                qualifiedName: variant.canonicalName,
                location: { filePath: file, line: variant.line },
                metadata: {
                  localName: variant.localName,
                  owningEnum: name,
                  ...(variant.value !== undefined ? { value: variant.value } : {}),
                },
              },
            })
            yield ctx.edge({
              payload: {
                edgeKind: "contains",
                srcSymbolName: canonicalName,
                dstSymbolName: variant.canonicalName,
                confidence: 1,
                derivation: "clangd",
                sourceLocation: {
                  sourceFilePath: file,
                  sourceLineNumber: variant.line,
                },
              },
            })
          }
        }

        // Type alias body references. `type X = User | Result` should
        // emit references_type edges from X to both User and Result.
        // We collect generic parameter names first so they're excluded
        // from the body walk (e.g. `type Box<T> = T | null` should
        // not emit Box → T).
        if (kind === "typedef") {
          for (const ref of extractTypeAliasBodyReferences(
            node,
            canonicalName,
            name,
            resolver,
            moduleNodeName,
            file,
          )) {
            yield ctx.edge({ payload: ref })
          }
        }

        // Top-level typed variable: record its var → type mapping in
        // resolver.varTypes so subsequent member calls on the var can
        // resolve to the type's FQ name. Two paths:
        //   1. Explicit annotation: `const x: Foo = ...`
        //   2. new-expression inference: `const x = new Foo()`
        // Both also emit references_type edges from the var to its type.
        if (kind === "global_var") {
          const declarator = firstNamedChildOfType(node, "variable_declarator")
          if (declarator) {
            const ann = firstNamedChildOfType(declarator, "type_annotation")
            if (ann) {
              // Path 1: explicit type annotation. Find the FIRST
              // type_identifier in the annotation. For simple `: Foo`
              // this is Foo. For `: Foo | null` it's still Foo. For
              // `: Promise<Foo>` it's Promise (which is built-in and
              // won't resolve, so we drop it).
              const firstType = findFirstDescendantOfType(ann, "type_identifier")
              if (firstType) {
                const resolved = resolveTypeName(
                  firstType.text,
                  resolver,
                  moduleNodeName,
                )
                if (resolved) {
                  resolver.varTypes.set(name, resolved.name)
                }
              }
              for (const ref of extractTypeReferencesFromAnnotations(
                [ann],
                canonicalName,
                resolver,
                moduleNodeName,
                file,
              )) {
                yield ctx.edge({ payload: ref })
              }
            } else {
              // Path 2: untyped declarator with an inferable value.
              // Two recognized forms:
              //   - new_expression: the constructor identifier is the type
              //   - as_expression:  the cast target is the type
              const value = declarator.childForFieldName("value")
              const inferred = inferVarTypeFromValue(
                value,
                resolver,
                moduleNodeName,
              )
              if (inferred) {
                resolver.varTypes.set(name, inferred.fq)
                yield ctx.edge({
                  payload: {
                    edgeKind: "references_type",
                    srcSymbolName: canonicalName,
                    dstSymbolName: inferred.fq,
                    confidence: 0.9,
                    derivation: "clangd",
                    sourceLocation: {
                      sourceFilePath: file,
                      sourceLineNumber: (value ?? declarator).startPosition.row + 1,
                    },
                    metadata: {
                      resolved: true,
                      resolutionKind: inferred.resolutionKind,
                      typeName: inferred.typeName,
                      [inferred.via]: true,
                    },
                  },
                })
              }
            }
          }
        }
      }

      // Push the class/interface onto classStack BEFORE recursing so
      // child method_definition nodes see it as their enclosing scope.
      // Popped after the recursive walk, below.
      if (kind === "class" || kind === "interface") {
        classStack.push(name)
      }
    }

    // Imports
    if (node.type === "import_statement") {
      const importEdge = extractImportEdge(node, moduleNodeName, file, workspaceRoot)
      if (importEdge) {
        yield ctx.edge({ payload: importEdge })
        // Populate the resolver from the same import_statement so call
        // sites later in the file can resolve cross-file references.
        // The dst FQ module is in importEdge.dstSymbolName ("module:...").
        populateResolverFromImport(node, importEdge.dstSymbolName, resolver)
      }
    }

    // Re-exports: `export { x } from "./y"`, `export * from "./y"`,
    // `export * as ns from "./y"`. These are semantically imports — the
    // current module depends on the source module — so we emit them as
    // `imports` edges. Re-exports don't bring names into local scope, so
    // the resolver is not populated. (Plain `export const x = ...` and
    // `export function y() {}` flow through the recursive walk via
    // their declaration children and are picked up by extractDeclaration.)
    if (node.type === "export_statement") {
      const reExport = extractReExportEdge(node, moduleNodeName, file, workspaceRoot)
      if (reExport) {
        yield ctx.edge({ payload: reExport })
      }
    }

    // Scope management for call_expression attribution
    const enter = maybeEnterScope(node)
    if (enter) {
      // For methods inside a class, qualify the scope name as
      // `Class.method` so call edges originate from the right symbol
      // (matches the canonical_name used at declaration time).
      const enclosingClassForScope =
        enter.kind === "method" && classStack.length
          ? classStack[classStack.length - 1]
          : null
      const localName = enclosingClassForScope
        ? `${enclosingClassForScope}.${enter.name}`
        : enter.name
      const fqName = `${moduleNodeName}#${localName}`
      scopeStack.push({ name: fqName, node })

      // Push a fresh parameter type frame and populate it from the
      // function/method's formal_parameters. Each typed param gets
      // mapped to its resolved type FQ so member calls inside the
      // body can resolve via varTypes (param-member kind).
      const paramFrame = collectParamTypes(
        node,
        resolver,
        moduleNodeName,
      )
      resolver.paramTypeStack.push(paramFrame)
    } else if (
      // D35: inline arrow/function_expression that maybeEnterScope
      // didn't grab (e.g. `arr.map((x: Foo) => x.y())`). The call
      // attribution scope stays at the outer function (correct), but
      // the inline lambda's typed params should still bind so member
      // calls inside resolve via param-member. Push a paramTypeStack
      // frame WITHOUT pushing a scopeStack frame.
      node.type === "arrow_function" ||
      node.type === "function_expression"
    ) {
      const paramFrame = collectParamTypes(
        node,
        resolver,
        moduleNodeName,
      )
      // Push even when empty so the matching pop in the cleanup block
      // doesn't underflow. Empty frames are cheap.
      resolver.paramTypeStack.push(paramFrame)
    }

    // JSX component usage: `<Foo />` or `<Foo>...</Foo>` is semantically
    // a function call to Foo. Emit it as a `calls` edge with resolutionKind
    // jsx-component so the visualizer can render the component graph.
    // HTML tags (lowercase first letter) are not components and skipped.
    // We only handle the opening and self-closing forms — closing tags
    // would otherwise produce duplicate edges.
    if (
      node.type === "jsx_self_closing_element" ||
      node.type === "jsx_opening_element"
    ) {
      const ref = extractJsxComponentRef(node, resolver, moduleNodeName)
      if (ref) {
        const callerName = scopeStack.length
          ? scopeStack[scopeStack.length - 1].name
          : moduleNodeName
        // D32: collect prop names from jsx_attribute children. Spread
        // props don't have a name, so we tag hasSpread separately.
        const propsInfo = collectJsxProps(node)
        yield ctx.edge({
          payload: {
            edgeKind: "calls",
            srcSymbolName: callerName,
            dstSymbolName: ref.name,
            confidence: ref.resolved ? 0.95 : 0.7,
            derivation: "clangd",
            sourceLocation: {
              sourceFilePath: file,
              sourceLineNumber: node.startPosition.row + 1,
            },
            metadata: {
              resolved: ref.resolved,
              resolutionKind: ref.kind,
              jsxTag: ref.jsxTag,
              ...(propsInfo.props.length > 0 ? { props: propsInfo.props } : {}),
              ...(propsInfo.hasSpread ? { hasSpread: true } : {}),
            },
            evidence: {
              sourceKind: "file_line",
              location: locationOf(file, node),
            },
          },
        })
      }
    }

    // new Foo() — constructor invocations are semantically a call to
    // the type. The variable_declarator path (D18) already handles
    // `const x = new Foo()` for type inference; here we also emit a
    // calls edge so the call graph captures the instantiation, even
    // when the new-expression is a bare statement or an argument.
    if (node.type === "new_expression") {
      const ctor = node.namedChild(0)
      if (ctor && ctor.type === "identifier") {
        const resolved = resolveTypeName(ctor.text, resolver, moduleNodeName)
        const callerName = scopeStack.length
          ? scopeStack[scopeStack.length - 1].name
          : moduleNodeName
        yield ctx.edge({
          payload: {
            edgeKind: "calls",
            srcSymbolName: callerName,
            dstSymbolName: resolved ? resolved.name : ctor.text,
            confidence: resolved ? 0.95 : 0.7,
            derivation: "clangd",
            sourceLocation: {
              sourceFilePath: file,
              sourceLineNumber: node.startPosition.row + 1,
            },
            metadata: {
              resolved: resolved !== null,
              resolutionKind: "constructor",
              ctorName: ctor.text,
            },
            evidence: {
              sourceKind: "file_line",
              location: locationOf(file, node),
            },
          },
        })
      }
    }

    // this.field accesses inside method bodies. Emits reads_field /
    // writes_field edges from the enclosing method to the field node
    // (which phase 1 created). Scope is intentionally narrow:
    //
    //   - Only this.foo is recognized; obj.foo / param.foo would
    //     require full type inference and are deferred.
    //   - The field must already exist in seenSymbols (i.e. declared
    //     on the enclosing class). Phantom accesses to inherited or
    //     dynamically-attached fields are silently dropped — better
    //     to skip than to fabricate edges to non-existent nodes.
    //   - this.method() (the call_expression case) is skipped because
    //     it's already covered by the calls edge. this.method
    //     without parens IS a read of the method-as-value.
    if (node.type === "member_expression") {
      const access = classifyThisFieldAccess(node, classStack, scopeStack)
      if (access) {
        const fieldFqName = `${moduleNodeName}#${access.className}.${access.fieldName}`
        // Only emit if the field exists as a real symbol — phase 1
        // populated seenSymbols at class extraction time, so by the
        // time we visit method bodies the class's fields are all in.
        if (seenSymbols.has(fieldFqName)) {
          yield ctx.edge({
            payload: {
              edgeKind: access.kind, // "reads_field" or "writes_field"
              srcSymbolName: access.callerFqName,
              dstSymbolName: fieldFqName,
              confidence: 0.95,
              derivation: "clangd",
              sourceLocation: {
                sourceFilePath: file,
                sourceLineNumber: node.startPosition.row + 1,
              },
              metadata: {
                resolved: true,
                accessKind: access.kind === "reads_field" ? "read" : "write",
                via: "this",
              },
            },
          })
        }
      }
    }

    // Call expressions inside the current scope
    if (node.type === "call_expression") {
      const enclosingClassNow = classStack.length
        ? classStack[classStack.length - 1]
        : null
      const callee = extractCalleeWithResolution(
        node,
        resolver,
        moduleNodeName,
        enclosingClassNow,
      )
      if (callee) {
        const callerName = scopeStack.length
          ? scopeStack[scopeStack.length - 1].name
          : moduleNodeName // top-level call
        // Tagged template literal detection: a call_expression whose
        // second positional named child is a template_string instead
        // of arguments. e.g. sql`SELECT *` or styled.div`color: red`.
        // Visualizers can highlight DSL usage distinctly from regular
        // function calls.
        const isTaggedTemplate = isTaggedTemplateCall(node)
        // D33: detect await wrapping. `await foo()` parses as
        // await_expression > call_expression so we check the parent.
        const isAwaited =
          node.parent !== null && node.parent.type === "await_expression"
        // D34: detect yield wrapping. `yield foo()` and `yield* foo()`
        // both parse as yield_expression > call_expression. Effect
        // generator code uses this heavily.
        const yieldedFlags = detectYieldWrapping(node)
        yield ctx.edge({
          payload: {
            edgeKind: "calls",
            srcSymbolName: callerName,
            dstSymbolName: callee.name,
            confidence: callee.resolved ? 0.95 : 0.7,
            derivation: "clangd",
            sourceLocation: {
              sourceFilePath: file,
              sourceLineNumber: node.startPosition.row + 1,
            },
            metadata: {
              resolved: callee.resolved,
              resolutionKind: callee.kind,
              ...(isTaggedTemplate ? { taggedTemplate: true } : {}),
              ...(isAwaited ? { awaited: true } : {}),
              ...yieldedFlags,
            },
            evidence: {
              sourceKind: "file_line",
              location: locationOf(file, node),
            },
          },
        })
      }
    }

    // Recurse into named children
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)
      if (child) {
        yield* visit(child)
      }
    }

    if (enter) {
      scopeStack.pop()
      resolver.paramTypeStack.pop()
    } else if (
      // D35: matching pop for the inline-lambda paramTypeStack push
      // above. Must mirror the same node-type predicate.
      node.type === "arrow_function" ||
      node.type === "function_expression"
    ) {
      resolver.paramTypeStack.pop()
    }
    if (declared && (declared.kind === "class" || declared.kind === "interface")) {
      classStack.pop()
    }
  }

  yield* visit(tree.rootNode)
}

// ---------------------------------------------------------------------------
// Per-node extractors
// ---------------------------------------------------------------------------

function extractDeclaration(
  node: TsNode,
): { name: string; kind: SymbolRow["kind"] } | null {
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration": {
      const name = node.childForFieldName("name")
      return name ? { name: name.text, kind: "function" } : null
    }
    case "class_declaration":
    case "abstract_class_declaration": {
      const name = node.childForFieldName("name")
      return name ? { name: name.text, kind: "class" } : null
    }
    case "interface_declaration": {
      const name = node.childForFieldName("name")
      return name ? { name: name.text, kind: "interface" } : null
    }
    case "type_alias_declaration": {
      const name = node.childForFieldName("name")
      return name ? { name: name.text, kind: "typedef" } : null
    }
    case "enum_declaration": {
      const name = node.childForFieldName("name")
      return name ? { name: name.text, kind: "enum" } : null
    }
    case "internal_module": // namespace X { ... }
    case "module": {
      const name = node.childForFieldName("name")
      return name ? { name: name.text, kind: "namespace" } : null
    }
    case "method_definition": {
      const name = node.childForFieldName("name")
      return name ? { name: name.text, kind: "method" } : null
    }
    // Anonymous default exports: `export default class {}`,
    // `export default function() {}`, `export default ({}) => ...`.
    // Recognized only when the parent is export_statement; the
    // synthesized name is "default" so the symbol has a stable id
    // (canonical_name becomes module:foo.ts#default).
    case "class": {
      if (node.parent && node.parent.type === "export_statement") {
        return { name: "default", kind: "class" }
      }
      return null
    }
    case "function_expression": {
      if (node.parent && node.parent.type === "export_statement") {
        return { name: "default", kind: "function" }
      }
      return null
    }
    case "arrow_function": {
      if (node.parent && node.parent.type === "export_statement") {
        return { name: "default", kind: "function" }
      }
      return null
    }
    case "lexical_declaration":
    case "variable_declaration": {
      // const foo = () => {} → record as function-typed export when
      // the initializer is an arrow_function or function_expression.
      // Otherwise, if the declarator carries a type_annotation, emit
      // it as `global_var` so its referenced types still flow into
      // the graph. Round D18 also picks up untyped `const x = new Foo()`
      // — the constructor is the implied type.
      const declarator = firstNamedChildOfType(node, "variable_declarator")
      if (!declarator) return null
      const nameNode = declarator.childForFieldName("name")
      const value = declarator.childForFieldName("value")
      if (!nameNode) return null
      if (
        value &&
        (value.type === "arrow_function" || value.type === "function_expression")
      ) {
        return { name: nameNode.text, kind: "function" }
      }
      // Typed top-level variable: emit as global_var so its
      // type_annotation can be walked for references_type edges.
      if (firstNamedChildOfType(declarator, "type_annotation")) {
        return { name: nameNode.text, kind: "global_var" }
      }
      // Untyped `const x = new Foo()` — also a global_var, type
      // recovered from the new_expression's constructor in the
      // global_var emit block.
      if (value && value.type === "new_expression") {
        return { name: nameNode.text, kind: "global_var" }
      }
      // `const x = expr as Foo` — global_var, type recovered from
      // the cast target in the global_var emit block.
      if (value && value.type === "as_expression") {
        return { name: nameNode.text, kind: "global_var" }
      }
      return null
    }
    default:
      return null
  }
}

/**
 * Build a dotted receiver chain for a member_expression node. Walks
 * left-associatively so `a.b.c` → `"a.b.c"`, `JSON.parse` → `"JSON.parse"`,
 * `this.foo.bar` → `"this.foo.bar"`. If any link in the chain is a form
 * we don't recognize (e.g. subscript_expression, call_expression as the
 * receiver), returns null so the caller can fall back to the raw text.
 */
function memberExpressionDottedName(node: TsNode): string | null {
  if (node.type === "identifier" || node.type === "property_identifier") {
    return node.text
  }
  if (node.type === "this") return "this"
  if (node.type === "super") return "super"
  if (node.type === "member_expression") {
    const obj = node.childForFieldName("object")
    const prop = node.childForFieldName("property")
    if (!obj || !prop) return null
    const lhs = memberExpressionDottedName(obj)
    if (lhs === null) return null
    return `${lhs}.${prop.text}`
  }
  return null
}

function extractCallee(callExpr: TsNode): string | null {
  const fn = callExpr.childForFieldName("function")
  if (!fn) return null
  // Identifier — straightforward `foo()`
  if (fn.type === "identifier") return fn.text
  // member_expression — `obj.method()` → full dotted chain when possible,
  // e.g. `JSON.parse`, `path.resolve`, `this.foo.bar`. Falls back to the
  // bare property name when the chain contains an unrecognized form.
  if (fn.type === "member_expression") {
    const dotted = memberExpressionDottedName(fn)
    if (dotted) return dotted
    const property = fn.childForFieldName("property")
    if (property) return property.text
  }
  // Other forms (computed access, generic instantiation): use the
  // raw text up to the first paren.
  const text = fn.text
  if (text && text.length < 200) return text
  return null
}

/**
 * Variant of extractCallee that uses a per-file FileResolver to map a
 * bare identifier or namespace.member to a fully-qualified module
 * symbol when possible.
 *
 * Returns:
 *   - { name, resolved: true, kind: "named-import" }    cross-file via named import
 *   - { name, resolved: true, kind: "default-import" }  cross-file via default import
 *   - { name, resolved: true, kind: "namespace-member"} cross-file via namespace import
 *   - { name, resolved: true, kind: "this-method" }     this.x() → enclosing class
 *   - { name, resolved: true, kind: "local" }           same-file declaration
 *   - { name, resolved: false, kind: "bare" }           unresolved fallback
 *   - null if no callee text could be extracted
 *
 * @param enclosingClass local name of the class currently being walked,
 *   or null if not inside a class. Used to resolve `this.x()` to
 *   `module:foo.ts#Class.x`.
 */
function extractCalleeWithResolution(
  callExpr: TsNode,
  resolver: FileResolver,
  moduleNodeName: string,
  enclosingClass: string | null,
): { name: string; resolved: boolean; kind: string } | null {
  const fn = callExpr.childForFieldName("function")
  if (!fn) return null

  if (fn.type === "identifier") {
    const local = fn.text
    // 1. named import wins (most precise)
    const named = resolver.namedImports.get(local)
    if (named) return { name: named, resolved: true, kind: "named-import" }
    // 2. default import (less precise — points at the whole module)
    const def = resolver.defaultImports.get(local)
    if (def) return { name: def, resolved: true, kind: "default-import" }
    // 3. local declaration in this file
    if (resolver.localSymbols.has(local)) {
      return { name: `${moduleNodeName}#${local}`, resolved: true, kind: "local" }
    }
    // 4. unresolved (built-in, npm, dynamic, etc.)
    return { name: local, resolved: false, kind: "bare" }
  }

  if (fn.type === "member_expression") {
    const obj = fn.childForFieldName("object")
    const property = fn.childForFieldName("property")
    if (!property) return null
    const propName = property.text
    if (obj) {
      // this.method() → resolve to enclosing class's method, when in scope
      if (obj.type === "this" && enclosingClass) {
        return {
          name: `${moduleNodeName}#${enclosingClass}.${propName}`,
          resolved: true,
          kind: "this-method",
        }
      }
      if (obj.type === "identifier") {
        // Resolution order — most specific (uses type info) to least
        // specific. Param scope wins over typed var which wins over
        // localSymbols, since the more local binding shadows.
        //
        // param.member() — receiver is a typed function/method param
        // in the enclosing scope. The walker stacked a paramTypes
        // frame on entry; check it innermost-first.
        const paramType = lookupParamType(resolver, obj.text)
        if (paramType) {
          return {
            name: `${paramType}.${propName}`,
            resolved: true,
            kind: "param-member",
          }
        }
        // typedVar.member() — receiver is a top-level typed var whose
        // type we know via its annotation. Resolve to the type's FQ
        // name + member. e.g. `const x: Foo = ...; x.method()` →
        // `${FooFq}.method`.
        const varType = resolver.varTypes.get(obj.text)
        if (varType) {
          return {
            name: `${varType}.${propName}`,
            resolved: true,
            kind: "var-member",
          }
        }
        // namespace.member → look up the namespace in import map
        const ns = resolver.namespaceImports.get(obj.text)
        if (ns) {
          // ns is "module:src/x.ts"; member is `format`
          return {
            name: `${ns}#${propName}`,
            resolved: true,
            kind: "namespace-member",
          }
        }
        // namedImport.member() → many opencode-style namespaces are
        // exported as named values: `import { Effect } from "effect"`
        // → `Effect.sync(...)`. Treat the receiver's named-import FQ
        // as the parent and append the member. The dst may or may
        // not exist as a real graph_node, but the FQ shape is what
        // lets a visualizer group calls by their owning namespace.
        const named = resolver.namedImports.get(obj.text)
        if (named) {
          // named is e.g. "module:effect#Effect"; append .propName
          return {
            name: `${named}.${propName}`,
            resolved: true,
            kind: "named-member",
          }
        }
        // local.member() — receiver is a same-file declaration. Same
        // logic: treat the local FQ as the namespace parent.
        if (resolver.localSymbols.has(obj.text)) {
          return {
            name: `${moduleNodeName}#${obj.text}.${propName}`,
            resolved: true,
            kind: "local-member",
          }
        }
      }
    }
    // Other member expressions: fall back to the full dotted receiver
    // chain so built-ins and unresolved references keep their prefix.
    // e.g. `JSON.parse(x)` → dst "JSON.parse", `path.resolve(a,b)` →
    // "path.resolve", `this.foo.bar()` → "this.foo.bar". If the chain
    // contains an unrecognized form (subscript, call-as-receiver, etc.)
    // we drop back to the bare property name so we never emit garbage.
    const dotted = memberExpressionDottedName(fn)
    if (dotted) {
      return { name: dotted, resolved: false, kind: "member" }
    }
    return { name: propName, resolved: false, kind: "member" }
  }

  // Other forms (computed access, generic instantiation): use raw text
  const text = fn.text
  if (text && text.length < 200) {
    return { name: text, resolved: false, kind: "raw" }
  }
  return null
}

/**
 * Walk an `import_statement` node and populate the resolver with each
 * binding it introduces. This is what makes cross-file call resolution
 * possible: by the time the AST walk reaches a function body, the
 * import map for the current file is fully populated.
 *
 * Tree-sitter typescript shape for import_statement:
 *   import_statement
 *     ├─ import_clause
 *     │   ├─ identifier (default import)         `import x`
 *     │   ├─ namespace_import                    `import * as ns`
 *     │   │   └─ identifier
 *     │   └─ named_imports                       `import { a, b as c }`
 *     │       └─ import_specifier
 *     │           ├─ identifier (name)
 *     │           └─ identifier (alias, optional)
 *     └─ string (source)                         `from "./x"`
 */
function populateResolverFromImport(
  importNode: TsNode,
  dstFqModule: string,
  resolver: FileResolver,
): void {
  // Find the import_clause child
  const clause = firstNamedChildOfType(importNode, "import_clause")
  if (!clause) return

  for (let i = 0; i < clause.namedChildCount; i++) {
    const child = clause.namedChild(i)
    if (!child) continue

    if (child.type === "identifier") {
      // default import: `import x from "./y"`
      resolver.defaultImports.set(child.text, dstFqModule)
      continue
    }

    if (child.type === "namespace_import") {
      // `import * as ns from "./y"`
      const id = firstNamedChildOfType(child, "identifier")
      if (id) {
        resolver.namespaceImports.set(id.text, dstFqModule)
      }
      continue
    }

    if (child.type === "named_imports") {
      // `import { a, b as c } from "./y"`
      for (let j = 0; j < child.namedChildCount; j++) {
        const spec = child.namedChild(j)
        if (!spec || spec.type !== "import_specifier") continue
        // import_specifier has: name (the original) and optionally alias
        const nameNode = spec.childForFieldName("name")
        const aliasNode = spec.childForFieldName("alias")
        if (!nameNode) continue
        const sourceName = nameNode.text
        const localName = aliasNode ? aliasNode.text : sourceName
        resolver.namedImports.set(localName, `${dstFqModule}#${sourceName}`)
      }
      continue
    }
  }
}

/**
 * Infer a global_var's type from its initializer value when no
 * explicit type annotation is present. Two recognized shapes:
 *   - new_expression: `const x = new Foo()` → type Foo (via=inferredFromNew)
 *   - as_expression:  `const x = expr as Foo` → type Foo (via=inferredFromCast)
 *
 * Returns null when the value can't be inferred.
 */
function inferVarTypeFromValue(
  value: TsNode | null,
  resolver: FileResolver,
  moduleNodeName: string,
): {
  fq: string
  typeName: string
  resolutionKind: string
  via: "inferredFromNew" | "inferredFromCast"
} | null {
  if (!value) return null
  if (value.type === "new_expression") {
    const ctor = value.namedChild(0)
    if (!ctor || ctor.type !== "identifier") return null
    const resolved = resolveTypeName(ctor.text, resolver, moduleNodeName)
    if (!resolved) return null
    return {
      fq: resolved.name,
      typeName: ctor.text,
      resolutionKind: resolved.kind,
      via: "inferredFromNew",
    }
  }
  if (value.type === "as_expression") {
    // Find the type_identifier child (the cast target). It's a direct
    // named child of as_expression after the value.
    const typeNode = findFirstDescendantOfType(value, "type_identifier")
    if (!typeNode) return null
    const resolved = resolveTypeName(typeNode.text, resolver, moduleNodeName)
    if (!resolved) return null
    return {
      fq: resolved.name,
      typeName: typeNode.text,
      resolutionKind: resolved.kind,
      via: "inferredFromCast",
    }
  }
  return null
}

/**
 * Walk a function/method/arrow node's formal_parameters and build a
 * map from each typed parameter's local name to its resolved type FQ.
 * Untyped params and params with unresolvable types are skipped.
 *
 * For function_expression / arrow_function, the parameters live on the
 * node itself; for function_declaration / method_definition, same shape.
 */
function collectParamTypes(
  fnNode: TsNode,
  resolver: FileResolver,
  moduleNodeName: string,
): Map<string, string> {
  const out = new Map<string, string>()
  const params = firstNamedChildOfType(fnNode, "formal_parameters")
  if (!params) return out

  for (let i = 0; i < params.namedChildCount; i++) {
    const param = params.namedChild(i)
    if (!param) continue
    if (param.type !== "required_parameter" && param.type !== "optional_parameter") {
      continue
    }
    // Param shape: required_parameter > [pattern: identifier|object_pattern] [type_annotation]
    const pattern = param.childForFieldName("pattern")
    if (!pattern || pattern.type !== "identifier") continue
    const ann = firstNamedChildOfType(param, "type_annotation")
    if (!ann) continue
    const firstType = findFirstDescendantOfType(ann, "type_identifier")
    if (!firstType) continue
    const resolved = resolveTypeName(firstType.text, resolver, moduleNodeName)
    if (!resolved) continue
    out.set(pattern.text, resolved.name)
  }
  return out
}

/**
 * Walk the param type stack from innermost to outermost and return the
 * first match for the given param name. Returns null if not bound.
 */
function lookupParamType(
  resolver: FileResolver,
  name: string,
): string | null {
  for (let i = resolver.paramTypeStack.length - 1; i >= 0; i--) {
    const frame = resolver.paramTypeStack[i]
    const t = frame.get(name)
    if (t) return t
  }
  return null
}

/**
 * Collect JSDoc/TSDoc-style comments that begin with /** and precede
 * top-level declarations. Returns a map from local declaration name
 * to the raw comment text.
 *
 * Walks the program node's named children in order. When a comment
 * matching the JSDoc shape is encountered, it's saved as pending.
 * The next non-comment child consumes the pending doc — if it's a
 * declaration (or wraps one in an export_statement), the doc is
 * attached to that declaration's local name.
 *
 * Non-doc comments (line comments or non-JSDoc block comments) reset
 * the pending buffer so they don't get mistakenly applied later.
 */
function collectTopLevelDocs(rootNode: TsNode): Map<string, string> {
  const docs = new Map<string, string>()
  let pendingDoc: string | null = null

  for (let i = 0; i < rootNode.namedChildCount; i++) {
    const child = rootNode.namedChild(i)
    if (!child) continue
    if (child.type === "comment") {
      const text = child.text
      if (text.startsWith("/**")) {
        pendingDoc = text
      } else {
        pendingDoc = null
      }
      continue
    }
    if (pendingDoc !== null) {
      // Find the inner declaration. For export_statement, walk into
      // its named children; otherwise the child IS the declaration.
      let target: TsNode | null = child
      if (child.type === "export_statement") {
        for (let j = 0; j < child.namedChildCount; j++) {
          const inner = child.namedChild(j)
          if (!inner) continue
          if (inner.type === "comment") continue
          target = inner
          break
        }
      }
      if (target) {
        const declared = extractDeclaration(target)
        if (declared) {
          docs.set(declared.name, pendingDoc)
        }
      }
      pendingDoc = null
    }
  }
  return docs
}

/**
 * Single non-yielding pass over the program's top-level statements to
 * collect every declared name into resolver.localSymbols. Walks one
 * level into export_statement so `export class Foo {}` is captured.
 * Skips declarations inside class bodies — methods are not in the
 * bare-call/type namespace.
 */
function prepopulateLocalSymbols(
  rootNode: TsNode,
  resolver: FileResolver,
): void {
  for (let i = 0; i < rootNode.namedChildCount; i++) {
    const stmt = rootNode.namedChild(i)
    if (!stmt) continue
    visitTopLevel(stmt)
  }

  function visitTopLevel(node: TsNode): void {
    // Unwrap export_statement to find the inner declaration
    if (node.type === "export_statement") {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i)
        if (!child) continue
        visitTopLevel(child)
      }
      return
    }
    const declared = extractDeclaration(node)
    if (declared && declared.kind !== "method") {
      resolver.localSymbols.add(declared.name)
    }
  }
}

/**
 * Walk a function/method declaration's signature (parameters + return
 * type) and emit a `references_type` edge for each named type that
 * resolves through the FileResolver. Built-in types (Promise, string,
 * number, …) and unresolved type names are dropped to avoid noise — we
 * only emit references that point at a real graph node.
 *
 * AST shape (typescript grammar):
 *   function_declaration / method_definition
 *     ├─ formal_parameters
 *     │   └─ required_parameter / optional_parameter
 *     │       └─ type_annotation
 *     │           └─ type_identifier  (or generic_type → type_identifier+)
 *     └─ type_annotation               ← return type
 *         └─ type_identifier  (or generic_type → type_identifier+)
 *
 * Generic instantiations like `Promise<User>` produce two type_identifiers
 * (`Promise` and `User`); we collect both, but `Promise` won't resolve and
 * is dropped.
 */
function extractTypeReferences(
  fnNode: TsNode,
  thisFqName: string,
  resolver: FileResolver,
  moduleNodeName: string,
  file: string,
): Array<TypeRefEdgePayload> {
  const annotations: TsNode[] = []

  // Parameter type annotations
  const params = firstNamedChildOfType(fnNode, "formal_parameters")
  if (params) {
    for (let i = 0; i < params.namedChildCount; i++) {
      const param = params.namedChild(i)
      if (!param) continue
      // required_parameter / optional_parameter both contain a
      // type_annotation as a direct child.
      const ann = firstNamedChildOfType(param, "type_annotation")
      if (ann) annotations.push(ann)
    }
  }

  // Return type annotation: a direct type_annotation child of the
  // function/method (NOT inside formal_parameters or statement_block).
  for (let i = 0; i < fnNode.namedChildCount; i++) {
    const child = fnNode.namedChild(i)
    if (child && child.type === "type_annotation") {
      annotations.push(child)
    }
  }

  return extractTypeReferencesFromAnnotations(
    annotations,
    thisFqName,
    resolver,
    moduleNodeName,
    file,
  )
}

interface TypeRefEdgePayload {
  // The type-reference helpers historically only emitted references_type
  // edges. Phase 3a added a parallel field-level emission path
  // (extractFieldTypeEdges) that uses the same payload shape but
  // tags the edges with field_of_type. Both kinds share this struct.
  edgeKind: "references_type" | "field_of_type"
  srcSymbolName: string
  dstSymbolName: string
  confidence: number
  derivation: "clangd" | "llm" | "runtime" | "hybrid"
  sourceLocation: { sourceFilePath: string; sourceLineNumber: number }
  metadata: Record<string, unknown>
}

/**
 * Shared core for emitting references_type edges from a list of
 * type_annotation nodes. Called by the function-signature, class-field,
 * and global-var paths.
 */
function extractTypeReferencesFromAnnotations(
  annotations: TsNode[],
  thisFqName: string,
  resolver: FileResolver,
  moduleNodeName: string,
  file: string,
): Array<TypeRefEdgePayload> {
  const out: TypeRefEdgePayload[] = []
  const seen = new Set<string>()

  for (const ann of annotations) {
    for (const typeName of namedDescendantTexts(ann, "type_identifier")) {
      if (seen.has(typeName)) continue
      const resolved = resolveTypeName(typeName, resolver, moduleNodeName)
      if (!resolved) continue // built-in or unknown — drop
      seen.add(typeName)
      out.push({
        edgeKind: "references_type",
        srcSymbolName: thisFqName,
        dstSymbolName: resolved.name,
        confidence: 0.95,
        derivation: "clangd",
        sourceLocation: {
          sourceFilePath: file,
          sourceLineNumber: ann.startPosition.row + 1,
        },
        metadata: {
          resolved: true,
          resolutionKind: resolved.kind,
          typeName,
        },
      })
    }
  }
  return out
}

/**
 * Walk a declaration's type_parameters child for generic constraints
 * and emit a references_type edge for each constraint type that
 * resolves through the FileResolver.
 *
 * AST shape:
 *   type_parameters
 *     └─ type_parameter
 *         ├─ type_identifier (the parameter name like T)
 *         └─ constraint
 *             └─ type_identifier (the constraint type like Bar)
 *                 OR
 *             └─ generic_type → type_identifier+ (e.g. Promise<X>)
 *
 * Built-in types are dropped (predefined_type, not type_identifier).
 * The parameter name itself is collected into a skip-set so a
 * constraint that references another generic param of the same
 * declaration doesn't create a self-loop edge.
 */
function extractGenericConstraintReferences(
  declNode: TsNode,
  thisFqName: string,
  resolver: FileResolver,
  moduleNodeName: string,
  file: string,
): Array<TypeRefEdgePayload> {
  const params = firstNamedChildOfType(declNode, "type_parameters")
  if (!params) return []

  // Collect parameter names so a constraint can't refer to its own
  // declaration's params (those would resolve falsely).
  const paramNames = new Set<string>()
  for (let i = 0; i < params.namedChildCount; i++) {
    const tparam = params.namedChild(i)
    if (!tparam || tparam.type !== "type_parameter") continue
    const id = firstNamedChildOfType(tparam, "type_identifier")
    if (id) paramNames.add(id.text)
  }

  const out: TypeRefEdgePayload[] = []
  const seen = new Set<string>()

  for (let i = 0; i < params.namedChildCount; i++) {
    const tparam = params.namedChild(i)
    if (!tparam || tparam.type !== "type_parameter") continue
    const constraint = firstNamedChildOfType(tparam, "constraint")
    if (!constraint) continue
    for (const typeName of namedDescendantTexts(constraint, "type_identifier")) {
      if (paramNames.has(typeName)) continue
      if (seen.has(typeName)) continue
      const resolved = resolveTypeName(typeName, resolver, moduleNodeName)
      if (!resolved) continue
      seen.add(typeName)
      out.push({
        edgeKind: "references_type",
        srcSymbolName: thisFqName,
        dstSymbolName: resolved.name,
        confidence: 0.95,
        derivation: "clangd",
        sourceLocation: {
          sourceFilePath: file,
          sourceLineNumber: constraint.startPosition.row + 1,
        },
        metadata: {
          resolved: true,
          resolutionKind: resolved.kind,
          typeName,
          genericConstraint: true,
        },
      })
    }
  }
  return out
}

/**
 * Walk a type_alias_declaration body and emit references_type edges
 * for each named type that resolves through the FileResolver. Excludes
 * the alias's own name and any generic type parameters.
 *
 * AST: type_alias_declaration → [type_identifier (name)] [type_parameters?] [body]
 *   body can be union_type, object_type, function_type, type_identifier, etc.
 *   All named type references throughout the body are type_identifier nodes.
 */
function extractTypeAliasBodyReferences(
  aliasNode: TsNode,
  thisFqName: string,
  aliasLocalName: string,
  resolver: FileResolver,
  moduleNodeName: string,
  file: string,
): Array<TypeRefEdgePayload> {
  // Collect generic parameter names so we don't emit edges to them.
  const skipNames = new Set<string>([aliasLocalName])
  const params = firstNamedChildOfType(aliasNode, "type_parameters")
  if (params) {
    for (let i = 0; i < params.namedChildCount; i++) {
      const tparam = params.namedChild(i)
      if (!tparam) continue
      // type_parameter → type_identifier (the parameter name)
      const id = firstNamedChildOfType(tparam, "type_identifier")
      if (id) skipNames.add(id.text)
    }
  }

  const out: TypeRefEdgePayload[] = []
  const seen = new Set<string>()

  // Walk every child of the alias EXCEPT type_parameters and the
  // alias's own name node (the first type_identifier child).
  // Everything else is the body.
  let aliasNameSeen = false
  for (let i = 0; i < aliasNode.namedChildCount; i++) {
    const child = aliasNode.namedChild(i)
    if (!child) continue
    if (child.type === "type_parameters") continue
    if (!aliasNameSeen && child.type === "type_identifier") {
      // The alias's own name comes first in document order.
      aliasNameSeen = true
      continue
    }
    for (const typeName of namedDescendantTexts(child, "type_identifier")) {
      if (skipNames.has(typeName)) continue
      if (seen.has(typeName)) continue
      const resolved = resolveTypeName(typeName, resolver, moduleNodeName)
      if (!resolved) continue
      seen.add(typeName)
      out.push({
        edgeKind: "references_type",
        srcSymbolName: thisFqName,
        dstSymbolName: resolved.name,
        confidence: 0.95,
        derivation: "clangd",
        sourceLocation: {
          sourceFilePath: file,
          sourceLineNumber: child.startPosition.row + 1,
        },
        metadata: {
          resolved: true,
          resolutionKind: resolved.kind,
          typeName,
          aliasRef: true,
        },
      })
    }
  }
  return out
}

/**
 * Classify a `member_expression` node as a `this.field` read or write,
 * if it qualifies. Returns null when the access is not on `this`, or
 * when it's a method call (which the calls-edge handler already covers),
 * or when there's no enclosing class to attribute the access to.
 *
 * Read vs write detection inspects the parent node:
 *   - parent is assignment_expression and we are the left field → write
 *   - parent is augmented_assignment_expression and we are left → write
 *     (covers `this.x += 1`, `this.x ??= y`, etc.)
 *   - parent is update_expression (`this.x++`) → write
 *   - parent is unary_expression with `delete` operator → write
 *   - anything else → read
 *
 * The return shape includes:
 *   - kind: "reads_field" | "writes_field"
 *   - className: enclosing class name (the canonical name's local part
 *                between # and the field name)
 *   - fieldName: the field's local name
 *   - callerFqName: the canonical name of the method or function the
 *                   access lives in (taken from scopeStack)
 *
 * Returns null if any of these can't be derived.
 */
function classifyThisFieldAccess(
  node: TsNode,
  classStack: string[],
  scopeStack: Array<{ name: string; node: TsNode }>,
): {
  kind: "reads_field" | "writes_field"
  className: string
  fieldName: string
  callerFqName: string
} | null {
  // Must be a member access on `this`
  const obj = node.childForFieldName("object")
  if (!obj || obj.type !== "this") return null
  // Property name lives under the "property" field
  const prop = node.childForFieldName("property")
  if (!prop) return null
  // Skip computed property accesses (`this[foo]`) — no stable name
  if (prop.type !== "property_identifier") return null
  const fieldName = prop.text
  if (!fieldName) return null

  // Need an enclosing class for attribution. If we're not inside one
  // (e.g. a free function with `this` from a binding context), drop.
  if (classStack.length === 0) return null
  const className = classStack[classStack.length - 1]

  // Need an enclosing scope (a method/function) to attribute the
  // access to. Top-level access doesn't really happen for `this.foo`
  // outside a class but defensively skip if scopeStack is empty.
  if (scopeStack.length === 0) return null
  const callerFqName = scopeStack[scopeStack.length - 1].name

  // Skip method calls — `this.method()` is already a calls edge.
  // The case to skip: parent is call_expression and we are the
  // function field of that call. `this.method` without parens is
  // a true read of the method-as-value, so it's NOT skipped.
  const parent = node.parent
  if (parent && parent.type === "call_expression") {
    const fn = parent.childForFieldName("function")
    if (fn === node) return null
  }

  // Detect write context. tree-sitter's childForFieldName returns
  // a fresh JS wrapper for the same underlying node, so we can't
  // use identity comparison — compare by startIndex which is
  // stable across wrapper instances.
  let kind: "reads_field" | "writes_field" = "reads_field"
  const nodeStart = node.startIndex
  if (parent) {
    if (parent.type === "assignment_expression") {
      const left = parent.childForFieldName("left")
      if (left && left.startIndex === nodeStart) kind = "writes_field"
    } else if (parent.type === "augmented_assignment_expression") {
      const left = parent.childForFieldName("left")
      if (left && left.startIndex === nodeStart) kind = "writes_field"
    } else if (parent.type === "update_expression") {
      // ++/-- — always a write to the operand
      kind = "writes_field"
    } else if (parent.type === "unary_expression") {
      // delete this.foo — semantically a write (mutation). The
      // operator is the first child via the "operator" field.
      const op = parent.childForFieldName("operator")
      if (op && op.type === "delete") kind = "writes_field"
    }
  }

  return { kind, className, fieldName, callerFqName }
}

/**
 * Walk the body of a class or interface and return one descriptor per
 * declared field / property. Used to emit field SymbolFacts with
 * canonical names of the form `module:src/foo.ts#ClassName.fieldName`.
 *
 * Handles two member node types:
 *   - public_field_definition (class fields):    `prefix: string`, `count = 0`
 *   - property_signature      (interface props): `prefix: string`
 *
 * Field name extraction: each member has a "name" child which is
 * usually a property_identifier. Computed property names
 * (`[Symbol.iterator]`) are skipped — they have no stable canonical
 * name we can attach edges to.
 *
 * Static fields are included; abstract fields (which only appear in
 * abstract_class_body / class_body via abstract modifier) are
 * included too — what matters is that the field has a name.
 */
function extractFieldDeclarations(
  classOrIfaceNode: TsNode,
  className: string,
  moduleNodeName: string,
  _file: string,
): Array<{
  localName: string
  canonicalName: string
  line: number
  exported: boolean
  /** The original member AST node, exposed so callers can also walk
   *  its type_annotation for field_of_type edges. */
  memberNode: TsNode
}> {
  const out: Array<{
    localName: string
    canonicalName: string
    line: number
    exported: boolean
    memberNode: TsNode
  }> = []
  const body =
    firstNamedChildOfType(classOrIfaceNode, "class_body") ??
    firstNamedChildOfType(classOrIfaceNode, "interface_body") ??
    firstNamedChildOfType(classOrIfaceNode, "object_type")
  if (!body) return out

  for (let i = 0; i < body.namedChildCount; i++) {
    const member = body.namedChild(i)
    if (!member) continue
    if (
      member.type !== "public_field_definition" &&
      member.type !== "property_signature"
    ) {
      continue
    }
    // Extract the field's local name. property_identifier is the
    // common case (`prefix:`); plain `identifier` covers public_field
    // shorthand on parameter properties (rare in declared bodies).
    const nameNode = member.childForFieldName("name")
    if (!nameNode) continue
    if (
      nameNode.type !== "property_identifier" &&
      nameNode.type !== "identifier"
    ) {
      // computed_property_name (`[Symbol.iterator]`) lands here. Skip:
      // no stable canonical name to attach edges to.
      continue
    }
    const localName = `${className}.${nameNode.text}`
    const canonicalName = `${moduleNodeName}#${localName}`
    out.push({
      localName,
      canonicalName,
      line: member.startPosition.row + 1,
      exported: false,
      memberNode: member,
    })
  }
  return out
}

/**
 * Walk a TS enum_declaration body and return one descriptor per
 * declared variant. TS enums are nominal — each variant is just a
 * name with an optional literal value, no payloads.
 *
 * Two AST shapes per member:
 *   - Bare property_identifier:  `Active`           (no value)
 *   - enum_assignment node:      `Inactive = 1`     (with value)
 *                                `Pending = "x"`
 *
 * The literal value (when present) is recorded in metadata.value
 * as a string for display.
 */
function extractTsEnumVariants(
  enumDeclNode: TsNode,
  enumName: string,
  moduleNodeName: string,
): Array<{
  localName: string
  canonicalName: string
  line: number
  value: string | undefined
}> {
  const out: Array<{
    localName: string
    canonicalName: string
    line: number
    value: string | undefined
  }> = []
  const body = firstNamedChildOfType(enumDeclNode, "enum_body")
  if (!body) return out

  for (let i = 0; i < body.namedChildCount; i++) {
    const member = body.namedChild(i)
    if (!member) continue

    let nameNode: TsNode | null = null
    let value: string | undefined = undefined

    if (member.type === "property_identifier") {
      // Bare member without an initializer
      nameNode = member
    } else if (member.type === "enum_assignment") {
      // Member with an initializer
      const id = firstNamedChildOfType(member, "property_identifier")
      if (id) nameNode = id
      // Capture the literal value child if present
      for (let j = 0; j < member.namedChildCount; j++) {
        const c = member.namedChild(j)
        if (!c) continue
        if (c.type === "property_identifier") continue
        // Take the first non-name child as the value
        value = c.text
        break
      }
    }

    if (!nameNode) continue
    const variantLocalName = nameNode.text
    if (!variantLocalName) continue
    const localName = `${enumName}.${variantLocalName}`
    out.push({
      localName,
      canonicalName: `${moduleNodeName}#${localName}`,
      line: member.startPosition.row + 1,
      value,
    })
  }
  return out
}

/**
 * Per-field type extraction with containment metadata. Emits
 * field_of_type edges from a field node to its declared type(s),
 * tagging each edge with how the field contains the target:
 *
 *   - "direct"   bare type identifier:        prefix: string         (skipped — built-in)
 *                                             owner: User            ← edge with containment=direct
 *   - "array"    Foo[] or Array<Foo>          items: Foo[]           ← containment=array
 *   - "set"      Set<Foo>                     tags: Set<string>      (skipped — built-in element)
 *   - "map"      Map<K, V> or Record<K, V>    cache: Map<string,Foo> ← containment=map, keyType=string
 *   - "promise"  Promise<Foo>                 result: Promise<Foo>   ← containment=promise
 *   - "optional" T | null, T | undefined, T?  fallback?: Foo         ← containment=optional
 *   - "union"    A | B                        kind: A | B            ← TWO edges, containment=union
 *   - "intersection" A & B                                            ← two edges, containment=intersection
 *
 * Recursive wrappers compose: Promise<Array<Foo>> emits one edge
 * with containment=promise.array — the kinds chain from outer to
 * inner. For maps, the key type is recorded in metadata.keyType
 * but does NOT get its own edge (it's metadata, not a structural
 * pointer).
 *
 * Built-in elements (string, number, boolean, void, never, etc.)
 * are dropped — they don't resolve through the resolver and aren't
 * interesting for the data-structure graph. The function returns
 * an empty array when the field has no usable type or the type
 * resolves to nothing.
 *
 * Each returned edge payload also carries metadata.typeExpr — the
 * raw text of the type annotation — so the visualizer can show
 * the user what the field looks like in source.
 */
function extractFieldTypeEdges(
  memberNode: TsNode,
  fieldFqName: string,
  resolver: FileResolver,
  moduleNodeName: string,
  file: string,
): Array<TypeRefEdgePayload> {
  // Get the type_annotation child. Both public_field_definition and
  // property_signature expose it under the same "type" field name.
  const typeAnn =
    firstNamedChildOfType(memberNode, "type_annotation") ??
    memberNode.childForFieldName("type")
  if (!typeAnn) return []

  // The annotation wraps the actual type expression. The
  // type_annotation node is `: Type` — we want the Type child.
  let typeExpr: TsNode | null = null
  for (let i = 0; i < typeAnn.namedChildCount; i++) {
    const c = typeAnn.namedChild(i)
    if (c) {
      typeExpr = c
      break
    }
  }
  if (!typeExpr) return []

  const rawText = typeExpr.text
  const out: TypeRefEdgePayload[] = []
  const seenDsts = new Set<string>()
  const memberLine = memberNode.startPosition.row + 1

  // Recursive walker. `accumulated` is the chain of containment
  // wrappers we've passed through so far (e.g. ["promise", "array"]
  // for Promise<Array<Foo>>). At each leaf type_identifier we
  // resolve and emit an edge tagged with the joined chain.
  const visit = (n: TsNode, accumulated: string[]): void => {
    switch (n.type) {
      case "predefined_type":
        // string, number, boolean, void, never, undefined, null,
        // any, unknown, object, symbol, bigint — all built-in,
        // not interesting for the data-structure graph.
        return

      case "type_identifier": {
        const name = n.text
        const resolved = resolveTypeName(name, resolver, moduleNodeName)
        if (!resolved) return
        const containment = accumulated.length > 0 ? accumulated.join(".") : "direct"
        const dstKey = resolved.name + "|" + containment
        if (seenDsts.has(dstKey)) return
        seenDsts.add(dstKey)
        out.push({
          edgeKind: "field_of_type",
          srcSymbolName: fieldFqName,
          dstSymbolName: resolved.name,
          confidence: 0.95,
          derivation: "clangd",
          sourceLocation: {
            sourceFilePath: file,
            sourceLineNumber: memberLine,
          },
          metadata: {
            resolved: true,
            resolutionKind: resolved.kind,
            containment,
            typeExpr: rawText,
          },
        })
        return
      }

      case "array_type": {
        // T[] — wrap with "array", recurse on the element type
        for (let i = 0; i < n.namedChildCount; i++) {
          const c = n.namedChild(i)
          if (c) visit(c, [...accumulated, "array"])
        }
        return
      }

      case "generic_type": {
        // Promise<T>, Array<T>, Set<T>, Map<K,V>, Record<K,V>, Foo<T>
        const nameNode = n.childForFieldName("name") ?? n.namedChild(0)
        const argsNode = firstNamedChildOfType(n, "type_arguments")
        const wrapperName = nameNode ? nameNode.text : ""
        let wrapperKind: string | null = null
        let walkArgIndex = -1 // -1 means walk all type args
        let keyArgIndex = -1 // for Map/Record: which arg is the key
        switch (wrapperName) {
          case "Promise":
            wrapperKind = "promise"
            break
          case "Array":
          case "ReadonlyArray":
            wrapperKind = "array"
            break
          case "Set":
          case "ReadonlySet":
            wrapperKind = "set"
            break
          case "Map":
          case "ReadonlyMap":
            wrapperKind = "map"
            walkArgIndex = 1 // value type
            keyArgIndex = 0
            break
          case "Record":
            wrapperKind = "record"
            walkArgIndex = 1
            keyArgIndex = 0
            break
        }
        if (!argsNode) {
          // Bare generic name (rare). Resolve as a plain type identifier.
          if (nameNode && nameNode.type === "type_identifier") {
            visit(nameNode, accumulated)
          }
          return
        }
        if (wrapperKind) {
          const newAcc = [...accumulated, wrapperKind]
          // For map/record, also extract the key type (as metadata
          // on every emitted edge — collected at emission time below
          // via a closure on `keyType`).
          let keyTypeText: string | null = null
          if (keyArgIndex >= 0) {
            const k = argsNode.namedChild(keyArgIndex)
            if (k) keyTypeText = k.text
          }
          // Walk the value type arg only (or all args for non-key wrappers).
          if (walkArgIndex >= 0) {
            const target = argsNode.namedChild(walkArgIndex)
            if (target) {
              const before = out.length
              visit(target, newAcc)
              if (keyTypeText) {
                for (let i = before; i < out.length; i++) {
                  const meta = out[i].metadata as Record<string, unknown> | undefined
                  if (meta) meta.keyType = keyTypeText
                }
              }
            }
          } else {
            for (let i = 0; i < argsNode.namedChildCount; i++) {
              const c = argsNode.namedChild(i)
              if (c) visit(c, newAcc)
            }
          }
        } else {
          // User-defined generic type Foo<T>. The name itself is the
          // primary target (containment=direct), and we ALSO walk the
          // type args at the same accumulated depth so e.g.
          // Box<Inner> emits both Box and Inner.
          if (nameNode && nameNode.type === "type_identifier") {
            visit(nameNode, accumulated)
          }
          for (let i = 0; i < argsNode.namedChildCount; i++) {
            const c = argsNode.namedChild(i)
            if (c) visit(c, accumulated)
          }
        }
        return
      }

      case "union_type": {
        // T | null / T | undefined → optional
        // A | B → union (multi-target, one edge each)
        //
        // tree-sitter-typescript parses `null` and `undefined` in
        // type position as a literal_type wrapping a `null` or
        // `undefined` node. We treat both as "nullish".
        const isNullish = (c: TsNode): boolean => {
          if (c.type === "null" || c.type === "undefined") return true
          if (c.type === "literal_type") {
            const inner = c.namedChild(0)
            if (inner && (inner.type === "null" || inner.type === "undefined")) {
              return true
            }
          }
          return false
        }
        const members: TsNode[] = []
        let hasNullish = false
        for (let i = 0; i < n.namedChildCount; i++) {
          const c = n.namedChild(i)
          if (!c) continue
          if (isNullish(c)) {
            hasNullish = true
            continue
          }
          members.push(c)
        }
        if (members.length === 1 && hasNullish) {
          visit(members[0], [...accumulated, "optional"])
        } else {
          // Real union: emit one edge per member, tagged "union"
          for (const m of members) visit(m, [...accumulated, "union"])
        }
        return
      }

      case "intersection_type": {
        for (let i = 0; i < n.namedChildCount; i++) {
          const c = n.namedChild(i)
          if (c) visit(c, [...accumulated, "intersection"])
        }
        return
      }

      case "parenthesized_type":
      case "literal_type":
      case "type_query":
      case "index_type_query":
      case "conditional_type":
      case "mapped_type_clause":
      case "lookup_type":
      case "template_literal_type":
        // These either have no usable target or are out of scope for v1.
        // Walk children defensively in case they wrap a usable type.
        for (let i = 0; i < n.namedChildCount; i++) {
          const c = n.namedChild(i)
          if (c) visit(c, accumulated)
        }
        return

      default:
        // Catch-all: walk children. Tree-sitter-typescript has many
        // type node variants and we'd rather under-report than crash.
        for (let i = 0; i < n.namedChildCount; i++) {
          const c = n.namedChild(i)
          if (c) visit(c, accumulated)
        }
        return
    }
  }
  visit(typeExpr, [])
  return out
}

/**
 * Walk the body of a class or interface and emit references_type edges
 * for each typed field / property whose type resolves through the
 * FileResolver. Handles three member node types:
 *   - public_field_definition (class fields):     `field: Type`
 *   - property_signature      (interface props):  `field: Type`
 *   - method_signature        (interface methods): `greet(name: string): Result`
 *
 * For property_signature and public_field_definition, we look at the
 * direct type_annotation child. For method_signature, we walk the
 * entire node — every type_identifier inside lives in either a
 * parameter type_annotation or the return type_annotation.
 *
 * Class method bodies (method_definition nodes inside class_body) are
 * NOT walked here — they're already handled by extractTypeReferences
 * when each method_definition is processed during the recursive walk.
 */
function extractFieldTypeReferences(
  classOrIfaceNode: TsNode,
  thisFqName: string,
  resolver: FileResolver,
  moduleNodeName: string,
  file: string,
): Array<TypeRefEdgePayload> {
  const out: TypeRefEdgePayload[] = []
  const seen = new Set<string>()

  const body =
    firstNamedChildOfType(classOrIfaceNode, "class_body") ??
    firstNamedChildOfType(classOrIfaceNode, "interface_body") ??
    firstNamedChildOfType(classOrIfaceNode, "object_type")
  if (!body) return out

  for (let i = 0; i < body.namedChildCount; i++) {
    const member = body.namedChild(i)
    if (!member) continue

    // Pick the right walking strategy by member kind.
    let walkRoot: TsNode | null = null
    if (
      member.type === "public_field_definition" ||
      member.type === "property_signature"
    ) {
      // The type_annotation child carries the field's type. Walking
      // just that subtree avoids picking up unrelated identifiers
      // (e.g. inside a default value initializer).
      walkRoot = firstNamedChildOfType(member, "type_annotation")
    } else if (member.type === "method_signature") {
      // Interface method shorthand: `greet(name: string): Result`.
      // Every type_identifier inside the method_signature lives in a
      // parameter type_annotation or the return type, so walking the
      // whole member is safe and picks up both.
      walkRoot = member
    }
    if (!walkRoot) continue

    for (const typeName of namedDescendantTexts(walkRoot, "type_identifier")) {
      if (seen.has(typeName)) continue
      const resolved = resolveTypeName(typeName, resolver, moduleNodeName)
      if (!resolved) continue
      seen.add(typeName)
      out.push({
        edgeKind: "references_type",
        srcSymbolName: thisFqName,
        dstSymbolName: resolved.name,
        confidence: 0.95,
        derivation: "clangd",
        sourceLocation: {
          sourceFilePath: file,
          sourceLineNumber: walkRoot.startPosition.row + 1,
        },
        metadata: {
          resolved: true,
          resolutionKind: resolved.kind,
          typeName,
          fieldRef: true,
          memberKind: member.type,
        },
      })
    }
  }
  return out
}

/**
 * Resolve a bare type identifier against the FileResolver. Returns null
 * for built-ins / unknowns so callers can drop them.
 */
function resolveTypeName(
  name: string,
  resolver: FileResolver,
  moduleNodeName: string,
): { name: string; kind: string } | null {
  const named = resolver.namedImports.get(name)
  if (named) return { name: named, kind: "named-import" }
  const def = resolver.defaultImports.get(name)
  if (def) return { name: def, kind: "default-import" }
  if (resolver.localSymbols.has(name)) {
    return { name: `${moduleNodeName}#${name}`, kind: "local" }
  }
  return null
}

interface InheritanceEdgePayload {
  edgeKind: "extends" | "implements"
  srcSymbolName: string
  dstSymbolName: string
  confidence: number
  derivation: "clangd" | "llm" | "runtime" | "hybrid"
  sourceLocation: { sourceFilePath: string; sourceLineNumber: number }
  metadata: Record<string, unknown>
}

function extractInheritanceEdges(
  classOrIface: TsNode,
  thisFqName: string,
  file: string,
  resolver: FileResolver,
  moduleNodeName: string,
): Array<InheritanceEdgePayload> {
  const out: InheritanceEdgePayload[] = []
  // class_heritage holds extends_clause and implements_clause children.
  // The TS grammar uses `identifier` (a value reference) for the parent
  // class in extends_clause but `type_identifier` (a type reference) for
  // implements_clause and interface heritage. We accept both.
  //
  // Targets are resolved through the FileResolver so the destination
  // canonical_name is the FQ form (e.g. `module:src/x.ts#Greeter`),
  // not the bare identifier. Without this fix the structural intents
  // (find_class_inheritance / find_class_subtypes / find_interface_implementors)
  // would never join to a real graph_node row because the dst was bare.
  const seen = new Set<string>()
  const pushEdge = (
    kind: "extends" | "implements",
    target: string,
  ) => {
    const key = `${kind}:${target}`
    if (seen.has(key)) return
    seen.add(key)
    const resolved = resolveTypeName(target, resolver, moduleNodeName)
    const dst = resolved ? resolved.name : target
    out.push({
      edgeKind: kind,
      srcSymbolName: thisFqName,
      dstSymbolName: dst,
      confidence: resolved ? 1 : 0.7,
      derivation: "clangd",
      sourceLocation: {
        sourceFilePath: file,
        sourceLineNumber: classOrIface.startPosition.row + 1,
      },
      metadata: {
        resolved: resolved !== null,
        ...(resolved ? { resolutionKind: resolved.kind } : {}),
        targetName: target,
      },
    })
  }

  const heritage = firstNamedChildOfType(classOrIface, "class_heritage")
  if (heritage) {
    for (let i = 0; i < heritage.namedChildCount; i++) {
      const clause = heritage.namedChild(i)
      if (!clause) continue
      const kind: "extends" | "implements" =
        clause.type === "implements_clause" ? "implements" : "extends"
      for (const target of namedDescendantTexts(clause, "type_identifier")) {
        pushEdge(kind, target)
      }
      for (const target of namedDescendantTexts(clause, "identifier")) {
        pushEdge(kind, target)
      }
    }
  }
  // interface extends X, Y { ... } — extends_type_clause
  const extendsClause = firstNamedChildOfType(classOrIface, "extends_type_clause")
  if (extendsClause) {
    for (const target of namedDescendantTexts(extendsClause, "type_identifier")) {
      pushEdge("extends", target)
    }
    for (const target of namedDescendantTexts(extendsClause, "identifier")) {
      pushEdge("extends", target)
    }
  }
  return out
}

interface ImportEdgePayload {
  edgeKind: "imports"
  srcSymbolName: string
  dstSymbolName: string
  confidence: number
  derivation: "clangd" | "llm" | "runtime" | "hybrid"
  sourceLocation: { sourceFilePath: string; sourceLineNumber: number }
  metadata?: Record<string, unknown>
}

function extractImportEdge(
  importNode: TsNode,
  moduleNodeName: string,
  file: string,
  workspaceRoot: string,
): ImportEdgePayload | null {
  const source = firstStringChildText(importNode)
  if (!source) return null
  // Detect `import type { … } from "…"` — the `type` keyword is an
  // anonymous child of import_statement, not a named one.
  const isTypeOnly = hasAnonymousChildOfType(importNode, "type")
  return {
    edgeKind: "imports",
    srcSymbolName: moduleNodeName,
    dstSymbolName: resolveImportTarget(source, file, workspaceRoot),
    confidence: 1,
    derivation: "clangd",
    sourceLocation: {
      sourceFilePath: file,
      sourceLineNumber: importNode.startPosition.row + 1,
    },
    ...(isTypeOnly ? { metadata: { importType: true } } : {}),
  }
}

/**
 * `export { x } from "./y"`, `export * from "./y"`, and
 * `export * as ns from "./y"` are semantically imports — they create a
 * dependency on the source module. We emit them as `imports` edges with
 * metadata.reExport=true so a visualizer can distinguish them from
 * direct imports.
 *
 * `export const x = ...` and `export function y() {}` have no `string`
 * source and are returned as null; their declaration children flow
 * through the recursive walk and are picked up by extractDeclaration.
 */
function extractReExportEdge(
  exportNode: TsNode,
  moduleNodeName: string,
  file: string,
  workspaceRoot: string,
): ImportEdgePayload | null {
  const source = firstStringChildText(exportNode)
  if (!source) return null
  return {
    edgeKind: "imports",
    srcSymbolName: moduleNodeName,
    dstSymbolName: resolveImportTarget(source, file, workspaceRoot),
    confidence: 1,
    derivation: "clangd",
    sourceLocation: {
      sourceFilePath: file,
      sourceLineNumber: exportNode.startPosition.row + 1,
    },
    metadata: { reExport: true },
  }
}

function firstStringChildText(node: TsNode): string | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)
    if (!child) continue
    if (child.type === "string") {
      return child.text.replace(/^['"]|['"]$/g, "")
    }
  }
  return null
}

function resolveImportTarget(
  source: string,
  file: string,
  workspaceRoot: string,
): string {
  if (source.startsWith("./") || source.startsWith("../")) {
    const abs = resolveImportPath(resolvePath(dirname(file), source))
    return `module:${workspaceRelativePath(workspaceRoot, abs)}`
  }
  if (source.startsWith("/")) {
    const abs = resolveImportPath(source)
    return `module:${workspaceRelativePath(workspaceRoot, abs)}`
  }
  return `module:${source}`
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

/**
 * Shallow check: does this directory contain any .ts/.tsx/.js/.jsx
 * file at depth 0 or 1? Used by appliesTo() as a fallback for
 * workspaces that don't ship a package.json.
 */
function hasTsFilesShallow(dir: string): boolean {
  if (!existsSync(dir)) return false
  let st
  try {
    st = statSync(dir)
  } catch {
    return false
  }
  if (!st.isDirectory()) return false
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    const name = entry.name
    if (entry.isFile()) {
      if (
        name.endsWith(".ts") ||
        name.endsWith(".tsx") ||
        name.endsWith(".mts") ||
        name.endsWith(".cts") ||
        name.endsWith(".js") ||
        name.endsWith(".jsx") ||
        name.endsWith(".mjs") ||
        name.endsWith(".cjs")
      ) {
        return true
      }
    } else if (entry.isDirectory() && !name.startsWith(".") && !SKIP_DIRS.has(name)) {
      // One level deep — check immediate file children only.
      try {
        const subEntries = readdirSync(join(dir, name), { withFileTypes: true })
        for (const sub of subEntries) {
          if (sub.isFile()) {
            const subName = sub.name
            if (
              subName.endsWith(".ts") ||
              subName.endsWith(".tsx") ||
              subName.endsWith(".mts") ||
              subName.endsWith(".cts") ||
              subName.endsWith(".js") ||
              subName.endsWith(".jsx")
            ) {
              return true
            }
          }
        }
      } catch {
        // unreadable subdir, ignore
      }
    }
  }
  return false
}

function workspaceRelativePath(workspaceRoot: string, file: string): string {
  const rel = relative(workspaceRoot, file)
  // Normalize separators and strip leading "./"
  return rel.replace(/\\/g, "/").replace(/^\.\//, "")
}

/**
 * Probe a relative import path for the actual TS/JS file. Mirrors the
 * tsc/Node module resolver in a small subset:
 *   - exact path with one of [.ts, .tsx, .mts, .cts, .js, .jsx, .mjs, .cjs]
 *   - <path>/index with the same extension list
 * Falls back to the input unchanged if nothing matches (e.g. an
 * unresolved relative import to a missing file).
 */
function resolveImportPath(basePath: string): string {
  // If the path already has a JS-family extension (common in NodeNext
  // resolution: `import { x } from "./foo.js"`), strip it and try the
  // TS equivalent first. This is the .js→.ts normalization that prevents
  // cross-file edges from using mismatched extensions.
  const jsExts = [".js", ".mjs", ".cjs", ".jsx"]
  const stripped = jsExts.reduce((p, ext) => p.endsWith(ext) ? p.slice(0, -ext.length) : p, basePath)

  const exts = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]

  // Try stripped path first (handles .js→.ts normalization)
  if (stripped !== basePath) {
    for (const ext of exts) {
      const p = stripped + ext
      if (existsSync(p)) return p
    }
  }
  // Try original path with extensions appended
  for (const ext of exts) {
    const p = basePath + ext
    if (existsSync(p)) return p
  }
  // Try index files
  for (const ext of exts) {
    const p = join(basePath, "index" + ext)
    if (existsSync(p)) return p
  }
  if (stripped !== basePath) {
    for (const ext of exts) {
      const p = join(stripped, "index" + ext)
      if (existsSync(p)) return p
    }
  }
  return basePath
}

function locationOf(
  file: string,
  node: TsNode,
): { filePath: string; line: number; column: number } {
  return {
    filePath: file,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
  }
}

/**
 * Extract a JSX component reference from a jsx_opening_element /
 * jsx_self_closing_element node and resolve it through the FileResolver.
 *
 * Returns null when the tag is an HTML element (lowercase) or unknown.
 *
 * Tree-sitter shape:
 *   jsx_opening_element / jsx_self_closing_element
 *     ├─ identifier (the tag, e.g. "Foo")
 *     │   OR
 *     ├─ member_expression (e.g. "Tabs.Item" — the typescript tsx grammar
 *     │   uses member_expression for both jsx and js property access)
 *     │   OR
 *     ├─ nested_identifier (rarer; same shape as a chain of identifiers)
 *     └─ jsx_attribute*
 *
 * Resolution:
 *   - Plain identifier: same path as call_expression's identifier branch
 *     (named import → default → local → bare)
 *   - Member: resolve the leftmost object via the FileResolver, append
 *     the property to produce `${objFq}.${prop}` with kind=jsx-namespace-component
 */
function extractJsxComponentRef(
  jsxNode: TsNode,
  resolver: FileResolver,
  moduleNodeName: string,
): { name: string; resolved: boolean; kind: string; jsxTag: string } | null {
  let tagNode: TsNode | null = null
  for (let i = 0; i < jsxNode.namedChildCount; i++) {
    const child = jsxNode.namedChild(i)
    if (!child) continue
    if (
      child.type === "identifier" ||
      child.type === "member_expression" ||
      child.type === "nested_identifier"
    ) {
      tagNode = child
      break
    }
  }
  if (!tagNode) return null

  // Plain identifier — single component name like <Foo />
  if (tagNode.type === "identifier") {
    const name = tagNode.text
    if (!isComponentTagName(name)) return null
    const resolved = resolveTypeName(name, resolver, moduleNodeName)
    return {
      name: resolved ? resolved.name : name,
      resolved: resolved !== null,
      kind: "jsx-component",
      jsxTag: name,
    }
  }

  // Member-expression tag — <Tabs.Item />, <pkg.Component />
  if (tagNode.type === "member_expression") {
    const obj = tagNode.childForFieldName("object")
    const prop = tagNode.childForFieldName("property")
    if (!obj || !prop) return null
    const propName = prop.text
    // The component check applies to the LAST segment (the actual
    // rendered element); HTML lowercase tags don't appear here in
    // practice, but check anyway.
    if (!isComponentTagName(propName) && obj.type === "identifier" &&
        !isComponentTagName(obj.text)) {
      return null
    }
    if (obj.type === "identifier") {
      const objFq = resolveTypeName(obj.text, resolver, moduleNodeName)
      if (objFq) {
        return {
          name: `${objFq.name}.${propName}`,
          resolved: true,
          kind: "jsx-namespace-component",
          jsxTag: `${obj.text}.${propName}`,
        }
      }
      return {
        name: `${obj.text}.${propName}`,
        resolved: false,
        kind: "jsx-namespace-component",
        jsxTag: `${obj.text}.${propName}`,
      }
    }
    // Deeper member chains: leave as the property name only.
    return {
      name: propName,
      resolved: false,
      kind: "jsx-namespace-component",
      jsxTag: tagNode.text,
    }
  }

  // nested_identifier fallback — rare; treat as a chain.
  const first = firstNamedChildOfType(tagNode, "identifier")
  const text = first?.text ?? tagNode.text
  if (!isComponentTagName(text)) return null
  const resolved = resolveTypeName(text, resolver, moduleNodeName)
  return {
    name: resolved ? resolved.name : text,
    resolved: resolved !== null,
    kind: "jsx-component",
    jsxTag: tagNode.text,
  }
}

/**
 * Walk a jsx_self_closing_element / jsx_opening_element's named
 * children for jsx_attribute (named props) and jsx_expression nodes
 * containing spread_element (`{...rest}`). Returns an array of
 * literal prop names plus a flag indicating whether any spread
 * props are present.
 */
function collectJsxProps(jsxNode: TsNode): {
  props: string[]
  hasSpread: boolean
} {
  const props: string[] = []
  let hasSpread = false
  for (let i = 0; i < jsxNode.namedChildCount; i++) {
    const child = jsxNode.namedChild(i)
    if (!child) continue
    if (child.type === "jsx_attribute") {
      // jsx_attribute's first named child is property_identifier
      const nameNode = child.namedChild(0)
      if (nameNode && nameNode.type === "property_identifier") {
        props.push(nameNode.text)
      }
    } else if (child.type === "jsx_expression") {
      // jsx_expression containing spread_element = {...rest}
      const spread = firstNamedChildOfType(child, "spread_element")
      if (spread) hasSpread = true
    }
  }
  return { props, hasSpread }
}

/**
 * React convention: lowercase tag names are HTML elements, uppercase
 * are components. We also accept `_` and `$` as valid component-name
 * starts to be safe with mangled or generated code.
 */
function isComponentTagName(name: string): boolean {
  if (!name) return false
  const c = name.charCodeAt(0)
  // 'A'..'Z' or '_' or '$'
  return (c >= 65 && c <= 90) || c === 95 || c === 36
}

/**
 * Returns true when the declaration node is wrapped in an
 * export_statement (e.g. `export class Foo {}`, `export function foo() {}`,
 * `export const x = ...`). The declaration node's direct parent is
 * the export_statement in those cases. Default-default exports
 * (`export default class Foo {}`) are also recognized — same parent
 * shape.
 */
function isExportedDeclaration(node: TsNode): boolean {
  return node.parent !== null && node.parent.type === "export_statement"
}

/**
 * Detect whether a call_expression is wrapped in a yield_expression
 * (`yield foo()` or `yield* foo()`). Returns an object with the
 * appropriate metadata flags. tree-sitter encodes both forms as
 * `yield_expression > call_expression` — the `*` is anonymous so we
 * detect delegation by walking the yield_expression's children for
 * an anonymous "*" token.
 */
function detectYieldWrapping(callNode: TsNode): {
  yielded?: boolean
  delegated?: boolean
} {
  const parent = callNode.parent
  if (!parent || parent.type !== "yield_expression") return {}
  // Walk the yield_expression's anonymous children for "*"
  let delegated = false
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i)
    if (child && child.type === "*") {
      delegated = true
      break
    }
  }
  return delegated ? { yielded: true, delegated: true } : { yielded: true }
}

/**
 * A tagged template literal call (e.g. sql`SELECT *`) parses as a
 * call_expression whose second named child is a template_string
 * instead of an arguments node. Detect by walking the named children
 * for any template_string.
 */
function isTaggedTemplateCall(callNode: TsNode): boolean {
  for (let i = 0; i < callNode.namedChildCount; i++) {
    const child = callNode.namedChild(i)
    if (child && child.type === "template_string") return true
  }
  return false
}

/**
 * Check whether any of `node`'s children (named or anonymous) have the
 * given type. Used for keywords like `type` in `import type` that
 * appear as anonymous children of import_statement.
 */
function hasAnonymousChildOfType(node: TsNode, type: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child && child.type === type) return true
  }
  return false
}

function firstNamedChildOfType(node: TsNode, type: string): TsNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)
    if (child && child.type === type) return child
  }
  return null
}

/**
 * Depth-first search for the first descendant of `node` whose type
 * matches. Used by D16 to extract a typed-var's primary type from a
 * type_annotation (which may wrap the type in union_type, generic_type,
 * etc.).
 */
function findFirstDescendantOfType(node: TsNode, type: string): TsNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)
    if (!child) continue
    if (child.type === type) return child
    const found = findFirstDescendantOfType(child, type)
    if (found) return found
  }
  return null
}

function namedDescendantTexts(node: TsNode, type: string): string[] {
  const out: string[] = []
  const stack: TsNode[] = [node]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (let i = 0; i < current.namedChildCount; i++) {
      const child = current.namedChild(i)
      if (!child) continue
      if (child.type === type) {
        out.push(child.text)
      }
      stack.push(child)
    }
  }
  return out
}
