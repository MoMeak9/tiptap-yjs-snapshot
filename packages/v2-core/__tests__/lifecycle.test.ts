import { describe, expect, it } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import StarterKit from '@tiptap/starter-kit'
import { TiptapTransformer } from '@hocuspocus/transformer'
import * as Y from 'yjs'
import { createRevisionApiClient } from '../../revision-history/src/api/revision-api-client'
import {
  buildCanonicalContent, commitDocumentHistoryWrite, currentRevisionId,
  prepareDocumentHistoryWrite, V2HistoryService,
  type DocumentPatch, type DocumentRecord, type DocumentStore,
  type DocumentTransaction, type RevisionInsert, type RevisionListRow,
  type RevisionRecord, type RevisionStore,
} from '../src/index'

const schema = new Schema({
  nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*', attrs: { align: { default: 'left' }, meta: { default: {} } } }, text: {} },
  marks: { strong: {} },
})

const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'before' }] }] }
const canonical = buildCanonicalContent(schema, body)
function yState(text: string, title: string): Uint8Array {
  const doc = TiptapTransformer.toYdoc({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }, 'default', [StarterKit])
  doc.getText('title').insert(0, title)
  const update = Y.encodeStateAsUpdateV2(doc)
  doc.destroy()
  return update
}
const state = yState('before', 'Before')

function document(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: 'doc-public', title: 'Before', contentJson: canonical.serialized,
    contentHash: canonical.contentHash, schemaVersion: 1, revisionCount: 1,
    state, mtime: new Date('2026-01-01T00:00:00.000Z'), lastModifiedBy: 'author-a', deleted: false,
    ...overrides,
  }
}

class Memory implements DocumentStore, RevisionStore {
  current = document()
  rows: RevisionRecord[] = []
  private tail: Promise<void> = Promise.resolve()
  onFirstLock?: () => Promise<void>
  readLocks = 0
  transactions = 0

  async read(id: string) { return id === this.current.id ? this.current : null }
  async write(id: string, patch: DocumentPatch) {
    if (id !== this.current.id) throw new Error('document missing')
    this.current = { ...this.current, ...patch, revisionCount: this.current.revisionCount + (patch.revisionCountIncrement ?? 0), mtime: patch.mtime ?? new Date(this.current.mtime.getTime() + 1) }
    return this.current
  }
  async transaction<T>(work: (tx: DocumentTransaction) => Promise<T>): Promise<T> {
    this.transactions += 1
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise(resolve => { release = resolve })
    await previous
    const beforeDocument = this.current
    const beforeRows = [...this.rows]
    try {
      return await work({
        readForUpdate: async id => {
          this.readLocks += 1
          if (this.readLocks === 1 && this.onFirstLock) await this.onFirstLock()
          return this.read(id)
        },
        write: (id, patch) => this.write(id, patch),
      })
    } catch (error) {
      this.current = beforeDocument
      this.rows = beforeRows
      throw error
    } finally { release() }
  }
  async latest(documentId: string) {
    return this.rows.filter(row => row.documentId === documentId && !row.deleted).sort((a, b) => b.version - a.version || b.id.localeCompare(a.id))[0] ?? null
  }
  async get(documentId: string, revisionId: string) {
    return this.rows.find(row => row.documentId === documentId && row.id === revisionId) ?? null
  }
  async list(documentId: string, cursor: { version: number; id: string } | null, limit: number): Promise<readonly RevisionListRow[]> {
    return this.rows
      .filter(row => row.documentId === documentId && !row.deleted && (!cursor || row.version < cursor.version || (row.version === cursor.version && row.id < cursor.id)))
      .sort((a, b) => b.version - a.version || b.id.localeCompare(a.id))
      .slice(0, limit)
      .map(row => ({
        id: row.id, documentId: row.documentId, version: row.version, type: row.type,
        name: row.name, title: row.title, createdBy: row.createdBy,
        contributors: row.contributors, ctime: row.ctime, deleted: row.deleted,
        restoredFromRevisionId: row.restoredFromRevisionId,
        restoredFromVersion: row.restoredFromRevisionId === null ? null : this.rows.find(source => source.id === row.restoredFromRevisionId)?.version ?? null,
        contentPresent: !!row.contentJson, statePresent: row.state.byteLength > 0,
      }))
  }
  async insert(input: RevisionInsert, _tx: DocumentTransaction): Promise<RevisionRecord> {
    const rows = this.rows.filter(row => row.documentId === input.documentId)
    const version = rows.length ? Math.max(...rows.map(row => row.version)) + 1 : 0
    const latestTime = rows.length ? Math.max(...rows.map(row => row.ctime.getTime())) : -Infinity
    const ctime = new Date(Math.max(input.materializedAt.getTime(), latestTime + 1))
    const row: RevisionRecord = { ...input, version, ctime, mtime: ctime, deleted: false }
    this.rows.push(row)
    return row
  }
}

function service(memory: Memory, options: { roomReset?: { flushAndReset: (id: string, reason: string, work: () => Promise<void>) => Promise<void> }; makeId?: () => string } = {}) {
  let next = 0
  const scheduled: Array<{ kind: string; documentId: string }> = []
  const api = new V2HistoryService({
    schema, documents: memory, revisions: memory,
    scheduler: {
      enqueueDelayed: async job => { scheduled.push({ kind: 'delayed', documentId: job.documentId }); return 'job-delayed' },
      enqueueCreate: async job => { scheduled.push({ kind: 'create', documentId: job.documentId }); return 'job-create' },
      cancelDelayed: async documentId => { scheduled.push({ kind: 'cancel', documentId }) },
    },
    roomReset: options.roomReset ?? { flushAndReset: async (_id, _reason, work) => { await work() } },
    makeId: options.makeId ?? (() => `r${++next}`),
    now: () => new Date('2026-02-01T00:00:00.000Z'),
  })
  return { api, scheduled }
}

describe('V2 persistence and materialization', () => {
  it('keeps mtime and revisionCount for metadata-only writes, then counts title changes once', async () => {
    const memory = new Memory()
    const prepared = prepareDocumentHistoryWrite(schema, { documentId: memory.current.id, writePath: 'collaboration_store', persistenceV2Enabled: true, title: 'Before', actor: 'author-b' })
    const original = memory.current.mtime
    const same = await commitDocumentHistoryWrite(memory, prepared, (fields, client) => client.write(memory.current.id, fields))
    expect(same.businessChanged).toBe(false)
    expect(memory.current.revisionCount).toBe(1)
    expect(memory.current.mtime).toEqual(original)
    expect(memory.current.lastModifiedBy).toBe('author-a')

    const changed = prepareDocumentHistoryWrite(schema, { documentId: memory.current.id, writePath: 'open_api_title_update', persistenceV2Enabled: true, title: 'After', actor: 'author-b' })
    const committed = await commitDocumentHistoryWrite(memory, changed, (fields, client) => client.write(memory.current.id, { title: 'After', ...fields }))
    expect(committed.businessChanged).toBe(true)
    expect(memory.current.revisionCount).toBe(2)
    expect(memory.current.lastModifiedBy).toBe('author-b')
  })

  it('handles schema drift with tolerant JSON but degrades malformed JSON without advancing the hash', () => {
    const unknown = prepareDocumentHistoryWrite(schema, {
      documentId: 'doc-public', writePath: 'collaboration_store', persistenceV2Enabled: true,
      content: { type: 'doc', content: [{ type: 'customBlock', attrs: { z: 1, a: 2 } }] },
    })
    expect(unknown.degraded).toBe(false)
    expect(unknown.unknownTypes?.nodeTypes).toEqual(['customBlock'])
    expect(unknown.canonical?.serialized).toContain('customBlock')
    const invalid = prepareDocumentHistoryWrite(schema, {
      documentId: 'doc-public', writePath: 'collaboration_store', persistenceV2Enabled: true,
      content: { type: 'doc', content: [{ type: 'text' }] },
    })
    expect(invalid.degraded).toBe(true)
    expect(invalid.canonical).toBeUndefined()
  })

  it('deduplicates two jobs after the document lock even when both passed the fast check', async () => {
    const memory = new Memory()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const firstLock = new Promise<void>(resolve => { entered = resolve })
    memory.onFirstLock = async () => { entered(); await gate }
    const { api } = service(memory)
    const job = { documentId: 'doc-public', source: 'auto' as const, enqueuedAt: Date.now() }
    const first = api.materialize(job)
    await firstLock
    const second = api.materialize(job)
    await Promise.resolve()
    release()
    const results = await Promise.all([first, second])
    expect(results.map(result => result.kind).sort()).toEqual(['created', 'duplicate'])
    expect(memory.rows).toHaveLength(1)
    expect(memory.readLocks).toBe(2)
  })

  it('creates two manual bookmarks, lists metadata without state, and isolates current detail by document', async () => {
    const memory = new Memory()
    const { api } = service(memory)
    await api.createManual({ documentId: 'doc-public', actorId: 'author-a' }, 'First')
    await api.createManual({ documentId: 'doc-public', actorId: 'author-a' }, 'Second')
    expect(memory.rows.map(row => row.version)).toEqual([0, 1])
    expect(memory.rows.every(row => row.sourceFormat === 'v2_json')).toBe(true)
    const page = await api.list({ documentId: 'doc-public' }, { limit: 1 })
    expect(page.hasMore).toBe(true)
    expect(page.data[0].name).toBe('Second')
    expect(page.data[0].collaborators).toEqual([])
    expect('state' in page.data[0]).toBe(false)
    expect((await api.list({ documentId: 'doc-public' }, { limit: 1, cursor: page.nextCursor! })).data[0].name).toBe('First')
    const current = await api.detail({ documentId: 'doc-public' }, currentRevisionId('doc-public'))
    expect(current.version).toBe(-1)
    await expect(api.detail({ documentId: 'doc-other' }, currentRevisionId('doc-public'))).rejects.toThrow('Revision not found')
  })

  it('uses the source V2 availability wire label when current JSON is not materialized', async () => {
    const memory = new Memory()
    memory.current = document({ contentJson: null, contentHash: '' })
    const { api } = service(memory)
    const current = await api.detail({ documentId: 'doc-public' }, currentRevisionId('doc-public'))
    expect(current.availability).toBe('legacy_pending')
    expect(current.diffEligible).toBe(false)
    expect(current.content).toBeNull()
  })

  it('feeds list and detail wire responses into the ported frontend API client', async () => {
    const memory = new Memory()
    const { api } = service(memory)
    const created = await api.createManual({ documentId: 'doc-public', actorId: 'author-a' }, 'Saved')
    memory.rows[0] = { ...memory.rows[0], contributors: ['author-b'] }
    const client = createRevisionApiClient({
      documentId: 'doc-public', servicePrefix: 'https://example.test/api',
      auth: { getToken: () => 'test-token', applyTokenEnvelope: () => {} },
      fetchImpl: (async input => {
        const url = new URL(String(input))
        const data = url.pathname.endsWith('/list')
          ? await api.list({ documentId: 'doc-public' }, { limit: 20 })
          : await api.detail({ documentId: 'doc-public' }, url.searchParams.get('id') ?? '')
        return new Response(JSON.stringify({ code: 0, data }), { status: 200 })
      }) as typeof fetch,
    })
    const page = await client.list({ cursor: null, limit: 20, signal: new AbortController().signal })
    expect(page.items[0].createdByUser).toEqual({ username: 'author-a', nickname: 'author-a' })
    expect(page.items[0].collaborators).toEqual([{ username: 'author-b', nickname: 'author-b' }])
    expect(page.items[0].availability).toBe('ready')
    const detail = await client.getDetail({ revisionId: created.id, signal: new AbortController().signal })
    expect(detail.contentHash).toBe(canonical.contentHash)
    expect(detail.decodedFromState).toBe(false)
  })

  it('never advertises restoration for a zero-byte state', async () => {
    const memory = new Memory()
    memory.rows.push({
      id: 'r-empty', documentId: 'doc-public', version: 0, type: 'manual', name: null,
      title: 'Empty binary', contentJson: canonical.serialized, contentHash: canonical.contentHash,
      schemaVersion: 1, sourceFormat: 'v2_json', state: new Uint8Array(0),
      createdBy: null, contributors: [], attribution: null,
      ctime: new Date(), mtime: new Date(), deleted: false, restoredFromRevisionId: null,
    })
    const { api } = service(memory)
    expect((await api.list({ documentId: 'doc-public' })).data[0].restorable).toBe(false)
    expect((await api.detail({ documentId: 'doc-public' }, 'r-empty')).restorable).toBe(false)
    await expect(api.restore({ documentId: 'doc-public' }, 'r-empty')).rejects.toThrow('no complete V2 content')
  })

  it('skips a delayed job superseded by a newer document mtime', async () => {
    const memory = new Memory()
    const { api, scheduled } = service(memory)
    expect(await api.processDelayed({ documentId: 'doc-public', source: 'auto', enqueuedAt: memory.current.mtime.getTime() - 1 })).toBe('superseded')
    expect(scheduled).toEqual([])
  })

  it('restores the original Yjs V2 bytes, protects the prior state, and records an audit revision', async () => {
    const memory = new Memory()
    const targetContent = buildCanonicalContent(schema, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'after' }] }] })
    const targetState = yState('after', 'After')
    await memory.transaction(async tx => memory.insert({
      id: 'r-target', documentId: 'doc-public', type: 'manual', name: 'Target',
      title: 'After', contentJson: targetContent.serialized, contentHash: targetContent.contentHash,
      schemaVersion: 1, sourceFormat: 'v2_json', state: targetState, createdBy: 'author-b', contributors: [],
      attribution: null, materializedAt: new Date('2026-01-20T00:00:00.000Z'),
      restoredFromRevisionId: null,
    }, tx))
    const resets: string[] = []
    const { api } = service(memory, { roomReset: {
      flushAndReset: async (_id, reason, work) => { resets.push(reason); await work() },
    } })
    const transactionsBeforeRestore = memory.transactions
    const result = await api.restore({ documentId: 'doc-public', actorId: 'restorer' }, 'r-target')
    expect(memory.transactions - transactionsBeforeRestore).toBe(1)
    expect([...memory.current.state!]).toEqual([...targetState])
    expect(memory.current.title).toBe('After')
    expect(memory.current.contentHash).toBe(targetContent.contentHash)
    expect(memory.rows.map(row => row.type)).toEqual(['manual', 'pre_restore', 'restore'])
    expect(memory.rows[1].contentHash).toBe(canonical.contentHash)
    expect(result).toEqual({ id: 'r-target' })
    expect(memory.rows[2].restoredFromRevisionId).toBe('r-target')
    expect(memory.rows[2].attribution).toEqual({ kind: 'whole', author: 'restorer' })
    expect(resets).toEqual(['snapshot restored to r-target, reconnect required'])
    const listedAudit = (await api.list({ documentId: 'doc-public' })).data[0]
    expect(listedAudit.restoredFromVersion).toBe(0)
  })

  it('rolls back protection and replacement together when restore audit insertion fails', async () => {
    const memory = new Memory()
    const targetContent = buildCanonicalContent(schema, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'after' }] }] })
    const targetState = yState('after', 'After')
    await memory.transaction(async tx => memory.insert({
      id: 'r-target', documentId: 'doc-public', type: 'manual', name: null,
      title: 'After', contentJson: targetContent.serialized, contentHash: targetContent.contentHash,
      schemaVersion: 1, sourceFormat: 'v2_json', state: targetState,
      createdBy: null, contributors: [], attribution: null,
      materializedAt: new Date(), restoredFromRevisionId: null,
    }, tx))
    const originalInsert = memory.insert.bind(memory)
    memory.insert = async (input, tx) => {
      if (input.type === 'restore') throw new Error('audit insert unavailable')
      return originalInsert(input, tx)
    }
    let resetBroadcast = false
    const { api } = service(memory, { roomReset: {
      flushAndReset: async (_id, _reason, work) => { await work(); resetBroadcast = true },
    } })
    await expect(api.restore({ documentId: 'doc-public' }, 'r-target')).rejects.toThrow('audit insert unavailable')
    expect(memory.rows.map(row => row.id)).toEqual(['r-target'])
    expect(memory.current.contentHash).toBe(canonical.contentHash)
    expect([...memory.current.state!]).toEqual([...state])
    expect(resetBroadcast).toBe(false)
  })
})
