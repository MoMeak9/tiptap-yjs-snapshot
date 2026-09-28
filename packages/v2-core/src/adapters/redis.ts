import type { RevisionJob } from '../ports'
import type { DelayedJobMarker, DelayedJobRegistry, RevisionQueueDriver } from './scheduler'

/** The standard Redis 6.2+ commands used by this registry. ioredis Redis/Cluster fit this shape. */
export interface RedisDelayedJobClient {
  eval(script: string, numberOfKeys: 2, currentKey: string, newestKey: string, ...args: string[]): Promise<unknown>
  getdel(key: string): Promise<string | null>
}

export interface RedisDelayedJobRegistryOptions {
  /** Include any separator in the prefix. The default is `revision:delayed-job:`. */
  readonly keyPrefix?: string
}

/** Both keys carry the same per-document hash tag for Redis Cluster. */
const REGISTER_NEWEST_SCRIPT = `
local newest = redis.call('GET', KEYS[2])
if newest then
  local ok, previous = pcall(cjson.decode, newest)
  if ok and type(previous) == 'table' then
    local previousTime = tonumber(previous.enqueuedAt)
    local proposedTime = tonumber(ARGV[2])
    if previousTime and (previousTime > proposedTime or
      (previousTime == proposedTime and tostring(previous.jobId) >= ARGV[3])) then
      return 0
    end
  end
end
redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[4])
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[4])
return 1
`

const RESTORE_IF_ABSENT_SCRIPT = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
local restored = redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX')
if restored then return 1 end
return 0
`

function parseMarker(raw: string): DelayedJobMarker {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) throw new TypeError('Invalid delayed-job marker')
  const marker = parsed as Partial<DelayedJobMarker>
  if (typeof marker.jobId !== 'string' || !marker.jobId ||
    !Number.isSafeInteger(marker.enqueuedAt) ||
    !Number.isSafeInteger(marker.ttlMs) || (marker.ttlMs ?? 0) <= 0) {
    throw new TypeError('Invalid delayed-job marker')
  }
  return marker as DelayedJobMarker
}

/**
 * EVAL makes same-document registration newest-wins even when Queue.add resolves
 * out of order. GETDEL claims the current marker while a separate newest marker
 * remains. EVAL restore uses SET PX NX only if no newer job was ever registered.
 * The two keys share a per-document Redis Cluster hash slot.
 */
export function createRedisDelayedJobRegistry(
  redis: RedisDelayedJobClient,
  options: RedisDelayedJobRegistryOptions = {},
): DelayedJobRegistry {
  const keyPrefix = options.keyPrefix ?? 'revision:delayed-job:'
  const keys = (documentId: string) => {
    if (!documentId) throw new RangeError('documentId must be nonempty')
    const base = `${keyPrefix}{${encodeURIComponent(documentId)}}`
    return { current: `${base}:current`, newest: `${base}:newest` }
  }
  return {
    async set(documentId, jobId, enqueuedAt, ttlMs) {
      if (!Number.isSafeInteger(enqueuedAt) || enqueuedAt < 0) throw new RangeError('enqueuedAt must be a nonnegative integer')
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError('ttlMs must be positive and finite')
      const ttl = Math.ceil(ttlMs)
      const marker: DelayedJobMarker = { jobId, enqueuedAt, ttlMs: ttl }
      const { current, newest } = keys(documentId)
      const result = await redis.eval(
        REGISTER_NEWEST_SCRIPT, 2, current, newest,
        JSON.stringify(marker), String(enqueuedAt), jobId, String(ttl),
      )
      return result === 1
    },
    async take(documentId) {
      const raw = await redis.getdel(keys(documentId).current)
      return raw === null ? null : parseMarker(raw)
    },
    async restore(documentId, marker) {
      const { current, newest } = keys(documentId)
      const result = await redis.eval(
        RESTORE_IF_ABSENT_SCRIPT, 2, current, newest,
        JSON.stringify(marker), String(marker.ttlMs),
      )
      return result === 1
    },
  }
}

/** Minimal BullMQ Job and Queue shapes; no BullMQ runtime dependency is required. */
export interface BullMQRevisionJob {
  readonly data: RevisionJob
  remove(): Promise<unknown>
}

export interface BullMQRevisionQueue {
  add(kind: 'delayed' | 'create', data: RevisionJob, options: { delay: number }): Promise<{ readonly id?: string }>
  getJob(jobId: string): Promise<BullMQRevisionJob | null | undefined>
}

/** Adapts normal BullMQ Queue.add/getJob and Job.remove to the scheduler port. */
export function createBullMQRevisionQueueDriver(queue: BullMQRevisionQueue): RevisionQueueDriver {
  return {
    async add(kind, job, delayMs) {
      const added = await queue.add(kind, job, { delay: delayMs })
      return added.id ?? null
    },
    async get(jobId) {
      const found = await queue.getJob(jobId)
      if (!found) return null
      return {
        job: found.data,
        remove: async () => { await found.remove() },
      }
    },
  }
}
