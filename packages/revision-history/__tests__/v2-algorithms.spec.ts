import { Schema } from '@tiptap/pm/model'
import { describe, expect, it } from 'vitest'
import { diffDocuments } from '../src/diff/diff-documents'
import { renderHistoryDocument } from '../src/viewer/render-history-document'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
  },
  marks: { bold: {} },
})

const paragraph = (text: string) => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
})

const doc = (content: unknown[]) => schema.nodeFromJSON({ type: 'doc', content })

describe('source V2 structural diff', () => {
  it('reports both inserted and deleted CJK spans within a rewritten paragraph', () => {
    const changes = diffDocuments(
      doc([paragraph('今天写旧稿')]),
      doc([paragraph('今天写新稿')]),
    ).changes
    expect(changes.some(change => change.kind === 'inserted')).toBe(true)
    expect(changes.some(change => change.kind === 'deleted')).toBe(true)
    expect(changes.every(change => change.from >= 0 && change.to >= change.from)).toBe(true)
  })

  it('keeps a mark-only edit separate from text insertion', () => {
    const before = doc([paragraph('重要')])
    const after = doc([{
      type: 'paragraph',
      content: [{ type: 'text', text: '重要', marks: [{ type: 'bold' }] }],
    }])
    expect(diffDocuments(before, after).changes.map(change => change.kind)).toEqual([
      'marks-changed',
    ])
  })

  it('positions an inserted heading before an edited paragraph', () => {
    const before = doc([paragraph('原文')])
    const after = doc([
      { type: 'heading', content: [{ type: 'text', text: '章节' }] },
      paragraph('新文'),
    ])
    const changes = diffDocuments(before, after).changes
    expect(changes.some(change => change.kind === 'inserted' && change.from === 0)).toBe(true)
    expect(changes.some(change => change.from >= after.firstChild!.nodeSize)).toBe(true)
  })
})

describe('read-only historical schema fallback', () => {
  it('preserves readable text from an unknown custom node and reports degradation', () => {
    const result = renderHistoryDocument(schema, {
      type: 'doc',
      content: [{
        type: 'customContainer',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '保留正文' }] }],
      }],
    })
    expect(result.doc.textContent).toBe('保留正文')
    expect(result.degradations).toContainEqual({
      kind: 'unknown-node',
      name: 'customContainer',
      path: '$.content[0]',
    })
  })
})
