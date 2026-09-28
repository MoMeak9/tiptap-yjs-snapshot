import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { describe, expect, it } from 'vitest'
import { createDurableScheduler, createRedisDelayedJobRegistry, type RevisionJob } from '../src/index'

const redisUrl = process.env.REDIS_URL

/** Run with REDIS_URL pointing to an ordinary Redis 6.2+ instance. */
describe.skipIf(!redisUrl)('standard Redis integration', () => {
  it('keeps the newest delayed job and restores only the current claim', async () => {
    const client = new Redis(redisUrl!, { lazyConnect: true, maxRetriesPerRequest: 1 })
    const prefix = `revision-test:${randomUUID()}:`
    const documents = ['out-of-order', 'restore']
    const registry = createRedisDelayedJobRegistry(client, { keyPrefix: prefix })
    await client.connect()
    try {
      let releaseOld!: () => void
      const oldAdd = new Promise<void>(resolve => { releaseOld = resolve })
      const job: RevisionJob = { documentId: documents[0]!, source: 'auto', enqueuedAt: 100 }
      const scheduler = createDurableScheduler({
        add: async (_kind, queued) => {
          if (queued.enqueuedAt === 100) await oldAdd
          return queued.enqueuedAt === 100 ? 'job-old' : 'job-new'
        },
        get: async () => null,
      }, registry)
      const older = scheduler.enqueueDelayed(job, 5_000)
      expect(await scheduler.enqueueDelayed({ ...job, enqueuedAt: 200 }, 5_000)).toBe('job-new')
      releaseOld()
      expect(await older).toBe('job-old')
      expect((await registry.take(documents[0] as string))?.jobId).toBe('job-new')
      // The watermark persists even though GETDEL has consumed the current marker.
      expect(await registry.set(documents[0] as string, 'job-old', 100, 5_000)).toBe(false)
      expect(await registry.take(documents[0] as string)).toBeNull()

      await registry.set(documents[1] as string, 'job-original', 100, 5_000)
      const claimed = await registry.take(documents[1] as string)
      expect(claimed?.jobId).toBe('job-original')
      expect(await registry.restore(documents[1] as string, claimed!)).toBe(true)
      expect((await registry.take(documents[1] as string))?.jobId).toBe('job-original')

      await registry.set(documents[1] as string, 'job-newer', 200, 5_000)
      expect((await registry.take(documents[1] as string))?.jobId).toBe('job-newer')
      expect(await registry.restore(documents[1] as string, claimed!)).toBe(false)
      expect(await registry.take(documents[1] as string)).toBeNull()
    } finally {
      const keys = documents.flatMap(documentId => {
        const base = `${prefix}{${encodeURIComponent(documentId)}}`
        return [`${base}:current`, `${base}:newest`]
      })
      await client.del(...keys)
      await client.quit()
    }
  })
})
