import type { JSONContent } from '@tiptap/core'
import type { Schema } from '@tiptap/pm/model'
import { buildCanonicalContent, buildTolerantCanonicalContent, CURRENT_SCHEMA_VERSION, UnknownProseMirrorTypeError, type CanonicalContent } from './canonical'
import type { DocumentPatch, DocumentRecord, DocumentStore, DocumentWriteClient } from './ports'

export type DocumentHistoryWritePath = 'collaboration_store' | 'open_api_content_update' | 'open_api_title_update' | 'snapshot_restore'

export interface DocumentHistoryInput {
  readonly documentId: string
  readonly writePath: DocumentHistoryWritePath
  readonly persistenceV2Enabled: boolean
  readonly content?: JSONContent
  readonly title?: string
  readonly actor?: string
}

export interface PreparedDocumentHistoryWrite {
  readonly input: DocumentHistoryInput
  readonly canonical?: CanonicalContent
  readonly degraded: boolean
  readonly disabled: boolean
  readonly unknownTypes?: { nodeTypes: readonly string[]; markTypes: readonly string[] }
  readonly failureReason?: string
}

export type DocumentHistoryFields = Pick<DocumentPatch,
  'contentJson' | 'contentHash' | 'schemaVersion' | 'revisionCountIncrement' | 'lastModifiedBy' | 'mtime'>

/** CPU-only. Call before acquiring the document lock or entering a room reset window. */
export function prepareDocumentHistoryWrite(schema: Schema, input: DocumentHistoryInput): PreparedDocumentHistoryWrite {
  if (!input.persistenceV2Enabled) return { input, degraded: false, disabled: true }
  if (input.content === undefined) return { input, degraded: false, disabled: false }
  try {
    return { input, canonical: buildCanonicalContent(schema, input.content), degraded: false, disabled: false }
  } catch (error) {
    if (error instanceof UnknownProseMirrorTypeError) {
      return {
        input,
        canonical: buildTolerantCanonicalContent(input.content),
        degraded: false,
        disabled: false,
        unknownTypes: { nodeTypes: error.nodeTypes, markTypes: error.markTypes },
      }
    }
    // A malformed body cannot advance the V2 hash/count. Caller still persists its
    // original state through write, and its monitoring adapter can inspect reason.
    return { input, degraded: true, disabled: false, failureReason: error instanceof Error ? error.name : 'UnknownError' }
  }
}

export interface DocumentHistoryWriteResult<T> {
  readonly result: T
  readonly businessChanged: boolean
  readonly degraded: boolean
  readonly disabled: boolean
}

/** Use when a larger operation already holds the document lock. */
export function buildDocumentHistoryFields(
  prepared: PreparedDocumentHistoryWrite,
  baseline: DocumentRecord | null,
): { fields: DocumentHistoryFields; businessChanged: boolean } {
  if (prepared.disabled || prepared.degraded) return { fields: {}, businessChanged: false }
  const { input, canonical } = prepared
  const titleChanged = input.title !== undefined && (baseline === null || input.title !== baseline.title)
  const contentChanged = canonical !== undefined && (baseline === null || canonical.contentHash !== baseline.contentHash)
  const businessChanged = titleChanged || contentChanged
  const fields: DocumentHistoryFields = {}
  if (canonical) {
    fields.contentJson = canonical.serialized
    fields.contentHash = canonical.contentHash
    fields.schemaVersion = CURRENT_SCHEMA_VERSION
  }
  if (businessChanged) {
    fields.revisionCountIncrement = 1
    if (input.actor !== undefined) fields.lastModifiedBy = input.actor
  } else if (baseline) {
    fields.mtime = baseline.mtime
  }
  return { fields, businessChanged }
}

export async function commitDocumentHistoryWrite<T>(
  store: DocumentStore,
  prepared: PreparedDocumentHistoryWrite,
  write: (fields: DocumentHistoryFields, client: DocumentWriteClient) => Promise<T>,
): Promise<DocumentHistoryWriteResult<T>> {
  // No V2 decision is possible on these paths. Preserve the underlying write and
  // avoid a lock, matching the source write-path semantics.
  if (prepared.disabled || prepared.degraded) {
    return {
      result: await write({}, store),
      businessChanged: false,
      degraded: prepared.degraded,
      disabled: prepared.disabled,
    }
  }

  return store.transaction(async tx => {
    const baseline = await tx.readForUpdate(prepared.input.documentId)
    const { fields, businessChanged } = buildDocumentHistoryFields(prepared, baseline)
    return { result: await write(fields, tx), businessChanged, degraded: false, disabled: false }
  })
}
