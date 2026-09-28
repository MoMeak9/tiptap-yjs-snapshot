import { describe, expect, it } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { buildCanonicalContent, decodeRevisionCursor, encodeRevisionCursor, prepareDocumentHistoryWrite } from '../src/index'

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', attrs: { align: { default: 'left' }, meta: { default: {} } } },
    text: {},
  },
  marks: { strong: {} },
})

describe('V2 public contract', () => {
  it('normalizes equivalent JSON once for persisted JSON and SHA-256', () => {
    const a = buildCanonicalContent(schema, {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { meta: { z: 2, a: { y: 2, x: 1 } }, align: 'left' }, content: [{ type: 'text', text: 'hello' }] }],
    })
    const b = buildCanonicalContent(schema, {
      content: [{ content: [{ text: 'hello', type: 'text' }], attrs: { align: 'left', meta: { a: { x: 1, y: 2 }, z: 2 } }, type: 'paragraph' }],
      type: 'doc',
    })
    expect(a.serialized).toBe(b.serialized)
    expect(a.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(a.serialized).toBe(JSON.stringify(a.json))
    expect(a.serialized).toContain('"meta":{"a":{"x":1,"y":2},"z":2}')
  })

  it('separates pure metadata writes from business changes', () => {
    const prepared = prepareDocumentHistoryWrite(schema, {
      documentId: 'doc-example',
      writePath: 'collaboration_store',
      persistenceV2Enabled: true,
      actor: 'user-example',
      title: 'Same title',
    })
    expect(prepared.disabled).toBe(false)
    expect(prepared.degraded).toBe(false)
  })

  it('round-trips UUID revision IDs in the V2 cursor wire format', () => {
    const key = { version: 23, id: '6a4547ee-2bcd-4903-904f-041180b740a9' }
    expect(decodeRevisionCursor(encodeRevisionCursor(key))).toEqual(key)
  })
})
