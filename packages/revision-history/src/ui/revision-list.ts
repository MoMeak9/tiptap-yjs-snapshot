import { html, LitElement, nothing, type PropertyValues } from 'lit'
import { property, state } from 'lit/decorators.js'
import { repeat } from 'lit/directives/repeat.js'
import type {
  RevisionCollaborator,
  RevisionListItem,
  RevisionRef,
} from '../contracts/api'
import type { RevisionHistoryViewState } from '../contracts/state'
import { CollaboratorColorAssigner } from './collaborator-colors'
import {
  formatRevisionActivityTime,
  formatRevisionTime,
  groupRevisionsByDate,
} from './date-groups'
import { describeRevisionError } from './error-copy'
import {
  dispatchRevisionIntent,
  REVISION_LOAD_NEXT_PAGE_EVENT,
  REVISION_RESTORE_REQUEST_EVENT,
  REVISION_SELECT_EVENT,
  type RevisionLoadNextPageDetail,
  type RevisionRestoreRequestDetail,
  type RevisionSelectDetail,
} from './events'

/** 一行协作者：名字 + 可选的本次编辑时间与操作说明。 */
interface CollaboratorRow {
  readonly username: string
  readonly nickname: string
  readonly editedAt: number | null
  readonly note: string | null
}

function createEmptyList(): RevisionHistoryViewState['list'] {
  return {
    status: 'idle',
    items: [],
    nextCursor: null,
    hasNextPage: false,
    error: null,
  }
}

class RevisionListElement extends LitElement {
  override createRenderRoot(): HTMLElement {
    return this
  }

  @property({ attribute: false })
  list: RevisionHistoryViewState['list'] = createEmptyList()

  @property({ attribute: false })
  selectedRef: RevisionRef | null = null

  @property({ attribute: false })
  now = Date.now()

  @state()
  private focusedRevisionId: string | null = null

  @state()
  private expandedRevisionIds: ReadonlySet<string> = new Set()

  /**
   * Per-person colour assignment.
   *
   * Assigned from outside when the host also colours the diff, so a person's dot
   * here and their changes in the body are the same colour. Defaults to an own
   * instance so the list is usable standalone; either way it is instance-scoped,
   * which matches the design's allowance that re-entering a document may reset
   * the mapping.
   */
  @property({ attribute: false })
  colors: CollaboratorColorAssigner = new CollaboratorColorAssigner()

  /**
   * 宿主是否允许对本文档发起还原。
   *
   * 这是「调用方允不允许写」那一半，与服务端的 `restorable`（「还原所需的数据在不在」）
   * 是两个不同的问题：两者都为真才有入口。只读文档由宿主传 `false` —— 服务端也会以
   * 403 fail closed，但入口先露出来就已经在承诺一个做不到的操作。
   *
   * 默认 `true`：独立使用本组件（单测、demo）时不改变原有行为。
   */
  @property({ attribute: false })
  canRestore = true

  private focusAfterPresentationUpdate: string | null = null

  /** Scroll offset saved while an append request briefly changes list status. */
  private paginationScrollTop: number | null = null

  private get orderedItems(): readonly RevisionListItem[] {
    return this.getOrderedItems(this.list, this.now)
  }

  private getOrderedItems(
    list: RevisionHistoryViewState['list'],
    now: number
  ): readonly RevisionListItem[] {
    if (list.status !== 'ready') {
      return []
    }

    return groupRevisionsByDate(list.items, now).flatMap(group => group.items)
  }

  private getRovingRevisionId(
    orderedItems: readonly RevisionListItem[]
  ): string | null {
    const orderedIds = orderedItems.map(item => item.id)
    if (
      this.focusedRevisionId !== null &&
      orderedIds.includes(this.focusedRevisionId)
    ) {
      return this.focusedRevisionId
    }
    if (
      this.selectedRef?.kind === 'revision' &&
      orderedIds.includes(this.selectedRef.id)
    ) {
      return this.selectedRef.id
    }
    return orderedIds[0] ?? null
  }

  private isSelected(item: RevisionListItem): boolean {
    return (
      this.selectedRef?.kind === 'revision' && this.selectedRef.id === item.id
    )
  }

  private selectRevision(id: string): void {
    dispatchRevisionIntent<RevisionSelectDetail>(this, REVISION_SELECT_EVENT, {
      id,
    })
  }

  private focusRevision(id: string): void {
    this.focusedRevisionId = id
    void this.updateComplete.then(() => {
      if (!this.isConnected) {
        return
      }
      this.findRow(id)?.focus()
    })
  }

  private findRow(id: string): HTMLElement | undefined {
    return Array.from(
      this.querySelectorAll<HTMLElement>('.revision-vh-snapshot-item')
    ).find(row => row.dataset.revisionId === id)
  }

  private coordinateFocusAfterPresentationUpdate(
    changedProperties: PropertyValues<this>
  ): void {
    if (typeof document === 'undefined') {
      return
    }

    const activeElement = document.activeElement
    if (
      !(activeElement instanceof HTMLElement) ||
      !this.contains(activeElement) ||
      !activeElement.matches('.revision-vh-snapshot-item[role="gridcell"]')
    ) {
      return
    }

    const activeRevisionId = activeElement.dataset.revisionId
    if (activeRevisionId === undefined) {
      return
    }

    const previousList = changedProperties.has('list')
      ? ((changedProperties.get('list') as
          | RevisionHistoryViewState['list']
          | undefined) ?? createEmptyList())
      : this.list
    const previousNow = changedProperties.has('now')
      ? ((changedProperties.get('now') as number | undefined) ?? this.now)
      : this.now
    const previousItems = this.getOrderedItems(previousList, previousNow)
    const nextItems = this.orderedItems
    const previousIndex = previousItems.findIndex(
      item => item.id === activeRevisionId
    )
    const nextItem =
      nextItems.find(item => item.id === activeRevisionId) ??
      nextItems[Math.min(Math.max(previousIndex, 0), nextItems.length - 1)]

    this.focusedRevisionId = nextItem?.id ?? null
    this.focusAfterPresentationUpdate = nextItem?.id ?? null
  }

  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    const presentationChanged =
      changedProperties.has('list') || changedProperties.has('now')
    if (!presentationChanged) {
      return
    }

    const previousList = changedProperties.get('list') as
      | RevisionHistoryViewState['list']
      | undefined
    if (
      changedProperties.has('list') &&
      previousList?.status === 'ready' &&
      this.list.status === 'loading' &&
      this.list.items.length > 0
    ) {
      this.paginationScrollTop =
        this.querySelector<HTMLElement>('.revision-vh-sidebar-content')
          ?.scrollTop ?? 0
    }

    this.coordinateFocusAfterPresentationUpdate(changedProperties)
  }

  protected override updated(): void {
    if (this.list.status === 'ready' && this.paginationScrollTop !== null) {
      const scrollTop = this.paginationScrollTop
      this.paginationScrollTop = null
      const content = this.querySelector<HTMLElement>(
        '.revision-vh-sidebar-content'
      )
      if (content !== null) {
        content.scrollTop = scrollTop
      }
    }

    const revisionId = this.focusAfterPresentationUpdate
    this.focusAfterPresentationUpdate = null
    if (revisionId !== null && this.isConnected) {
      this.findRow(revisionId)?.focus()
    }
  }

  private handleRowKeyDown(event: KeyboardEvent, id: string): void {
    if (event.target !== event.currentTarget) {
      return
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      this.selectRevision(id)
      return
    }

    const items = this.orderedItems
    const currentIndex = items.findIndex(item => item.id === id)
    let targetIndex = currentIndex

    switch (event.key) {
      case 'ArrowDown':
        targetIndex = Math.min(currentIndex + 1, items.length - 1)
        break
      case 'ArrowUp':
        targetIndex = Math.max(currentIndex - 1, 0)
        break
      case 'Home':
        targetIndex = 0
        break
      case 'End':
        targetIndex = items.length - 1
        break
      default:
        return
    }

    event.preventDefault()
    const target = items[targetIndex]
    if (target && target.id !== id) {
      this.focusRevision(target.id)
    }
  }

  /**
   * Expands or collapses one card's edit history.
   *
   * Stops propagation for the same reason restore does: the toggle sits inside
   * the selectable row, and expanding is not selecting.
   */
  private toggleExpanded(event: MouseEvent, revisionId: string): void {
    event.preventDefault()
    event.stopPropagation()

    const next = new Set(this.expandedRevisionIds)
    if (!next.delete(revisionId)) {
      next.add(revisionId)
    }
    this.expandedRevisionIds = next
  }

  /**
   * Emits a restore intent for one card.
   *
   * Stops propagation so restoring does not also select the card: the click
   * lands on a control nested inside the selectable row.
   */
  private requestRestore(event: MouseEvent, revisionId: string): void {
    event.preventDefault()
    event.stopPropagation()
    dispatchRevisionIntent<RevisionRestoreRequestDetail>(
      this,
      REVISION_RESTORE_REQUEST_EVENT,
      { id: revisionId }
    )
  }

  /**
   * 这张卡片该不该给「还原」按钮。
   *
   * 主判据是 `restorable` —— 服务端唯一权威地回答了「恢复所需的数据在不在」。
   * `isFirst` 只是列表里的位置推断，服务端并没有「当前版」这个字段，所以它不能
   * 当主判据：分页、乱序、只加载了后半页时，第一条都可能不是最新那一版。
   *
   * 但两个条件都要：它们否决的是**不同**的事。`restorable` 为假说明数据不存在，
   * 恢复根本无从执行；`isFirst` 为真说明这一版就是当前状态 —— 数据齐备
   * (`restorable` 为真)，可恢复过去也是空操作，而且服务端还没为它生成快照。
   * 少任一个都会漏掉一类不该出现的按钮。
   *
   * 只按 `restorable` 为假隐藏，不把它为真当成「点了一定成」：按契约它对
   * 「调用方有没有写权限」不作承诺，那由服务端答 403。写权限这一半由宿主的
   * `canRestore` 回答（只读文档传 `false`），所以这里只收敛入口，不在 Controller
   * 侧拦截已经发出的恢复意图。
   */
  private shouldOfferRestore(
    item: RevisionListItem,
    isFirst: boolean
  ): boolean {
    return this.canRestore && item.restorable && !isFirst
  }

  private renderStatus() {
    let copy: string | null = null
    if (this.list.status === 'loading') {
      copy = '加载中...'
    } else if (this.list.status === 'error') {
      copy = describeRevisionError(this.list.error)
    } else if (this.list.status === 'ready' && this.list.items.length === 0) {
      copy = '暂无版本记录'
    }

    return copy === null
      ? nothing
      : html`<div class="revision-vh-state" role="status" aria-live="polite">
          ${copy}
        </div>`
  }

  private renderRevision(
    item: RevisionListItem,
    isFirst: boolean,
    rovingRevisionId: string | null
  ) {
    const selected = this.isSelected(item)
    const activity = item.activity ?? []
    // 只有服务端给了逐次操作数据才可展开 —— 否则展开是一片空白。
    const expandable = activity.length > 0
    const expanded = expandable && this.expandedRevisionIds.has(item.id)

    return html`
      <div
        class="revision-vh-snapshot-row"
        data-revision-row-id=${item.id}
        role="row"
      >
        <div
          class="revision-vh-snapshot-item ${selected
            ? 'revision-vh-snapshot-item--selected'
            : ''}"
          data-revision-id=${item.id}
          role="gridcell"
          aria-selected=${String(selected)}
          tabindex=${rovingRevisionId === item.id ? 0 : -1}
          @focus=${() => {
            this.focusedRevisionId = item.id
          }}
          @click=${() => this.selectRevision(item.id)}
          @keydown=${(event: KeyboardEvent) =>
            this.handleRowKeyDown(event, item.id)}
        >
          <div class="revision-vh-snapshot-header">
            ${expandable
              ? html`
                  <button
                    type="button"
                    class="revision-vh-expand-toggle ${expanded
                      ? 'revision-vh-expand-toggle--expanded'
                      : ''}"
                    data-revision-id=${item.id}
                    aria-expanded=${String(expanded)}
                    aria-label=${expanded
                      ? `收起第${item.version}版的编辑记录`
                      : `展开第${item.version}版的编辑记录`}
                    @click=${(event: MouseEvent) =>
                      this.toggleExpanded(event, item.id)}
                  ></button>
                `
              : nothing}
            <div class="revision-vh-snapshot-version">第${item.version}版</div>
            ${isFirst
              ? html`<div class="revision-vh-current-badge">当前</div>`
              : nothing}
            ${this.shouldOfferRestore(item, isFirst)
              ? html`
                  <button
                    type="button"
                    class="revision-vh-restore-action"
                    data-revision-id=${item.id}
                    aria-label="还原至第${item.version}版"
                    @click=${(event: MouseEvent) =>
                      this.requestRestore(event, item.id)}
                  >
                    <span
                      class="revision-vh-restore-icon"
                      aria-hidden="true"
                    ></span>
                    <span>还原</span>
                  </button>
                `
              : nothing}
          </div>
          <div class="revision-vh-snapshot-time">
            ${formatRevisionTime(item.createdAt)}
          </div>
          ${repeat(
            this.collaboratorRows(item),
            row => row.username,
            row => this.renderCollaboratorRow(row, expanded)
          )}
          ${item.type === 'pre_restore' && !item.createdBy
            ? html`<div class="revision-vh-revision-note">回滚前自动保存</div>`
            : nothing}
        </div>
      </div>
    `
  }

  /**
   * Merges the `collaborators` list with optional per-edit activity.
   *
   * `collaborators` is the source of truth for who appears: activity is optional
   * and may cover only some of them. An activity entry for someone absent from
   * `collaborators` is still shown rather than dropped, so a card never hides an
   * edit the service reported.
   */
  private collaboratorRows(item: RevisionListItem): readonly CollaboratorRow[] {
    const activity = item.activity ?? []
    const byUsername = new Map(activity.map(entry => [entry.name, entry]))
    const collaborators: RevisionCollaborator[] = [...item.collaborators]

    const addCollaborator = (username: string): void => {
      if (
        username !== '' &&
        !collaborators.some(entry => entry.username === username)
      ) {
        // 触发者未必是内容贡献者：补行时读取独立资料，不能把他写回 contributors。
        // 已有协作者行保留原昵称；资料身份必须与 createdBy 对上才可用于展示。
        const nickname =
          username === item.createdBy &&
          item.createdByUser?.username === username
            ? item.createdByUser.nickname.trim() || username
            : username
        collaborators.push({ username, nickname })
      }
    }

    for (const entry of activity) {
      addCollaborator(entry.name)
    }

    // 版本级的恢复归属挂在 `createdBy` 那一行：`restoredFromVersion` 描述的是
    // 「这一版恢复自第 N 版」，而恢复是一个人的显式动作，服务端把执行者记在
    // `createdBy`。若他不在协作者名单里也要补进去 —— 否则整条说明无处可挂。
    const restorer =
      item.restoredFromVersion === null ||
      item.restoredFromVersion === undefined
        ? null
        : item.createdBy
    if (restorer !== null && restorer !== '') {
      addCollaborator(restorer)
    }

    // pre_restore 保存的是回滚前内容，但建档动作由 createdBy 触发。执行者未必是
    // 内容作者，故不写回 collaborators；只在展示层补一行承载操作说明。
    const preRestoreActor = item.type === 'pre_restore' ? item.createdBy : null
    if (preRestoreActor !== null && preRestoreActor !== '') {
      addCollaborator(preRestoreActor)
    }

    // OpenAPI 修改由单一服务端操作者发起。后端通常已把他写进 collaborators，
    // 这里保留展示兜底，避免灰度期的半旧数据丢失来源说明。
    const openApiActor = item.type === 'open_api' ? item.createdBy : null
    if (openApiActor !== null && openApiActor !== '') {
      addCollaborator(openApiActor)
    }

    // protect 保存的是 OpenAPI 修改前的旧内容。createdBy 只表示触发保护的操作者，
    // collaborators 仍只表示旧内容作者；缺失时仅在展示名单中补行，不回写字段。
    const protectActor = item.type === 'protect' ? item.createdBy : null
    if (protectActor !== null && protectActor !== '') {
      addCollaborator(protectActor)
    }

    // 有 activity 时它是唯一权威：它逐次记录了恢复动作，版本级字段是同一事实的
    // 粗粒度摘要。按行做 `??` 回落会出错 —— 某人有 activity 条目但那次不是恢复时，
    // 回落会把版本级的说明错挂到他头上。
    const hasActivity = activity.length > 0

    return collaborators.map(collaborator => {
      const { username, nickname } = collaborator
      const entry = byUsername.get(username)
      const restoredFromVersion = hasActivity
        ? (entry?.restoredFromVersion ?? null)
        : username === restorer
          ? (item.restoredFromVersion ?? null)
          : null
      const note =
        username === preRestoreActor
          ? '回滚前自动保存'
          : username === openApiActor
            ? 'OpenAPI 修改'
            : username === protectActor
              ? 'OpenAPI 修改前保护'
              : restoredFromVersion === null
                ? null
                : `恢复了第${restoredFromVersion}版内容`

      return {
        username,
        nickname,
        editedAt: entry?.editedAt ?? null,
        note,
      }
    })
  }

  private renderCollaboratorRow(row: CollaboratorRow, expanded: boolean) {
    const color = this.colors.get(row.username)

    return html`
      <div class="revision-vh-snapshot-user" data-collaborator=${row.username}>
        <div class="revision-vh-snapshot-user-main">
          <span
            class="revision-vh-user-dot"
            style="background:${color.strong}"
          ></span>
          <span class="revision-vh-user-nickname">${row.nickname}</span>
          ${row.nickname === row.username
            ? nothing
            : html`<span class="revision-vh-user-username"
                >(${row.username})</span
              >`}
          ${row.note === null
            ? nothing
            : html`<span class="revision-vh-user-note">${row.note}</span>`}
        </div>
        ${expanded && row.editedAt !== null
          ? html`<div class="revision-vh-user-time">
              ${formatRevisionActivityTime(row.editedAt)}
            </div>`
          : nothing}
      </div>
    `
  }

  /**
   * Renders one flat, newest-first run of cards.
   *
   * The approved sidebar has no date headers — each card carries its own
   * absolute timestamp — so the rows are emitted directly rather than grouped.
   */
  private renderRevisionGroups() {
    if (this.list.status !== 'ready') {
      return nothing
    }

    const orderedItems = this.orderedItems
    const firstId = orderedItems[0]?.id
    const rovingRevisionId = this.getRovingRevisionId(orderedItems)

    return repeat(
      orderedItems,
      item => item.id,
      item => this.renderRevision(item, item.id === firstId, rovingRevisionId)
    )
  }

  override render() {
    const hasRevisionRows =
      this.list.status === 'ready' && this.list.items.length > 0

    return html`
      <div class="revision-vh-sidebar-content">
        <div
          class="revision-vh-revision-list"
          role=${hasRevisionRows ? 'grid' : nothing}
          aria-label=${hasRevisionRows ? '版本历史' : nothing}
          aria-colcount=${hasRevisionRows ? '1' : nothing}
        >
          ${this.renderStatus()} ${this.renderRevisionGroups()}
        </div>
        ${this.list.status === 'ready' && this.list.hasNextPage
          ? html`
              <button
                type="button"
                class="revision-vh-load-more"
                @click=${() =>
                  dispatchRevisionIntent<RevisionLoadNextPageDetail>(
                    this,
                    REVISION_LOAD_NEXT_PAGE_EVENT,
                    {}
                  )}
              >
                加载更多
              </button>
            `
          : nothing}
      </div>
    `
  }
}

const hasDocumentCustomElements =
  typeof document !== 'undefined' && typeof customElements !== 'undefined'
const registeredRevisionList = hasDocumentCustomElements
  ? customElements.get('yjs-revision-list')
  : undefined

export type RevisionList = RevisionListElement
export const RevisionList = (registeredRevisionList ??
  RevisionListElement) as typeof RevisionListElement

if (hasDocumentCustomElements && registeredRevisionList === undefined) {
  customElements.define('yjs-revision-list', RevisionList)
}

declare global {
  interface HTMLElementTagNameMap {
    'yjs-revision-list': RevisionList
  }
}
