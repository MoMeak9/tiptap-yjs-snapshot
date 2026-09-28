import type { RevisionJob, Scheduler } from '../ports'

/** Back this driver with a durable queue shared by every server instance. */
export interface RevisionQueueDriver {
  add(kind: 'delayed' | 'create', job: RevisionJob, delayMs: number): Promise<string | null>
  get(jobId: string): Promise<{ readonly job: RevisionJob; remove(): Promise<void> } | null>
}

export interface DelayedJobMarker {
  readonly jobId: string
  readonly enqueuedAt: number
  readonly ttlMs: number
}

/** Cross-instance registry. Keys expire after the delayed window plus a margin. */
export interface DelayedJobRegistry {
  /** Atomically register only if this job is newer than the current marker. */
  set(documentId: string, jobId: string, enqueuedAt: number, ttlMs: number): Promise<boolean>
  /** Atomically return and remove the current marker; a later registration must survive. */
  take(documentId: string): Promise<DelayedJobMarker | null>
  /** Restore a claimed marker only when no new marker has appeared. */
  restore(documentId: string, marker: DelayedJobMarker): Promise<boolean>
}

export interface SchedulerFailure {
  readonly operation: 'enqueue_delayed' | 'enqueue_create' | 'register_delayed' | 'cancel_delayed' | 'restore_delayed'
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
        try { await registry.set(job.documentId, jobId, job.enqueuedAt, delayMs + 60_000) }
        catch (error) { warn('register_delayed', error) }
      }
      return jobId
    },
    async enqueueCreate(job) {
      try { return await queue.add('create', job, 0) }
      catch (error) { warn('enqueue_create', error); return null }
    },
    async cancelDelayed(documentId) {
      let claimed: DelayedJobMarker | null = null
      try {
        claimed = await registry.take(documentId)
        if (claimed === null) return
        const pending = await queue.get(claimed.jobId)
        if (pending?.job.documentId !== documentId) return
        await pending.remove()
      } catch (error) {
        // A running job cannot be removed; its locked dedupe check will skip it.
        // A transient queue failure retains the marker for a later cancellation.
        warn('cancel_delayed', error)
        if (claimed !== null) {
          try { await registry.restore(documentId, claimed) }
          catch (restoreError) { warn('restore_delayed', restoreError) }
        }
      }
    },
  }
}
