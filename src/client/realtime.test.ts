import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

import { createRealtimeSession, type SocketLike } from './realtime'

class FakeSocket implements SocketLike {
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []
  close = vi.fn(() => { this.readyState = 3 })

  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  disconnect(code: number) {
    this.readyState = 3
    this.onclose?.({ code })
  }

  send(message: string) {
    this.sent.push(message)
  }
}

function encoded(doc: Y.Doc) {
  return Buffer.from(Y.encodeStateAsUpdateV2(doc)).toString('base64')
}

function sourceDoc(title: string) {
  const doc = new Y.Doc()
  doc.getText('title').insert(0, title)
  doc.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')])
  return doc
}

describe('real-time snapshot lifecycle', () => {
  it('hydrates title and default body from a V2 sync without echoing it', () => {
    const socket = new FakeSocket()
    const statuses: string[] = []
    const session = createRealtimeSession({
      docId: 'demo',
      socketFactory: () => socket,
      onStatus: (status) => statuses.push(status),
      onReset: vi.fn(),
    })

    const source = sourceDoc('first title')
    socket.receive({ type: 'sync', epoch: 7, update: encoded(source) })

    expect(session.doc.getText('title').toString()).toBe('first title')
    expect(session.doc.getXmlFragment('default').length).toBe(1)
    expect(socket.sent).toEqual([])
    expect(statuses.at(-1)).toBe('ready')
    session.destroy()
    source.destroy()
  })

  it('sends local V2 updates with the current epoch and does not echo remote updates', () => {
    const socket = new FakeSocket()
    const session = createRealtimeSession({
      docId: 'demo',
      socketFactory: () => socket,
      onStatus: vi.fn(),
      onReset: vi.fn(),
    })
    const source = sourceDoc('hello')
    socket.receive({ type: 'sync', epoch: 3, update: encoded(source) })

    session.doc.getText('title').insert(5, ' local')
    expect(socket.sent).toHaveLength(1)
    expect(JSON.parse(socket.sent[0])).toMatchObject({ type: 'update', epoch: 3 })
    const sentUpdate = Buffer.from(JSON.parse(socket.sent[0]).update, 'base64')
    const replica = new Y.Doc()
    Y.applyUpdateV2(replica, Y.encodeStateAsUpdateV2(source))
    Y.applyUpdateV2(replica, sentUpdate)
    expect(replica.getText('title').toString()).toBe('hello local')

    const other = new Y.Doc()
    Y.applyUpdateV2(other, Y.encodeStateAsUpdateV2(source))
    other.getText('title').insert(0, 'remote ')
    socket.receive({ type: 'update', epoch: 3, update: encoded(other) })
    expect(session.doc.getText('title').toString()).toContain('remote ')
    expect(socket.sent).toHaveLength(1)

    session.destroy()
    source.destroy()
    replica.destroy()
    other.destroy()
  })

  it('requests a fresh document after a server reset or changed epoch', () => {
    const socket = new FakeSocket()
    const onReset = vi.fn()
    const session = createRealtimeSession({
      docId: 'demo',
      socketFactory: () => socket,
      onStatus: vi.fn(),
      onReset,
    })
    const old = sourceDoc('old')
    const restored = sourceDoc('restored')
    socket.receive({ type: 'sync', epoch: 1, update: encoded(old) })
    socket.receive({ type: 'sync', epoch: 2, update: encoded(restored) })

    expect(onReset).toHaveBeenCalledTimes(1)
    expect(session.doc.getText('title').toString()).toBe('old')
    socket.disconnect(4205)
    expect(onReset).toHaveBeenCalledTimes(1)
    session.destroy()
    old.destroy()
    restored.destroy()
  })

  it('replays the full local state after reconnect when an in-flight update was lost', () => {
    vi.useFakeTimers()
    try {
      const first = new FakeSocket()
      const second = new FakeSocket()
      const sockets = [first, second]
      const session = createRealtimeSession({
        docId: 'demo',
        socketFactory: () => sockets.shift()!,
        onStatus: vi.fn(),
        onReset: vi.fn(),
      })
      const server = sourceDoc('server')
      first.receive({ type: 'sync', epoch: 8, update: encoded(server) })

      session.doc.getText('title').insert(6, ' local')
      expect(first.sent).toHaveLength(1)
      // The first frame never reached the server.
      first.disconnect(1006)
      vi.advanceTimersByTime(250)
      second.receive({ type: 'sync', epoch: 8, update: encoded(server) })

      expect(second.sent).toHaveLength(1)
      const replay = JSON.parse(second.sent[0]) as { epoch: number; update: string }
      expect(replay.epoch).toBe(8)
      Y.applyUpdateV2(server, Buffer.from(replay.update, 'base64'))
      expect(server.getText('title').toString()).toBe('server local')
      session.destroy()
      server.destroy()
    } finally {
      vi.useRealTimers()
    }
  })
})
