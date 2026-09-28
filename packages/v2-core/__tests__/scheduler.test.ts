import { describe, expect, it } from 'vitest'
import {
  createDurableScheduler,
  type DelayedJobMarker,
  type DelayedJobRegistry,
  type RevisionJob,
  type SchedulerFailure,
} from '../src/index'

const job: RevisionJob = { documentId: 'doc-public', source: 'auto', enqueuedAt: 100 }

const marker = (jobId: string, enqueuedAt = 100): DelayedJobMarker => ({ jobId, enqueuedAt, ttlMs: 60_500 })

function memoryRegistry(values = new Map<string, DelayedJobMarker>()): DelayedJobRegistry {
  return {
    set: async (documentId, jobId, enqueuedAt, ttlMs) => {
      const current = values.get(documentId)
      if (current && (current.enqueuedAt > enqueuedAt ||
        (current.enqueuedAt === enqueuedAt && current.jobId >= jobId))) return false
      values.set(documentId, { jobId, enqueuedAt, ttlMs })
      return true
    },
    take: async documentId => {
      const claimed = values.get(documentId) ?? null
      values.delete(documentId)
      return claimed
    },
    restore: async (documentId, claimed) => {
      if (values.has(documentId)) return false
      values.set(documentId, claimed)
      return true
    },
  }
}

describe('durable scheduling', () => {
  it('registers delayed work across instances and cancels only a matching document job', async () => {
    const registry = new Map<string, DelayedJobMarker>()
    const removed: string[] = []
    const queue = {
      add: async (kind: 'delayed' | 'create') => kind === 'delayed' ? 'job-1' : 'job-2',
      get: async (id: string) => ({ job: { ...job, documentId: id === 'job-1' ? 'doc-public' : 'other' }, remove: async () => { removed.push(id) } }),
    }
    const writer = createDurableScheduler(queue, memoryRegistry(registry))
    const otherInstance = createDurableScheduler(queue, memoryRegistry(registry))
    expect(await writer.enqueueDelayed(job, 500)).toBe('job-1')
    expect(registry.get('doc-public')?.jobId).toBe('job-1')
    await otherInstance.cancelDelayed('doc-public')
    expect(removed).toEqual(['job-1'])
    expect(registry.has('doc-public')).toBe(false)
  })

  it('keeps a newly registered job when cancellation has claimed an older job', async () => {
    const registry = new Map([['doc-public', marker('job-old')]])
    const removed: string[] = []
    let releaseLookup!: () => void
    let lookupStarted!: () => void
    const lookupGate = new Promise<void>(resolve => { releaseLookup = resolve })
    const lookupSignal = new Promise<void>(resolve => { lookupStarted = resolve })
    const queue = {
      add: async () => 'job-new',
      get: async (id: string) => {
        lookupStarted()
        await lookupGate
        return { job, remove: async () => { removed.push(id) } }
      },
    }
    const scheduler = createDurableScheduler(queue, memoryRegistry(registry))
    const cancel = scheduler.cancelDelayed('doc-public')
    await lookupSignal
    expect(await scheduler.enqueueDelayed(job, 500)).toBe('job-new')
    releaseLookup()
    await cancel
    expect(removed).toEqual(['job-old'])
    expect(registry.get('doc-public')?.jobId).toBe('job-new')
  })

  it('keeps the newer delayed job when the older queue add finishes last', async () => {
    const registry = new Map<string, DelayedJobMarker>()
    let releaseOld!: () => void
    const oldAdd = new Promise<void>(resolve => { releaseOld = resolve })
    const queue = {
      add: async (_kind: 'delayed' | 'create', queued: RevisionJob) => {
        if (queued.enqueuedAt === 100) await oldAdd
        return queued.enqueuedAt === 100 ? 'job-old' : 'job-new'
      },
      get: async () => null,
    }
    const scheduler = createDurableScheduler(queue, memoryRegistry(registry))

    const old = scheduler.enqueueDelayed(job, 500)
    expect(await scheduler.enqueueDelayed({ ...job, enqueuedAt: 200 }, 500)).toBe('job-new')
    releaseOld()
    expect(await old).toBe('job-old')
    expect(registry.get('doc-public')?.jobId).toBe('job-new')
  })

  it('enqueues immediate work without registering it as delayed', async () => {
    const registry = new Map<string, DelayedJobMarker>()
    const added: Array<{ kind: string; delayMs: number }> = []
    const scheduler = createDurableScheduler({
      add: async (kind, _job, delayMs) => {
        added.push({ kind, delayMs })
        return 'job-immediate'
      },
      get: async () => null,
    }, memoryRegistry(registry))

    expect(await scheduler.enqueueCreate(job)).toBe('job-immediate')
    expect(added).toEqual([{ kind: 'create', delayMs: 0 }])
    expect(registry.size).toBe(0)
  })

  it('leaves the delayed fallback when immediate enqueue fails', async () => {
    const registry = new Map([['doc-public', marker('job-delayed')]])
    const failures: SchedulerFailure[] = []
    const scheduler = createDurableScheduler({
      add: async kind => {
        if (kind === 'create') throw new Error('queue unavailable')
        return 'job-delayed'
      },
      get: async () => null,
    }, memoryRegistry(registry), failure => { failures.push(failure) })
    expect(await scheduler.enqueueCreate(job)).toBeNull()
    expect(registry.get('doc-public')?.jobId).toBe('job-delayed')
    expect(failures).toEqual([{ operation: 'enqueue_create', errorClass: 'Error' }])
  })

  it('keeps delayed work queued when its optional cancellation registration fails', async () => {
    const failures: SchedulerFailure[] = []
    const scheduler = createDurableScheduler({
      add: async () => 'job-delayed',
      get: async () => null,
    }, {
      set: async () => { throw new Error('registry unavailable') },
      take: async () => null,
      restore: async () => false,
    }, failure => { failures.push(failure) })

    expect(await scheduler.enqueueDelayed(job, 500)).toBe('job-delayed')
    expect(failures).toEqual([{ operation: 'register_delayed', errorClass: 'Error' }])
  })

  it('restores a claimed marker after a transient removal failure for a later retry', async () => {
    const registry = new Map([['doc-public', marker('job-delayed')]])
    const failures: SchedulerFailure[] = []
    let removals = 0
    const scheduler = createDurableScheduler({
      add: async () => null,
      get: async () => ({
        job,
        remove: async () => {
          removals++
          if (removals === 1) throw new Error('transient queue failure')
        },
      }),
    }, memoryRegistry(registry), failure => { failures.push(failure) })

    await scheduler.cancelDelayed('doc-public')
    expect(registry.get('doc-public')?.jobId).toBe('job-delayed')
    await scheduler.cancelDelayed('doc-public')
    expect(registry.size).toBe(0)
    expect(removals).toBe(2)
    expect(failures).toEqual([{ operation: 'cancel_delayed', errorClass: 'Error' }])
  })

  it('does not restore a failed cancellation over a newer registration', async () => {
    const registry = new Map([['doc-public', marker('job-old')]])
    const sharedRegistry = memoryRegistry(registry)
    const scheduler = createDurableScheduler({
      add: async () => 'job-new',
      get: async () => {
        await sharedRegistry.set('doc-public', 'job-new', 200, 60_500)
        throw new Error('queue lookup unavailable')
      },
    }, sharedRegistry)

    await scheduler.cancelDelayed('doc-public')
    expect(registry.get('doc-public')?.jobId).toBe('job-new')
  })
})
