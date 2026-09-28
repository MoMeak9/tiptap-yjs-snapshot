import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import * as Y from 'yjs'
import { materialize, type Materialized } from './model'

type RevisionType = 'manual' | 'auto' | 'pre_restore'

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
  state: string
}

type StoredDocument = {
  schemaVersion: 1
  documentId: string
  epoch: number
  updatedAt: string
  state: string
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
const NOT_FOUND = 404

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

function revisionOf(stored: StoredDocument, type: RevisionType, name: string | null, value: Materialized): Revision {
  const ctime = Date.now()
  return {
    id: randomUUID(),
    documentId: stored.documentId,
    version: (stored.revisions.at(-1)?.version ?? 0) + 1,
    type,
    name,
    ctime,
    createdAt: new Date(ctime).toISOString(),
    title: value.title,
    contentHash: value.hash,
    state: stored.state,
  }
}

function summary(revision: Revision) {
  const { state: _state, ...fields } = revision
  return fields
}

function cursorVersion(raw: string | null): number | null {
  if (raw === null) return null
  try {
    const text = Buffer.from(raw, 'base64url').toString('utf8')
    if (!/^[1-9]\d*$/.test(text)) throw new Error('bad cursor')
    const value = Number(text)
    if (!Number.isSafeInteger(value)) throw new Error('bad cursor')
    return value
  } catch {
    throw new HttpError(BAD_REQUEST, 'Invalid cursor')
  }
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
    'access-control-allow-origin': 'http://127.0.0.1:5173',
  })
  response.end(JSON.stringify(body))
}

export async function startSnapshotServer(options: SnapshotServerOptions = {}): Promise<SnapshotServer> {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 3001
  const dataDir = options.dataDir ?? join(process.cwd(), '.data')
  const autoSnapshotIdleMs = options.autoSnapshotIdleMs ?? 1500
  if (!Number.isFinite(autoSnapshotIdleMs) || autoSnapshotIdleMs < 0) throw new Error('Invalid autoSnapshotIdleMs')
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
        stored = JSON.parse(await readFile(pathFor(id), 'utf8')) as StoredDocument
        if (stored.schemaVersion !== 1 || stored.documentId !== id || !Array.isArray(stored.revisions) ||
            typeof stored.state !== 'string' || !Number.isSafeInteger(stored.epoch)) {
          throw new Error('Unsupported or corrupt document file')
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const doc = new Y.Doc()
        stored = {
          schemaVersion: 1,
          documentId: id,
          epoch: 1,
          updatedAt: new Date().toISOString(),
          state: encode(doc),
          revisions: [],
        }
        return { doc, stored, clients: new Set<WebSocket>() }
      }
      const doc = new Y.Doc()
      Y.applyUpdateV2(doc, decodeUpdate(stored.state))
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

  function scheduleAuto(id: string, room: Room) {
    if (stopped) return
    if (room.autoTimer) clearTimeout(room.autoTimer)
    room.autoTimer = setTimeout(() => {
      room.autoTimer = undefined
      void serialize(id, async () => {
        if (stopped) return
        const value = materialize(room.doc)
        const latest = room.stored.revisions.at(-1)
        if (latest?.contentHash === value.hash && latest.title === value.title) return
        const revision = revisionOf(room.stored, 'auto', null, value)
        const next = { ...room.stored, revisions: [...room.stored.revisions, revision] }
        await persist(next)
        room.stored = next
      }).catch(error => console.error('Automatic revision failed:', error))
    }, autoSnapshotIdleMs)
  }

  async function handleHttp(request: IncomingMessage, response: ServerResponse) {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'access-control-allow-origin': 'http://127.0.0.1:5173',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
        })
        response.end()
        return
      }
      if (!url.pathname.startsWith('/api/revisions/')) throw new HttpError(NOT_FOUND, 'Not found')
      const id = documentId(url)
      const room = await roomFor(id)

      if (request.method === 'GET' && url.pathname === '/api/revisions/current') {
        const value = await serialize(id, async () => {
          const current = materialize(room.doc)
          return { documentId: id, title: current.title, content: current.content,
            contentHash: current.hash, epoch: room.stored.epoch, updatedAt: room.stored.updatedAt }
        })
        return send(response, 200, { code: 0, data: value })
      }

      if (request.method === 'GET' && url.pathname === '/api/revisions/list') {
        const rawLimit = url.searchParams.get('limit')
        const limit = rawLimit === null ? 20 : Number(rawLimit)
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HttpError(BAD_REQUEST, 'Invalid limit')
        const cursor = cursorVersion(url.searchParams.get('cursor'))
        const page = await serialize(id, async () => {
          const matching = [...room.stored.revisions].reverse()
            .filter(revision => cursor === null || revision.version < cursor)
          const selected = matching.slice(0, limit)
          const hasMore = matching.length > selected.length
          return {
            data: selected.map(summary),
            nextCursor: hasMore ? Buffer.from(String(selected.at(-1)!.version)).toString('base64url') : null,
            hasMore,
          }
        })
        return send(response, 200, { code: 0, data: page })
      }

      if (request.method === 'GET' && url.pathname === '/api/revisions/detail') {
        const revisionId = requiredId(url.searchParams.get('id'))
        const detail = await serialize(id, async () => {
          const revision = room.stored.revisions.find(item => item.id === revisionId)
          if (!revision) throw new HttpError(NOT_FOUND, 'Revision not found')
          const doc = new Y.Doc()
          try {
            Y.applyUpdateV2(doc, decodeUpdate(revision.state))
            const value = materialize(doc)
            return { ...summary(revision), title: value.title, content: value.content,
              contentHash: value.hash }
          } finally {
            doc.destroy()
          }
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
          const value = materialize(room.doc)
          const revision = revisionOf(room.stored, 'manual', name, value)
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
          try {
            Y.applyUpdateV2(replacement, decodeUpdate(target.state))
            materialize(replacement)
          } catch (error) {
            replacement.destroy()
            throw error
          }

          // This first atomic write must succeed before the current document is replaced.
          const before = materialize(room.doc)
          const backup = revisionOf(room.stored, 'pre_restore', null, before)
          const withBackup = { ...room.stored, revisions: [...room.stored.revisions, backup] }
          try {
            await persist(withBackup)
          } catch (error) {
            replacement.destroy()
            throw error
          }
          room.stored = withBackup

          const next: StoredDocument = {
            ...withBackup,
            state: encode(replacement),
            epoch: withBackup.epoch + 1,
            updatedAt: new Date().toISOString(),
          }
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
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      if (url.pathname !== '/collaboration') throw new HttpError(NOT_FOUND, 'Not found')
      id = documentId(url)
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wsServer.handleUpgrade(request, socket, head, ws => {
      void serialize(id, async () => {
        const room = await roomFor(id)
        if (stopped) return ws.close()
        room.clients.add(ws)
        ws.send(JSON.stringify({ type: 'sync', epoch: room.stored.epoch, update: encode(room.doc) }))
        ws.on('close', () => room.clients.delete(ws))
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
                materialize(candidate)
                const next: StoredDocument = {
                  ...room.stored,
                  state: encode(candidate),
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
