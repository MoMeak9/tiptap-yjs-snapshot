import { describe, expect, it } from 'vitest'
import type { JSONContent } from '@tiptap/core'
import { diffRevisions } from './diff'

function document(...content: JSONContent[]): JSONContent {
  return { type: 'doc', content }
}

function paragraph(text: string, marks?: JSONContent['marks']): JSONContent {
  return { type: 'paragraph', content: [{ type: 'text', text, ...(marks ? { marks } : {}) }] }
}

describe('StarterKit revision difference', () => {
  it('reports CJK insertions and deletions from actual JSON text', () => {
    const result = diffRevisions(
      { title: '文档', content: document(paragraph('你好世界')) },
      { title: '文档', content: document(paragraph('你好新世')) },
    )
    expect(result.changes).toContainEqual({ kind: 'insert', block: 1, text: '新' })
    expect(result.changes).toContainEqual({ kind: 'delete', block: 1, text: '界' })
  })

  it('reports mark, heading attribute, and title changes without inventing authors', () => {
    const result = diffRevisions(
      { title: '旧标题', content: document({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '你好', marks: [{ type: 'bold' }] }] }) },
      { title: '新标题', content: document({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '你好', marks: [{ type: 'italic' }] }] }) },
    )
    expect(result.changes).toContainEqual({ kind: 'title', before: '旧标题', after: '新标题' })
    expect(result.changes).toContainEqual({ kind: 'block', block: 1, before: '标题 H1', after: '标题 H2' })
    expect(result.changes).toContainEqual({ kind: 'format', block: 1, text: '你好', before: '加粗', after: '斜体' })
    expect(result.changes.every((change) => !('author' in change))).toBe(true)
  })

  it('distinguishes a new block from text inserted into an existing block', () => {
    const result = diffRevisions(
      { title: '', content: document(paragraph('第一段')) },
      { title: '', content: document(paragraph('新段'), paragraph('第一段')) },
    )
    expect(result.changes).toContainEqual({ kind: 'block', block: 1, before: '不存在', after: '段落' })
    expect(result.changes).toContainEqual({ kind: 'insert', block: 1, text: '新段' })
  })
})
