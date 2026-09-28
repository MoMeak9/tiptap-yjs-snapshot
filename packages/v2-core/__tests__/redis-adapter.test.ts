import { describe, expect, it } from 'vitest'
import {
  createBullMQRevisionQueueDriver,
  createRedisDelayedJobRegistry,
  type RevisionJob,
} from '../src/index'

const job: RevisionJob = { documentId: 'doc-public', source: 'auto', enqueuedAt: 100 }

function fakeRedis() {
  const values = new Map<string, string>()
  const commands: Array<{ script: string; keyCount: number; keys: string[]; args: string[] }> = []
  const client = {
    eval: async (script: string, keyCount: number, currentKey: string, newestKey: string, ...args: string[]) => {
      commands.push({ script, keyCount, keys: [currentKey, newestKey], args })
      const incoming = JSON.parse(args[0]!) as { jobId: string; enqueuedAt: number }
      if (args.length === 4) {
        const raw = values.get(newestKey)
        const previous = raw ? JSON.parse(raw) as typeof incoming : null
        if (previous && (previous.enqueuedAt > incoming.enqueuedAt ||
          (previous.enqueuedAt === incoming.enqueuedAt && previous.jobId >= incoming.jobId))) return 0
        values.set(newestKey, args[0]!)
        values.set(currentKey, args[0]!)
        return 1
      }
      if (values.get(newestKey) !== args[0] || values.has(currentKey)) return 0
      values.set(currentKey, args[0]!)
      return 1
    },
    getdel: async (key: string) => {
      const value = values.get(key) ?? null
      values.delete(key)
      return value
    },
  }
  return { client, values, commands }
}

describe('standard Redis delayed-job registry', () => {
  it('uses same-slot EVAL registration and atomic GETDEL with a configurable key prefix', async () => {
    const { client, commands } = fakeRedis()
    const registry = createRedisDelayedJobRegistry(client, { keyPrefix: 'history:delayed:' })

    expect(await registry.set('doc-public', 'job-old', 100, 450.2)).toBe(true)
    expect(await registry.take('doc-public')).toEqual({ jobId: 'job-old', enqueuedAt: 100, ttlMs: 451 })
    expect(await registry.take('doc-public')).toBeNull()
    expect(commands).toHaveLength(1)
    expect(commands[0]?.keyCount).toBe(2)
    expect(commands[0]?.keys).toEqual([
      'history:delayed:{doc-public}:current',
      'history:delayed:{doc-public}:newest',
    ])
    expect(commands[0]?.args).toEqual([
      JSON.stringify({ jobId: 'job-old', enqueuedAt: 100, ttlMs: 451 }),
      '100', 'job-old', '451',
    ])
    expect(commands[0]?.script).toContain("redis.call('SET'")
    expect(commands[0]?.script).toContain("'PX'")
  })

  it('does not restore an old claim after a newer registration is itself consumed', async () => {
    const { client } = fakeRedis()
    const registry = createRedisDelayedJobRegistry(client)
    await registry.set('doc-public', 'job-old', 100, 500)
    const claimed = await registry.take('doc-public')
    expect(claimed?.jobId).toBe('job-old')
    await registry.set('doc-public', 'job-new', 200, 500)
    expect((await registry.take('doc-public'))?.jobId).toBe('job-new')
    expect(await registry.restore('doc-public', claimed!)).toBe(false)
    expect(await registry.take('doc-public')).toBeNull()
  })

  it('rejects an older delayed registration even when its queue add finishes later', async () => {
    const { client } = fakeRedis()
    const registry = createRedisDelayedJobRegistry(client)
    expect(await registry.set('doc-public', 'job-new', 200, 500)).toBe(true)
    expect(await registry.set('doc-public', 'job-old', 100, 500)).toBe(false)
    expect((await registry.take('doc-public'))?.jobId).toBe('job-new')
  })

  it('breaks equal enqueue-time ties consistently by job ID', async () => {
    const { client } = fakeRedis()
    const registry = createRedisDelayedJobRegistry(client)
    expect(await registry.set('doc-public', 'job-a', 100, 500)).toBe(true)
    expect(await registry.set('doc-public', 'job-z', 100, 500)).toBe(true)
    expect(await registry.set('doc-public', 'job-m', 100, 500)).toBe(false)
    expect((await registry.take('doc-public'))?.jobId).toBe('job-z')
  })
})

describe('BullMQ-compatible queue driver', () => {
  it('passes delayed and immediate jobs through normal queue methods', async () => {
    const calls: unknown[][] = []
    const queue = {
      add: async (kind: 'delayed' | 'create', data: RevisionJob, options: { delay: number }) => {
        calls.push(['add', kind, data, options])
        return { id: kind === 'delayed' ? 'job-delayed' : 'job-immediate' }
      },
      getJob: async (id: string) => {
        calls.push(['getJob', id])
        return { data: job, remove: async () => { calls.push(['remove', id]) } }
      },
    }
    const driver = createBullMQRevisionQueueDriver(queue)

    expect(await driver.add('delayed', job, 500)).toBe('job-delayed')
    expect(await driver.add('create', job, 0)).toBe('job-immediate')
    const pending = await driver.get('job-delayed')
    expect(pending?.job).toEqual(job)
    await pending?.remove()
    expect(calls).toEqual([
      ['add', 'delayed', job, { delay: 500 }],
      ['add', 'create', job, { delay: 0 }],
      ['getJob', 'job-delayed'],
      ['remove', 'job-delayed'],
    ])
  })
})
