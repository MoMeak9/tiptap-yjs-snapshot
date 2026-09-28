import { describe, expect, it } from 'vitest'
import { createDurableScheduler, type RevisionJob } from '../src/index'

const job: RevisionJob = { documentId: 'doc-public', source: 'auto', enqueuedAt: 100 }

describe('durable scheduling', () => {
  it('registers delayed work across instances and cancels only a matching document job', async () => {
    const registry = new Map<string, string>()
    const removed: string[] = []
    const queue = {
      add: async (kind: 'delayed' | 'create') => kind === 'delayed' ? 'job-1' : 'job-2',
      get: async (id: string) => ({ job: { ...job, documentId: id === 'job-1' ? 'doc-public' : 'other' }, remove: async () => { removed.push(id) } }),
    }
    const sharedRegistry = {
      set: async (documentId: string, id: string) => { registry.set(documentId, id) },
      get: async (documentId: string) => registry.get(documentId) ?? null,
      delete: async (documentId: string) => { registry.delete(documentId) },
    }
    const writer = createDurableScheduler(queue, sharedRegistry)
    const otherInstance = createDurableScheduler(queue, sharedRegistry)
    expect(await writer.enqueueDelayed(job, 500)).toBe('job-1')
    expect(registry.get('doc-public')).toBe('job-1')
    await otherInstance.cancelDelayed('doc-public')
    expect(removed).toEqual(['job-1'])
    expect(registry.has('doc-public')).toBe(false)
  })

  it('leaves the delayed fallback when immediate enqueue fails', async () => {
    const registry = new Map([['doc-public', 'job-delayed']])
    const scheduler = createDurableScheduler({
      add: async kind => kind === 'create' ? null : 'job-delayed',
      get: async () => null,
    }, {
      set: async () => {}, get: async id => registry.get(id) ?? null,
      delete: async id => { registry.delete(id) },
    })
    expect(await scheduler.enqueueCreate(job)).toBeNull()
    expect(registry.get('doc-public')).toBe('job-delayed')
  })
})
