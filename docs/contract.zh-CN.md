# V2 修订历史参考契约

本仓库是可运行的原创参考实现，抽取现行 V2 修订历史链路的可移植部分。它只在本机单进程运行，不包含业务鉴权、员工信息、分布式队列或多实例同步。[提取范围](v2-extraction.zh-CN.md)列出源方案与本地适配层的差异。

## 数据与行为

- 正文使用 Yjs `XmlFragment('default')`，标题使用 `Y.Text('title')`。两者一起进入完整的 `Y.encodeStateAsUpdateV2` 状态。`Y.encodeSnapshotV2` 只是轻量快照元数据，不能单独恢复正文。
- 服务端持久化当前 V2 状态、规范化 Tiptap JSON、标题、SHA-256 内容哈希与修订计数。每个新修订版本保存同源完整 V2 状态、不可变 JSON、标题、哈希、schema 版本及来源格式 `v2_json`。恢复时配对使用 `Y.applyUpdateV2`。
- 手动创建总会留下版本，即使内容未变化。自动物化只在当前状态完成持久化后安排，最后连接断开时可提前触发；按正文语义哈希及标题去重，写入时再次检查。
- `GET /api/revisions/list` 使用 `(version DESC, id DESC)` 游标分页，只向客户端返回修订元数据；`GET /api/revisions/detail` 优先读取不可变 JSON。详情 ID `current-<documentId>` 表示当前文档，不属于版本列表。本机文件存储会将整份记录载入内存，生产数据库应对列表仅选元数据。
- 前端实时编辑器绑定当前 Y.Doc。打开历史时锁定实时正文、标题与工具栏；历史预览使用独立、只读的实例和服务端返回的 JSON，不修改实时编辑器。比较逻辑只覆盖本示例的 StarterKit schema。
- 恢复从目标版本完整 V2 状态创建新的 Y.Doc 并替换当前状态，记录恢复前保护版本及恢复来源。以 `document.reset` 和 WebSocket 4205 关闭旧会话，客户端销毁旧 Y.Doc/编辑器并重新连接。示例传输额外使用 epoch 拒绝旧连接更新；epoch 不属于 V2 REST 合同。
- 所有写入对同一文档串行化，并用同目录临时文件加原子重命名持久化当前状态与版本列表。示例仅保证单进程文件存储的原子性。

正文变化的最小契约示例（标题另存在 `Y.Text('title')` 中）：

```json
{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"初稿"}]}]}
```

编辑后的 JSON：

```json
{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"第二稿"}]}]}
```

两个 JSON 均须通过同一套 StarterKit schema 与 Yjs `default` 片段往返，恢复指定版本后正文和标题应与该版本语义一致。HTML/Markdown 不在示例写入链路中，也不承诺无损转换。

## 示例接口

所有 HTTP 成功响应为 `{ "code": 0, "data": ... }`，错误返回非零 code 和 message。文档由 `doc_id` 查询参数选择，默认演示文档为 `demo`。

| 方法 | 路径 | 输入 | 输出 |
| --- | --- | --- | --- |
| GET | `/api/revisions/list` | `doc_id`, `limit`, `cursor?` | `{ data, nextCursor, hasMore }` |
| GET | `/api/revisions/detail` | `doc_id`, `id`（修订 ID 或 `current-<documentId>`） | 修订元数据、`title`、`content`、`contentHash`、可用性 |
| POST | `/api/revisions/create` | `doc_id`, `{ name? }` | `{ id, version }` |
| POST | `/api/revisions/restore` | `doc_id`, `{ id }` | `{ id }` |

列表项至少包含 `id`、`documentId`、`version`、`name`、`type`、`title`、`ctime`（毫秒时间戳）、`availability`、`diffEligible`、`restorable`。游标为不透明 base64url 编码；调用方不得从中推导业务含义。V2 可用性定义为 `ready`、`legacy_pending`、`legacy_failed`、`deleted`；此本地适配层没有删除模型，因此不会产生 `deleted`。是否可比较与是否有完整恢复状态分别由 `diffEligible`、`restorable` 表示。此示例对已验证解码失败的旧状态会关闭恢复入口，以免重复执行必然失败的请求。示例没有真实人员目录和逐处归属数据，相应字段应为空或 `null`，不能从建版人推断正文作者。

前一个演示版本的 `GET /api/revisions/current` 暂保留为本地兼容路由，供旧客户端读取 epoch；它不属于 V2 历史 API。新前端统一调用 `detail?id=current-<documentId>`。

WebSocket `/collaboration?doc_id=...` 连接时服务端发送 `{type:'sync', epoch, update:<base64 V2>}`。客户端编辑时发送 `{type:'update', epoch, update:<base64 V2>}`，服务端广播到同文档的其他连接。恢复时先发送 `document.reset`，再以 4205 关闭旧连接；客户端重新创建 Y.Doc 并连接。这里的 epoch 只是本地传输实现，不是 V2 API 字段。

## 兼容性与边界

示例只支持 StarterKit 的基础节点和 mark；加入自定义节点时，前后端需同步 schema，并验证 JSON↔Yjs 往返。历史 JSON 无法识别的节点不应静默写回实时文档。

本示例没有线上鉴权、授权、多实例协同、离线 IndexedDB、真实归属信息或生产级队列。部署到多人环境前，需要把这些能力补齐；特别是恢复后必须清理任何离线缓存，以免旧状态重新合并。示例会兼容自身前一个版本写下的文件，不能当作源系统 V1 迁移方案。

无效文档 ID、游标、修订 ID、名称或请求体应返回 4xx；跨文档修订按不存在处理，不得读取其他文档内容。目标状态解码失败时不写入新当前状态。本示例要求恢复前保护版本成功落盘才继续；这是明确的安全性强化，与源方案的尽力而为审计不同。旧客户端与既有业务库迁移需要单独设计。
