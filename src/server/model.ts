import { createHash } from 'node:crypto'
import { TiptapTransformer } from '@hocuspocus/transformer'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import type * as Y from 'yjs'

export type Materialized = {
  title: string
  content: Record<string, unknown>
  hash: string
}

/** This portable sample supports the built-in StarterKit document schema only. */
export const CONTENT_SCHEMA_VERSION = 1
const schema = getSchema([StarterKit])

// Yjs encodings contain client clocks and insertion history; revisions compare the
// materialized editor document instead of bytes so equivalent edits deduplicate.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function materialize(doc: Y.Doc): Materialized {
  // Round-trip through the same schema on every write (and legacy decode), so
  // state-derived JSON and the stored semantic hash use the same defaults.
  const extracted = TiptapTransformer.fromYdoc(doc, 'default') as Record<string, unknown>
  const content = schema.nodeFromJSON(extracted).toJSON() as Record<string, unknown>
  return {
    title: doc.getText('title').toString(),
    content,
    hash: createHash('sha256').update(canonical(content)).digest('hex'),
  }
}
