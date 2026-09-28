import { describe, expect, it } from 'vitest'
import type { RevisionApiClient, RevisionContent, RevisionListItem } from '../src/contracts/api'
import { RevisionHistoryController } from '../src/controller/revision-history-controller'

const item: RevisionListItem = {
  id: 'rev-1', documentId: 'doc-1', title: 'Draft', name: null,
  createdAt: 1000, createdBy: 'author1', collaborators: [],
  version: 1, type: 'auto', availability: 'ready', diffEligible: true, restorable: true,
}
const content: RevisionContent = {
  ref: { kind: 'revision', id: 'rev-1' }, documentId: 'doc-1',
  title: 'Draft', content: { type: 'doc', content: [{ type: 'paragraph' }] },
  contentHash: 'hash', availability: 'ready', decodedFromState: false, attribution: null,
}

describe('V2 controller lifecycle', () => {
  it('loads one revision, requires confirmation, and delegates reset after restore', async () => {
    const calls: string[] = []
    const api: RevisionApiClient = {
      list: async () => ({ items: [item], nextCursor: null, hasNextPage: false }),
      getDetail: async ({ revisionId }) => {
        calls.push(`detail:${revisionId}`)
        return content
      },
      restore: async ({ revisionId }) => {
        calls.push(`restore:${revisionId}`)
        return { revisionId }
      },
    }
    const controller = new RevisionHistoryController({
      api, documentId: 'doc-1',
      onRestoreComplete: result => calls.push(`reset:${result.revisionId}`),
    })

    controller.open()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(controller.getState().list.items).toHaveLength(1)
    await controller.selectRevision('rev-1')
    expect(controller.getState().viewer.status).toBe('ready')
    controller.requestRestore('rev-1')
    expect(calls).not.toContain('restore:rev-1')
    await controller.confirmRestore()
    expect(calls).toEqual(['detail:rev-1', 'restore:rev-1', 'reset:rev-1'])
    expect(controller.getState().restore.status).toBe('rebuilding')
    controller.dispose()
  })

  it('refreshes the first page after reopening', async () => {
    let version = 1
    const api: RevisionApiClient = {
      list: async () => ({
        items: [{ ...item, id: `rev-${version}`, version }],
        nextCursor: null,
        hasNextPage: false,
      }),
      getDetail: async () => content,
      restore: async ({ revisionId }) => ({ revisionId }),
    }
    const controller = new RevisionHistoryController({ api, documentId: 'doc-1' })
    controller.open()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(controller.getState().list.items.map(entry => entry.id)).toEqual(['rev-1'])

    controller.close()
    version = 2
    controller.open()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(controller.getState().list.items.map(entry => entry.id)).toEqual(['rev-2'])
    controller.dispose()
  })
})
