import { Schema } from '@tiptap/pm/model'
import { describe, expect, it } from 'vitest'
import { diffDocuments } from '../src/diff/diff-documents'
import { tokenize } from '../src/diff/tokenize'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    text: {},
  },
})

describe('public V2 history contract', () => {
  it('preserves CJK text while splitting changes below paragraph level', () => {
    const text = '欢迎使用修订历史'
    expect(tokenize(text).join('')).toBe(text)
    expect(tokenize(text).length).toBeGreaterThan(1)

    const before = schema.nodeFromJSON({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '欢迎使用' }] }],
    })
    const after = schema.nodeFromJSON({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    })
    expect(diffDocuments(before, after).changes.some(change => change.kind === 'inserted')).toBe(true)
  })
})
