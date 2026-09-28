import { describe, expect, it } from 'vitest'
import { createRevisionApiClient } from '../src/api/revision-api-client'

function response(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, data }), {
    headers: { 'content-type': 'application/json' },
  })
}

describe('public V2 API adapter', () => {
  it('maps list, detail and restore while allowing generic route and header names', async () => {
    const requests: { url: string; init?: RequestInit }[] = []
    const replies = [
      response({
        data: [{
          id: 'rev-1', documentId: 'doc-1', title: 'Draft', name: null,
          version: 1, type: 'auto', ctime: 1000, createdBy: 'author1',
          collaborators: [{ username: 'author1', nickname: 'Author' }],
          availability: 'ready', diffEligible: true, restorable: true,
        }],
        nextCursor: null,
        hasMore: false,
      }),
      response({
        id: 'rev-1', documentId: 'doc-1', title: 'Draft',
        availability: 'ready', contentHash: 'hash', decodedFromState: false,
        content: { type: 'doc', content: [{ type: 'paragraph' }] },
        attribution: null,
      }),
      response({ id: 'rev-1' }),
    ]
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init })
      const next = replies.shift()
      if (!next) throw new Error('unexpected request')
      return next
    }) as typeof fetch
    const api = createRevisionApiClient({
      documentId: 'doc-1',
      servicePrefix: '/api',
      auth: { getToken: () => 'token', applyTokenEnvelope: () => undefined },
      fetchImpl,
      transport: {
        documentIdQueryKey: 'document_id',
        tokenHeader: 'authorization',
        refreshEnvelopeHeader: null,
        routes: { list: '/history', detail: '/history/item', restore: '/history/restore' },
      },
    })

    const signal = new AbortController().signal
    const page = await api.list({ cursor: null, limit: 10, signal })
    const detail = await api.getDetail({ revisionId: 'rev-1', signal })
    const restored = await api.restore({ revisionId: 'rev-1' })

    expect(page.items[0].createdAt).toBe(1000)
    expect(page.items[0].collaborators[0].nickname).toBe('Author')
    expect(detail.content).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] })
    expect(restored.revisionId).toBe('rev-1')
    expect(requests.map(request => new URL(request.url, 'https://example.test').pathname))
      .toEqual(['/api/history', '/api/history/item', '/api/history/restore'])
    expect(requests.every(request =>
      new URL(request.url, 'https://example.test').searchParams.get('document_id') === 'doc-1',
    )).toBe(true)
    expect(requests[0].init?.headers).toMatchObject({ authorization: 'token' })
    expect(requests[2].init?.method).toBe('POST')
    expect(JSON.parse(String(requests[2].init?.body))).toEqual({ id: 'rev-1' })
  })
})
