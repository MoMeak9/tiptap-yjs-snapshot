import type { JSONContent } from '@tiptap/core'

export interface RevisionContributor {
  username: string
  nickname: string
}

export interface RevisionSummary {
  id: string
  documentId: string
  version: number
  name: string | null
  title: string
  type: 'auto' | 'manual' | 'pre_restore' | 'restore' | 'current'
  ctime: number
  createdBy: string | null
  createdByUser: RevisionContributor | null
  collaborators: RevisionContributor[]
  availability: 'ready' | 'legacy_pending' | 'legacy_failed' | 'deleted'
  diffEligible: boolean
  restorable: boolean
  restoredFromVersion: number | null
}

export interface RevisionDetail extends Omit<RevisionSummary, 'collaborators'> {
  collaborators: string[]
  content: JSONContent | null
  contentHash: string | null
  decodedFromState: boolean
  attribution: null
}

export type CurrentDocument = RevisionDetail

export interface RevisionPage {
  data: RevisionSummary[]
  nextCursor: string | null
  hasMore: boolean
}

interface Envelope<T> {
  code: number
  data?: T
  message?: string
}

function query(docId: string, extra: Record<string, string | number | undefined> = {}) {
  const params = new URLSearchParams({ doc_id: docId })
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) params.set(key, String(value))
  }
  return params.toString()
}

export function createRevisionApi(fetcher: typeof fetch = fetch) {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response
    try {
      response = await fetcher(`/api/revisions/${path}`, init)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      throw new Error('网络连接失败，请检查服务端是否已启动。')
    }

    let envelope: Envelope<T>
    try {
      envelope = await response.json() as Envelope<T>
    } catch {
      throw new Error(`服务端返回了无法解析的响应（HTTP ${response.status}）。`)
    }
    if (!response.ok || envelope.code !== 0 || envelope.data === undefined) {
      throw new Error(envelope.message || `请求失败（HTTP ${response.status}）。`)
    }
    return envelope.data
  }

  function post<T>(path: string, body: unknown, signal?: AbortSignal) {
    return request<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  }

  return {
    list: (docId: string, limit = 10, cursor?: string, signal?: AbortSignal) =>
      request<RevisionPage>(`list?${query(docId, { limit, cursor })}`, { signal }),
    detail: (docId: string, id: string, signal?: AbortSignal) =>
      request<RevisionDetail>(`detail?${query(docId, { id })}`, { signal }),
    current: (docId: string, signal?: AbortSignal) =>
      request<CurrentDocument>(`detail?${query(docId, { id: `current-${docId}` })}`, { signal }),
    create: (docId: string, name?: string, signal?: AbortSignal) =>
      post<{ id: string; version: number }>(`create?${query(docId)}`, name ? { name } : {}, signal),
    restore: (docId: string, id: string, signal?: AbortSignal) =>
      post<{ id: string }>(`restore?${query(docId)}`, { id }, signal),
  }
}
