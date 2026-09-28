// @vitest-environment jsdom
import { Schema } from '@tiptap/pm/model'
import { describe, expect, it } from 'vitest'
import type { RevisionHistoryViewState } from '../src/contracts/state'
import { RevisionViewerHost } from '../src/viewer/revision-viewer-host'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*', toDOM: () => ['p', 0] },
    media: { group: 'block', atom: true, toDOM: () => ['div', { 'data-type': 'media' }] },
    text: {},
  },
})

const snapshot: RevisionHistoryViewState = {
  version: 1,
  open: true,
  list: { status: 'ready', items: [], nextCursor: null, hasNextPage: false, error: null },
  selection: { ref: { kind: 'revision', id: 'rev-1' }, compareTarget: { kind: 'previous' }, requestGeneration: 1 },
  viewer: {
    status: 'ready',
    selected: { kind: 'revision', id: 'rev-1' },
    compareTarget: { kind: 'previous' },
    content: { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: '历史正文' }] },
      { type: 'media' },
    ] },
    title: 'Historical title',
    contentHash: 'hash',
    compareContent: null,
    compareTitle: null,
    showChanges: false,
    totalChanges: 0,
    changes: [],
    attribution: null,
  },
  restore: { status: 'idle' },
  changeNavigation: { current: 0, total: 0 },
}

describe('V2 read-only viewer host', () => {
  it('renders with a host media adapter and never enables editing', async () => {
    expect(customElements.get('yjs-revision-viewer-shell')).toBeDefined()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const host = new RevisionViewerHost({
      container,
      schema,
      nodeViews: {
        media: () => {
          const dom = document.createElement('figure')
          dom.textContent = 'media rendered by host'
          return { dom }
        },
      },
    })

    host.update(snapshot)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(container.textContent).toContain('历史正文')
    expect(container.textContent).toContain('media rendered by host')
    expect(container.querySelector('.ProseMirror')?.getAttribute('contenteditable')).toBe('false')

    host.destroy()
    expect(container.querySelector('.ProseMirror')).toBeNull()
    container.remove()
  })

  it('does not mount a view after a pending render is closed', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const host = new RevisionViewerHost({ container, schema })
    const shell = (host as unknown as { shell: HTMLElement & { updateComplete: Promise<boolean> } }).shell
    let resolveRender!: (value: boolean) => void
    Object.defineProperty(shell, 'updateComplete', {
      configurable: true,
      value: new Promise<boolean>(resolve => { resolveRender = resolve }),
    })

    host.update(snapshot)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(shell.querySelector('.revision-vh-render')).not.toBeNull()
    host.update({ ...snapshot, open: false })
    resolveRender(true)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(shell.querySelector('.ProseMirror')).toBeNull()
    host.destroy()
    container.remove()
  })
})
