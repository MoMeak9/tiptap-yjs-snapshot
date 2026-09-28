import type { Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { EditorView, type NodeViewConstructor } from '@tiptap/pm/view'
import type { RevisionListItem } from '../contracts/api'
import type { RevisionHistoryViewState } from '../contracts/state'
import {
  createAttributionIndex,
  type AttributionIndex,
} from '../diff/attribution'
import { buildDiffDecorations } from '../diff/diff-decorations'
import type { RevisionChange } from '../diff/diff-documents'
import type { CollaboratorColorAssigner } from '../ui/collaborator-colors'
import '../ui/revision-viewer-shell'
import type { RevisionViewerShell } from '../ui/revision-viewer-shell'
import {
  renderHistoryDocument,
  type HistoryDegradation,
} from './render-history-document'

/**
 * 汇总所有已加载版本的 username → 昵称。
 *
 * 跨条目合并而不是只取当前版本：徽章的作者来自逐处归属，可能是某个在当前卡片
 * `collaborators` 里没露面的人（比如只删了内容的人不计入本区间贡献者）。多取几条不会
 * 错 —— username 到昵称是全局一对一的，冲突时后者覆盖前者，结果一样。
 *
 * 空昵称不入表，这样 `get` 返回 `undefined`，徽章回落到 username；写一个空串进去反而会
 * 让徽章显示成空白。
 */
function collectDisplayNames(
  items: readonly RevisionListItem[]
): Map<string, string> {
  const names = new Map<string, string>()
  for (const item of items) {
    for (const collaborator of item.collaborators) {
      const nickname = collaborator.nickname.trim()
      if (collaborator.username !== '' && nickname !== '') {
        names.set(collaborator.username, nickname)
      }
    }
  }
  return names
}

export interface RevisionViewerHostConfig {
  /** Where the viewer takes over, i.e. the host's main document area. */
  readonly container: HTMLElement
  /**
   * The live editor schema.
   *
   * Historical bodies are rendered against it rather than the frozen historical
   * schema because only the live one carries the DOM serializers, node views and
   * styles that make a revision look like the document it came from.
   */
  readonly schema: Schema
  /** Optional read-only renderers for media or custom nodes in the host schema. */
  readonly nodeViews?: Readonly<Record<string, NodeViewConstructor>>
  /**
   * Shared per-person colour mapping.
   *
   * The same instance the sidebar uses, so a person's dot there and their changes
   * here resolve to one colour — the design requires one colour per person per
   * document.
   */
  readonly colors?: CollaboratorColorAssigner
  readonly onDegradation?: (degradations: readonly HistoryDegradation[]) => void
}

/**
 * Read-only presentation of a selected revision.
 *
 * It owns a bare `EditorView` with no plugins and no transaction handling: this
 * is a renderer, not an editor. Nothing here can reach the live document, the
 * provider or the network.
 *
 * The sidebar owns close and comparison controls; the body is rendered separately.
 */
export class RevisionViewerHost {
  private readonly container: HTMLElement
  private readonly schema: Schema
  private readonly nodeViews: Readonly<Record<string, NodeViewConstructor>>
  private readonly colors?: CollaboratorColorAssigner
  private readonly onDegradation?: (
    degradations: readonly HistoryDegradation[]
  ) => void
  private readonly shell: RevisionViewerShell
  private view: EditorView | null = null
  /**
   * The body currently rendered. Compared by identity to skip rebuilding the
   * view when an unrelated part of the snapshot changes — the controller
   * publishes a new snapshot for every state change, including list paging.
   */
  private renderedContent: unknown = null
  private changes: readonly RevisionChange[] = []
  private showChanges = false
  private activeIndex = -1
  /**
   * Per-position authorship for the rendered revision, taken from the same
   * snapshot as `changes` so a badge can never name the author of a different
   * revision than the one on screen.
   */
  private attribution: AttributionIndex | null = null
  /**
   * username → 昵称，取自侧栏列表已经拿到的 `collaborators`。
   *
   * 徽章要显示昵称（`示例作者 新增`），而归属里的作者是 username（`author1`）。昵称由服务端
   * 在列表接口上给出，这里只做映射 —— 不为徽章单独请求一次，也不在前端拼字符串。
   */
  private names: Map<string, string> = new Map()
  /** Invalidates pending Lit renders when selection or attachment changes. */
  private renderGeneration = 0
  private destroyed = false

  constructor(config: RevisionViewerHostConfig) {
    this.container = config.container
    this.schema = config.schema
    this.nodeViews = config.nodeViews ?? {}
    this.colors = config.colors
    this.onDegradation = config.onDegradation

    this.shell = config.container.ownerDocument.createElement(
      'yjs-revision-viewer-shell'
    ) as RevisionViewerShell
  }

  /** Whether the viewer currently occupies the container. */
  get active(): boolean {
    return this.shell.parentNode === this.container
  }

  update(snapshot: RevisionHistoryViewState): void {
    if (this.destroyed) {
      return
    }

    if (!snapshot.open) {
      this.detach()
      return
    }

    this.attach()
    this.shell.viewer = snapshot.viewer

    if (snapshot.viewer.status !== 'ready') {
      this.teardownView()
      return
    }

    this.changes = snapshot.viewer.changes
    this.attribution = createAttributionIndex(snapshot.viewer.attribution)
    this.showChanges = snapshot.viewer.showChanges
    this.names = collectDisplayNames(snapshot.list.items)
    // The navigation cursor is 1-based for display; -1 means nothing is active.
    this.activeIndex = snapshot.changeNavigation.current - 1

    if (snapshot.viewer.content === this.renderedContent) {
      // Same body, different overlay: repaint instead of rebuilding the view,
      // which would lose the scroll position on every navigation step.
      this.applyDecorations()
      this.scrollActiveChangeIntoView()
      return
    }
    this.renderedContent = snapshot.viewer.content
    this.renderBody(snapshot.viewer.content)
  }

  destroy(): void {
    if (this.destroyed) {
      return
    }
    this.destroyed = true
    this.teardownView()
    this.detach()
  }

  private attach(): void {
    if (this.active) {
      return
    }
    this.container.appendChild(this.shell)
  }

  private detach(): void {
    this.teardownView()
    this.renderedContent = null
    if (this.shell.parentNode === this.container) {
      this.container.removeChild(this.shell)
    }
  }

  private teardownView(): void {
    this.renderGeneration += 1
    this.view?.destroy()
    this.view = null
  }

  private renderBody(content: unknown): void {
    const generation = ++this.renderGeneration
    const { doc, degradations } = renderHistoryDocument(
      this.schema,
      content as never
    )

    if (degradations.length > 0) {
      try {
        this.onDegradation?.(degradations)
      } catch {
        // Diagnostics must not stop the revision from rendering.
      }
    }

    // The shell renders its container only in the ready branch, so this runs
    // after its property assignment has been reflected.
    void this.shell.updateComplete.then(() => {
      if (
        this.destroyed ||
        generation !== this.renderGeneration ||
        !this.active ||
        this.shell.viewer.status !== 'ready' ||
        this.renderedContent !== content
      ) {
        return
      }
      const mount = this.shell.viewerContainer
      if (mount === null) {
        return
      }

      this.view?.destroy()
      this.view = null
      this.view = new EditorView(mount, {
        state: EditorState.create({ doc }),
        attributes: { 'data-revision-scoped': '' },
        // The host may supply read-only node views for its own custom schema.
        // Otherwise ProseMirror uses each node's schema DOM serializer.
        nodeViews: this.nodeViews,
        editable: () => false,
        // A revision is historical data; nothing the user does here may produce
        // a transaction, so none is ever applied.
        dispatchTransaction: () => undefined,
      })
      this.applyDecorations()
      this.scrollActiveChangeIntoView()
    })
  }

  /**
   * Paints the diff overlay.
   *
   * Decorations are set through `setProps` rather than a plugin: the view applies
   * no transactions, so there is no state pipeline for a plugin to hook into.
   */
  private applyDecorations(): void {
    const view = this.view
    if (view === null) {
      return
    }

    const changes = this.showChanges ? this.changes : []
    // Attribution goes in as `null` while changes are hidden: badges hang on
    // highlight runs, and there are none to hang them on. The empty change list
    // already produces no badge, so this states the intent rather than being the
    // only thing enforcing it. The owner name is withheld for the same reason —
    // it is the other badge source, so leaving it in would be the one thing that
    // could still produce a badge with the overlay off.
    const attribution = this.showChanges ? this.attribution : null
    view.setProps({
      decorations: state =>
        buildDiffDecorations(
          state.doc,
          changes,
          this.showChanges ? this.activeIndex : -1,
          attribution,
          // The assigner the sidebar shares, so a person's badge here and their
          // dot there resolve to one colour.
          this.colors,
          this.names
        ),
    })
  }

  private scrollActiveChangeIntoView(): void {
    const view = this.view
    if (view === null || !this.showChanges) {
      return
    }

    const change = this.changes[this.activeIndex]
    if (change === undefined) {
      return
    }

    try {
      const target = view.domAtPos(change.from).node
      // Only elements scroll; a text node's parent is what has a box.
      const element =
        target instanceof HTMLElement ? target : target.parentElement
      element?.scrollIntoView({ block: 'center' })
    } catch {
      // A position the DOM cannot resolve is not worth failing the repaint over.
    }
  }
}
