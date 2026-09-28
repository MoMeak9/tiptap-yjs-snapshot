import type { JSONContent } from '@tiptap/core'
import { Fragment, type Mark, type Node, type Schema } from '@tiptap/pm/model'

export type HistoryDegradationKind =
  | 'unknown-node'
  | 'unknown-mark'
  | 'invalid-content'

export interface HistoryDegradation {
  readonly kind: HistoryDegradationKind
  /** The offending node or mark name, as it appeared in the stored JSON. */
  readonly name: string
  /** JSON pointer-ish path, e.g. `$.content[2].content[0]`. */
  readonly path: string
}

export interface HistoryDocumentRender {
  readonly doc: Node
  /**
   * Every type this render could not honour.
   *
   * Reported rather than thrown: a frozen historical schema is a superset of
   * what the running editor knows, so an unknown type is expected in old
   * revisions and must not make a readable revision unreadable.
   */
  readonly degradations: readonly HistoryDegradation[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function attrsOf(json: Record<string, unknown>): Record<string, unknown> {
  // Attributes the type does not declare are dropped by ProseMirror itself, so
  // they are passed through as-is rather than filtered here.
  return isRecord(json.attrs) ? json.attrs : {}
}

/**
 * Converts stored marks, skipping the ones this schema no longer has.
 *
 * A dropped mark loses styling but keeps its text, which is the difference
 * between a revision that reads correctly and one that reads as a hole.
 */
function convertMarks(
  schema: Schema,
  json: Record<string, unknown>,
  path: string,
  report: (degradation: HistoryDegradation) => void
): readonly Mark[] {
  const raw = json.marks
  if (!Array.isArray(raw)) {
    return []
  }

  const marks: Mark[] = []
  raw.forEach((entry, index) => {
    if (!isRecord(entry) || typeof entry.type !== 'string') {
      return
    }

    const markType = schema.marks[entry.type]
    if (markType === undefined) {
      report({
        kind: 'unknown-mark',
        name: entry.type,
        path: `${path}.marks[${index}]`,
      })
      return
    }

    try {
      marks.push(markType.create(attrsOf(entry)))
    } catch {
      // A mark whose attributes no longer validate is dropped for the same
      // reason an unknown one is: the text it covers still has to render.
      report({
        kind: 'invalid-content',
        name: entry.type,
        path: `${path}.marks[${index}]`,
      })
    }
  })
  return marks
}

function convertChildren(
  schema: Schema,
  json: Record<string, unknown>,
  path: string,
  report: (degradation: HistoryDegradation) => void
): Node[] {
  const raw = json.content
  if (!Array.isArray(raw)) {
    return []
  }

  return raw.flatMap((child, index) =>
    isRecord(child)
      ? convertNode(schema, child, `${path}.content[${index}]`, report)
      : []
  )
}

/**
 * Wraps inline children so they have somewhere legal to live.
 *
 * Returns the children untouched when they are blocks: an unknown container's
 * block children are spliced into its parent instead, which keeps the reading
 * order intact rather than nesting them under a paragraph that cannot hold them.
 */
function reparent(schema: Schema, children: readonly Node[]): Node[] {
  if (children.length === 0) {
    return []
  }
  if (!children.some(child => child.isInline)) {
    return [...children]
  }

  const inline = children.filter(child => child.isInline)
  const blocks = children.filter(child => !child.isInline)
  const paragraph = schema.nodes.paragraph
  if (paragraph === undefined) {
    // Without a paragraph type there is nothing to hold loose inline content;
    // the blocks are still worth keeping.
    return blocks
  }

  try {
    return [paragraph.create(null, Fragment.fromArray(inline)), ...blocks]
  } catch {
    return blocks
  }
}

function convertNode(
  schema: Schema,
  json: Record<string, unknown>,
  path: string,
  report: (degradation: HistoryDegradation) => void
): Node[] {
  if (json.type === 'text') {
    const text = typeof json.text === 'string' ? json.text : ''
    if (text === '') {
      return []
    }
    return [schema.text(text, [...convertMarks(schema, json, path, report)])]
  }

  const children = convertChildren(schema, json, path, report)

  if (typeof json.type !== 'string') {
    report({ kind: 'unknown-node', name: String(json.type), path })
    return reparent(schema, children)
  }

  const nodeType = schema.nodes[json.type]
  if (nodeType === undefined) {
    report({ kind: 'unknown-node', name: json.type, path })
    return reparent(schema, children)
  }

  const marks = [...convertMarks(schema, json, path, report)]
  try {
    return [
      nodeType.createChecked(
        attrsOf(json),
        Fragment.fromArray(children),
        marks
      ),
    ]
  } catch {
    // The type exists but this content no longer satisfies it. Filling is tried
    // first because it preserves the node itself; only then is the node given
    // up and its children kept.
    try {
      const filled = nodeType.createAndFill(
        attrsOf(json),
        Fragment.fromArray(children),
        marks
      )
      if (filled !== null) {
        report({ kind: 'invalid-content', name: json.type, path })
        return [filled]
      }
    } catch {
      // Fall through to keeping the children.
    }
    report({ kind: 'invalid-content', name: json.type, path })
    return reparent(schema, children)
  }
}

/**
 * Builds a renderable document from a stored revision body.
 *
 * The host's live schema is used, not the frozen historical one: only the live
 * schema carries the `toDOM`, node views and styles that make a document
 * viewable. The historical schema is a superset, so anything it allows but the
 * live schema does not is degraded and reported instead of failing the render.
 *
 * This function never throws — an unreadable body still yields an empty
 * document, which the caller can distinguish through `degradations`.
 */
export function renderHistoryDocument(
  schema: Schema,
  content: JSONContent
): HistoryDocumentRender {
  const degradations: HistoryDegradation[] = []
  const report = (degradation: HistoryDegradation): void => {
    degradations.push(degradation)
  }

  const json = isRecord(content) ? content : {}
  const children = convertChildren(schema, json, '$', report)
  const topType = schema.topNodeType

  const fallback = (): Node => {
    const empty = topType.createAndFill()
    if (empty !== null) {
      return empty
    }
    // A top node that cannot even be filled empty is a broken host schema, not
    // a property of the revision.
    return topType.create()
  }

  try {
    const doc = topType.createAndFill(
      attrsOf(json),
      Fragment.fromArray(reparent(schema, children))
    )
    if (doc !== null) {
      return { doc, degradations }
    }
  } catch {
    // Handled below as an unrenderable body.
  }

  report({ kind: 'invalid-content', name: topType.name, path: '$' })
  return { doc: fallback(), degradations }
}
