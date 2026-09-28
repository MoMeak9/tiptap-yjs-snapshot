import { createHash, randomInt } from 'node:crypto'
import type { JSONContent } from '@tiptap/core'
import type { Schema } from '@tiptap/pm/model'
import { CURRENT_SCHEMA_VERSION } from './canonical'
import { currentRevisionId, decodeRevisionCursor, encodeRevisionCursor, parseCurrentRevisionId } from './cursor'
import { buildDocumentHistoryFields, commitDocumentHistoryWrite, prepareDocumentHistoryWrite, type DocumentHistoryFields, type DocumentHistoryInput, type PreparedDocumentHistoryWrite } from './document-history'
import type {
  CanonicalizationFailureMarker, DocumentContext, DocumentRecord,
  DocumentStore, DocumentWriteClient, EventPublisher, IntervalPort, RevisionInsert, RevisionJob,
  RevisionListRow, RevisionRecord, RevisionSource, RevisionStore, RoomReset,
  Scheduler, V2StateCodec,
} from './ports'
import { yjsV2StateCodec } from './state-codec'

export class RevisionNotFoundError extends Error {
  constructor() { super('Revision not found'); this.name = 'RevisionNotFoundError' }
}

export class RevisionUnavailableError extends Error {
  constructor() { super('Revision has no complete V2 content and Yjs state'); this.name = 'RevisionUnavailableError' }
}

export class DocumentNotFoundError extends Error {
  constructor() { super('Document not found'); this.name = 'DocumentNotFoundError' }
}

export type MaterializeResult =
  | { kind: 'created'; revision: RevisionRecord }
  | { kind: 'duplicate'; afterLock: boolean }
  | { kind: 'stale_hash'; afterLock: boolean; writePath: string }
  | { kind: 'unavailable' }

export interface V2HistoryOptions {
  readonly schema: Schema
  readonly documents: DocumentStore
  readonly revisions: RevisionStore
  readonly scheduler: Scheduler
  readonly roomReset: RoomReset
  readonly stateCodec?: V2StateCodec
  readonly failureMarker?: CanonicalizationFailureMarker
  readonly interval?: IntervalPort
  readonly events?: EventPublisher
  readonly now?: () => Date
  readonly makeId?: () => string
  readonly delayedMs?: number
  readonly normalizeTitle?: (title: string) => string
  /** Optional identity enrichment; failures fall back to stable actor IDs. */
  readonly resolveDisplayNames?: (actorIds: readonly string[]) => Promise<ReadonlyMap<string, string>>
  readonly onEventError?: (kind: 'revision.created' | 'revision.restored', errorClass: string) => void
  readonly onMarkerError?: (operation: 'mark' | 'clear', errorClass: string) => void
}

const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'

export function generateRevisionId(): string {
  let id = 'r'
  for (let index = 0; index < 23; index += 1) id += alphabet[randomInt(alphabet.length)]
  return id
}

export function shouldCreateRevision(
  current: { contentHash: string; title: string },
  latest: { contentHash: string; title: string } | null,
): boolean {
  if (latest === null || !latest.contentHash) return true
  return latest.contentHash !== current.contentHash || latest.title !== current.title
}

function complete(document: DocumentRecord | null): document is DocumentRecord & { contentJson: string; state: Uint8Array } {
  return !!document && !document.deleted && !!document.contentHash && document.contentJson !== null && !!document.state?.byteLength
}

function insertFromDocument(
  document: DocumentRecord & { contentJson: string; state: Uint8Array },
  input: Pick<RevisionInsert, 'id' | 'type' | 'name' | 'createdBy' | 'contributors' | 'attribution' | 'materializedAt' | 'restoredFromRevisionId'>,
): RevisionInsert {
  return {
    ...input,
    documentId: document.id,
    title: document.title,
    contentJson: document.contentJson,
    contentHash: document.contentHash,
    schemaVersion: document.schemaVersion,
    sourceFormat: 'v2_json',
    state: new Uint8Array(document.state),
  }
}

function contextDocumentId(context: DocumentContext): string {
  if (!context.documentId) throw new DocumentNotFoundError()
  return context.documentId
}

export class V2HistoryService {
  private readonly codec: V2StateCodec
  private readonly now: () => Date
  private readonly makeId: () => string
  private readonly delayedMs: number
  private readonly normalizeTitle: (title: string) => string

  constructor(private readonly options: V2HistoryOptions) {
    this.codec = options.stateCodec ?? yjsV2StateCodec
    this.now = options.now ?? (() => new Date())
    this.makeId = options.makeId ?? generateRevisionId
    this.delayedMs = options.delayedMs ?? 5 * 60_000
    this.normalizeTitle = options.normalizeTitle ?? (title => title)
  }

  prepareWrite(input: DocumentHistoryInput): PreparedDocumentHistoryWrite {
    return prepareDocumentHistoryWrite(this.options.schema, input)
  }

  async commitWrite<T>(
    prepared: PreparedDocumentHistoryWrite,
    write: (fields: DocumentHistoryFields, client: DocumentWriteClient) => Promise<T>,
  ) {
    const result = await commitDocumentHistoryWrite(this.options.documents, prepared, write)
    try {
      if (result.degraded) await this.options.failureMarker?.mark(prepared.input.documentId, prepared.input.writePath)
      else if (!result.disabled) await this.options.failureMarker?.clear(prepared.input.documentId)
    } catch (error) {
      // The original document write has committed; a diagnostic marker outage
      // must not make callers retry that successful content write.
      this.options.onMarkerError?.(result.degraded ? 'mark' : 'clear', error instanceof Error ? error.name : 'UnknownError')
    }
    return result
  }

  /** Collaboration onStore hook: state and canonical JSON were already committed. */
  async scheduleDelayed(documentId: string, source: RevisionSource = 'auto'): Promise<string | null> {
    const job = { documentId, source, enqueuedAt: this.now().getTime() }
    return this.options.scheduler.enqueueDelayed(job, this.delayedMs)
  }

  /** Last disconnect: enqueue first, then cancel the delayed fallback only on success. */
  async scheduleImmediate(documentId: string, source: RevisionSource = 'auto'): Promise<string | null> {
    const job = { documentId, source, enqueuedAt: this.now().getTime() }
    const id = await this.options.scheduler.enqueueCreate(job)
    if (id !== null) await this.options.scheduler.cancelDelayed(documentId)
    return id
  }

  async processDelayed(job: RevisionJob): Promise<'superseded' | 'enqueued' | 'unavailable'> {
    const document = await this.options.documents.read(job.documentId)
    if (!document || document.deleted) return 'unavailable'
    if (document.mtime.getTime() > job.enqueuedAt) return 'superseded'
    const id = await this.options.scheduler.enqueueCreate(job)
    return id === null ? 'unavailable' : 'enqueued'
  }

  /**
   * Auto materialization has a cheap check followed by the authoritative check
   * under the same document lock used by persistence and revision insertion.
   */
  async materialize(job: RevisionJob): Promise<MaterializeResult> {
    const [fastDocument, fastLatest] = await Promise.all([
      this.options.documents.read(job.documentId),
      this.options.revisions.latest(job.documentId),
    ])
    if (!complete(fastDocument)) return { kind: 'unavailable' }
    if (!shouldCreateRevision(fastDocument, fastLatest)) {
      const stale = await this.options.failureMarker?.peek(job.documentId)
      return stale ? { kind: 'stale_hash', afterLock: false, writePath: stale } : { kind: 'duplicate', afterLock: false }
    }

    const interval = job.source === 'auto' ? await this.options.interval?.claim(job.documentId) : undefined
    let intervalMerged = false
    let restoreOnError = true
    try {
      const result = await this.options.documents.transaction(async tx => {
        const document = await tx.readForUpdate(job.documentId)
        if (!complete(document)) return { kind: 'unavailable' } as MaterializeResult
        const latest = await this.options.revisions.latest(job.documentId, tx)
        if (!shouldCreateRevision(document, latest)) {
          const stale = await this.options.failureMarker?.peek(job.documentId)
          if (stale) return { kind: 'stale_hash', afterLock: true, writePath: stale } as MaterializeResult
          if (interval && latest && this.options.revisions.mergeInterval) {
            await this.options.revisions.mergeInterval(latest.id, interval, tx)
            intervalMerged = true
          }
          return { kind: 'duplicate', afterLock: true } as MaterializeResult
        }
        const actor = document.lastModifiedBy || null
        const revision = await this.options.revisions.insert(insertFromDocument(document, {
          id: this.makeId(),
          type: job.source,
          name: null,
          createdBy: job.source === 'open_api' ? actor : null,
          contributors: interval?.contributors ?? [],
          attribution: job.source === 'open_api' && actor ? { kind: 'whole', author: actor } : interval?.attribution ?? null,
          materializedAt: this.now(),
          restoredFromRevisionId: null,
        }), tx)
        return { kind: 'created', revision } as MaterializeResult
      })
      if (interval && result.kind !== 'created' && !intervalMerged) {
        restoreOnError = false
        await this.options.interval?.restore(job.documentId, interval)
      }
      restoreOnError = false
      if (result.kind === 'created') await this.publish('revision.created', result.revision, fastDocument.lastModifiedBy)
      return result
    } catch (error) {
      if (interval && restoreOnError) await this.options.interval?.restore(job.documentId, interval)
      throw error
    }
  }

  /** Manual revisions are named bookmarks. They deliberately never deduplicate. */
  async createManual(context: DocumentContext, name?: string): Promise<RevisionRecord> {
    const documentId = contextDocumentId(context)
    const revision = await this.options.documents.transaction(async tx => {
      const document = await tx.readForUpdate(documentId)
      if (!complete(document)) throw new RevisionUnavailableError()
      return this.options.revisions.insert({ ...insertFromDocument(document, {
        id: this.makeId(), type: 'manual', name: name ?? null,
        createdBy: context.actorId || null, contributors: [], attribution: null,
        materializedAt: this.now(), restoredFromRevisionId: null,
      }), title: this.normalizeTitle(document.title) }, tx)
    })
    await this.publish('revision.created', revision, context.actorId ?? null)
    return revision
  }

  async list(context: DocumentContext, options: { cursor?: string; limit?: number } = {}) {
    const documentId = contextDocumentId(context)
    const limit = options.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('limit must be 1..100')
    const cursor = options.cursor === undefined ? null : decodeRevisionCursor(options.cursor)
    const rows = await this.options.revisions.list(documentId, cursor, limit + 1)
    const hasMore = rows.length > limit
    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    let names: ReadonlyMap<string, string> = new Map()
    if (this.options.resolveDisplayNames) {
      const ids = [...new Set(page.flatMap(row => [...row.contributors, ...(row.createdBy ? [row.createdBy] : [])]))]
      try { names = await this.options.resolveDisplayNames(ids) } catch { /* display fallback */ }
    }
    return {
      data: page.map(row => this.listItem(row, names)),
      hasMore,
      nextCursor: hasMore && last ? encodeRevisionCursor({ version: last.version, id: last.id }) : null,
    }
  }

  private listItem(row: RevisionListRow, names: ReadonlyMap<string, string>) {
    const person = (username: string) => ({ username, nickname: names.get(username)?.trim() || username })
    return {
      id: row.id, documentId: row.documentId, version: row.version,
      type: row.type, name: row.name, title: row.title, createdBy: row.createdBy,
      createdByUser: row.createdBy ? person(row.createdBy) : null,
      collaborators: row.contributors.map(person), ctime: row.ctime.getTime(),
      availability: row.deleted ? 'deleted' as const : row.contentPresent ? 'ready' as const : 'legacy_pending' as const,
      diffEligible: !row.deleted && row.contentPresent,
      restorable: !row.deleted && row.statePresent,
      restoredFromRevisionId: row.restoredFromRevisionId,
      restoredFromVersion: row.restoredFromVersion,
    }
  }

  async detail(context: DocumentContext, revisionId: string) {
    const documentId = contextDocumentId(context)
    const currentOf = parseCurrentRevisionId(revisionId)
    if (currentOf !== null) {
      if (currentOf !== documentId) throw new RevisionNotFoundError()
      const document = await this.options.documents.read(documentId)
      if (!document || document.deleted) throw new RevisionNotFoundError()
      return {
        id: currentRevisionId(documentId), documentId, version: -1, type: 'current' as const,
        name: null, title: document.title, createdBy: document.lastModifiedBy || null,
        createdByUser: document.lastModifiedBy ? { username: document.lastModifiedBy, nickname: document.lastModifiedBy } : null,
        collaborators: [], ctime: document.mtime.getTime(),
        availability: document.contentJson !== null ? 'ready' as const : 'legacy_pending' as const,
        diffEligible: document.contentJson !== null, restorable: false,
        content: document.contentJson === null ? null : JSON.parse(document.contentJson) as JSONContent,
        contentHash: document.contentJson === null ? null : document.contentHash || hashStoredJson(document.contentJson),
        attribution: null, decodedFromState: false,
      }
    }
    const row = await this.options.revisions.get(documentId, revisionId)
    if (!row) throw new RevisionNotFoundError()
    const names = await this.displayNames([...row.contributors, ...(row.createdBy ? [row.createdBy] : [])])
    const person = (username: string) => ({ username, nickname: names.get(username)?.trim() || username })
    return {
      id: row.id, documentId, version: row.version, type: row.type, name: row.name,
      title: row.title, createdBy: row.createdBy, createdByUser: row.createdBy ? person(row.createdBy) : null,
      collaborators: row.contributors.map(person),
      ctime: row.ctime.getTime(), availability: row.deleted ? 'deleted' as const : 'ready' as const,
      diffEligible: !row.deleted, restorable: !row.deleted && row.state.byteLength > 0,
      content: row.deleted ? null : JSON.parse(row.contentJson) as JSONContent,
      contentHash: row.deleted ? null : row.contentHash || hashStoredJson(row.contentJson),
      attribution: row.attribution, decodedFromState: false,
    }
  }

  private async displayNames(actorIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (!this.options.resolveDisplayNames || actorIds.length === 0) return new Map()
    try { return await this.options.resolveDisplayNames([...new Set(actorIds)]) }
    catch { return new Map() }
  }

  /**
   * Snapshot state remains the authority. The decoder only derives JSON/title;
   * storing a re-encoded Y.Doc would merge a different binary history.
   */
  async restore(context: DocumentContext, revisionId: string): Promise<{ id: string }> {
    const documentId = contextDocumentId(context)
    const target = await this.options.revisions.get(documentId, revisionId)
    if (!target || target.deleted) throw new RevisionNotFoundError()
    if (!target.state.byteLength) throw new RevisionUnavailableError()
    const decoded = this.codec.decode(target.state)
    const normalizedTitle = decoded.title === undefined ? undefined : this.normalizeTitle(decoded.title)
    const prepared = this.prepareWrite({
      documentId, writePath: 'snapshot_restore', persistenceV2Enabled: true,
      content: decoded.content, actor: context.actorId,
      ...(normalizedTitle === undefined ? {} : { title: normalizedTitle }),
    })
    if (prepared.degraded || !prepared.canonical) throw new RevisionUnavailableError()
    const reason = `snapshot restored to ${target.id}, reconnect required`
    let restored: RevisionRecord | undefined
    await this.options.roomReset.flushAndReset(documentId, reason, async () => {
      restored = await this.options.documents.transaction(async tx => {
        const locked = await tx.readForUpdate(documentId)
        if (!locked || locked.deleted) throw new DocumentNotFoundError()
        // The protection row and replacement use one locked baseline and one
        // transaction. A failed replacement rolls the protection row back too.
        if (locked.state?.byteLength) {
          const before = this.codec.decode(locked.state)
          const beforePrepared = this.prepareWrite({
            documentId, writePath: 'snapshot_restore', persistenceV2Enabled: true,
            content: before.content,
          })
          if (beforePrepared.degraded || !beforePrepared.canonical) throw new RevisionUnavailableError()
          const beforeTitle = before.title === undefined ? locked.title : this.normalizeTitle(before.title)
          const afterTitle = normalizedTitle ?? locked.title
          if (beforePrepared.canonical.contentHash !== prepared.canonical!.contentHash || beforeTitle !== afterTitle) {
          await this.options.revisions.insert({
            id: this.makeId(), type: 'pre_restore', name: null,
            documentId,
            title: beforeTitle,
            contentJson: beforePrepared.canonical.serialized,
            contentHash: beforePrepared.canonical.contentHash,
            schemaVersion: CURRENT_SCHEMA_VERSION,
            sourceFormat: 'v2_json',
            state: new Uint8Array(locked.state),
            createdBy: context.actorId || null, contributors: [], attribution: null,
            materializedAt: this.now(), restoredFromRevisionId: null,
          }, tx)
          }
        } else if (locked.contentJson !== null) {
          // The current JSON has no faithful binary backup. Do not replace it.
          throw new RevisionUnavailableError()
        }
        const { fields } = buildDocumentHistoryFields(prepared, locked)
        const updated = await tx.write(documentId, {
          state: new Uint8Array(target.state),
          ...(normalizedTitle === undefined ? {} : { title: normalizedTitle }),
          ...fields,
        })
        if (!complete(updated)) throw new RevisionUnavailableError()
        return this.options.revisions.insert(insertFromDocument(updated, {
          id: this.makeId(), type: 'restore', name: null,
          createdBy: context.actorId || null, contributors: [],
          attribution: context.actorId ? { kind: 'whole', author: context.actorId } : null,
          materializedAt: this.now(), restoredFromRevisionId: target.id,
        }), tx)
      })
    })
    try { await this.options.failureMarker?.clear(documentId) }
    catch (error) { this.options.onMarkerError?.('clear', error instanceof Error ? error.name : 'UnknownError') }
    if (!restored) throw new RevisionUnavailableError()
    await this.publish('revision.restored', restored, context.actorId ?? null)
    // The HTTP wire echoes the requested target, not the new audit row.
    return { id: target.id }
  }

  private async publish(kind: 'revision.created' | 'revision.restored', revision: RevisionRecord, actorId: string | null | undefined) {
    if (!this.options.events) return
    try {
      await this.options.events.publish({ kind, documentId: revision.documentId, revisionId: revision.id, version: revision.version, actorId: actorId ?? null })
    } catch (error) {
      // The row has already committed. Re-throwing invites retries and duplicates.
      this.options.onEventError?.(kind, error instanceof Error ? error.name : 'UnknownError')
    }
  }
}

function hashStoredJson(serialized: string): string {
  return createHash('sha256').update(serialized, 'utf8').digest('hex')
}
