import { html, LitElement, nothing, type PropertyValues } from 'lit'
import { property, state } from 'lit/decorators.js'
import type { RevisionHistoryControllerPort } from '../contracts/controller'
import type { RevisionHistoryViewState } from '../contracts/state'
import { CollaboratorColorAssigner } from './collaborator-colors'
import {
  REVISION_CLOSE_EVENT,
  REVISION_COMPARE_TARGET_CHANGE_EVENT,
  REVISION_LOAD_NEXT_PAGE_EVENT,
  REVISION_RESTORE_CANCEL_EVENT,
  REVISION_RESTORE_CONFIRM_EVENT,
  REVISION_RESTORE_REQUEST_EVENT,
  REVISION_SELECT_EVENT,
  REVISION_SHOW_CHANGES_EVENT,
  REVISION_STEP_CHANGE_EVENT,
  type RevisionCompareTargetChangeDetail,
  type RevisionRestoreRequestDetail,
  type RevisionSelectDetail,
  type RevisionShowChangesDetail,
  type RevisionStepChangeDetail,
} from './events'
import './restore-confirm-dialog'
import './revision-list'
import './revision-viewer-shell'
import type { RevisionRestoreConfirmDialog } from './restore-confirm-dialog'
import type { RevisionList } from './revision-list'
import type { RevisionViewerShell } from './revision-viewer-shell'

type Snapshot = RevisionHistoryViewState

const INITIAL_STATE: Snapshot = Object.freeze({
  version: -1,
  open: false,
  list: Object.freeze({
    status: 'idle' as const,
    items: Object.freeze([]),
    nextCursor: null,
    hasNextPage: false,
    error: null,
  }),
  selection: Object.freeze({
    ref: null,
    compareTarget: Object.freeze({ kind: 'previous' as const }),
    requestGeneration: 0,
  }),
  viewer: Object.freeze({ status: 'empty' as const }),
  restore: Object.freeze({ status: 'idle' as const }),
  changeNavigation: Object.freeze({ current: 0, total: 0 }),
})

function isHTMLElement(value: unknown): value is HTMLElement {
  return typeof HTMLElement !== 'undefined' && value instanceof HTMLElement
}

class RevisionHistoryPanelElement extends LitElement {
  override createRenderRoot(): HTMLElement {
    return this
  }

  override get updateComplete(): Promise<boolean> {
    return super.updateComplete.then(async result => {
      const children = Array.from(
        this.querySelectorAll<HTMLElement>(
          'yjs-revision-list, yjs-revision-viewer-shell, yjs-revision-restore-confirm-dialog'
        )
      )
      await Promise.all(
        children.map(child => {
          const updateComplete = (
            child as HTMLElement & { updateComplete?: Promise<boolean> }
          ).updateComplete
          return updateComplete ?? Promise.resolve()
        })
      )
      return result
    })
  }

  @property({ attribute: false })
  controller: RevisionHistoryControllerPort | null = null

  /**
   * Shared per-person colour mapping.
   *
   * Set by the host so the sidebar's dots and the diff overlay in the body agree:
   * both read this one instance, and the design requires one colour per person
   * per document.
   */
  @property({ attribute: false })
  colors: CollaboratorColorAssigner = new CollaboratorColorAssigner()

  /**
   * 宿主是否允许对本文档发起还原。
   *
   * 由扩展从 `RevisionHistoryOptions.canRestore` 设在面板上，再传给列表：只读文档
   * 下整条「还原」入口（按钮 + 确认弹窗）都不出现。面板这里是通往 Controller 的
   * 唯一入口，所以也在这里丢弃还原意图 —— 列表不渲染按钮之后本不该再有意图，
   * 拦住它是因为确认弹窗一旦打开，用户能做的就是确认一个注定会被 403 拒掉的操作。
   *
   * 默认 `true`，与列表一致。
   */
  @property({ attribute: false })
  canRestore = true

  @state()
  private snapshot: Snapshot = INITIAL_STATE

  private subscribedController: RevisionHistoryControllerPort | null = null
  private unsubscribeController: (() => void) | null = null
  private activeSubscription: object | null = null
  private latestVersion = -1
  private returnFocusTarget: HTMLElement | null = null
  private focusBackOnOpen = false
  private viewerMount: HTMLElement | null = null

  private readonly receiveSnapshot = (
    source: RevisionHistoryControllerPort,
    subscription: object,
    next: Snapshot
  ): void => {
    if (
      source !== this.subscribedController ||
      subscription !== this.activeSubscription
    ) {
      return
    }

    if (!(next.version > this.latestVersion)) {
      return
    }
    this.latestVersion = next.version

    if (next === this.snapshot) {
      return
    }

    const previous = this.snapshot
    if (!previous.open && next.open) {
      const activeElement =
        typeof document === 'undefined' ? null : document.activeElement
      this.returnFocusTarget = isHTMLElement(activeElement)
        ? activeElement
        : null
      this.focusBackOnOpen = true
    }

    this.snapshot = next
  }

  private readonly subscribeToController = (
    controller: RevisionHistoryControllerPort | null
  ): void => {
    const unsubscribe = this.unsubscribeController
    this.unsubscribeController = null
    this.activeSubscription = null
    this.subscribedController = null
    this.latestVersion = -1
    unsubscribe?.()

    if (controller === null || !this.isConnected) {
      return
    }

    const subscription = {}
    this.activeSubscription = subscription
    this.subscribedController = controller
    this.unsubscribeController = controller.subscribe(snapshot => {
      this.receiveSnapshot(controller, subscription, snapshot)
    })
  }

  override connectedCallback(): void {
    super.connectedCallback()
    this.addEventListener('keydown', this.handleKeyDown)
    this.addEventListener(REVISION_CLOSE_EVENT, this.handleClose)
    this.addEventListener(REVISION_SELECT_EVENT, this.handleSelect)
    this.addEventListener(
      REVISION_LOAD_NEXT_PAGE_EVENT,
      this.handleLoadNextPage
    )
    this.addEventListener(
      REVISION_COMPARE_TARGET_CHANGE_EVENT,
      this.handleCompareTargetChange
    )
    this.addEventListener(
      REVISION_RESTORE_REQUEST_EVENT,
      this.handleRestoreRequest
    )
    this.addEventListener(
      REVISION_RESTORE_CONFIRM_EVENT,
      this.handleRestoreConfirm
    )
    this.addEventListener(
      REVISION_RESTORE_CANCEL_EVENT,
      this.handleRestoreCancel
    )
    this.addEventListener(REVISION_SHOW_CHANGES_EVENT, this.handleShowChanges)
    this.addEventListener(REVISION_STEP_CHANGE_EVENT, this.handleStepChange)
    this.subscribeToController(this.controller)
  }

  override disconnectedCallback(): void {
    this.removeEventListener('keydown', this.handleKeyDown)
    this.removeEventListener(REVISION_CLOSE_EVENT, this.handleClose)
    this.removeEventListener(REVISION_SELECT_EVENT, this.handleSelect)
    this.removeEventListener(
      REVISION_LOAD_NEXT_PAGE_EVENT,
      this.handleLoadNextPage
    )
    this.removeEventListener(
      REVISION_COMPARE_TARGET_CHANGE_EVENT,
      this.handleCompareTargetChange
    )
    this.removeEventListener(
      REVISION_RESTORE_REQUEST_EVENT,
      this.handleRestoreRequest
    )
    this.removeEventListener(
      REVISION_RESTORE_CONFIRM_EVENT,
      this.handleRestoreConfirm
    )
    this.removeEventListener(
      REVISION_RESTORE_CANCEL_EVENT,
      this.handleRestoreCancel
    )
    this.removeEventListener(
      REVISION_SHOW_CHANGES_EVENT,
      this.handleShowChanges
    )
    this.removeEventListener(REVISION_STEP_CHANGE_EVENT, this.handleStepChange)
    this.unsubscribeFromController()
    super.disconnectedCallback()
  }

  private unsubscribeFromController(): void {
    const unsubscribe = this.unsubscribeController
    this.unsubscribeController = null
    this.activeSubscription = null
    this.subscribedController = null
    unsubscribe?.()
  }

  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    if (
      changedProperties.has('controller') &&
      this.isConnected &&
      this.controller !== this.subscribedController
    ) {
      this.subscribeToController(this.controller)
    }
  }

  protected override updated(changedProperties: PropertyValues<this>): void {
    const changes = changedProperties as Map<PropertyKey, unknown>
    if (!changes.has('snapshot')) {
      return
    }

    const previous = changes.get('snapshot') as Snapshot | undefined
    if (!this.snapshot.open) {
      if (previous?.open && this.returnFocusTarget?.isConnected) {
        this.returnFocusTarget.focus()
      }
      return
    }

    this.syncChildProperties()
    if (this.focusBackOnOpen) {
      this.focusBackOnOpen = false
      void this.focusBackButton()
    }
  }

  private syncChildProperties(): void {
    const list = this.querySelector<RevisionList>('yjs-revision-list')
    if (list !== null) {
      list.list = this.snapshot.list
      list.selectedRef = this.snapshot.selection.ref
      list.colors = this.colors
    }

    const dialog = this.querySelector<RevisionRestoreConfirmDialog>(
      'yjs-revision-restore-confirm-dialog'
    )
    if (dialog !== null) {
      dialog.restore = this.snapshot.restore
    }
  }

  /**
   * Moves focus into the sidebar when it opens.
   *
   * The close control is the target because it is the sidebar's first control
   * and its only guaranteed one — the list below may be empty or still loading.
   */
  private async focusBackButton(): Promise<void> {
    await this.updateComplete

    if (!this.isConnected || !this.snapshot.open) {
      return
    }
    this.querySelector<HTMLButtonElement>('.revision-vh-sidebar-close')?.focus()
  }

  private get activeController(): RevisionHistoryControllerPort | null {
    return this.subscribedController ?? this.controller
  }

  private handleSelect = (event: Event): void => {
    const id = (event as CustomEvent<RevisionSelectDetail>).detail?.id
    if (typeof id === 'string' && this.activeController !== null) {
      void this.activeController.selectRevision(id)
    }
  }

  private handleLoadNextPage = (): void => {
    if (this.activeController !== null) {
      void this.activeController.loadNextPage()
    }
  }

  private handleCompareTargetChange = (event: Event): void => {
    const target = (event as CustomEvent<RevisionCompareTargetChangeDetail>)
      .detail?.target
    if (target !== undefined && this.activeController !== null) {
      void this.activeController.setCompareTarget(target)
    }
  }

  /**
   * Mapped here rather than over the body: the layout has no toolbar, so
   * nothing in this package emits these. They stay wired because both remain
   * public intents and the commands `nextRevisionChange` / `previousRevisionChange`
   * expose the same controller methods to hosts.
   */
  private handleShowChanges = (event: Event): void => {
    const show = (event as CustomEvent<RevisionShowChangesDetail>).detail?.show
    if (typeof show === 'boolean' && this.activeController !== null) {
      this.activeController.setShowChanges(show)
    }
  }

  private handleStepChange = (event: Event): void => {
    const delta = (event as CustomEvent<RevisionStepChangeDetail>).detail?.delta
    if (typeof delta === 'number' && this.activeController !== null) {
      this.activeController.stepChange(delta)
    }
  }

  private handleRestoreRequest = (event: Event): void => {
    if (!this.canRestore) {
      return
    }

    const id = (event as CustomEvent<RevisionRestoreRequestDetail>).detail?.id
    if (typeof id === 'string' && this.activeController !== null) {
      this.activeController.requestRestore(id)
    }
  }

  private handleRestoreConfirm = (): void => {
    if (this.activeController !== null) {
      void this.activeController.confirmRestore()
    }
  }

  private handleRestoreCancel = (): void => {
    this.activeController?.cancelRestore()
  }

  private handleClose = (): void => {
    this.activeController?.close()
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) {
      return
    }

    // Escape must not dismiss a restore already in flight: the service has
    // rewritten state, so closing the dialog would imply it was called off.
    if (
      this.snapshot.restore.status === 'committing' ||
      this.snapshot.restore.status === 'rebuilding'
    ) {
      event.preventDefault()
      event.stopPropagation()
      return
    }

    const menu = this.querySelector<HTMLElement>('.revision-vh-context-menu')
    if (menu !== null) {
      event.preventDefault()
      const trigger = this.querySelector<HTMLElement>(
        '.revision-vh-menu-trigger[aria-expanded="true"]'
      )
      trigger?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          composed: true,
          cancelable: true,
        })
      )
      if (this.querySelector('.revision-vh-context-menu') !== null) {
        document.dispatchEvent(new Event('pointerdown'))
      }
      return
    }

    event.preventDefault()
    this.activeController?.close()
  }

  override render() {
    if (!this.snapshot.open) {
      return nothing
    }

    // An inline sidebar, not an overlay: the layout sits beside the
    // document and must not cover it. The host owns where this is placed.
    return html`
      <aside class="revision-vh-sidebar" aria-label="版本历史">
        <div class="revision-vh-sidebar-header">
          <h3>历史版本</h3>
          <button
            type="button"
            class="revision-vh-sidebar-close"
            aria-label="关闭历史版本"
            @click=${() => this.activeController?.close()}
          ></button>
        </div>
        <yjs-revision-list
          .list=${this.snapshot.list}
          .selectedRef=${this.snapshot.selection.ref}
          .colors=${this.colors}
          .canRestore=${this.canRestore}
        ></yjs-revision-list>
        <yjs-revision-restore-confirm-dialog
          .restore=${this.snapshot.restore}
        ></yjs-revision-restore-confirm-dialog>
      </aside>
    `
  }
}

const hasDocumentCustomElements =
  typeof document !== 'undefined' && typeof customElements !== 'undefined'
const registeredRevisionHistoryPanel = hasDocumentCustomElements
  ? customElements.get('yjs-revision-history-panel')
  : undefined

export type RevisionHistoryPanel = RevisionHistoryPanelElement
export const RevisionHistoryPanel = (registeredRevisionHistoryPanel ??
  RevisionHistoryPanelElement) as typeof RevisionHistoryPanelElement

if (hasDocumentCustomElements && registeredRevisionHistoryPanel === undefined) {
  customElements.define('yjs-revision-history-panel', RevisionHistoryPanel)
}

declare global {
  interface HTMLElementTagNameMap {
    'yjs-revision-history-panel': RevisionHistoryPanel
  }
}
