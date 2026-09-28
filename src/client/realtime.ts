import * as Y from 'yjs'

export interface SocketLike {
  readyState: number
  onopen: (() => void) | null
  onmessage: ((event: { data: string }) => void) | null
  onclose: ((event: { code: number }) => void) | null
  onerror: (() => void) | null
  send(message: string): void
  close(code?: number, reason?: string): void
}

export type RealtimeStatus = 'connecting' | 'ready' | 'reconnecting' | 'resetting'

export interface RealtimeSessionOptions {
  docId: string
  socketFactory?: (url: string) => SocketLike
  onStatus: (status: RealtimeStatus) => void
  onReset: () => void
  onError?: (message: string) => void
}

function socketUrl(docId: string) {
  const location = typeof window === 'undefined' ? undefined : window.location
  const origin = location
    ? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`
    : 'ws://localhost:3001'
  return `${origin}/collaboration?doc_id=${encodeURIComponent(docId)}`
}

function toBase64(bytes: Uint8Array) {
  const segments: string[] = []
  for (let index = 0; index < bytes.length; index += 8192) {
    segments.push(String.fromCharCode(...bytes.subarray(index, index + 8192)))
  }
  return btoa(segments.join(''))
}

function fromBase64(value: string) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

const remoteOrigin = Symbol('server-update')

export function createRealtimeSession(options: RealtimeSessionOptions) {
  const doc = new Y.Doc()
  const createSocket = options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as SocketLike)
  let socket: SocketLike | null = null
  let epoch: number | null = null
  let ready = false
  let destroyed = false
  let resetting = false
  let retry: ReturnType<typeof setTimeout> | null = null
  let retryCount = 0
  const pending: Uint8Array[] = []

  function requestReset() {
    if (destroyed || resetting) return
    resetting = true
    ready = false
    pending.length = 0
    options.onStatus('resetting')
    options.onReset()
  }

  function send(update: Uint8Array) {
    if (!socket || socket.readyState !== 1 || epoch === null) return false
    socket.send(JSON.stringify({ type: 'update', epoch, update: toBase64(update) }))
    return true
  }

  const onDocumentUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === remoteOrigin || destroyed || resetting) return
    if (!ready || !send(update)) pending.push(update)
  }
  doc.on('updateV2', onDocumentUpdate)

  function connect() {
    if (destroyed || resetting) return
    options.onStatus(epoch === null ? 'connecting' : 'reconnecting')
    const next = createSocket(socketUrl(options.docId))
    socket = next
    next.onmessage = ({ data }) => {
      if (destroyed || resetting || socket !== next) return
      try {
        const message: unknown = JSON.parse(data)
        if (!message || typeof message !== 'object') return
        const value = message as Record<string, unknown>
        if (value.event === 'document.reset') {
          requestReset()
          return
        }
        if (value.type !== 'sync' && value.type !== 'update') return
        if (typeof value.epoch !== 'number' || typeof value.update !== 'string') return
        if (epoch !== null && value.epoch !== epoch) {
          requestReset()
          return
        }
        if (value.type === 'update' && !ready) return
        const reconnecting = epoch !== null
        if (epoch === null) epoch = value.epoch
        Y.applyUpdateV2(doc, fromBase64(value.update), remoteOrigin)
        if (value.type === 'sync') {
          ready = true
          retryCount = 0
          if (reconnecting) {
            // A frame sent immediately before disconnect may have been lost.
            // Re-send the full merged state only when the epoch is unchanged.
            pending.length = 0
            pending.push(Y.encodeStateAsUpdateV2(doc))
          }
          while (pending.length) {
            const update = pending.shift()!
            if (!send(update)) {
              pending.unshift(update)
              break
            }
          }
          options.onStatus('ready')
        }
      } catch {
        options.onError?.('同步消息无效，请刷新页面重试。')
      }
    }
    next.onclose = ({ code }) => {
      if (destroyed || resetting || socket !== next) return
      ready = false
      socket = null
      if (code === 4205) {
        requestReset()
        return
      }
      options.onStatus('reconnecting')
      const delay = Math.min(250 * 2 ** retryCount, 5000)
      retryCount += 1
      retry = setTimeout(() => {
        retry = null
        connect()
      }, delay)
    }
    next.onerror = () => {
      if (!destroyed && !resetting) options.onError?.('实时连接中断，正在重连。')
    }
  }

  connect()
  return {
    doc,
    destroy() {
      if (destroyed) return
      destroyed = true
      if (retry) clearTimeout(retry)
      doc.off('updateV2', onDocumentUpdate)
      if (socket) {
        socket.onmessage = null
        socket.onclose = null
        socket.onerror = null
        socket.close()
      }
      doc.destroy()
    },
  }
}
