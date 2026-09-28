import type { JSONContent } from '@tiptap/core'
import { TiptapTransformer } from '@hocuspocus/transformer'
import * as Y from 'yjs'
import type { V2StateCodec } from './ports'

/** V2 bytes are decoded for derived JSON only; restore writes the original bytes. */
export const yjsV2StateCodec: V2StateCodec = {
  decode(state: Uint8Array): { content: JSONContent; title?: string } {
    const doc = new Y.Doc()
    try {
      Y.applyUpdateV2(doc, state)
      const content = TiptapTransformer.fromYdoc(doc, 'default') as JSONContent
      const title = doc.share.has('title') ? doc.getText('title').toString() : undefined
      return { content, ...(title === undefined ? {} : { title }) }
    } finally {
      doc.destroy()
    }
  },
}
