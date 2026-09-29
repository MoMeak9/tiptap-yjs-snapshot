# V2 实践代码的公开适配范围

[English](v2-extraction.en.md) · 简体中文

本仓库的主要交付物是由现有 **V2 修订历史实现**改造的可复用前后端代码。这里的 V2 是修订历史的数据与交互契约：当前文档和每条可恢复修订保存同源的完整 Yjs V2 state 与规范化 Tiptap JSON；列表、详情、比较、归属和恢复围绕这两份表示协作。`Y.encodeSnapshotV2` 的轻量元数据不能独立还原正文。

## 设计参考与代码来源

[Outline](https://github.com/outline/outline) 启发了延迟建版、正文加标题判重、虚拟当前版本、只传元数据的列表以及行内/块级差异展示。本项目另行实现完整 Yjs V2 state + JSON 双表示、CJK 词边界、游标分页和在线协同恢复。下面映射的是**本项目自身 V2 源模块**到公开包的适配；本仓库不内置 Outline 源码。[Outline 仓库采用 BSL 1.1](https://github.com/outline/outline/blob/main/LICENSE)；本仓库代码采用 [MIT](../LICENSE)。

公开适配保留算法、状态机和关键写入顺序；将业务数据库、鉴权、协同房间、队列、用户目录和媒体渲染改为通用接口或去除。下表中的“源模块”是相对源代码库的路径，便于读者对照职责；公开包内代码经过脱敏、重命名及通用环境改造。

## 后端模块映射

| 源模块（相对路径） | 公开模块 | 保留的实践与改造 |
| --- | --- | --- |
| `packages/server/src/modules/history-core/{canonicalize,content-hash,schema-version}.ts` | `packages/v2-core/src/canonical.ts` | Schema round-trip、固定序列化顺序、内容哈希与版本门禁；Schema 由宿主注入，未知节点类型以可观察的降级路径处理 |
| `packages/server/src/modules/revision-persistence/document-history-fields.ts` | `packages/v2-core/src/document-history.ts` | 锁外准备 JSON/哈希、锁内比较业务变化，保持 state、JSON、标题、哈希和修订计数的一致写入 |
| `packages/server/src/modules/revision-queue/{revision-dedup,revision-queue.processor,revision-queue.service}.ts` | `packages/v2-core/src/service.ts`、`src/adapters/{scheduler,redis}.ts` | 持久化后延迟调度、断连触发、锁前与锁内两次判重、区间归属的 claim/restore；队列与登记表可由宿主提供或使用标准环境适配器 |
| `packages/server/src/modules/revision-persistence/revision-insert.ts` | `packages/v2-core/src/adapters/postgres.ts`、`schema.postgres.sql` | 统一插入字段、文档锁下分配递增版本与时间；公开参考适配改用 PostgreSQL，不依赖源系统的 ORM 或表名 |
| `packages/server/src/modules/revision-manual/revision-manual.service.ts` | `V2HistoryService.createManual` | 手动命名版本允许相同内容重复保存 |
| `packages/server/src/modules/revision-list/{revision-cursor,revision-current,revision-list.service,revision-detail.service}.ts` | `packages/v2-core/src/cursor.ts`、`service.ts` | 不透明游标、仅元数据的列表、`current-<documentId>` 虚拟当前详情和按文档隔离的读取 |
| `packages/server/src/modules/snapshot/snapshot.service.ts` 中的 V2 恢复链路 | `V2HistoryService.restore`、`state-codec.ts`、`RoomReset` 端口 | 使用目标原始完整 V2 state 替换当前文档、保存恢复前状态、记恢复来源、重置活跃协同房间 |

后端包的入口是 `packages/v2-core/src/index.ts`。`DocumentStore`、`RevisionStore`、`Scheduler`、`RoomReset`、可选的 `IntervalPort` / `EventPublisher` / 失败标记端口定义在 `ports.ts`。HTTP 控制器和身份授权属于宿主层；在调用 `list`、`detail`、`createManual` 或 `restore` 前，宿主必须验证文档访问权限，再构造 `DocumentContext`。PostgreSQL schema 与驱动包装示例见 [`packages/v2-core/README.md`](../packages/v2-core/README.md)。

队列适配是通用化改造：源环境的代理命令限制处理未移植，公开版本通过结构化 BullMQ 驱动与标准 Redis 6.2+ 的 `EVAL` / `GETDEL` 登记表接入；也可以注入其他持久队列与 TTL 登记表。这一适配只处理修订任务，不提供协同文档或 awareness 同步；房间重置仍由独立的 `RoomReset` 端口承担。Cluster 同槽要求见[后端包说明](../packages/v2-core/README.md)。

## 前端模块映射

前端源目录为 `packages/extensions/revision-history/src/`，公开目录为 `packages/revision-history/src/`。下列 V2 文件组按原有职责适配，保留可测试的差异算法和控制器生命周期。

| 源目录或模块 | 公开目录或模块 | 保留的实践与改造 |
| --- | --- | --- |
| `api/revision-api-client.ts`、`contracts/` | 同名目录 | V2 列表/详情/恢复响应映射、当前版本引用、游标、鉴权令牌刷新与稳定错误分类；服务前缀、路由、请求头及 `fetch` 可配置 |
| `controller/revision-history-controller.ts`、`revision-history.ts` | 同名文件 | 打开/关闭、选中、比较、异步请求取消、恢复确认与宿主编辑器交接；运行时与挂载点由宿主注入 |
| `diff/{tokenize,sequence-diff,diff-documents,diff-title,attribution,change-groups,diff-decorations}.ts` | 同名目录与文件 | CJK 分词、Myers 序列差异、结构差异、文字归属及标记；没有来源证据的变更显示中性归属 |
| `ui/`、`styles/version-history.scss` | 同名目录与文件 | Lit 历史列表、面板、恢复对话框及样式；组件名、文案和配色替换为公开中性形式 |
| `viewer/{render-history-document,revision-viewer-host}.ts` | 同名目录与文件 | 独立只读 `EditorView`、历史 schema 降级和宿主隔离；媒体 NodeView 改由接入方注入 |

源目录中的专用图片、音视频、附件、嵌入等媒体 NodeView 没有直接公开。宿主若有自定义节点，可向 `RevisionViewerHost` 传入只读 `nodeViews`，并验证历史 JSON 与当前 schema 的兼容性。前端包用合成文档测试 API、控制器、差异和查看器；未包含实际文档内容、账号样本或私有资源。接入说明见 [`packages/revision-history/README.md`](../packages/revision-history/README.md)。

## 公开演示的边界

`src/server/` 与 `src/client/` 是一个独立的本机示例。服务端使用 `v2-core` 的规范化、游标和判重函数，自己实现文件持久化、REST 和简单 WebSocket；客户端用 React 展示实时编辑与历史交互。它没有调用完整的 `V2HistoryService`、PostgreSQL 适配器或 `RevisionHistory` 前端扩展。因此本机演示可以检查 V2 数据和交互，而两套公开包的生产接入方式应分别参照包内 README。演示的短延迟时间窗、单进程序列化和 WebSocket `epoch` 属于本地适配，`epoch` 不是 V2 REST 字段。

公开代码保留 `open_api`、自动、手动、恢复前保护和恢复记录的数据类型与服务处理；本机演示只提供自动、手动和恢复接口。源系统的业务数据库结构、分布式队列驱动、Hocuspocus 房间管理、真实身份与文档 Token、专有节点 Schema、通知/观测实现及离线 IndexedDB 管理由宿主接入。前后端传输成功信封使用 `{ code: 0, data }`；实际服务可以通过前端 transport 配置更换路由和请求头，但须维持所需响应字段。

## 恢复与失败语义

完整 Yjs V2 state 是恢复依据。服务先解码并规范化目标状态，保存恢复前内容，再写回目标原始 state；`RoomReset` 必须阻止旧房间继续写入，通知并断开在线客户端。客户端销毁旧编辑器、Y.Doc 和 provider，清理对应离线缓存后重连。将目标 update 直接应用到旧 Y.Doc 会合并两段 CRDT 历史，无法保证精确恢复。

公开服务要求恢复前保护版本写入成功才继续。在 `RoomReset` 阻止旧房间继续写入后，保护版本、目标 state 替换和恢复来源审计在同一文档事务中完成；任一步写入失败都会回滚该事务。事务提交后，宿主负责广播重置并断开在线客户端。本机演示使用单文件原子替换，不能把它等同于生产数据库事务。

## 验证范围

包级测试使用合成文档覆盖同源 JSON/state、语义判重、手动重复版本、游标及虚拟当前详情、恢复和前端异步状态；仓库根目录还保留本机演示测试。`npm run check:public` 扫描公开文件中的私有标识与敏感模式。测试不会替代宿主环境中的 Schema 往返、数据库并发、队列故障、跨实例驱逐和离线缓存恢复演练。
