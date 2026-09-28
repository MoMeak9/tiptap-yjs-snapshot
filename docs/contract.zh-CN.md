# V2 修订历史数据与接口契约

本仓库公开从现有 V2 修订历史链路适配的前后端实践代码，并附本机运行的集成演示。本页区分**可复用包的接口**与 **`src/` 演示的 HTTP/WebSocket**。来源模块、脱敏与通用环境改造见 [提取范围](v2-extraction.zh-CN.md)。

## 核心数据不变量

- 正文使用 Yjs `XmlFragment('default')`，标题使用 `Y.Text('title')`。可恢复版本保存整个 `Y.encodeStateAsUpdateV2(doc)` 的 state。恢复时以 `Y.applyUpdateV2` 解码作验证，持久化目标版本的原始 state；轻量 `Y.encodeSnapshotV2` 元数据没有独立可恢复的正文。
- 当前文档持久化同源 state、规范化 Tiptap JSON、标题、SHA-256 内容哈希、schema 版本和修订计数。新写入修订行保存同源不可变 JSON、完整 state、标题、哈希和 `sourceFormat: 'v2_json'`。正文哈希与标题合并判断业务变化。
- 自动修订仅在当前状态持久化后调度。任务在文档锁外快速判重，拿锁后重新读取最新修订并再次判重。手动版本每次请求都写入，允许相同正文和标题。
- 列表按 `(version DESC, id DESC)` 分页，用不透明游标，只读取元数据和 JSON/state 是否存在；详情读取持久化 JSON。`current-<documentId>` 是当前文档的虚拟详情 ID，不进入修订列表。
- 恢复前按内容变化保存 `pre_restore` 保护版本，用目标原始 state 替换当前文档，并写入 `restore` 来源记录。在线旧房间和旧 Y.Doc 必须失效；客户端收到重置信号后重建编辑器、Y.Doc 与 provider，并清理该文档的离线缓存。

正文变化的最小 JSON 示例（标题单独保存在 `Y.Text('title')`）：

```json
{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"初稿"}]}]}
```

后续版本：

```json
{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"第二稿"}]}]}
```

这两份 JSON 应通过同一套宿主 schema 与 Yjs 正文片段往返。公开包由宿主注入 schema；本机演示使用 StarterKit。未知业务节点和 mark 需要接入方声明、迁移或处理 viewer 降级，不能静默写回实时文档。

## 可复用后端端口

`packages/v2-core/src/ports.ts` 定义以下边界：

| 端口 | 接入要求 |
| --- | --- |
| `DocumentStore` / `RevisionStore` | 同一文档的状态写入、修订插入与版本分配在同一事务连接和文档锁下完成；列表仅取元数据 |
| `Scheduler` | 延迟任务和立即物化任务需要持久化，并能在多实例间协调与取消 |
| `RoomReset` | 在恢复中阻止新房间加载，刷新活跃文档，执行替换，广播重置并断开所有实例的旧连接 |
| `V2StateCodec` | 从完整 V2 state 取得正文与可选标题，供恢复前校验与 JSON 派生 |
| `IntervalPort`、`EventPublisher`、失败标记 | 按需接入来源归属、事件和规范化故障恢复；不依赖特定身份目录或消息系统 |

包内 `PostgresDocumentStore`、`PostgresRevisionStore` 和 [`schema.postgres.sql`](../packages/v2-core/schema.postgres.sql) 给出数据库参考适配。`V2HistoryService` 实现 `prepareWrite` / `commitWrite`、调度和物化、`createManual`、`list`、`detail`、`restore`。宿主应先验证文档读写权限，再构造 `DocumentContext` 调用服务。包不自带生产 HTTP 控制器、鉴权或协同服务器。

前端 [`RevisionHistory`](../packages/revision-history/README.md) 扩展、API 客户端与控制器期望 V2 列表、详情、恢复响应。`RevisionTransportConfig` 可改文档 ID 查询键、令牌请求头、刷新信封头及路由。列表的每项至少包含 `id`、`documentId`、`version`、`name`、`type`、`title`、`ctime`、`availability`、`diffEligible`、`restorable`；详情还需 `content`、`contentHash`，可选归属数据。没有真实逐处归属时，应返回空值并让变更保持中性，不得从建版人推断文字作者。

## 本机演示 REST 接口

`src/server/` 提供下列参考路由。HTTP 成功响应为 `{ "code": 0, "data": ... }`，失败返回非零 `code` 和 `message`。`doc_id` 选择演示文档，省略时为 `demo`；它不代表已完成授权。本机服务默认只监听 `127.0.0.1`。

| 方法 | 路径 | 输入 | 成功响应的 `data` |
| --- | --- | --- | --- |
| GET | `/api/revisions/list` | `doc_id`、`limit`（1–100）、`cursor?` | `{ data, nextCursor, hasMore }`，其中 `data` 为元数据列表 |
| GET | `/api/revisions/detail` | `doc_id`、`id`（修订 ID 或 `current-<documentId>`） | 修订元数据、`content`、`contentHash`、可用性和归属 |
| POST | `/api/revisions/create` | `doc_id`、JSON `{ name? }` | `{ id, version }` |
| POST | `/api/revisions/restore` | `doc_id`、JSON `{ id }` | `{ id }` |

`POST /create` 是演示提供的手动建版接口，前端 `RevisionHistory` 包专注读取、比较和恢复，由宿主负责建版入口。演示只产生完整的原生 V2 修订，列表 `availability` 为 `ready`；`diffEligible` 和 `restorable` 分别表示能否比较与恢复。`sourceFormat` 与 state 存在服务端存储中，不随列表传输。当前文档详情使用 `id=current-<documentId>`，其 `restorable` 为 `false`。

WebSocket `/collaboration?doc_id=...` 在连接时发送 `{ type: 'sync', epoch, update: <base64 V2> }`；客户端编辑时发送 `{ type: 'update', epoch, update: <base64 V2> }`。恢复后服务端发 `document.reset` 并以 4205 关闭旧连接，客户端重新创建 Y.Doc。`epoch` 是演示适配器的旧连接围栏，不属于 REST 字段。真实协同服务可采用自己的跨实例重置实现，但必须达到旧状态无法回灌的效果。

## 兼容性与安全边界

公开包使用合成测试数据。宿主必须接入实际读写授权、事务数据库、可靠队列、跨实例房间重置和必要的离线缓存清理。演示的文件存储仅保证单进程接线；每次写入通过临时文件与原子重命名保存其自身格式，不自动转换其他存储格式。`PORT`、`DATA_DIR` 和 `FRONTEND_ORIGINS` 可按 [`.env.example`](../.env.example) 设置，演示对浏览器来源进行限制，但没有账号体系。

无效文档 ID、游标、修订 ID、名称和请求体返回 4xx；跨文档修订按不存在处理。解码目标 state 失败时不得替换当前文档。生产接入还须验证自定义 schema 的 JSON↔Yjs 往返、恢复后的离线客户端、队列重试与审计失败补偿。
