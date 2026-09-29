# V2 修订历史的前后端架构

[English](architecture.en.md) · 简体中文

本页描述公开的实践代码如何接入真实协同编辑服务，以及仓库中的本机演示如何验证链路。模块来源与适配边界见 [V2 提取范围](v2-extraction.zh-CN.md)，字段和 HTTP 示例见 [契约](contract.zh-CN.md)。

[Outline](https://github.com/outline/outline) 是延迟建版、正文与标题判重、虚拟当前版本、元数据列表和行内/块级差异的设计参考。本项目的 Yjs V2 state + JSON、CJK 差异、游标分页与在线恢复另有实现约束；详见 [来源说明](v2-extraction.zh-CN.md)。

## 1. 两份同源表示

编辑中的正文位于 `Y.XmlFragment('default')`，标题位于 `Y.Text('title')`。服务端从同一 Y.Doc 取得完整 `Y.encodeStateAsUpdateV2` 状态和 Tiptap JSON，再用接入方提供的 ProseMirror schema 规范化 JSON、计算语义哈希。正常 V2 写入时，当前文档与新修订行都保存 state 和 JSON；导入的历史修订也可以暂时只有完整 V2 state。JSON 用于历史阅读和差异，原始 state 用于恢复。单独的 `Y.encodeSnapshotV2` 元数据没有正文，不能作为可恢复版本。

```mermaid
flowchart TD
  LIVE[实时 Y.Doc] --> STATE[完整 Yjs V2 state]
  LIVE --> JSON[同源 Tiptap JSON]
  LIVE --> TITLE[标题]
  JSON --> CANON[Schema 规范化与 SHA-256]
  STATE --> CURRENT[当前文档存储]
  TITLE --> CURRENT
  CANON --> CURRENT
  CURRENT --> JOB[延迟或断连物化]
  JOB --> REV[新修订行: state + JSON]
  REV --> API[元数据列表 / JSON 详情]
  API --> UI[Lit 面板 + 独立只读查看器]
  REV --> RESTORE[目标 state 替换当前状态]
  RESTORE --> RESET[房间重置与客户端重连]
```

`packages/v2-core` 提供 `V2HistoryService`、规范化逻辑、Yjs V2 解码器和持久化端口。`schema.postgres.sql` 与 `PostgresDocumentStore` / `PostgresRevisionStore` 是 PostgreSQL 参考适配。协同传输、鉴权、队列实例和房间管理由宿主提供。`packages/revision-history` 提供前端 API、控制器、差异、Lit UI 和只读 viewer；宿主拥有实时编辑器及 provider。

## 2. 写入与建版

1. 协同服务收到更新后，在它管理的活跃 Y.Doc 中完成变更，从该状态同时取完整 V2 state、正文 JSON 和标题。
2. `prepareWrite` 在文档锁外进行 Schema 规范化、固定序列化和哈希计算。`commitWrite` 在锁内读当前文档，只在正文语义哈希或标题变化时推进 `revisionCount`，并同次写入 state、JSON、标题、哈希及 schema 版本。结构无法规范化时，不推进 V2 元数据，宿主仍可按自身策略持久化原始 state，并记录失败标记。
3. **当前状态持久化成功后**，`Scheduler` 安排延迟任务。最后一个连接离开时可提前安排物化。任务执行时先快速比较当前内容与最新修订，再拿同文档锁重新读取并作权威判重；只有正文哈希或标题变化时才写自动版本。
4. 手动版本是用户书签：`createManual` 在文档锁内保存当前完整 state 和 JSON，即使内容相同也新增一条。修订版本号在锁内单调递增。
5. 列表按 `(version DESC, id DESC)` 使用不透明游标，只返回元数据与可用性标记；选中版本后再取 JSON 详情。只有 state 的历史修订在首次详情读取时触发按需 JSON 补齐。详情也接受 `current-<documentId>` 虚拟 ID，供前端与当前文档比较。

规范化内容比对用于避免相同可见正文产生重复自动版本。Yjs update 的二进制字节包含客户端时钟和编辑历史，不能作为业务内容判重依据。自定义节点和 mark 需由编辑器、服务端规范化器和历史查看器共享兼容的 schema，并验证 JSON↔Yjs 往返。

## 3. 历史快照按需升级

这里的“升级”是从导入的**完整 V2 state** 补齐缺失的 JSON 投影；不重新编码或替换原始 state，也不执行活跃协同文档的 state 压缩。

1. `list` 只查修订元数据，以及 JSON 和 state 是否存在。只有 state 的记录暂报 `legacy_pending`，列表不会载入或解码二进制。`detail` 先通过 `getDetailRow` 查元数据和 state 字节数；已有 JSON 直接读取。
2. 如果 JSON 缺失，且 state 存在并不超过 **5 MiB**，`getState` 才加载二进制。宿主的 `RevisionProjectionDecoder` 应在**有容量上限的异步 worker 池**中运行；包内 `decodeV2Projection` 可在 worker 内一次解码 Y.Doc、提取正文、按宿主 schema 规范化，并从同一份文档和规范化树派生可选归属。
3. worker 计算规范化 JSON 的 SHA-256 哈希，以 `CURRENT_SCHEMA_VERSION`（目前为 **1**）标注派生结果。归属提取成功时，`backfillProjectionIfMissing` 用 `content_json IS NULL` 作 CAS，只写 JSON、哈希、schema 版本和归属；原始 state、`sourceFormat='state_only'`、`mtime`、版本及贡献者保留。归属提取失败时正文仍可读，但跳过回填以便下次重试。并发请求中只有一个回填成功；CAS 未命中或回填写库失败后会复查记录是否已被删除。
4. 未被删除的记录解码成功后，详情立即返回 `ready`、`decodedFromState=true` 和可比较内容；后续命中已回填 JSON 时 `decodedFromState=false`。无 state 时返回 `legacy_pending`；超过大小上限、缺少 decoder 或解码失败时为 `legacy_failed`。两种不可预览状态都不支持差异，但 `restorable` 仍独立依据原始 state 是否存在。worker 满载抛 `RevisionProjectionBusyError`，由宿主映射为可重试 HTTP 503。

解码失败的可观察信息只需错误类别，避免正文进入日志。归属坐标必须对应本次规范化内容；已有整篇归属或历史删除记录应按存储语义保留。若解码期间发生软删除且复查发现，详情清除内容并返回 `deleted`。当前文档的 `current-<documentId>` 虚拟详情不走这条补齐路径。`migrateToCurrentSchemaVersion` 仅提供已注册迁移的版本门禁，仓库没有自动跨 schema 转换或批量升级 worker。新表约束要求 `state_only` 的 JSON/哈希/schema 版本三列要么全空、要么全有；现有 PostgreSQL 表须显式迁移约束，重复执行 `CREATE TABLE IF NOT EXISTS` 不会改旧表。

导入后若**最新修订**仍缺 `content_hash`，自动建版的哈希判重会把它视作不同内容，可能新增一条可见正文相同的自动版本。启用自动建版前，若文档最新修订是尚未补齐的 `state_only` 行，宿主可先对它调用一次详情，再重读列表确认其为 `ready`，即 JSON 与哈希已持久化。若解码或回填无法完成，应接受首次自动建版可能重复的边界，并保留原始 state 供后续处理。

## 4. 查看与差异

前端 `RevisionHistory` 扩展通过 `RevisionHistoryController` 管理打开、分页、选中、比较与恢复确认；`RevisionApiClient` 处理 V2 信封、游标、鉴权头和稳定错误分类。`RevisionViewerHost` 在独立只读 ProseMirror `EditorView` 中显示历史 JSON。宿主在历史面板打开时应锁定实时正文、标题和工具栏，不把历史 JSON 写入协同中的编辑器。

差异模块先对 JSON 结构和文本分词，再计算序列差异、节点/格式变化和归属区间，最后生成 viewer decorations。缺少可靠逐处归属数据时，差异保持中性，不把修订创建人视作每处文字作者。宿主可以注入只读媒体 NodeView；未提供的自定义节点按 viewer 的降级策略展示可读内容并报告降级。

列表、详情与比较对象可能快速切换。控制器取消旧请求或丢弃晚到响应，保证旧详情不会覆盖当前选择。恢复是写操作，收到 HTTP 应答后仍需等待协同层重置信号和重新同步，才能重新开放实时编辑。

## 5. 恢复与在线客户端

```mermaid
sequenceDiagram
  participant UI as 历史面板 / 宿主
  participant API as V2HistoryService
  participant Store as 文档与修订存储
  participant Room as RoomReset 适配器
  UI->>API: restore(document, revision)
  API->>Store: 读取目标原始 V2 state 并校验
  API->>Room: flushAndReset(document, reason, persist)
  Room->>Room: 阻止新房间加载，刷新活跃 Y.Doc
  Room->>Store: 不同内容时保存 pre_restore
  Room->>Store: 用目标原始 state 替换当前状态
  Room->>Store: 同一事务写入 restore 来源审计
  Room-->>UI: 提交后广播 reset，断开旧连接
  API-->>UI: 返回恢复结果
  UI->>UI: 销毁旧编辑器、Y.Doc 和 provider
  UI->>Room: 清理离线副本后重新连接
```

恢复把目标修订的**原始完整 state**写回当前文档。解码仅用于验证和派生同源 JSON/标题；不能把目标 update 应用到旧 Y.Doc，因为这会合并 CRDT 历史。`RoomReset` 的宿主实现应在持久化替换期间阻止旧房间加载与写入，并把 reset 发送到所有实例，关闭旧连接。使用 IndexedDB 等离线 Yjs 副本时，客户端须清除对应文档缓存，避免旧更新重新进入新房间。

公开服务要求恢复前保护版本持久化成功才继续替换。保护版本、目标 state 替换及恢复来源审计在同一文档事务中完成，任一写入失败都会回滚；事务提交后由宿主广播重置并断开旧连接。权限检查必须在构造 `DocumentContext` 之前完成，查询参数中的文档 ID 只是路由键。

## 6. 本机演示和验收

`src/server/` 使用文件存储、单文档串行队列与简单 WebSocket，`src/client/` 使用 React + StarterKit。演示复用核心包的规范化、游标和判重算法，但有自己的 REST、WebSocket 与修订模型；前端演示也有自己的 UI。它的 `document.reset`、关闭码 4205 和传输 `epoch` 展示旧连接围栏，其中 `epoch` 只属于演示传输。运行环境配置见根目录 [README](../README.md)。

包级测试关注同源 state/JSON、锁内判重、列表分页、历史 state 按需补齐、手动版本、恢复和前端状态机/差异/只读隔离。真实部署还需按宿主 schema、事务数据库、持久队列、有界解码 worker 池、跨实例房间与离线客户端分别做集成验证。
