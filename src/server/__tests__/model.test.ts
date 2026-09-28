import { describe, expect, it } from 'vitest'
import { TiptapTransformer } from '@hocuspocus/transformer'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import * as Y from 'yjs'
import { buildCanonicalContent } from '../../../packages/v2-core/src/canonical'
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

  it('stores the same canonical content and hash as the V2 core', () => {
    const doc = TiptapTransformer.toYdoc({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Canonical V2' }] }],
    }, 'default', [StarterKit])
    const actual = materialize(doc)
    const expected = buildCanonicalContent(getSchema([StarterKit]), actual.content)
    expect(actual.content).toEqual(expected.json)
    expect(actual.hash).toBe(expected.contentHash)
  })
})
