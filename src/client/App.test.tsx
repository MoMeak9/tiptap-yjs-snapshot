// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

const snapshotContent = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Saved body' }] }],
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static autoSync = true
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []

  constructor(_url: string) {
    FakeWebSocket.instances.push(this)
    if (!FakeWebSocket.autoSync) return
    queueMicrotask(() => {
      const doc = new Y.Doc()
      doc.getText('title').insert(0, 'Live title')
      this.onmessage?.({ data: JSON.stringify({ type: 'sync', epoch: 1, update: Buffer.from(Y.encodeStateAsUpdateV2(doc)).toString('base64') }) })
      doc.destroy()
    })
  }

  send(value: string) { this.sent.push(value) }
  close() { this.readyState = 3 }
}

function json(data: unknown) {
  return new Response(JSON.stringify({ code: 0, data }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('snapshot UI', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    FakeWebSocket.autoSync = true
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('creates, previews, and restores a revision while keeping the live editor separate', async () => {
    let created = false
    let currentBody = 'Original server body'
    const creates: string[] = []
    const restores: string[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname.endsWith('/list')) return json({ data: created ? [{ id: 'rev-1', documentId: 'demo', version: 2, type: 'manual', name: 'Baseline', ctime: 1790553600000, availability: 'ready', diffEligible: true, restorable: true, collaborators: [] }] : [], nextCursor: null, hasMore: false })
      if (url.pathname.endsWith('/create')) {
        creates.push(JSON.parse(String(init?.body)).name)
        created = true
        return json({ id: 'rev-1', version: 2 })
      }
      if (url.pathname.endsWith('/detail')) {
        const isCurrent = url.searchParams.get('id') === 'current-demo'
        return json({ id: isCurrent ? 'current-demo' : 'rev-1', documentId: 'demo', version: isCurrent ? -1 : 2, type: isCurrent ? 'current' : 'manual', name: isCurrent ? null : 'Baseline', ctime: 1790553600000, title: isCurrent ? 'Live title' : 'Saved title', content: isCurrent ? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: currentBody }] }] } : snapshotContent, contentHash: isCurrent ? currentBody : 'old-hash', availability: 'ready', diffEligible: true, restorable: !isCurrent, collaborators: [], attribution: null })
      }
      if (url.pathname.endsWith('/restore')) {
        restores.push(JSON.parse(String(init?.body)).id)
        FakeWebSocket.instances.at(-1)?.onclose?.({ code: 4205 })
        await new Promise((resolve) => setTimeout(resolve, 20))
        return json({ id: 'rev-1' })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    })
    vi.stubGlobal('fetch', fetcher)
    const { App } = await import('./App')

    render(<App />)
    expect(await screen.findByText('实时连接正常')).toBeTruthy()
    fireEvent.click(screen.getByText('手动创建版本（API 集成示例）'))
    fireEvent.change(screen.getByPlaceholderText('版本名称（可选）'), { target: { value: 'Baseline' } })
    fireEvent.click(screen.getByRole('button', { name: '保存版本' }))

    expect(await screen.findByText('Saved body')).toBeTruthy()
    expect(creates).toEqual(['Baseline'])
    const preview = document.querySelector('[aria-label="历史快照正文"]')
    const live = document.querySelector('[aria-label="实时正文编辑器"]')
    expect(preview?.getAttribute('contenteditable')).toBe('false')
    expect(live?.getAttribute('contenteditable')).toBe('false')
    expect(screen.getByLabelText('标题')).toHaveProperty('value', 'Live title')
    expect(FakeWebSocket.instances).toHaveLength(1)

    currentBody = 'Updated server body'
    fireEvent.click(screen.getByRole('tab', { name: '对比变更' }))
    fireEvent.click(screen.getByRole('button', { name: '对照当前版本' }))
    expect(await screen.findByText('Updated server body')).toBeTruthy()
    expect(screen.getByText(/处变更/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '恢复此版本' }))
    expect(screen.getByRole('dialog', { name: '恢复版本 V2？' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认恢复' }))
    await waitFor(() => expect(restores).toEqual(['rev-1']))
    expect(await screen.findByText(/已恢复版本 V2/)).toBeTruthy()
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('opens V2 history read-only, defaults to the previous revision, and can target current', async () => {
    const requestedDetails: string[] = []
    const newer = { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '你好新' }] }] }
    const older = { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '你好' }] }] }
    const revisions = [
      { id: 'rev-new', documentId: 'demo', version: 2, name: null, type: 'auto', ctime: 1790553600000, availability: 'ready', diffEligible: true, restorable: true, collaborators: [] },
      { id: 'rev-old', documentId: 'demo', version: 1, name: null, type: 'auto', ctime: 1790550000000, availability: 'ready', diffEligible: true, restorable: true, collaborators: [] },
    ]
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname.endsWith('/list')) return json({ data: revisions, nextCursor: null, hasMore: false })
      if (url.pathname.endsWith('/detail')) {
        const id = url.searchParams.get('id')!
        requestedDetails.push(id)
        const current = id === 'current-demo'
        return json({
          ...(current ? { id, documentId: 'demo', version: -1, type: 'current', ctime: 1790557200000, restorable: false } : revisions.find((item) => item.id === id)),
          title: current ? '当前标题' : id === 'rev-new' ? '新版标题' : '旧版标题',
          content: current ? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '你好新现在' }] }] } : id === 'rev-new' ? newer : older,
          contentHash: id, availability: 'ready', diffEligible: true, attribution: null,
        })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    })
    vi.stubGlobal('fetch', fetcher)
    const { App } = await import('./App')
    render(<App />)
    expect(await screen.findByText('实时连接正常')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '打开版本历史' }))
    expect(await screen.findByText('新版标题')).toBeTruthy()
    expect(screen.getByLabelText('标题')).toHaveProperty('disabled', true)
    expect(document.querySelector('[aria-label="实时正文编辑器"]')?.getAttribute('contenteditable')).toBe('false')
    expect(screen.getByRole('button', { name: '加粗' })).toHaveProperty('disabled', true)

    fireEvent.click(screen.getByRole('tab', { name: '对比变更' }))
    expect(await screen.findByText(/新增.*新/)).toBeTruthy()
    expect(requestedDetails).toContain('rev-old')
    expect(requestedDetails).not.toContain('current-demo')

    fireEvent.click(screen.getByRole('button', { name: '对照当前版本' }))
    await waitFor(() => expect(requestedDetails).toContain('current-demo'))

    fireEvent.click(screen.getByRole('button', { name: '返回编辑' }))
    expect(screen.getByLabelText('标题')).toHaveProperty('disabled', false)
    expect(document.querySelector('[aria-label="实时正文编辑器"]')?.getAttribute('contenteditable')).toBe('true')
  })

  it('uses a generic message when V2 metadata says content cannot be previewed', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname.endsWith('/list')) return json({ data: [
        { id: 'unavailable', documentId: 'demo', version: 2, name: null, type: 'auto', ctime: 1790553600000, availability: 'deleted', diffEligible: false, restorable: false, collaborators: [] },
      ], nextCursor: null, hasMore: false })
      if (url.pathname.endsWith('/detail')) return json({
        id: 'unavailable', documentId: 'demo', version: 2, name: null, type: 'auto', ctime: 1790553600000,
        title: '版本标题', content: null, contentHash: null, availability: 'deleted', diffEligible: false, restorable: false, attribution: null,
      })
      throw new Error(`Unexpected request: ${url.pathname}`)
    })
    vi.stubGlobal('fetch', fetcher)
    const { App } = await import('./App')
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '打开版本历史' }))

    expect(await screen.findByText('此版本正文暂不可预览或比较。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '恢复此版本' })).toBeNull()
  })

  it('rechecks a previous revision in detail when list comparison metadata has changed', async () => {
    const requestedDetails: string[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname.endsWith('/list')) return json({ data: [
        { id: 'new', documentId: 'demo', version: 2, name: null, type: 'auto', ctime: 1790553600000, availability: 'ready', diffEligible: true, restorable: true, collaborators: [] },
        { id: 'earlier', documentId: 'demo', version: 1, name: null, type: 'auto', ctime: 1790550000000, availability: 'ready', diffEligible: false, restorable: true, collaborators: [] },
      ], nextCursor: null, hasMore: false })
      if (url.pathname.endsWith('/detail')) {
        const id = url.searchParams.get('id')!
        requestedDetails.push(id)
        return json({ id, documentId: 'demo', version: id === 'new' ? 2 : 1, name: null, type: 'auto', ctime: 1790553600000,
          title: '标题', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: id === 'new' ? '你好新' : '你好' }] }] },
          contentHash: id, availability: 'ready', diffEligible: true, restorable: true, collaborators: [], attribution: null,
        })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    })
    vi.stubGlobal('fetch', fetcher)
    const { App } = await import('./App')
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '打开版本历史' }))
    fireEvent.click(await screen.findByRole('tab', { name: '对比变更' }))

    expect(await screen.findByText(/新增.*新/)).toBeTruthy()
    expect(requestedDetails).toContain('earlier')
  })

  it('refreshes the list when history opens so newly automatic revisions are found', async () => {
    let listCalls = 0
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname.endsWith('/list')) {
        listCalls += 1
        return json({ data: listCalls === 1 ? [] : [{ id: 'auto-1', documentId: 'demo', version: 1, name: null, type: 'auto', ctime: 1790553600000, availability: 'ready', diffEligible: true, restorable: true, collaborators: [] }], nextCursor: null, hasMore: false })
      }
      if (url.pathname.endsWith('/detail')) return json({ id: 'auto-1', documentId: 'demo', version: 1, name: null, type: 'auto', ctime: 1790553600000, title: '自动保存', content: snapshotContent, contentHash: 'auto', availability: 'ready', diffEligible: true, restorable: true, attribution: null })
      throw new Error(`Unexpected request: ${url.pathname}`)
    })
    vi.stubGlobal('fetch', fetcher)
    const { App } = await import('./App')
    render(<App />)
    await waitFor(() => expect(listCalls).toBe(1))

    fireEvent.click(screen.getByRole('button', { name: '打开版本历史' }))
    expect(await screen.findByText('自动保存')).toBeTruthy()
    expect(listCalls).toBeGreaterThanOrEqual(2)
  })

  it('closes history on restore but keeps the stale live document locked until the reset signal', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname.endsWith('/list')) return json({ data: [{ id: 'rev-1', documentId: 'demo', version: 1, name: null, type: 'auto', ctime: 1790553600000, availability: 'ready', diffEligible: true, restorable: true, collaborators: [] }], nextCursor: null, hasMore: false })
      if (url.pathname.endsWith('/detail')) return json({ id: 'rev-1', documentId: 'demo', version: 1, name: null, type: 'auto', ctime: 1790553600000, title: '旧标题', content: snapshotContent, contentHash: 'old', availability: 'ready', diffEligible: true, restorable: true, attribution: null })
      if (url.pathname.endsWith('/restore')) return json({ id: 'rev-1' })
      throw new Error(`Unexpected request: ${url.pathname}`)
    })
    vi.stubGlobal('fetch', fetcher)
    const { App } = await import('./App')
    render(<App />)
    expect(await screen.findByText('实时连接正常')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '打开版本历史' }))
    fireEvent.click(await screen.findByRole('button', { name: '恢复此版本' }))
    fireEvent.click(screen.getByRole('button', { name: '确认恢复' }))

    expect(await screen.findByRole('button', { name: '打开版本历史' })).toHaveProperty('disabled', true)
    expect(screen.getByLabelText('标题')).toHaveProperty('disabled', true)
    expect(screen.getAllByText(/等待协作重置/).length).toBeGreaterThan(0)
    expect(document.querySelector('[aria-label="实时正文编辑器"]')?.getAttribute('contenteditable')).toBe('false')
    expect(FakeWebSocket.instances).toHaveLength(1)

    FakeWebSocket.instances[0].onclose?.({ code: 4205 })
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    await waitFor(() => expect(screen.getByLabelText('标题')).toHaveProperty('disabled', false))
    expect(screen.getByRole('button', { name: '打开版本历史' })).toHaveProperty('disabled', false)
    expect(document.querySelector('[aria-label="实时正文编辑器"]')?.getAttribute('contenteditable')).toBe('true')
    await new Promise((resolve) => setTimeout(resolve, 1300))
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('reconnects once after restore when a not-yet-synced socket receives no reset event', async () => {
    FakeWebSocket.autoSync = false
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname.endsWith('/list')) return json({ data: [{ id: 'rev-1', documentId: 'demo', version: 1, name: null, type: 'auto', ctime: 1790553600000, availability: 'ready', diffEligible: true, restorable: true, collaborators: [] }], nextCursor: null, hasMore: false })
      if (url.pathname.endsWith('/detail')) return json({ id: 'rev-1', documentId: 'demo', version: 1, name: null, type: 'auto', ctime: 1790553600000, title: '旧标题', content: snapshotContent, contentHash: 'old', availability: 'ready', diffEligible: true, restorable: true, attribution: null })
      if (url.pathname.endsWith('/restore')) return json({ id: 'rev-1' })
      throw new Error(`Unexpected request: ${url.pathname}`)
    })
    vi.stubGlobal('fetch', fetcher)
    const { App } = await import('./App')
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '打开版本历史' }))
    fireEvent.click(await screen.findByRole('button', { name: '恢复此版本' }))
    fireEvent.click(screen.getByRole('button', { name: '确认恢复' }))
    expect(await screen.findByRole('button', { name: '打开版本历史' })).toHaveProperty('disabled', true)
    expect(screen.getByLabelText('标题')).toHaveProperty('disabled', true)
    expect(FakeWebSocket.instances).toHaveLength(1)

    FakeWebSocket.autoSync = true
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), { timeout: 2500 })
    await waitFor(() => expect(screen.getByLabelText('标题')).toHaveProperty('disabled', false))
    expect(screen.getByRole('button', { name: '打开版本历史' })).toHaveProperty('disabled', false)
    FakeWebSocket.instances[0].onclose?.({ code: 4205 })
    expect(FakeWebSocket.instances).toHaveLength(2)
  })
})
