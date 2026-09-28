import { describe, expect, it } from 'vitest'
import { TiptapTransformer } from '@hocuspocus/transformer'
import StarterKit from '@tiptap/starter-kit'
import * as Y from 'yjs'
import { materialize } from '../model'

describe('snapshot materialization', () => {
  it('reads body and title from the same V2 state and hashes semantic content', () => {
    const original = TiptapTransformer.toYdoc({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A paragraph' }] }],
    }, 'default', [StarterKit])
    original.getText('title').insert(0, 'A title')
    const reloaded = new Y.Doc()
    Y.applyUpdateV2(reloaded, Y.encodeStateAsUpdateV2(original))

    const first = materialize(original)
    const second = materialize(reloaded)
    expect(second).toEqual(first)
    expect(first.title).toBe('A title')
    expect(first.content).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A paragraph' }] }],
    })
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/)
  })
})
