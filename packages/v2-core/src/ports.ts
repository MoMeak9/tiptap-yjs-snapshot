import type { JSONContent } from '@tiptap/core'
import type { RevisionCursor } from './cursor'

/** The caller must authorize the document before passing this context into the service. */
export interface DocumentContext {
  readonly documentId: string
  readonly actorId?: string
}

export interface DocumentRecord {
  readonly id: string
  readonly title: string
  readonly contentJson: string | null
  readonly contentHash: string
  readonly schemaVersion: number
  readonly revisionCount: number
  readonly state: Uint8Array | null
  readonly mtime: Date
  readonly lastModifiedBy: string | null
  readonly deleted: boolean
}

export interface DocumentPatch {
  title?: string
  contentJson?: string
  contentHash?: string
  schemaVersion?: number
  /** Atomic increment. A metadata-only write leaves this absent. */
  revisionCountIncrement?: 1
  state?: Uint8Array
  lastModifiedBy?: string
  /** Preserve the old mtime when no business data changed. */
  mtime?: Date
}

export interface DocumentWriteClient {
  write(documentId: string, patch: DocumentPatch): Promise<DocumentRecord>
}

/** readForUpdate must acquire a document-level lock held through transaction commit. */
export interface DocumentTransaction extends DocumentWriteClient {
  readForUpdate(documentId: string): Promise<DocumentRecord | null>
}

export interface DocumentStore extends DocumentWriteClient {
  read(documentId: string): Promise<DocumentRecord | null>
  transaction<T>(work: (tx: DocumentTransaction) => Promise<T>): Promise<T>
}

export type RevisionType = 'auto' | 'open_api' | 'manual' | 'pre_restore' | 'restore'

/** All V2 revision types retain the original Yjs V2 state for faithful restore. */
export interface RevisionRecord {
  readonly id: string
  readonly documentId: string
  readonly version: number
  readonly type: RevisionType
  readonly name: string | null
  readonly title: string
  readonly contentJson: string
  readonly contentHash: string
  readonly schemaVersion: number
  readonly sourceFormat: 'v2_json'
  readonly state: Uint8Array
  readonly createdBy: string | null
  readonly contributors: readonly string[]
  readonly attribution: unknown | null
  readonly ctime: Date
  readonly mtime: Date
  readonly deleted: boolean
  readonly restoredFromRevisionId: string | null
}

/** The list projection intentionally has no contentJson or state property. */
export type RevisionListRow = Pick<RevisionRecord,
  'id' | 'documentId' | 'version' | 'type' | 'name' | 'title' | 'createdBy' |
  'contributors' | 'ctime' | 'deleted' | 'restoredFromRevisionId'> & {
    readonly contentPresent: boolean
    readonly statePresent: boolean
    readonly restoredFromVersion: number | null
  }

export interface RevisionInsert {
  readonly id: string
  readonly documentId: string
  readonly type: RevisionType
  readonly name: string | null
  readonly title: string
  readonly contentJson: string
  readonly contentHash: string
  readonly schemaVersion: number
  readonly sourceFormat: 'v2_json'
  readonly state: Uint8Array
  readonly createdBy: string | null
  readonly contributors: readonly string[]
  readonly attribution: unknown | null
  readonly materializedAt: Date
  readonly restoredFromRevisionId: string | null
}

/** Fast and lock-authoritative dedupe read; never fetches the binary or JSON. */
export interface RevisionHead {
  readonly id: string
  readonly contentHash: string
  readonly title: string
}

/**
 * Implement latest and insert using the SAME transaction connection as DocumentStore.
 * insert derives max(version)+1 under the document lock and clamps ctime above the
 * previous maximum by at least 1 ms. It returns the inserted row in that transaction.
 */
export interface RevisionStore {
  /** latest and list exclude deleted rows and sort by (version DESC, id DESC). */
  latest(documentId: string, tx?: DocumentTransaction): Promise<RevisionHead | null>
  get(documentId: string, revisionId: string): Promise<RevisionRecord | null>
  list(documentId: string, cursor: RevisionCursor | null, limitPlusOne: number): Promise<readonly RevisionListRow[]>
  insert(input: RevisionInsert, tx: DocumentTransaction): Promise<RevisionRecord>
  /** Called only inside the lock when another job just wrote the same revision. */
  mergeInterval?(revisionId: string, interval: ClaimedInterval, tx: DocumentTransaction): Promise<void>
}

export type RevisionSource = 'auto' | 'open_api'

export interface RevisionJob {
  readonly documentId: string
  readonly source: RevisionSource
  readonly enqueuedAt: number
}

/** Durable delayed jobs must survive process restarts and multi-instance ownership changes. */
export interface Scheduler {
  enqueueDelayed(job: RevisionJob, delayMs: number): Promise<string | null>
  enqueueCreate(job: RevisionJob): Promise<string | null>
  cancelDelayed(documentId: string): Promise<void>
}

/** A production adapter uses its cross-instance marker (for example Redis). */
export interface CanonicalizationFailureMarker {
  mark(documentId: string, writePath: string): Promise<void>
  clear(documentId: string): Promise<void>
  peek(documentId: string): Promise<string | null>
}

export interface ClaimedInterval {
  readonly contributors: readonly string[]
  readonly attribution: unknown | null
}

/** Optional Yjs attribution integration. A claim is returned on insert failure. */
export interface IntervalPort {
  claim(documentId: string): Promise<ClaimedInterval>
  restore(documentId: string, interval: ClaimedInterval): Promise<void>
}

/**
 * flushAndReset gates new room loads, persists the current active Y.Doc before work,
 * runs work, then disconnects/broadcasts reset to ALL instances. The client must
 * discard its local Yjs cache before reconnecting to avoid merging old state back.
 */
export interface RoomReset {
  flushAndReset(documentId: string, reason: string, work: () => Promise<void>): Promise<void>
}

export interface V2StateCodec {
  decode(state: Uint8Array): { content: JSONContent; title?: string }
}

export interface EventPublisher {
  publish(event: { kind: 'revision.created' | 'revision.restored'; documentId: string; revisionId: string; version: number; actorId: string | null }): Promise<void>
}
