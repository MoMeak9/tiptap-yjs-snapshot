import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TiptapTransformer } from '@hocuspocus/transformer'
import StarterKit from '@tiptap/starter-kit'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { startSnapshotServer, type SnapshotServer } from '../server'

const servers: SnapshotServer[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(idleMs = 50) {
  const dataDir = await mkdtemp(join(tmpdir(), 'snapshot-reference-'))
  directories.push(dataDir)
  const server = await startSnapshotServer({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    autoSnapshotIdleMs: idleMs,
  })
  servers.push(server)
  return { server, dataDir, base: `http://127.0.0.1:${server.port}` }
}

async function api(base: string, path: string, init?: RequestInit) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  return { status: response.status, body: await response.json() }
}

async function openSocket(port: number, docId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/collaboration?doc_id=${encodeURIComponent(docId)}`)
  const sync = await new Promise<{ type: string; epoch: number; update: string }>((resolve, reject) => {
    ws.once('message', raw => resolve(JSON.parse(raw.toString())))
    ws.once('error', reject)
  })
  expect(sync.type).toBe('sync')
  return { ws, sync }
}

async function eventually<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const value = await read()
    if (accepts(value)) return value
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  throw new Error('Timed out waiting for persisted document state')
}

function ydoc(text: string, title: string) {
  const doc = TiptapTransformer.toYdoc(
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
    'default',
    [StarterKit],
  )
  doc.getText('title').insert(0, title)
  return doc
}

function sendUpdate(ws: WebSocket, epoch: number, doc: Y.Doc) {
  ws.send(JSON.stringify({
    type: 'update',
    epoch,
    update: Buffer.from(Y.encodeStateAsUpdateV2(doc)).toString('base64'),
  }))
}

describe('snapshot reference server', () => {
  it('does not create an auto revision when an untouched client disconnects', async () => {
    const { server, base, dataDir } = await fixture(20)
    const { ws } = await openSocket(server.port, 'untouched')
    ws.close()
    await new Promise(resolve => ws.once('close', resolve))
    await new Promise(resolve => setTimeout(resolve, 50))
    const list = await api(base, '/api/revisions/list?doc_id=untouched')
    expect(list.body.data.data).toEqual([])
    expect(await readdir(dataDir)).toEqual([])
  })

  it('increments revisionCount only for semantic document changes, including restore', async () => {
    const { server, base, dataDir } = await fixture(60_000)
    const { ws, sync } = await openSocket(server.port, 'counted')
    const source = ydoc('Body', 'First')
    sendUpdate(ws, sync.epoch, source)
    await eventually(() => api(base, '/api/revisions/detail?doc_id=counted&id=current-counted'),
      result => result.body.data?.title === 'First')
    const file = join(dataDir, (await readdir(dataDir))[0])
    const stored = async () => JSON.parse(await readFile(file, 'utf8'))
    expect((await stored()).revisionCount).toBe(1)

    const peer = await openSocket(server.port, 'counted')
    const broadcast = new Promise(resolve => peer.ws.once('message', resolve))
    sendUpdate(ws, sync.epoch, source)
    await broadcast
    expect((await stored()).revisionCount).toBe(1)
    const saved = await api(base, '/api/revisions/create?doc_id=counted', { method: 'POST', body: '{}' })
    expect((await stored()).revisionCount).toBe(1)

    source.getText('title').delete(0, source.getText('title').length)
    source.getText('title').insert(0, 'Second')
    sendUpdate(ws, sync.epoch, source)
    await eventually(() => api(base, '/api/revisions/detail?doc_id=counted&id=current-counted'),
      result => result.body.data?.title === 'Second')
    expect((await stored()).revisionCount).toBe(2)
    await api(base, '/api/revisions/restore?doc_id=counted', {
      method: 'POST', body: JSON.stringify({ id: saved.body.data.id }),
    })
    expect((await stored()).revisionCount).toBe(3)
    await api(base, '/api/revisions/restore?doc_id=counted', {
      method: 'POST', body: JSON.stringify({ id: saved.body.data.id }),
    })
    expect((await stored()).revisionCount).toBe(3)
    peer.ws.close()
  })

  it('retries a failed last-client materialization while the durable pending task remains', async () => {
    const { server, base, dataDir } = await fixture(60_000)
    const { ws, sync } = await openSocket(server.port, 'retry')
    sendUpdate(ws, sync.epoch, ydoc('Retry me', 'Retry title'))
    await eventually(() => api(base, '/api/revisions/detail?doc_id=retry&id=current-retry'),
      result => result.body.data?.title === 'Retry title')

    const file = join(dataDir, (await readdir(dataDir))[0])
    const backup = `${file}.bak`
    await rename(file, backup)
    await mkdir(file)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      ws.close()
      await new Promise(resolve => ws.once('close', resolve))
      await eventually(async () => errors.mock.calls.some(call =>
        String(call[0]).includes('Disconnect revision failed')), value => value)
      expect(JSON.parse(await readFile(backup, 'utf8')).pendingAutoAt).toEqual(expect.any(Number))
      await rm(file, { recursive: true })
      await rename(backup, file)
      await eventually(() => api(base, '/api/revisions/list?doc_id=retry'),
        result => result.body.data?.data?.length === 1)
      expect(JSON.parse(await readFile(file, 'utf8')).pendingAutoAt).toBeNull()
    } finally {
      errors.mockRestore()
      if ((await readdir(dataDir)).some(name => name.endsWith('.bak'))) {
        await rm(file, { recursive: true, force: true })
        await rename(backup, file)
      }
    }
  })

  it('persists current V2 fields and a recoverable delayed revision task before auto materialization', async () => {
    const { server, base, dataDir } = await fixture(60_000)
    const { ws, sync } = await openSocket(server.port, 'v2-durable')
    sendUpdate(ws, sync.epoch, ydoc('Durable body', 'Durable title'))
    await eventually(() => api(base, '/api/revisions/detail?doc_id=v2-durable&id=current-v2-durable'),
      result => result.body.data?.title === 'Durable title')

    const files = await readdir(dataDir)
    expect(files).toHaveLength(1)
    const stored = JSON.parse(await readFile(join(dataDir, files[0]), 'utf8'))
    expect(stored).toMatchObject({
      fileVersion: 2,
      schemaVersion: 1,
      title: 'Durable title',
      content: { type: 'doc' },
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      pendingAutoAt: expect.any(Number),
    })
    const virtual = await api(base, '/api/revisions/detail?doc_id=v2-durable&id=current-v2-durable')
    expect(virtual.body.data).toMatchObject({
      id: 'current-v2-durable', version: -1, type: 'current',
      availability: 'ready', diffEligible: true, restorable: false,
      decodedFromState: false,
    })
    expect((await api(base, '/api/revisions/detail?doc_id=v2-durable&id=current-other')).status).toBe(404)
    ws.close()
    await new Promise(resolve => ws.once('close', resolve))
    await eventually(() => api(base, '/api/revisions/list?doc_id=v2-durable'),
      result => result.body.data?.data?.length === 1)
    const revised = JSON.parse(await readFile(join(dataDir, files[0]), 'utf8'))
    expect(revised.pendingAutoAt).toBeNull()
    expect(revised.revisions[0]).toMatchObject({
      sourceFormat: 'v2_json', schemaVersion: 1, title: 'Durable title',
      content: stored.content, contentHash: stored.contentHash,
    })
  })

  it('recovers a pending delayed task after restart and uses V2 cursor and list metadata', async () => {
    const { server, base, dataDir } = await fixture(200)
    const { ws, sync } = await openSocket(server.port, 'recover')
    sendUpdate(ws, sync.epoch, ydoc('Recover me', 'Recover'))
    await eventually(() => api(base, '/api/revisions/detail?doc_id=recover&id=current-recover'),
      result => result.body.data?.title === 'Recover')
    await server.close()
    servers.splice(servers.indexOf(server), 1)
    ws.terminate()

    const restarted = await startSnapshotServer({ host: '127.0.0.1', port: 0, dataDir, autoSnapshotIdleMs: 200 })
    servers.push(restarted)
    const restartedBase = `http://127.0.0.1:${restarted.port}`
    const page = await eventually(() => api(restartedBase, '/api/revisions/list?doc_id=recover'),
      result => result.body.data?.data?.length === 1)
    expect(page.body.data.data[0]).toMatchObject({
      availability: 'ready', diffEligible: true, restorable: true,
      ctime: expect.any(Number), restoredFromVersion: null,
    })
    const manual = await api(restartedBase, '/api/revisions/create?doc_id=recover', { method: 'POST', body: '{}' })
    const first = await api(restartedBase, '/api/revisions/list?doc_id=recover&limit=1')
    expect(first.body.data.nextCursor).toBe(Buffer.from(`v2:${manual.body.data.version}:${manual.body.data.id}`).toString('base64url'))
    const second = await api(restartedBase, `/api/revisions/list?doc_id=recover&limit=1&cursor=${first.body.data.nextCursor}`)
    expect(second.body.data.data).toHaveLength(1)
    expect((await api(restartedBase, '/api/revisions/list?doc_id=recover&cursor=MQ')).status).toBe(400)
  })

  it('writes restore audit metadata and only backs up a changed current document', async () => {
    const { server, base, dataDir } = await fixture(60_000)
    const { ws, sync } = await openSocket(server.port, 'audit')
    const source = ydoc('A', 'First')
    sendUpdate(ws, sync.epoch, source)
    await eventually(() => api(base, '/api/revisions/detail?doc_id=audit&id=current-audit'), r => r.body.data?.title === 'First')
    const saved = await api(base, '/api/revisions/create?doc_id=audit', { method: 'POST', body: '{}' })
    source.getText('title').delete(0, source.getText('title').length)
    source.getText('title').insert(0, 'Second')
    const body = source.getXmlFragment('default')
    body.delete(0, body.length)
    const changed = ydoc('B', 'Second').getXmlFragment('default').toArray()
      .filter((node): node is Y.XmlElement | Y.XmlText => node instanceof Y.XmlElement || node instanceof Y.XmlText)
      .map(node => node.clone())
    body.insert(0, changed)
    sendUpdate(ws, sync.epoch, source)
    await eventually(() => api(base, '/api/revisions/detail?doc_id=audit&id=current-audit'), r => r.body.data?.title === 'Second')
    const restore = await api(base, '/api/revisions/restore?doc_id=audit', {
      method: 'POST', body: JSON.stringify({ id: saved.body.data.id }),
    })
    expect(restore.body.data).toEqual({ id: saved.body.data.id })
    const list = await api(base, '/api/revisions/list?doc_id=audit')
    expect(list.body.data.data.map((r: { type: string }) => r.type)).toEqual(['restore', 'pre_restore', 'manual'])
    expect(list.body.data.data[0].restoredFromVersion).toBe(saved.body.data.version)
    const detail = await api(base, `/api/revisions/detail?doc_id=audit&id=${list.body.data.data[0].id}`)
    expect(detail.body.data).toMatchObject({ content: { type: 'doc' }, decodedFromState: false })
    const files = await readdir(dataDir)
    const stored = JSON.parse(await readFile(join(dataDir, files[0]), 'utf8'))
    expect(stored.revisions.at(-1).restoredFromSnapshotId).toBe(saved.body.data.id)
    expect(stored.revisions.at(-1).state).toBe(stored.revisions[0].state)

    const same = await api(base, '/api/revisions/restore?doc_id=audit', {
      method: 'POST', body: JSON.stringify({ id: saved.body.data.id }),
    })
    expect(same.body.data).toEqual({ id: saved.body.data.id })
    const repeated = await api(base, '/api/revisions/list?doc_id=audit')
    expect(repeated.body.data.data.filter((r: { type: string }) => r.type === 'pre_restore')).toHaveLength(1)
    expect(repeated.body.data.data.filter((r: { type: string }) => r.type === 'restore')).toHaveLength(2)
  })

  it('reads a legacy V1 revision through bounded lazy V2 state decoding', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'snapshot-legacy-'))
    directories.push(dataDir)
    const doc = ydoc('Old body', 'Old title')
    const id = 'legacy'
    const revisionId = '11111111-1111-1111-1111-111111111111'
    const invalidId = '22222222-2222-2222-2222-222222222222'
    const state = Buffer.from(Y.encodeStateAsUpdateV2(doc)).toString('base64')
    const path = join(dataDir, `${createHash('sha256').update(id).digest('hex')}.json`)
    await writeFile(path, JSON.stringify({
      schemaVersion: 1, documentId: id, epoch: 1, updatedAt: new Date().toISOString(),
      state, revisions: [{ id: revisionId, documentId: id, version: 1, type: 'manual', name: null,
        ctime: Date.now(), createdAt: new Date().toISOString(), title: 'Old title', contentHash: '', state },
      { id: invalidId, documentId: id, version: 2, type: 'manual', name: null,
        ctime: Date.now(), createdAt: new Date().toISOString(), title: 'Broken', contentHash: '', state: 'AAAA' }],
    }))
    const server = await startSnapshotServer({ host: '127.0.0.1', port: 0, dataDir })
    servers.push(server)
    const base = `http://127.0.0.1:${server.port}`
    const before = await api(base, '/api/revisions/list?doc_id=legacy')
    expect(before.body.data.data.find((r: { id: string }) => r.id === revisionId))
      .toMatchObject({ availability: 'legacy_pending', diffEligible: false, restorable: true })
    const detail = await api(base, `/api/revisions/detail?doc_id=legacy&id=${revisionId}`)
    expect(detail.body.data).toMatchObject({ availability: 'ready', decodedFromState: true,
      content: { type: 'doc' }, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    const invalid = await api(base, `/api/revisions/detail?doc_id=legacy&id=${invalidId}`)
    expect(invalid.body.data).toMatchObject({ availability: 'legacy_failed', diffEligible: false,
      content: null, contentHash: null, restorable: false })
    expect((await api(base, '/api/revisions/restore?doc_id=legacy', {
      method: 'POST', body: JSON.stringify({ id: invalidId }),
    })).status).toBe(400)
    expect((await api(base, '/api/revisions/list?doc_id=legacy')).body.data.data
      .find((r: { id: string }) => r.id === invalidId).restorable).toBe(false)
    const migrated = JSON.parse(await readFile(path, 'utf8'))
    expect(migrated.revisionCount).toBe(0)
    expect(migrated.revisions[0].content).toEqual(detail.body.data.content)
    expect(migrated.revisions[1].migrationStatus).toBe('failed')
  })

  it('persists a V2 collaboration update and creates only one idle revision for identical semantic content', async () => {
    const { server, base, dataDir } = await fixture(35)
    const { ws, sync } = await openSocket(server.port, 'alpha')
    const source = ydoc('Hello snapshot', 'Draft')
    sendUpdate(ws, sync.epoch, source)

    const current = await eventually(
      () => api(base, '/api/revisions/current?doc_id=alpha'),
      result => result.body.data?.title === 'Draft',
    )
    expect(current.status).toBe(200)
    expect(current.body.data.content).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello snapshot' }] }],
    })
    expect(current.body.data.contentHash).toMatch(/^[a-f0-9]{64}$/)

    await eventually(
      () => api(base, '/api/revisions/list?doc_id=alpha'),
      result => result.body.data?.data?.length === 1,
    )
    sendUpdate(ws, sync.epoch, source)
    await new Promise(resolve => setTimeout(resolve, 100))
    const list = await api(base, '/api/revisions/list?doc_id=alpha')
    expect(list.body.data.data).toHaveLength(1)
    expect(list.body.data.data[0].type).toBe('auto')

    source.getText('title').delete(0, source.getText('title').length)
    source.getText('title').insert(0, 'Retitled')
    sendUpdate(ws, sync.epoch, source)
    await eventually(
      () => api(base, '/api/revisions/list?doc_id=alpha'),
      result => result.body.data?.data?.length === 2,
    )
    const retitled = await api(base, '/api/revisions/list?doc_id=alpha')
    expect(retitled.body.data.data[0].title).toBe('Retitled')
    expect(retitled.body.data.data[0].contentHash).toBe(retitled.body.data.data[1].contentHash)

    const files = await readdir(dataDir)
    expect(files).toHaveLength(1)
    const stored = JSON.parse(await readFile(join(dataDir, files[0]), 'utf8'))
    const restored = new Y.Doc()
    Y.applyUpdateV2(restored, Buffer.from(stored.state, 'base64'))
    expect(TiptapTransformer.fromYdoc(restored, 'default')).toEqual(current.body.data.content)
    expect(restored.getText('title').toString()).toBe('Retitled')
    ws.close()
  })

  it('allows identical manual revisions, paginates them, and scopes details to the document', async () => {
    const { server, base } = await fixture(60_000)
    const { ws, sync } = await openSocket(server.port, 'alpha')
    sendUpdate(ws, sync.epoch, ydoc('Version one', 'Document A'))
    await eventually(() => api(base, '/api/revisions/current?doc_id=alpha'), r => r.body.data?.title === 'Document A')

    const first = await api(base, '/api/revisions/create?doc_id=alpha', {
      method: 'POST', body: JSON.stringify({ name: 'Save one' }),
    })
    const second = await api(base, '/api/revisions/create?doc_id=alpha', {
      method: 'POST', body: JSON.stringify({ name: 'Save two' }),
    })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(first.body.data.id).not.toBe(second.body.data.id)
    const firstDetail = await api(base, `/api/revisions/detail?doc_id=alpha&id=${first.body.data.id}`)
    const secondDetail = await api(base, `/api/revisions/detail?doc_id=alpha&id=${second.body.data.id}`)
    expect(firstDetail.body.data.contentHash).toBe(secondDetail.body.data.contentHash)

    const page = await api(base, '/api/revisions/list?doc_id=alpha&limit=1')
    expect(page.body.data.data).toHaveLength(1)
    expect(page.body.data.hasMore).toBe(true)
    expect(page.body.data.data[0].ctime).toEqual(expect.any(Number))
    const next = await api(base, `/api/revisions/list?doc_id=alpha&limit=1&cursor=${page.body.data.nextCursor}`)
    expect(next.body.data.data).toHaveLength(1)
    expect(next.body.data.data[0].id).not.toBe(page.body.data.data[0].id)
    expect(next.body.data.hasMore).toBe(false)

    const detail = await api(base, `/api/revisions/detail?doc_id=alpha&id=${first.body.data.id}`)
    expect(detail.body.data).toMatchObject({
      title: 'Document A',
      name: 'Save one',
      type: 'manual',
      ctime: expect.any(Number),
      content: { type: 'doc' },
    })
    expect((await api(base, `/api/revisions/detail?doc_id=other&id=${first.body.data.id}`)).status).toBe(404)
    ws.close()
  })

  it('backs up live state before restore, resets peers, rejects an old epoch, and survives restart', async () => {
    const { server, base, dataDir } = await fixture(60_000)
    const { ws, sync } = await openSocket(server.port, 'alpha')
    sendUpdate(ws, sync.epoch, ydoc('Before', 'Old title'))
    await eventually(() => api(base, '/api/revisions/current?doc_id=alpha'), r => r.body.data?.title === 'Old title')
    const saved = await api(base, '/api/revisions/create?doc_id=alpha', {
      method: 'POST', body: JSON.stringify({ name: 'Good version' }),
    })

    const after = ydoc('After', 'New title')
    // A fresh connection starts from the persisted document and carries the same epoch.
    const peer = await openSocket(server.port, 'alpha')
    const client = new Y.Doc()
    Y.applyUpdateV2(client, Buffer.from(peer.sync.update, 'base64'))
    client.getText('title').delete(0, client.getText('title').length)
    client.getText('title').insert(0, 'New title')
    client.getXmlFragment('default').delete(0, client.getXmlFragment('default').length)
    const replacement = after.getXmlFragment('default').toArray()
      .filter((node): node is Y.XmlElement | Y.XmlText => node instanceof Y.XmlElement || node instanceof Y.XmlText)
      .map(node => node.clone())
    client.getXmlFragment('default').insert(0, replacement)
    const broadcast = new Promise<{ type: string; epoch: number }>(resolve => ws.once('message', raw => resolve(JSON.parse(raw.toString()))))
    sendUpdate(peer.ws, peer.sync.epoch, client)
    expect(await broadcast).toMatchObject({ type: 'update', epoch: sync.epoch })
    await eventually(() => api(base, '/api/revisions/current?doc_id=alpha'), r => r.body.data?.title === 'New title')

    const resetEvent = new Promise<unknown>(resolve => ws.on('message', raw => {
      const message = JSON.parse(raw.toString())
      if (message.event === 'document.reset') resolve(message)
    }))
    const closed = new Promise<{ code: number; reason: string }>(resolve => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
    const restore = await api(base, '/api/revisions/restore?doc_id=alpha', {
      method: 'POST', body: JSON.stringify({ id: saved.body.data.id }),
    })
    expect(restore.status).toBe(200)
    expect((await api(base, '/api/revisions/current?doc_id=alpha')).body.data.epoch).toBeGreaterThan(sync.epoch)
    expect(await resetEvent).toMatchObject({ event: 'document.reset' })
    expect(await closed).toEqual({ code: 4205, reason: 'document.reset' })

    const list = await api(base, '/api/revisions/list?doc_id=alpha')
    const backup = list.body.data.data.find((item: { type: string }) => item.type === 'pre_restore')
    expect(backup).toBeDefined()
    const backupDetail = await api(base, `/api/revisions/detail?doc_id=alpha&id=${backup.id}`)
    expect(backupDetail.body.data.title).toBe('New title')
    expect(backupDetail.body.data.content.content[0].content[0].text).toBe('After')
    const current = await api(base, '/api/revisions/current?doc_id=alpha')
    expect(current.body.data.title).toBe('Old title')
    expect(current.body.data.content).toEqual((await api(base, `/api/revisions/detail?doc_id=alpha&id=${saved.body.data.id}`)).body.data.content)

    const stale = await openSocket(server.port, 'alpha')
    sendUpdate(stale.ws, sync.epoch, after)
    await new Promise(resolve => stale.ws.once('close', resolve))
    expect((await api(base, '/api/revisions/current?doc_id=alpha')).body.data.title).toBe('Old title')

    await server.close()
    servers.splice(servers.indexOf(server), 1)
    const restarted = await startSnapshotServer({ host: '127.0.0.1', port: 0, dataDir, autoSnapshotIdleMs: 60_000 })
    servers.push(restarted)
    const durable = await api(`http://127.0.0.1:${restarted.port}`, '/api/revisions/current?doc_id=alpha')
    expect(durable.body.data.title).toBe('Old title')
    expect(durable.body.data.epoch).toBeGreaterThan(sync.epoch)
    peer.ws.close()
  })

  it('rejects missing ids, malformed updates, and foreign revision restores', async () => {
    const { server, base } = await fixture(60_000)
    expect((await api(base, '/api/revisions/current')).status).toBe(200)
    expect((await api(base, '/api/revisions/list?doc_id=alpha&limit=wat')).status).toBe(400)
    expect((await api(base, '/api/revisions/create?doc_id=alpha', { method: 'POST', body: JSON.stringify({ name: 1 }) })).status).toBe(400)
    const created = await api(base, '/api/revisions/create?doc_id=alpha', { method: 'POST', body: '{}' })
    expect(created.status).toBe(200)
    expect((await api(base, '/api/revisions/restore?doc_id=other', {
      method: 'POST', body: JSON.stringify({ id: created.body.data.id }),
    })).status).toBe(404)

    const { ws, sync } = await openSocket(server.port, 'alpha')
    ws.send(JSON.stringify({ type: 'update', epoch: sync.epoch, update: 'bad!!!' }))
    await new Promise(resolve => ws.once('close', resolve))
    expect((await api(base, '/api/revisions/current?doc_id=alpha')).body.data.title).toBe('')
  })
})
