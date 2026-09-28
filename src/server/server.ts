import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import * as Y from 'yjs'
import { currentRevisionId, decodeRevisionCursor, encodeRevisionCursor } from '../../packages/v2-core/src/cursor'
import { shouldCreateRevision } from '../../packages/v2-core/src/service'
import { CONTENT_SCHEMA_VERSION, materialize, type Materialized } from './model'

type RevisionType = 'manual' | 'auto' | 'pre_restore' | 'restore'

type Revision = {
  id: string
  documentId: string
  version: number
  type: RevisionType
  name: string | null
  ctime: number
  createdAt: string
  title: string
  contentHash: string
  content: Record<string, unknown>
  schemaVersion: number
  sourceFormat: 'v2_json'
  state: string
  restoredFromSnapshotId: string | null
}

type StoredDocument = {
  /** Version of this local file adapter, separate from the editor schema. */
  fileVersion: 2
  schemaVersion: number
  sourceFormat: 'v2_json'
  documentId: string
  epoch: number
  updatedAt: string
  state: string
  title: string
  content: Record<string, unknown>
  contentHash: string
  /** Counts semantic title/body writes, independent of history row count. */
  revisionCount: number
  /** Durable delayed job. A restart can resume it without a process-local timer. */
  pendingAutoAt: number | null
  revisions: Revision[]
}

type Room = {
  doc: Y.Doc
  stored: StoredDocument
  clients: Set<WebSocket>
  autoTimer?: ReturnType<typeof setTimeout>
}

export type SnapshotServerOptions = {
  host?: string
  port?: number
  dataDir?: string
  autoSnapshotIdleMs?: number
  allowedOrigins?: string[]
}

export type SnapshotServer = {
  port: number
  close: () => Promise<void>
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

const BAD_REQUEST = 400
const FORBIDDEN = 403
const CONFLICT = 409
const NOT_FOUND = 404
const UNSUPPORTED_MEDIA_TYPE = 415
const HASH_PATTERN = /^[a-f0-9]{64}$/
const REVISION_ID_PATTERN = /^[0-9a-f-]{36}$/
const DEFAULT_FRONTEND_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173']

function isBrowserOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.origin === value && url.pathname === '/' && !url.search && !url.hash &&
      !url.username && !url.password
  } catch {
    return false
  }
}

function allowedOrigin(request: IncomingMessage, allowedOrigins: ReadonlySet<string>): string | null {
  const origin = request.headers.origin
  return origin !== undefined && allowedOrigins.has(origin) ? origin : null
}

function requireAllowedBrowserOrigin(request: IncomingMessage, allowedOrigins: ReadonlySet<string>): void {
  if (request.headers.origin !== undefined && allowedOrigin(request, allowedOrigins) === null) {
    throw new HttpError(FORBIDDEN, 'Origin is not allowed')
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNativeRevision(value: unknown, id: string): value is Revision {
  if (!isObject(value)) return false
  return typeof value.id === 'string' && REVISION_ID_PATTERN.test(value.id) &&
    value.documentId === id && Number.isSafeInteger(value.version) && (value.version as number) >= 0 &&
    ['manual', 'auto', 'pre_restore', 'restore'].includes(String(value.type)) &&
    (value.name === null || typeof value.name === 'string') &&
    Number.isSafeInteger(value.ctime) && typeof value.createdAt === 'string' &&
    typeof value.title === 'string' && typeof value.contentHash === 'string' &&
    HASH_PATTERN.test(value.contentHash) && isObject(value.content) &&
    value.schemaVersion === CONTENT_SCHEMA_VERSION && value.sourceFormat === 'v2_json' &&
    typeof value.state === 'string' && value.state.length > 0 &&
    (value.restoredFromSnapshotId === null ||
      (typeof value.restoredFromSnapshotId === 'string' && REVISION_ID_PATTERN.test(value.restoredFromSnapshotId)))
}

function isNativeStored(value: unknown, id: string): value is StoredDocument {
  if (!isObject(value)) return false
  return value.fileVersion === 2 && value.schemaVersion === CONTENT_SCHEMA_VERSION &&
    value.sourceFormat === 'v2_json' && value.documentId === id &&
    Number.isSafeInteger(value.epoch) && (value.epoch as number) >= 1 &&
    typeof value.updatedAt === 'string' && typeof value.state === 'string' && value.state.length > 0 &&
    typeof value.title === 'string' && isObject(value.content) &&
    typeof value.contentHash === 'string' && HASH_PATTERN.test(value.contentHash) &&
    Number.isSafeInteger(value.revisionCount) && (value.revisionCount as number) >= 0 &&
    (value.pendingAutoAt === null || (Number.isSafeInteger(value.pendingAutoAt) &&
      (value.pendingAutoAt as number) >= 0)) &&
    Array.isArray(value.revisions) && value.revisions.every(item => isNativeRevision(item, id))
}

function documentId(url: URL): string {
  const value = url.searchParams.get('doc_id') ?? 'demo'
  if (!value || value.length > 128 || !/^[\p{L}\p{N}._:-]+$/u.test(value)) {
    throw new HttpError(BAD_REQUEST, 'Invalid doc_id')
  }
  return value
}

function requiredId(value: string | null | undefined): string {
  if (!value || !/^[0-9a-f-]{36}$/.test(value)) throw new HttpError(BAD_REQUEST, 'Invalid revision id')
  return value
}

function decodeUpdate(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32 * 1024 * 1024 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new HttpError(BAD_REQUEST, 'Invalid V2 update')
  }
  return Buffer.from(value, 'base64')
}

function encode(doc: Y.Doc): string {
  return Buffer.from(Y.encodeStateAsUpdateV2(doc)).toString('base64')
}

function clone(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc()
  Y.applyUpdateV2(copy, Y.encodeStateAsUpdateV2(doc))
  return copy
}

function revisionOf(stored: StoredDocument, type: RevisionType, name: string | null,
  restoredFromSnapshotId: string | null = null): Revision {
  const ctime = Math.max(Date.now(), (stored.revisions.at(-1)?.ctime ?? 0) + 1)
  const lastVersion = stored.revisions.reduce((maximum, item) => Math.max(maximum, item.version), -1)
  return {
    id: randomUUID(),
    documentId: stored.documentId,
    version: lastVersion + 1,
    type,
    name,
    ctime,
    createdAt: new Date(ctime).toISOString(),
    title: stored.title,
    contentHash: stored.contentHash,
    content: stored.content,
    schemaVersion: stored.schemaVersion,
    sourceFormat: 'v2_json',
    state: stored.state,
    restoredFromSnapshotId,
  }
}

function summary(revision: Revision, revisions: Revision[]) {
  const { state: _state, content: _content, createdAt: _createdAt,
    schemaVersion: _schemaVersion,
    sourceFormat: _sourceFormat,
    restoredFromSnapshotId: _restoredFromSnapshotId, ...fields } = revision
  return { ...fields, createdBy: null, createdByUser: null, collaborators: [],
    availability: 'ready' as const, diffEligible: true, restorable: Boolean(revision.state),
    restoredFromVersion: revision.restoredFromSnapshotId === null ? null
      : revisions.find(item => item.id === revision.restoredFromSnapshotId)?.version ?? null }
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.length
    if (length > 64 * 1024) throw new HttpError(BAD_REQUEST, 'Request body is too large')
    chunks.push(bytes)
  }
  try {
    const input = Buffer.concat(chunks).toString('utf8')
    const value: unknown = input ? JSON.parse(input) : {}
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid body')
    return value as Record<string, unknown>
  } catch {
    throw new HttpError(BAD_REQUEST, 'Invalid JSON object')
  }
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

export async function startSnapshotServer(options: SnapshotServerOptions = {}): Promise<SnapshotServer> {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 3001
  const dataDir = options.dataDir ?? join(process.cwd(), '.data', 'v2-oss')
  const autoSnapshotIdleMs = options.autoSnapshotIdleMs ?? 1500
  if (!Number.isFinite(autoSnapshotIdleMs) || autoSnapshotIdleMs < 0) throw new Error('Invalid autoSnapshotIdleMs')
  const configuredOrigins = options.allowedOrigins ?? DEFAULT_FRONTEND_ORIGINS
  if (!Array.isArray(configuredOrigins) || configuredOrigins.length === 0 ||
      !configuredOrigins.every(isBrowserOrigin)) throw new Error('Invalid allowedOrigins')
  const allowedOrigins = new Set(configuredOrigins)
  await mkdir(dataDir, { recursive: true })

  const rooms = new Map<string, Promise<Room>>()
  const writes = new Map<string, Promise<void>>()
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 24 * 1024 * 1024 })
  let stopped = false

  function pathFor(id: string): string {
    return join(dataDir, `${createHash('sha256').update(id).digest('hex')}.json`)
  }

  async function persist(stored: StoredDocument): Promise<void> {
    const destination = pathFor(stored.documentId)
    const temporary = `${destination}.${randomUUID()}.tmp`
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(JSON.stringify(stored))
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(temporary, destination)
    } catch (error) {
      await handle?.close().catch(() => {})
      await unlink(temporary).catch(() => {})
      throw error
    }
  }

  async function roomFor(id: string): Promise<Room> {
    const cached = rooms.get(id)
    if (cached) return cached
    const loading = (async () => {
      let stored: StoredDocument
      try {
        const raw: unknown = JSON.parse(await readFile(pathFor(id), 'utf8'))
        if (!isNativeStored(raw, id)) throw new HttpError(CONFLICT, 'Unsupported local document file')
        stored = raw
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          if (error instanceof HttpError) throw error
          throw new HttpError(CONFLICT, 'Unsupported local document file')
        }
        const doc = new Y.Doc()
        const current = materialize(doc)
        stored = {
          fileVersion: 2,
          schemaVersion: CONTENT_SCHEMA_VERSION,
          sourceFormat: 'v2_json',
          documentId: id,
          epoch: 1,
          updatedAt: new Date().toISOString(),
          state: encode(doc),
          title: current.title,
          content: current.content,
          contentHash: current.hash,
          revisionCount: 0,
          pendingAutoAt: null,
          revisions: [],
        }
        return { doc, stored, clients: new Set<WebSocket>() }
      }
      const doc = new Y.Doc()
      try {
        Y.applyUpdateV2(doc, decodeUpdate(stored.state))
      } catch {
        doc.destroy()
        throw new HttpError(CONFLICT, 'Unsupported local document file')
      }
      return { doc, stored, clients: new Set<WebSocket>() }
    })()
    rooms.set(id, loading)
    loading.catch(() => { if (rooms.get(id) === loading) rooms.delete(id) })
    return loading
  }

  // Every mutation of a given room, including active WebSocket updates, uses this queue.
  function serialize<T>(id: string, action: () => Promise<T>): Promise<T> {
    const before = writes.get(id) ?? Promise.resolve()
    const result = before.then(action)
    const settled = result.then(() => {}, () => {})
    writes.set(id, settled)
    settled.then(() => { if (writes.get(id) === settled) writes.delete(id) })
    return result
  }

  async function materializeAuto(room: Room): Promise<void> {
    const latest = [...room.stored.revisions]
      .sort((a, b) => b.version - a.version || b.id.localeCompare(a.id))[0]
    if (!shouldCreateRevision(room.stored, latest ?? null)) {
      if (room.stored.pendingAutoAt !== null) {
        const next = { ...room.stored, pendingAutoAt: null }
        await persist(next)
        room.stored = next
      }
      return
    }
    const revision = revisionOf(room.stored, 'auto', null)
    const next: StoredDocument = { ...room.stored, pendingAutoAt: null,
      revisions: [...room.stored.revisions, revision] }
    await persist(next)
    room.stored = next
  }

  function scheduleAuto(id: string, room: Room) {
    if (stopped) return
    if (room.autoTimer) clearTimeout(room.autoTimer)
    if (room.stored.pendingAutoAt === null) return
    room.autoTimer = setTimeout(() => {
      room.autoTimer = undefined
      void serialize(id, async () => {
        if (stopped) return
        if (room.stored.pendingAutoAt !== null && room.stored.pendingAutoAt <= Date.now()) {
          await materializeAuto(room)
        }
      }).then(() => {
        if (!stopped && room.stored.pendingAutoAt !== null) scheduleAuto(id, room)
      }).catch(error => {
        console.error('Automatic revision failed:', error)
        if (!stopped) room.autoTimer = setTimeout(() => scheduleAuto(id, room), 1000)
      })
    }, Math.max(0, room.stored.pendingAutoAt - Date.now()))
  }

  function retryDisconnectAuto(id: string, room: Room, expectedPendingAt: number | null) {
    if (stopped) return
    if (room.autoTimer) clearTimeout(room.autoTimer)
    room.autoTimer = setTimeout(() => {
      room.autoTimer = undefined
      void serialize(id, async () => {
        if (stopped) return
        if (room.stored.pendingAutoAt !== expectedPendingAt) {
          // A later edit superseded this disconnect. Its delayed task owns the
          // new state and should keep its own deadline.
          scheduleAuto(id, room)
          return
        }
        await materializeAuto(room)
      }).catch(error => {
        console.error('Disconnect revision retry failed:', error)
        retryDisconnectAuto(id, room, expectedPendingAt)
      })
    }, 1000)
  }

  async function handleHttp(request: IncomingMessage, response: ServerResponse) {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        requireAllowedBrowserOrigin(request, allowedOrigins)
      }
      const origin = allowedOrigin(request, allowedOrigins)
      if (origin !== null) response.setHeader('access-control-allow-origin', origin)
      response.setHeader('vary', 'Origin')
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
        })
        response.end()
        return
      }
      if (request.method === 'POST' &&
          request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        throw new HttpError(UNSUPPORTED_MEDIA_TYPE, 'Content-Type must be application/json')
      }
      if (!url.pathname.startsWith('/api/revisions/')) throw new HttpError(NOT_FOUND, 'Not found')
      const id = documentId(url)
      const room = await roomFor(id)

      if (request.method === 'GET' && url.pathname === '/api/revisions/list') {
        const rawLimit = url.searchParams.get('limit')
        const limit = rawLimit === null ? 20 : Number(rawLimit)
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HttpError(BAD_REQUEST, 'Invalid limit')
        const rawCursor = url.searchParams.get('cursor')
        let cursor: ReturnType<typeof decodeRevisionCursor> | null = null
        if (rawCursor !== null) {
          try {
            cursor = decodeRevisionCursor(rawCursor)
          } catch {
            throw new HttpError(BAD_REQUEST, 'Invalid cursor')
          }
        }
        const page = await serialize(id, async () => {
          const matching = [...room.stored.revisions]
            .sort((a, b) => b.version - a.version || b.id.localeCompare(a.id))
            .filter(revision => cursor === null || revision.version < cursor.version ||
              (revision.version === cursor.version && revision.id < cursor.id))
          const selected = matching.slice(0, limit)
          const hasMore = matching.length > selected.length
          return {
            data: selected.map(revision => summary(revision, room.stored.revisions)),
            nextCursor: hasMore ? encodeRevisionCursor({ version: selected.at(-1)!.version, id: selected.at(-1)!.id }) : null,
            hasMore,
          }
        })
        return send(response, 200, { code: 0, data: page })
      }

      if (request.method === 'GET' && url.pathname === '/api/revisions/detail') {
        const rawId = url.searchParams.get('id')
        const currentId = currentRevisionId(id)
        if (rawId?.startsWith('current-') && rawId !== currentId) {
          throw new HttpError(NOT_FOUND, 'Revision not found')
        }
        const revisionId = rawId === currentId ? rawId : requiredId(rawId)
        const detail = await serialize(id, async () => {
          if (revisionId === currentId) {
            return {
              id: revisionId, documentId: id, version: -1, name: null,
              title: room.stored.title, createdBy: null, createdByUser: null,
              type: 'current', collaborators: [], restoredFromVersion: null,
              ctime: Date.parse(room.stored.updatedAt), availability: 'ready',
              diffEligible: true, restorable: false, content: room.stored.content,
              contentHash: room.stored.contentHash, decodedFromState: false,
              attribution: null,
            }
          }
          const revision = room.stored.revisions.find(item => item.id === revisionId)
          if (!revision) throw new HttpError(NOT_FOUND, 'Revision not found')
          return { ...summary(revision, room.stored.revisions),
            content: revision.content, contentHash: revision.contentHash,
            decodedFromState: false, attribution: null }
        })
        return send(response, 200, { code: 0, data: detail })
      }

      if (request.method === 'POST' && url.pathname === '/api/revisions/create') {
        const body = await jsonBody(request)
        const name = body.name === undefined ? null : body.name
        if (name !== null && (typeof name !== 'string' || name.length > 100)) {
          throw new HttpError(BAD_REQUEST, 'Invalid revision name')
        }
        const created = await serialize(id, async () => {
          const revision = revisionOf(room.stored, 'manual', name)
          const next = { ...room.stored, revisions: [...room.stored.revisions, revision] }
          await persist(next)
          room.stored = next
          return { id: revision.id, version: revision.version }
        })
        return send(response, 200, { code: 0, data: created })
      }

      if (request.method === 'POST' && url.pathname === '/api/revisions/restore') {
        const body = await jsonBody(request)
        const revisionId = requiredId(typeof body.id === 'string' ? body.id : null)
        const restored = await serialize(id, async () => {
          const target = room.stored.revisions.find(item => item.id === revisionId)
          if (!target) throw new HttpError(NOT_FOUND, 'Revision not found')
          const replacement = new Y.Doc()
          let targetValue: Materialized
          try {
            Y.applyUpdateV2(replacement, decodeUpdate(target.state))
            targetValue = materialize(replacement)
          } catch {
            replacement.destroy()
            throw new HttpError(BAD_REQUEST, 'Revision state cannot be restored')
          }

          // Build the backup (only for a semantic change), replacement current
          // fields, and the restore audit row in one atomic file replacement.
          const changed = shouldCreateRevision(
            { contentHash: targetValue.hash, title: targetValue.title }, room.stored)
          const withBackup: StoredDocument = changed ? {
            ...room.stored,
            revisions: [...room.stored.revisions, revisionOf(room.stored, 'pre_restore', null)],
          } : room.stored
          const replaced: StoredDocument = {
            ...withBackup,
            state: target.state,
            title: targetValue.title,
            content: targetValue.content,
            contentHash: targetValue.hash,
            schemaVersion: CONTENT_SCHEMA_VERSION,
            revisionCount: withBackup.revisionCount + (changed ? 1 : 0),
            pendingAutoAt: null,
            epoch: withBackup.epoch + 1,
            updatedAt: new Date().toISOString(),
          }
          const audit = revisionOf(replaced, 'restore', null, target.id)
          const next: StoredDocument = { ...replaced, revisions: [...replaced.revisions, audit] }
          try {
            await persist(next)
          } catch (error) {
            replacement.destroy()
            throw error
          }
          const previous = room.doc
          room.doc = replacement
          room.stored = next
          if (room.autoTimer) clearTimeout(room.autoTimer)
          room.autoTimer = undefined
          previous.destroy()
          for (const peer of room.clients) {
            if (peer.readyState === WebSocket.OPEN) {
              peer.send(JSON.stringify({ event: 'document.reset', reason: 'snapshot.restore', epoch: next.epoch }))
              peer.close(4205, 'document.reset')
            }
          }
          room.clients.clear()
          return { id: target.id }
        })
        return send(response, 200, { code: 0, data: restored })
      }
      throw new HttpError(NOT_FOUND, 'Not found')
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      const message = error instanceof HttpError ? error.message : 'Internal server error'
      if (status === 500) console.error('Revision request failed:', error)
      if (!response.headersSent) send(response, status, { code: status, message })
    }
  }

  const httpServer = createServer((request, response) => { void handleHttp(request, response) })
  httpServer.on('upgrade', (request, socket, head) => {
    let id: string
    try {
      requireAllowedBrowserOrigin(request, allowedOrigins)
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      if (url.pathname !== '/collaboration') throw new HttpError(NOT_FOUND, 'Not found')
      id = documentId(url)
    } catch (error) {
      const forbidden = error instanceof HttpError && error.status === FORBIDDEN
      socket.end(`HTTP/1.1 ${forbidden ? '403 Forbidden' : '400 Bad Request'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      return
    }
    wsServer.handleUpgrade(request, socket, head, ws => {
      void serialize(id, async () => {
        const room = await roomFor(id)
        if (stopped) return ws.close()
        room.clients.add(ws)
        ws.send(JSON.stringify({ type: 'sync', epoch: room.stored.epoch, update: encode(room.doc) }))
        let disconnectPendingAt: number | null = null
        ws.on('close', () => {
          void serialize(id, async () => {
            room.clients.delete(ws)
            if (stopped || room.clients.size !== 0) return
            // Only a durable document write may trigger an auto revision.
            if (room.stored.pendingAutoAt === null) return
            if (room.autoTimer) clearTimeout(room.autoTimer)
            room.autoTimer = undefined
            disconnectPendingAt = room.stored.pendingAutoAt
            await materializeAuto(room)
          }).catch(error => {
            console.error('Disconnect revision failed:', error)
            // The pending job is still on disk. Retry the immediate close job
            // after a bounded pause; the usual delayed deadline may be far away.
            if (disconnectPendingAt !== null) retryDisconnectAuto(id, room, disconnectPendingAt)
          })
        })
        ws.on('message', raw => {
          void serialize(id, async () => {
            if (ws.readyState !== WebSocket.OPEN) return
            let message: { type?: unknown; epoch?: unknown; update?: unknown }
            try {
              message = JSON.parse(raw.toString()) as typeof message
              if (message.type !== 'update' || !Number.isSafeInteger(message.epoch)) {
                throw new HttpError(BAD_REQUEST, 'Invalid update message')
              }
              if (message.epoch !== room.stored.epoch) {
                ws.close(4205, 'document.reset')
                return
              }
              const update = decodeUpdate(message.update)
              const candidate = clone(room.doc)
              try {
                Y.applyUpdateV2(candidate, update)
                const value = materialize(candidate)
                const next: StoredDocument = {
                  ...room.stored,
                  state: encode(candidate),
                  title: value.title,
                  content: value.content,
                  contentHash: value.hash,
                  schemaVersion: CONTENT_SCHEMA_VERSION,
                  revisionCount: room.stored.revisionCount +
                    (shouldCreateRevision({ contentHash: value.hash, title: value.title }, room.stored) ? 1 : 0),
                  pendingAutoAt: Date.now() + autoSnapshotIdleMs,
                  updatedAt: new Date().toISOString(),
                }
                await persist(next)
                const previous = room.doc
                room.doc = candidate
                room.stored = next
                previous.destroy()
                for (const peer of room.clients) {
                  if (peer !== ws && peer.readyState === WebSocket.OPEN) {
                    peer.send(JSON.stringify({ type: 'update', epoch: next.epoch, update: message.update }))
                  }
                }
                scheduleAuto(id, room)
              } catch (error) {
                candidate.destroy()
                throw error
              }
            } catch (error) {
              if (error instanceof HttpError || error instanceof SyntaxError) {
                ws.close(1007, 'invalid update')
              } else {
                console.error('Collaboration update failed:', error)
                ws.close(1011, 'update failed')
              }
            }
          }).catch(error => console.error('Collaboration queue failed:', error))
        })
      }).catch(error => {
        console.error('Collaboration connection failed:', error)
        ws.close(1011, 'document load failed')
      })
    })
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject)
      resolve()
    })
  })
  const address = httpServer.address()
  if (!address || typeof address === 'string') throw new Error('Unexpected server address')

  // This adapter's delayed jobs live in each document file. Recover them at
  // process start even when nobody opens the document again.
  for (const entry of await readdir(dataDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue
    try {
      const raw = JSON.parse(await readFile(join(dataDir, entry.name), 'utf8')) as { documentId?: unknown }
      if (typeof raw.documentId !== 'string' || pathFor(raw.documentId) !== join(dataDir, entry.name)) continue
      const room = await roomFor(raw.documentId)
      scheduleAuto(raw.documentId, room)
    } catch (error) {
      console.error('Revision recovery failed:', error)
    }
  }

  return {
    port: address.port,
    async close() {
      if (stopped) return
      stopped = true
      for (const pending of rooms.values()) {
        const room = await pending
        if (room.autoTimer) clearTimeout(room.autoTimer)
        for (const client of room.clients) client.terminate()
      }
      wsServer.close()
      await new Promise<void>((resolve, reject) => {
        httpServer.close(error => error ? reject(error) : resolve())
      })
      await Promise.all(writes.values())
      for (const pending of rooms.values()) {
        const room = await pending
        if (room.autoTimer) clearTimeout(room.autoTimer)
        room.doc.destroy()
      }
    },
  }
}
