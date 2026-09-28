import { html, LitElement, nothing, type PropertyValues } from 'lit'
import { property } from 'lit/decorators.js'
import type { RevisionHistoryViewState } from '../contracts/state'
import { describeRevisionError } from './error-copy'
import {
  dispatchRevisionIntent,
  REVISION_RESTORE_CANCEL_EVENT,
  REVISION_RESTORE_CONFIRM_EVENT,
  type RevisionRestoreCancelDetail,
  type RevisionRestoreConfirmDetail,
} from './events'

type RestoreState = RevisionHistoryViewState['restore']

const IDLE_RESTORE: RestoreState = Object.freeze({ status: 'idle' })
const EMPTY_RESTORE_CONFIRM_DETAIL: RevisionRestoreConfirmDetail =
  Object.freeze({})
const EMPTY_RESTORE_CANCEL_DETAIL: RevisionRestoreCancelDetail = Object.freeze(
  {}
)

/**
 * Progress copy. There is no preflight stage: the service validates ownership
 * and privilege on the restore request itself, so a separate check would only
 * add a round trip that can go stale before the write.
 */
const PROGRESS_COPY = Object.freeze({
  committing: '正在回滚...',
  rebuilding: '正在重建文档...',
})

let restoreDialogInstance = 0

class RevisionRestoreConfirmDialogElement extends LitElement {
  override createRenderRoot(): HTMLElement {
    return this
  }

  @property({ attribute: false })
  restore: RestoreState = IDLE_RESTORE

  private readonly titleId = `yjs-revision-restore-title-${++restoreDialogInstance}`
  private readonly descriptionId = `yjs-revision-restore-description-${restoreDialogInstance}`

  private get dismissible(): boolean {
    return (
      this.restore.status === 'confirming' || this.restore.status === 'error'
    )
  }

  private confirmRestore(): void {
    dispatchRevisionIntent<RevisionRestoreConfirmDetail>(
      this,
      REVISION_RESTORE_CONFIRM_EVENT,
      EMPTY_RESTORE_CONFIRM_DETAIL
    )
  }

  private cancelRestore(): void {
    dispatchRevisionIntent<RevisionRestoreCancelDetail>(
      this,
      REVISION_RESTORE_CANCEL_EVENT,
      EMPTY_RESTORE_CANCEL_DETAIL
    )
  }

  private handleBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget && this.dismissible) {
      this.cancelRestore()
    }
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (!this.dismissible) {
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      this.cancelRestore()
      return
    }

    if (event.key !== 'Tab') {
      return
    }

    const actions = Array.from(
      this.querySelectorAll<HTMLButtonElement>(
        '.revision-vh-restore-actions button:not([disabled])'
      )
    )
    if (actions.length === 0) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    const activeIndex = actions.indexOf(
      document.activeElement as HTMLButtonElement
    )
    const targetIndex = event.shiftKey
      ? activeIndex <= 0
        ? actions.length - 1
        : activeIndex - 1
      : activeIndex < 0 || activeIndex === actions.length - 1
        ? 0
        : activeIndex + 1
    actions[targetIndex]?.focus()
  }

  protected override updated(changedProperties: PropertyValues<this>): void {
    if (!changedProperties.has('restore')) {
      return
    }

    const previousRestore = changedProperties.get('restore') as
      | RestoreState
      | undefined
    if (
      this.restore.status === 'confirming' &&
      previousRestore?.status !== 'confirming'
    ) {
      this.querySelector<HTMLButtonElement>('.revision-vh-restore-cancel')?.focus()
    }
  }

  private renderActions(confirmCopy: '确认回滚' | '重试') {
    return html`
      <div class="revision-vh-restore-actions">
        <button
          type="button"
          class="revision-vh-restore-cancel"
          @click=${this.cancelRestore}
        >
          取消
        </button>
        <button
          type="button"
          class="revision-vh-restore-confirm"
          @click=${this.confirmRestore}
        >
          ${confirmCopy}
        </button>
      </div>
    `
  }

  private renderConfirmation() {
    return html`
      <div
        class="revision-vh-restore-backdrop"
        @click=${this.handleBackdropClick}
        @keydown=${this.handleKeyDown}
      >
        <section
          class="revision-vh-restore-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby=${this.titleId}
          aria-describedby=${this.descriptionId}
        >
          <h2 id=${this.titleId}>恢复版本</h2>
          <p id=${this.descriptionId}>
            确定要回滚到此版本吗？当前未保存的更改将会丢失。
          </p>
          ${this.renderActions('确认回滚')}
        </section>
      </div>
    `
  }

  private renderProgress(status: keyof typeof PROGRESS_COPY) {
    return html`
      <div
        class="revision-vh-restore-backdrop"
        @click=${this.handleBackdropClick}
        @keydown=${this.handleKeyDown}
      >
        <section
          class="revision-vh-restore-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby=${this.titleId}
          aria-describedby=${this.descriptionId}
        >
          <h2 id=${this.titleId}>恢复版本</h2>
          <p id=${this.descriptionId} role="status" aria-live="polite">
            ${PROGRESS_COPY[status]}
          </p>
        </section>
      </div>
    `
  }

  private renderError(
    restore: Extract<RestoreState, { readonly status: 'error' }>
  ) {
    return html`
      <div
        class="revision-vh-restore-backdrop"
        @click=${this.handleBackdropClick}
        @keydown=${this.handleKeyDown}
      >
        <section
          class="revision-vh-restore-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby=${this.titleId}
          aria-describedby=${this.descriptionId}
        >
          <h2 id=${this.titleId}>恢复失败</h2>
          <p id=${this.descriptionId}>
            ${describeRevisionError(restore.error)}
          </p>
          ${this.renderActions('重试')}
        </section>
      </div>
    `
  }

  override render() {
    switch (this.restore.status) {
      case 'idle':
        return nothing
      case 'confirming':
        return this.renderConfirmation()
      case 'committing':
      case 'rebuilding':
        return this.renderProgress(this.restore.status)
      case 'error':
        return this.renderError(this.restore)
    }
  }
}

const hasDocumentCustomElements =
  typeof document !== 'undefined' && typeof customElements !== 'undefined'
const registeredRevisionRestoreConfirmDialog = hasDocumentCustomElements
  ? customElements.get('yjs-revision-restore-confirm-dialog')
  : undefined

export type RevisionRestoreConfirmDialog = RevisionRestoreConfirmDialogElement
export const RevisionRestoreConfirmDialog =
  (registeredRevisionRestoreConfirmDialog ??
    RevisionRestoreConfirmDialogElement) as typeof RevisionRestoreConfirmDialogElement

if (
  hasDocumentCustomElements &&
  registeredRevisionRestoreConfirmDialog === undefined
) {
  customElements.define(
    'yjs-revision-restore-confirm-dialog',
    RevisionRestoreConfirmDialog
  )
}

declare global {
  interface HTMLElementTagNameMap {
    'yjs-revision-restore-confirm-dialog': RevisionRestoreConfirmDialog
  }
}
