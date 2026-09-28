# V2 revision-history core and backend adapters

English · [简体中文](README.md)

This package extracts revision-history **write decisions and lifecycle** from a particular service framework. It works with ProseMirror JSON, the Tiptap Transformer, and Yjs V2 updates. Public interfaces accept the database, durable queue, room reset, and notification integrations. `schema.postgres.sql` and `PostgresDocumentStore` / `PostgresRevisionStore` provide PostgreSQL reference adapters.

[Outline](https://github.com/outline/outline) is a design reference for delayed revisions, body-and-title deduplication, virtual current revisions, and metadata-only lists. Full Yjs V2 state plus JSON, cursors, and live restore are this project's adaptations. This package does not vendor Outline source code. See [repository-level provenance](../../docs/v2-extraction.en.md) and licenses ([Outline BSL 1.1](https://github.com/outline/outline/blob/main/LICENSE), [this repository MIT](../../LICENSE)).

```sh
npm ci --registry=https://registry.npmmirror.com/
npm run test --workspace=@tiptap-yjs-snapshot/v2-core
npm run build --workspace=@tiptap-yjs-snapshot/v2-core
```

## Data contract

- `state` is the complete `Y.encodeStateAsUpdateV2(doc)` output. Restore decodes it with `Y.applyUpdateV2` to derive JSON, but writes back the revision's **original state bytes**.
- The body is in Yjs's `default` fragment and the title in `Y.Text('title')`. If state has no title, restore keeps the current title; an empty title in state overwrites it.
- `contentJson` and `contentHash` come from the **same** ProseMirror schema round trip, stable field ordering, recursive attribute-key sorting, and SHA-256. The host injects its schema; the package has no product node types or private converter.
- Unknown nodes or marks take a still deterministic tolerant canonicalization path and report type names through `unknownTypes` for alerting. For structurally invalid input, V2 fields are not written and `revisionCount` does not advance; the caller may still persist raw state. Logs contain error classes and type names only.
- `revisionCount` increases only for a business change in canonical body hash or title. `mtime` remains unchanged without such a change. `prepareWrite` does CPU work outside the lock; `commitWrite` reads the baseline and writes under the document lock.
- An automatic revision performs a cheap deduplication check and then rereads the latest revision under the document row lock; the latter is authoritative. Manual revisions are bookmarks and always insert. Versions start at 0 and rise monotonically per document; `ctime` is at least 1 ms later than the previous revision.
- Each revision explicitly stores fixed `source_format='v2_json'` for storage auditing and later format evolution. It does not change public list or detail responses.
- Lists use a `(version DESC, id DESC)` cursor. They fetch metadata and `content/state` presence without loading body JSON or binary state. Detail can address `current-<documentId>` and validates that its ID matches the authorized document.
- Lists map contributors to `{username,nickname}`. `resolveDisplayNames` can batch-resolve display names and falls back to stable IDs on failure. Restore revisions expose `restoredFromVersion`. `restore()` returns `{id}` where `id` is the requested target revision; the audit revision is stored separately.
- `RoomReset.flushAndReset` must gate new room loads during restore, flush the active document, perform the database replacement, broadcast reset, and close active connections. After `snapshot restored to <id>, reconnect required`, clients clear the local Yjs cache and reconnect.

## PostgreSQL integration

Apply [`schema.postgres.sql`](./schema.postgres.sql) with your migration tool, then inject any PostgreSQL driver compatible with `SqlPool`. The following wraps `pg`; this package does not require `pg` as a dependency.

```ts
import { Pool } from 'pg'
import {
  PostgresDocumentStore,
  PostgresRevisionStore,
  type SqlPool,
} from '@tiptap-yjs-snapshot/v2-core'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const sql: SqlPool = {
  query: (text, values) => pool.query(text, values),
  connect: async () => {
    const client = await pool.connect()
    return {
      query: (text, values) => client.query(text, values),
      release: () => client.release(),
    }
  },
}

const documents = new PostgresDocumentStore(sql)
const revisions = new PostgresRevisionStore(sql)
```

`DocumentStore.transaction` and `RevisionStore.insert/latest` use the **same connection**. The adapter starts `READ COMMITTED` transactions and locks the document row with `SELECT ... FOR UPDATE`. SQL assigns the revision version and monotonic `ctime` at insertion. Another database adapter must preserve these constraints. All writers, including body persistence, manual revisions, restore, and queue materialization, should acquire the same document lock.

If an `IntervalPort` is injected, the PostgreSQL adapter's `mergeInterval` merges contributors into the winning revision when a concurrent deduplication check yields, without advancing `mtime`. Merging two nonempty per-position attributions requires a host merge function passed as `PostgresRevisionStore(pool, mergeAttribution)`. Without one, the transaction throws and the claimed interval is returned rather than attaching an incorrect author.

## Queue and room integration

`createDurableScheduler` needs a shared durable queue and a cross-instance TTL registry. The public package provides `createBullMQRevisionQueueDriver` and `createRedisDelayedJobRegistry` as standard adapters. They use structural interfaces, so BullMQ and ioredis are not package runtime dependencies. The host may provide a compatible BullMQ Queue and ioredis Redis/Cluster instance, or implement the two ports differently.

The Redis registry uses standard `EVAL` scripts to register the newest job per document by `enqueuedAt`. Atomic [`GETDEL`](https://redis.io/docs/latest/commands/getdel/) claims a marker for cancellation; after a queue failure, the registry restores it only when no newer marker has appeared. Redis 6.2+ is required. The queue adapter uses normal BullMQ `add/getJob` and Job `remove`. The public generic integration needs none of the source environment's proxy-specific command workarounds (`EVALSHA`, `CLIENT SETNAME`, `MULTI/EXEC`, `INFO`); `EVAL` here is a standard Redis atomic compare-and-write.

```ts
import {
  createBullMQRevisionQueueDriver,
  createDurableScheduler,
  createRedisDelayedJobRegistry,
  type RoomReset,
} from '@tiptap-yjs-snapshot/v2-core'

// `queue` is a host-created BullMQ Queue; `redis` is its own ioredis client.
const registry = createRedisDelayedJobRegistry(redis, {
  keyPrefix: 'revision:delayed-job:',
})
const driver = createBullMQRevisionQueueDriver(queue)
const scheduler = createDurableScheduler(driver, registry)

const roomReset: RoomReset = {
  flushAndReset: (documentId, reason, persist) =>
    roomGate.withExclusive(documentId, async () => {
      await collaboration.flushActiveDocument(documentId)
      await persist()
      await collaboration.broadcastReset(documentId, reason)
      await collaboration.disconnectLocalClients(documentId, reason)
    }),
}
```

`roomGate`, `collaboration`, `queue`, and `redis` are host-provided instances. `roomGate` must cover every writer and room loader for the same document, and cross-instance broadcasts must reach other servers. If browsers hold offline copies, reset must clear the document's IndexedDB copy. Replacing database state alone leaves old connected Y.Docs able to merge pre-restore content back.

With Redis Cluster, configure the BullMQ Queue and Worker with the same BullMQ `prefix` containing one hash tag, such as `{revision-history}`, so the queue's multi-key operations use one slot. Do not substitute ioredis `keyPrefix` for BullMQ `prefix`. The registry's `keyPrefix` is separate from the queue prefix. Each document has `:current` and `:newest` keys sharing one per-document hash tag, keeping its two-key `EVAL` in one slot. `GETDEL` touches only `:current`. See BullMQ's [Redis Cluster guide](https://docs.bullmq.io/patterns/redis-cluster) and [connection guide](https://docs.bullmq.io/guide/connections).

This Redis adapter covers delayed-job registration only. It does not enable document or awareness replication between collaboration servers; `RoomReset` and any collaboration synchronization remain independent host responsibilities.

## Collaboration persistence and job processing

```ts
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TiptapTransformer } from '@hocuspocus/transformer'
import * as Y from 'yjs'
import { V2HistoryService } from '@tiptap-yjs-snapshot/v2-core'

const history = new V2HistoryService({
  schema: getSchema([StarterKit]),
  documents,
  revisions,
  scheduler,
  roomReset,
  failureMarker, // Host-provided cross-instance marker for stale hashes after canonicalization failure.
  interval,      // Optional Yjs contributor and deletion-attribution interval claim/restore.
  events,        // Optional; notification failure does not roll back a persisted revision.
})

async function onStoreDocument(documentId: string, doc: Y.Doc, actorId?: string) {
  const content = TiptapTransformer.fromYdoc(doc, 'default')
  const state = Y.encodeStateAsUpdateV2(doc)
  const title = doc.share.has('title') ? doc.getText('title').toString() : undefined
  const prepared = history.prepareWrite({
    documentId,
    writePath: 'collaboration_store',
    persistenceV2Enabled: true,
    content,
    ...(title === undefined ? {} : { title }),
    actor: actorId,
  })
  await history.commitWrite(prepared, (fields, client) => client.write(documentId, {
    state,
    ...(title === undefined ? {} : { title }),
    ...fields,
  }))
  await history.scheduleDelayed(documentId)
}

async function onLastDisconnect(documentId: string) {
  await collaboration.flushActiveDocument(documentId)
  await history.scheduleImmediate(documentId)
}

async function processQueueJob(kind: 'delayed' | 'create', data: {
  documentId: string; source: 'auto' | 'open_api'; enqueuedAt: number
}) {
  if (kind === 'delayed') await history.processDelayed(data)
  else await history.materialize(data)
}
```

The HTTP layer must authorize access, construct `DocumentContext` from a verified identity/document relationship, and then call `history.list/detail/createManual/restore`. Never trust the client-supplied document ID on its own. To integrate authorship, an `IntervalPort` consumes a claimed interval after a successful write and returns it on failure, stale hash, or lack of a merge target. It can use the host's existing Yjs attribution and deletion-event records; the package assumes no particular identity system.

## Source-practice mapping

| V2 source implementation | Public implementation |
| --- | --- |
| `history-core/canonicalize`, `content-hash`, `schema-version` | `canonical.ts`: injected schema, coherent JSON/hash, explicit version gate |
| `revision-persistence/document-history-fields` `prepareDocumentHistoryWrite` / `commitDocumentHistoryWrite` | `document-history.ts`: canonicalization outside the lock and business-change decision under it |
| `revision-queue/revision-dedup`, `revision-queue.processor` | `service.ts` `shouldCreateRevision`, `processDelayed`, `materialize` |
| `revision-persistence/revision-insert` | `PostgresRevisionStore.insert`: unified columns, database-assigned version and `ctime` |
| `revision-manual.service` | `V2HistoryService.createManual` |
| `revision-list/revision-cursor`, `revision-current`, `revision-list.service`, `revision-detail.service` | `cursor.ts`, `V2HistoryService.list/detail` |
| Restore flow in `snapshot.service` | `V2HistoryService.restore` + `RoomReset.flushAndReset` + `yjsV2StateCodec` |

The package contains V2 revision read/write behavior and PostgreSQL/durable-scheduling practice. The host integrates its node schema, real identity and attribution extraction, room broadcast, and queue driver. These interfaces intentionally contain no private SDK, internal URL, real user, or document data.

The source queue used proxy-specific compatibility handling. The public BullMQ + Redis 6.2+ adapter is a generic modernization for standard environments, not a line-for-line port of that queue factory. See [extraction scope](../../docs/v2-extraction.en.md) for broader source mapping.
