import type { RevisionJob, Scheduler } from '../ports'

/** Back this driver with a durable queue shared by every server instance. */
export interface RevisionQueueDriver {
  add(kind: 'delayed' | 'create', job: RevisionJob, delayMs: number): Promise<string | null>
  get(jobId: string): Promise<{ readonly job: RevisionJob; remove(): Promise<void> } | null>
}

/** Cross-instance registry. Keys expire after the delayed window plus a margin. */
export interface DelayedJobRegistry {
  set(documentId: string, jobId: string, ttlMs: number): Promise<void>
  get(documentId: string): Promise<string | null>
  delete(documentId: string): Promise<void>
}

export interface SchedulerFailure {
  readonly operation: 'enqueue_delayed' | 'enqueue_create' | 'register_delayed' | 'cancel_delayed'
  readonly errorClass: string
}

/** The callback must not log job bodies or connection URLs. */
export function createDurableScheduler(
  queue: RevisionQueueDriver,
  registry: DelayedJobRegistry,
  report?: (failure: SchedulerFailure) => void,
): Scheduler {
  const warn = (operation: SchedulerFailure['operation'], error: unknown) => {
    report?.({ operation, errorClass: error instanceof Error ? error.name : 'UnknownError' })
  }
  return {
    async enqueueDelayed(job, delayMs) {
      let jobId: string | null
      try { jobId = await queue.add('delayed', job, delayMs) }
      catch (error) { warn('enqueue_delayed', error); return null }
      if (jobId !== null) {
        try { await registry.set(job.documentId, jobId, delayMs + 60_000) }
        catch (error) { warn('register_delayed', error) }
      }
      return jobId
    },
    async enqueueCreate(job) {
      try { return await queue.add('create', job, 0) }
      catch (error) { warn('enqueue_create', error); return null }
    },
    async cancelDelayed(documentId) {
      try {
        const jobId = await registry.get(documentId)
        if (jobId === null) return
        await registry.delete(documentId)
        const pending = await queue.get(jobId)
        if (pending?.job.documentId !== documentId) return
        await pending.remove()
      } catch (error) {
        // A running job cannot be removed; its locked dedupe check will skip it.
        warn('cancel_delayed', error)
      }
    },
  }
}
