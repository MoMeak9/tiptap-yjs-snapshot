# V2 修订历史前端包

[English](README.md) · 简体中文

本包读取持久化的 V2 修订列表，在浏览器中比较规范化 Tiptap JSON，标记可归属的变更，在独立、只读的 ProseMirror `EditorView` 中渲染历史内容，并显式发起恢复请求。代码由本项目的 V2 修订历史模块适配而来；公开版本替换了名称、配色、环境接线和专用媒体渲染器，保留差异算法与控制器生命周期。测试只使用合成文档，不包含原系统的文档文本或账号样本。

[Outline](https://github.com/outline/outline) 是行内/块级历史差异和修订交互的设计参考。这里的 CJK 分词、V2 API/控制器接入和在线恢复是本项目的适配；本包不内置 Outline 源码。来源说明与许可见[仓库级说明](../../docs/v2-extraction.zh-CN.md)（[Outline BSL 1.1](https://github.com/outline/outline/blob/main/LICENSE)，[本仓库 MIT](../../LICENSE)）。

## 接入

在仓库根目录通过淘宝 npm 镜像安装依赖并构建包：

```sh
npm ci --registry=https://registry.npmmirror.com/
npm run build:packages
```

接入环境需要兼容版本的 `@tiptap/core`、`@tiptap/pm` 与 `lit`，并加载 `@tiptap-yjs-snapshot/revision-history/styles`。侧栏和 viewer 应挂载到不同的宿主元素。实时编辑器与协同 provider 由宿主拥有：

```ts
import { Editor } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import { RevisionHistory } from '@tiptap-yjs-snapshot/revision-history'
import '@tiptap-yjs-snapshot/revision-history/styles'

let editor: Editor
let resetPending = false
let documentToken = '' // Set from the host's short-lived auth state.
const liveEditorElement = document.getElementById('live-editor')!
const sidebarElement = document.getElementById('revision-sidebar')!
const viewerElement = document.getElementById('revision-viewer')!
const titleInput = document.querySelector<HTMLInputElement>('#document-title')!
const toolbarButtons = document.querySelectorAll<HTMLButtonElement>('#editor-toolbar button')

function setHostEditable(editable: boolean) {
  editor.setEditable(editable)
  titleInput.readOnly = !editable
  toolbarButtons.forEach(button => { button.disabled = !editable })
}

editor = new Editor({
  element: liveEditorElement,
  extensions: [
    StarterKit,
    RevisionHistory.configure({
      dataSource: 'v2',
      documentId: 'document-123',
      servicePrefix: '/api',
      mount: () => sidebarElement,
      viewerMount: () => viewerElement,
      auth: {
        getToken: () => documentToken,
        applyTokenEnvelope: ({ token }) => { documentToken = token },
      },
      canRestore: true,
      onOpenChange: ({ open }) => {
        setHostEditable(!open && !resetPending)
        // The viewer remains mounted in its own element beside the sidebar.
      },
      onRestoreComplete: () => {
        resetPending = true
        setHostEditable(false)
        editor.commands.closeRevisionHistory()
        // Rebuild the live Y.Doc, provider, and editor from the server's reset
        // signal. The restore HTTP response only acknowledges the request.
      },
    }),
  ],
})

// The host's collaboration event handler, after receiving document.reset or
// a server-defined reset close code (4205 in the source practice):
//   dispose the old provider and live Y.Doc
//   load a fresh document/provider, wait for initial sync
//   resetPending = false; setHostEditable(true)

editor.commands.openRevisionHistory()
```

参考传输契约使用 `GET /revisions/list`、`GET /revisions/detail` 和 `POST /revisions/restore`。每次请求带 `doc_id`；默认令牌请求头为 `x-document-token`；成功信封为 `{ code: 0, data }`。列表 `data` 形如 `{ data: RevisionListItem[], nextCursor, hasMore }`。`RevisionTransportConfig` 可更换路由、查询键和请求头，同时保持 V2 响应模型。使用 Cookie 鉴权时可设置 `tokenHeader: null`。服务端必须独立于查询参数中的文档 ID 执行授权。

恢复 HTTP 适配层应返回 `{ code: 0, data: { id: requestedTargetRevisionId } }`。审计行可以有自己的 ID，但此处必须返回请求恢复的目标版本 ID；客户端把 `data.id` 解释为恢复目标。实时编辑器仍需等待协同重置和重新同步后才能继续编辑。

```ts
const transport = {
  documentIdQueryKey: 'document_id',
  tokenHeader: 'authorization',
  refreshEnvelopeHeader: null,
  routes: {
    list: '/history',
    detail: '/history/item',
    restore: '/history/restore',
  },
} as const
```

将 `transport` 传给 `RevisionHistory.configure` 或 `createRevisionApiClient`。浏览器和测试环境可注入 `fetchImpl`。`RevisionViewerHost` 使用宿主 schema；不支持的历史节点尽量保留可读的子内容并报告降级。自定义媒体节点通过 `nodeViews` 注入只读 ProseMirror `NodeViewConstructor`；未提供时使用 schema 的 DOM serializer。不要把带上传能力的实时节点视图复用于历史 viewer。

## 来源边界

| 保留的 V2 实践 | 公开适配 |
| --- | --- |
| API 映射、游标分页、当前版本引用、恢复错误 | 可配置路由和鉴权请求头 |
| 控制器状态转换、请求取消、比较目标选择、恢复确认 | 不保留停用状态的占位控制器 |
| CJK 分词、序列/结构差异、归属与变更分组 | 仅用合成数据测试 |
| Diff decorations、Lit 面板/列表/弹窗、独立只读 `EditorView` | 中性的自定义元素名称和 CSS 配色 |
| 历史 schema 降级 | 宿主注入媒体 NodeView，替代专用视图 |

服务端负责同源 V2 Yjs state 与规范化 JSON、修订物化、访问控制，以及恢复后重置活跃房间；对应实现见[后端包](../v2-core/README.md)。客户端不会从 HTTP 恢复响应中把旧文档状态直接应用到活跃 provider。

在仓库根目录运行 `npm run typecheck --prefix packages/revision-history`、`npm run build --prefix packages/revision-history` 和 `npx vitest run packages/revision-history/__tests__`。
