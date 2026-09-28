# 快照示例契约

本仓库是可运行的原创参考实现，抽取当前 V2 修订历史链路的可移植部分。它只在本机单进程运行，不包含业务鉴权、员工信息、消息队列或多实例同步。

## 数据与行为

- 正文使用 Yjs `XmlFragment('default')`，标题使用 `Y.Text('title')`。两者一起进入完整的 `Y.encodeStateAsUpdateV2` 状态。`Y.encodeSnapshotV2` 只是轻量快照元数据，不能单独恢复正文。
- 服务端持久化当前 V2 状态。每个修订版本保存完整 V2 状态、标题、从相同状态导出的 Tiptap JSON、规范化内容的 SHA-256 哈希和版本元数据。恢复时配对使用 `Y.applyUpdateV2`。
- 手动创建总会留下版本，即使内容未变化。自动创建只在当前状态完成持久化后触发，并按正文语义哈希及标题去重。
- `GET /api/revisions/list` 使用游标分页，只向客户端返回修订元数据；`GET /api/revisions/detail` 才转换并返回正文。本机文件存储会将整份文档记录载入内存，生产数据库应对列表使用仅选元数据的查询。
- 前端实时编辑器绑定当前 Y.Doc。历史预览使用独立、只读的 Tiptap 实例和服务端返回的 JSON，不修改实时编辑器。
- 恢复先持久化恢复前保护版本，失败则拒绝恢复；然后从目标版本完整 V2 状态创建新的 Y.Doc，持久化，增加 epoch，并以 WebSocket 4205 关闭旧会话。客户端销毁旧 Y.Doc/编辑器并重新连接。带旧 epoch 的更新会被拒绝。
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
| GET | `/api/revisions/detail` | `doc_id`, `id` | 修订元数据、`title`、`content`、`contentHash` |
| GET | `/api/revisions/current` | `doc_id` | 当前标题、正文 JSON、语义哈希 |
| POST | `/api/revisions/create` | `doc_id`, `{ name? }` | `{ id, version }` |
| POST | `/api/revisions/restore` | `doc_id`, `{ id }` | `{ id }` |

WebSocket `/collaboration?doc_id=...` 连接时服务端发送 `{type:'sync', epoch, update:<base64 V2>}`。客户端编辑时发送 `{type:'update', epoch, update:<base64 V2>}`，服务端广播到同文档的其他连接。恢复后旧连接以 4205 关闭，客户端重新创建 Y.Doc 并连接。

## 兼容性与边界

示例只支持 StarterKit 的基础节点和 mark；加入自定义节点时，前后端需同步 schema，并验证 JSON↔Yjs 往返。历史 JSON 无法识别的节点不应静默写回实时文档。

本示例没有线上鉴权、授权、多实例协同、离线 IndexedDB、归属信息、旧 V1 数据迁移和生产级队列。部署到多人环境前，需要把这些能力补齐；特别是恢复后必须清理任何离线缓存，以免旧状态重新合并。

无效文档 ID、游标、修订 ID、名称或请求体应返回 4xx；跨文档修订按不存在处理，不得读取其他文档内容。恢复前备份或目标状态解码失败时，不写入新当前状态。示例只面向新写入的数据；旧客户端与既有业务库迁移需要单独设计。
