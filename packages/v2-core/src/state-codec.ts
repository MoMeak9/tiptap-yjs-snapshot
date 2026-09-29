import type { JSONContent } from '@tiptap/core'
import type { Schema } from '@tiptap/pm/model'
import { TiptapTransformer } from '@hocuspocus/transformer'
import * as Y from 'yjs'
import { buildCanonicalContent, CURRENT_SCHEMA_VERSION, type CanonicalContent } from './canonical'
import type { RevisionProjectionResult, V2StateCodec } from './ports'

/**
 * Call inside a host worker, never directly on an HTTP event loop for large states.
 * Canonical content and optional attribution share one decoded Y.Doc.
 */
export async function decodeV2Projection(
  state: Uint8Array,
  schema: Schema,
  deriveAttribution?: (doc: Y.Doc, canonical: CanonicalContent) => Promise<unknown | null> | unknown | null,
): Promise<RevisionProjectionResult> {
  const doc = new Y.Doc()
  try {
    Y.applyUpdateV2(doc, state)
    const json = TiptapTransformer.fromYdoc(doc, 'default') as JSONContent
    const canonical = buildCanonicalContent(schema, json)
    let attribution: unknown | null = null
    let attributionComplete = true
    let attributionErrorClass: string | undefined
    if (deriveAttribution) {
      try { attribution = await deriveAttribution(doc, canonical) }
      catch (error) {
        // Keep this read usable, but do not make missing credit permanent in storage.
        attributionComplete = false
        attributionErrorClass = error instanceof Error ? error.name : 'UnknownError'
      }
    }
    return {
      content: canonical.json, contentJson: canonical.serialized,
      contentHash: canonical.contentHash, schemaVersion: CURRENT_SCHEMA_VERSION,
      attribution, attributionComplete,
      ...(attributionErrorClass ? { attributionErrorClass } : {}),
    }
  } finally {
    doc.destroy()
  }
}

/** V2 bytes are decoded for derived JSON only; restore writes the original bytes. */
export const yjsV2StateCodec: V2StateCodec = {
  decode(state: Uint8Array): { content: JSONContent; title?: string } {
    const doc = new Y.Doc()
    try {
      Y.applyUpdateV2(doc, state)
      const content = TiptapTransformer.fromYdoc(doc, 'default') as JSONContent
      const title = doc.share.has('title') ? doc.getText('title').toString() : undefined
      return { content, ...(title === undefined ? {} : { title }) }
    } finally {
      doc.destroy()
    }
  },
}
