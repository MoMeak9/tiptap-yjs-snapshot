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
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []

  constructor(_url: string) {
    FakeWebSocket.instances.push(this)
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
      if (url.pathname.endsWith('/list')) return json({ data: created ? [{ id: 'rev-1', version: 1, name: 'Baseline', ctime: 1790553600000 }] : [], nextCursor: null, hasMore: false })
      if (url.pathname.endsWith('/create')) {
        creates.push(JSON.parse(String(init?.body)).name)
        created = true
        return json({ id: 'rev-1', version: 1 })
      }
      if (url.pathname.endsWith('/detail')) return json({ id: 'rev-1', version: 1, name: 'Baseline', ctime: 1790553600000, title: 'Saved title', content: snapshotContent, contentHash: 'old-hash' })
      if (url.pathname.endsWith('/current')) return json({ title: 'Live title', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: currentBody }] }] }, contentHash: currentBody })
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
    fireEvent.change(screen.getByPlaceholderText('版本名称（可选）'), { target: { value: 'Baseline' } })
    fireEvent.click(screen.getByRole('button', { name: '保存版本' }))

    expect(await screen.findByText('Saved body')).toBeTruthy()
    expect(creates).toEqual(['Baseline'])
    const preview = document.querySelector('[aria-label="历史快照正文"]')
    const live = document.querySelector('[aria-label="实时正文编辑器"]')
    expect(preview?.getAttribute('contenteditable')).toBe('false')
    expect(live?.getAttribute('contenteditable')).toBe('true')
    expect(screen.getByLabelText('标题')).toHaveProperty('value', 'Live title')
    expect(FakeWebSocket.instances).toHaveLength(1)

    currentBody = 'Updated server body'
    fireEvent.click(screen.getByRole('tab', { name: '对照当前' }))
    expect(await screen.findByText('Updated server body')).toBeTruthy()
    expect(screen.getByText('标题或正文存在差异')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '恢复此版本' }))
    expect(screen.getByRole('dialog', { name: '恢复版本 V1？' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认恢复' }))
    await waitFor(() => expect(restores).toEqual(['rev-1']))
    expect(await screen.findByText(/已恢复版本 V1/)).toBeTruthy()
    expect(FakeWebSocket.instances).toHaveLength(2)
  })
})
