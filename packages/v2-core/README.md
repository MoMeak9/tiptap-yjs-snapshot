# V2 修订历史核心与后端适配

这个包把修订历史的**写入判定和生命周期**从具体服务框架中抽出。它直接使用 ProseMirror JSON、Tiptap Transformer 和 Yjs V2 update；数据库、持久队列、房间重置、通知由公开接口注入。仓库内的 `schema.postgres.sql` 与 `PostgresDocumentStore` / `PostgresRevisionStore` 是可运行环境的数据库参考实现。

```sh
npm install --registry=https://registry.npmmirror.com
npm run test --workspace=@tiptap-yjs-snapshot/v2-core
npm run build --workspace=@tiptap-yjs-snapshot/v2-core
```

## 数据契约

- `state` 是 `Y.encodeStateAsUpdateV2(doc)` 的完整状态。恢复时用 `Y.applyUpdateV2` 解码以派生 JSON，但把修订中**原始 state 字节**写回文档。
- 正文位于 Yjs `default` fragment；标题位于 `Y.Text('title')`。state 中没有标题时，恢复保留当前标题；空标题则覆盖当前标题。
- `contentJson` 与 `contentHash` 来自**同一次** ProseMirror schema round-trip、固定字段顺序、递归 attr 排序和 SHA-256。schema 由接入方注入，包不含业务节点或私有 converter。
- 遇到未知节点或 mark，改用仍然字节确定的 tolerant 规范化，并通过 `unknownTypes` 输出类型名供告警。结构非法时，V2 字段整组不写、`revisionCount` 不推进；调用方仍可持久化原始 state。日志只写错误类别和类型名。
- `revisionCount` 只在规范化正文哈希或标题发生业务变化时递增。没有业务变化时，保留原 `mtime`。`prepareWrite` 在锁外完成 CPU 工作；`commitWrite` 在文档锁下读基线并写入。
- 自动修订先做廉价判重，拿文档行锁后再次读最新修订，后者才是权威判断。手动修订是书签，每次请求都写一条。修订 version 从 0 开始，每篇文档单调递增；ctime 至少比上一条大 1ms。
- 每条修订显式记录固定的 `source_format='v2_json'`，便于存储审计和后续格式演进；它不影响公开列表与详情响应。
- 列表按 `(version DESC, id DESC)` 使用 cursor。列表只取元数据和 `content/state` 存在性，不载入正文或二进制。详情可寻址 `current-<documentId>`，服务层验证其中的 ID 与已授权文档一致。
- 列表把贡献者映射为 `{username,nickname}`，`resolveDisplayNames` 可批量补充展示名，失败时回退稳定 ID；恢复修订通过 `restoredFromVersion` 标注来源。`restore()` 返回 `{id}`，其中 id 是请求恢复的目标版本，审计版本只写入存储。
- `RoomReset.flushAndReset` 必须在恢复时阻止新房间加载，先刷新活跃文档，再运行数据库替换，广播 reset 并断开活跃连接。客户端收到 `snapshot restored to <id>, reconnect required` 后需清理本地 Yjs 缓存再重连。

## 接入 PostgreSQL

先执行 [`schema.postgres.sql`](./schema.postgres.sql)，再把任意兼容 `SqlPool` 的 PostgreSQL 驱动传入适配器。下面以 `pg` 说明连接包装；包本身不强制安装 `pg`。

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

`DocumentStore.transaction` 与 `RevisionStore.insert/latest` 使用**同一连接**。适配器开启 `READ COMMITTED` 事务，并以 `SELECT ... FOR UPDATE` 锁住文档行；写入修订时 SQL 计算 version 和单调 ctime。换数据库时必须保留这三项约束。所有写入方，包括文档正文、手动修订、恢复和队列物化，都应先取同一文档锁。

若注入 `IntervalPort`，PostgreSQL 适配器的 `mergeInterval` 会在并发判重让位时把贡献者并入胜出修订，不推进 `mtime`。两个非空的逐处归属需要调用方提供 `PostgresRevisionStore(pool, mergeAttribution)` 的合并函数；若没有提供，事务抛错，已领取区间会被归还，避免错签。

## 接入队列与房间

`createDurableScheduler` 需要共享持久队列和带 TTL 的跨实例登记表。BullMQ + Redis 是一种实现；这里的包装只使用其普通 `add/getJob/remove` 和 Redis `get/set/del` 行为。

```ts
import { createDurableScheduler, type RoomReset } from '@tiptap-yjs-snapshot/v2-core'

const scheduler = createDurableScheduler(
  {
    add: async (kind, job, delayMs) => {
      const added = await queue.add(kind, job, { delay: delayMs })
      return added.id == null ? null : String(added.id)
    },
    get: async id => {
      const found = await queue.getJob(id)
      return found ? { job: found.data, remove: () => found.remove() } : null
    },
  },
  {
    set: async (documentId, jobId, ttlMs) => {
      await redis.set(`revision:delayed:${documentId}`, jobId, 'PX', ttlMs)
    },
    get: documentId => redis.get(`revision:delayed:${documentId}`),
    delete: async documentId => { await redis.del(`revision:delayed:${documentId}`) },
  },
)

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

`roomGate`、`collaboration`、`queue` 和 `redis` 是宿主应用提供的实例。`roomGate` 需要覆盖同一文档的全部写方与房间加载方；跨实例广播必须能到达别的服务器。若有浏览器离线副本，reset 事件还须清理 IndexedDB 中对应文档的副本。不能仅替换数据库 state：已连接的旧 Y.Doc 会把恢复前内容再次合并回去。

## 协同保存与任务处理

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
  failureMarker, // 例如 Redis；记录 canonicalize 结构失败时的陈旧哈希
  interval,      // 可选：Yjs 贡献者与删除归属区间的 claim/restore
  events,        // 可选：通知失败不回滚已写入修订
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

HTTP 层必须先完成鉴权，然后从已验证的身份与文档关系构造 `DocumentContext`，调用 `history.list/detail/createManual/restore`。不要直接信任客户端传入的文档 ID。`IntervalPort` 如果要接入作者归属，需要在写入成功后消费区间；失败、陈旧哈希或无可合并目标时归还。它可以使用应用已有的 `PermanentUserData` 与删除事件记录，包不假设具体身份系统。

## 源实践映射

| V2 源实现符号 | 本包对应实现 |
| --- | --- |
| `history-core/canonicalize`, `content-hash`, `schema-version` | `canonical.ts`，schema 注入、同次 JSON/哈希、显式版本门禁 |
| `revision-persistence/document-history-fields` 的 `prepareDocumentHistoryWrite` / `commitDocumentHistoryWrite` | `document-history.ts`，锁外规范化与锁内业务变化判定 |
| `revision-queue/revision-dedup`, `revision-queue.processor` | `service.ts` 的 `shouldCreateRevision`、`processDelayed`、`materialize` |
| `revision-persistence/revision-insert` | `PostgresRevisionStore.insert`，统一列清单、数据库侧 version / ctime |
| `revision-manual.service` | `V2HistoryService.createManual` |
| `revision-list/revision-cursor`, `revision-current`, `revision-list.service`, `revision-detail.service` | `cursor.ts`、`V2HistoryService.list/detail` |
| `snapshot.service` 的恢复链路 | `V2HistoryService.restore` + `RoomReset.flushAndReset` + `yjsV2StateCodec` |

本包包含纯 V2 修订写读与 PostgreSQL / 持久调度实践。业务节点 schema、真实身份与归属提取、房间广播和队列驱动由宿主接入；这些接口刻意不含私有 SDK、内部 URL、真实用户或文档数据。
