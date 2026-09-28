import { describe, expect, it, vi } from 'vitest'

import { createRevisionApi } from './api'

describe('revision API', () => {
  it('uses cursor pagination and unwraps the nested list payload', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({
      code: 0,
      data: { data: [{ id: 'r1', version: 1, name: 'First', ctime: 1790553600000 }], nextCursor: 'next', hasMore: true },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const api = createRevisionApi(fetcher as typeof fetch)

    const result = await api.list('my doc', 10, 'previous')

    expect(result.data).toHaveLength(1)
    expect(result.nextCursor).toBe('next')
    const url = new URL(String(fetcher.mock.calls[0][0]), 'http://localhost')
    expect(url.searchParams.get('doc_id')).toBe('my doc')
    expect(url.searchParams.get('cursor')).toBe('previous')
    expect(url.searchParams.get('limit')).toBe('10')
  })

  it('surfaces the server error message on a nonzero envelope', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: 409, message: 'Cannot restore this revision' }), { status: 409 }))
    const api = createRevisionApi(fetcher as typeof fetch)

    await expect(api.restore('demo', 'r1')).rejects.toThrow('Cannot restore this revision')
  })
})
