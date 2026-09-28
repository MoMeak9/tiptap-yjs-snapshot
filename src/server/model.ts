import { TiptapTransformer } from '@hocuspocus/transformer'
import { getSchema, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import type * as Y from 'yjs'
import { buildCanonicalContent, CURRENT_SCHEMA_VERSION } from '../../packages/v2-core/src/canonical'

export type Materialized = {
  title: string
  content: Record<string, unknown>
  hash: string
}

/** This portable sample supports the built-in StarterKit document schema only. */
export const CONTENT_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION
const schema = getSchema([StarterKit])

// Yjs encodings contain client clocks and insertion history; revisions compare the
// materialized editor document instead of bytes so equivalent edits deduplicate.
export function materialize(doc: Y.Doc): Materialized {
  // The same V2 core canonicalizer produces both persisted JSON and its hash.
  const extracted = TiptapTransformer.fromYdoc(doc, 'default') as JSONContent
  const canonical = buildCanonicalContent(schema, extracted)
  return {
    title: doc.getText('title').toString(),
    content: canonical.json as Record<string, unknown>,
    hash: canonical.contentHash,
  }
}
