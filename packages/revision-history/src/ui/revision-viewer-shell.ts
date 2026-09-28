import { html, LitElement, nothing } from 'lit'
import { property } from 'lit/decorators.js'
import type { RevisionAvailability } from '../contracts/api'
import type { RevisionViewerState } from '../contracts/state'
import { diffTitle, type TitleSegment } from '../diff/diff-title'

const EMPTY_VIEWER: RevisionViewerState = Object.freeze({ status: 'empty' })

const UNAVAILABLE_COPY: Readonly<
  Record<Exclude<RevisionAvailability, 'ready'>, string>
> = Object.freeze({
  legacy_pending: '该版本内容正在准备，暂时无法预览',
  legacy_failed: '该版本内容不可用，暂时无法预览',
  deleted: '该版本已删除，无法预览',
})

class RevisionViewerShellElement extends LitElement {
  override createRenderRoot(): HTMLElement {
    return this
  }

  @property({ attribute: false })
  viewer: RevisionViewerState = EMPTY_VIEWER

  get viewerContainer(): HTMLElement | null {
    return this.querySelector<HTMLElement>('.revision-vh-render')
  }

  override render() {
    switch (this.viewer.status) {
      case 'empty':
        return html`<div class="revision-vh-state">选择一个版本以预览</div>`
      case 'loading':
        return html`<div class="revision-vh-state" role="status" aria-live="polite">
          正在加载版本...
        </div>`
      case 'ready':
        return html`
          ${this.renderTitleDiff()}
          <div class="revision-vh-render" role="document"></div>
        `
      case 'unavailable':
        return html`<div class="revision-vh-state" role="status" aria-live="polite">
          ${UNAVAILABLE_COPY[this.viewer.availability]}
        </div>`
      case 'error':
        return html`<div class="revision-vh-state" role="alert">
          ${this.viewer.error.messageKey}
        </div>`
    }
  }

  /**
   * This revision's title, above the body.
   *
   * ## Why this row exists at all
   *
   * The live `revision-title-bar` is hidden while the viewer is open (see
   * the host editor's history-view state) — it is bound to the live
   * `Y.Text('title')` and would show the document's **current** title, not this
   * revision's. On a document whose title changed, that reads as if the old
   * revision already had the new name. So the viewer takes over the title the same
   * way it takes over the body.
   *
   * That is also why this renders on every ready revision, not only when the title
   * changed: it occupies the hidden title bar's slot, and rendering nothing would
   * leave a blank where the title belongs and read as "this revision had no title".
   *
   * ## Rendered only when this revision changed the title
   *
   * `diffTitle` returning `null` — identical titles, or a compare side that is
   * still loading, failed, or does not exist — means there is no title change to
   * report, and this renders nothing. The live `revision-title-bar` then stays visible
   * and shows the title itself, which is why nothing is lost by staying quiet:
   * the host can hide that bar when this row exists, so the two are
   * never both on screen and never both absent.
   *
   * ## What `showChanges` controls
   *
   * Only the highlighting, not whether the row appears. The row's presence answers
   * "did the title change", which the toggle has no say over; with changes off the
   * row shows this revision's title as plain text — matching the body, where the
   * text stays and only the overlay goes. It must still show **this revision's**
   * title rather than deferring to the live bar: the bar carries the document's
   * current title, which is the wrong one whenever the title changed here.
   *
   * The reused `revision-vh-diff--inserted` / `--deleted` classes carry the body diff's
   * colours, so one edit looks the same wherever it appears. No author badge here:
   * titles are short and the row would be mostly badge.
   */
  private renderTitleDiff() {
    const viewer = this.viewer
    if (viewer.status !== 'ready') {
      return nothing
    }

    // 先判「这一版有没有改标题」，与 showChanges 无关：它决定要不要接管标题栏，
    // 而 showChanges 只决定接管之后标不标高亮。
    const segments = diffTitle(viewer.compareTitle, viewer.title)
    if (segments === null) {
      return nothing
    }

    return html`<div class="revision-vh-title-diff">
      ${viewer.showChanges
        ? segments.map(segment => this.renderTitleSegment(segment))
        : viewer.title}
    </div>`
  }

  private renderTitleSegment(segment: TitleSegment) {
    switch (segment.kind) {
      case 'equal':
        return html`<span>${segment.text}</span>`
      case 'inserted':
        return html`<span class="revision-vh-diff--inserted">${segment.text}</span>`
      case 'deleted':
        return html`<span class="revision-vh-diff--deleted">${segment.text}</span>`
    }
  }
}

const hasDocumentCustomElements =
  typeof document !== 'undefined' && typeof customElements !== 'undefined'
const registeredRevisionViewerShell = hasDocumentCustomElements
  ? customElements.get('yjs-revision-viewer-shell')
  : undefined

export type RevisionViewerShell = RevisionViewerShellElement
export const RevisionViewerShell = (registeredRevisionViewerShell ??
  RevisionViewerShellElement) as typeof RevisionViewerShellElement

if (hasDocumentCustomElements && registeredRevisionViewerShell === undefined) {
  customElements.define('yjs-revision-viewer-shell', RevisionViewerShell)
}

declare global {
  interface HTMLElementTagNameMap {
    'yjs-revision-viewer-shell': RevisionViewerShell
  }
}
