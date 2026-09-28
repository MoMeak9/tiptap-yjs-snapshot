import type { JSONContent } from '@tiptap/core'
import { currentRevisionId } from '../api/revision-api-client'
import type {
  RestoreResult,
  RevisionApiClient,
  RevisionAvailability,
  RevisionHistoryPublicError,
  RevisionListItem,
} from '../contracts/api'
import type {
  CompareTarget,
  RevisionHistoryControllerPort,
} from '../contracts/controller'
import { deepFreeze } from '../contracts/deep-freeze'
import type { RevisionHistoryViewState } from '../contracts/state'
import type { RevisionChange } from '../diff/diff-documents'

const DEFAULT_PAGE_SIZE = 20

type StateListener = (snapshot: RevisionHistoryViewState) => void

/**
 * Computes the change list for two stored bodies.
 *
 * Injected rather than imported so the controller stays free of the schema: only
 * the host knows which schema the bodies should be read against, and a
 * controller that built its own would diff against different types than the
 * viewer renders.
 */
export type RevisionDiffPort = (
  compared: JSONContent,
  selected: JSONContent
) => readonly RevisionChange[]

export interface RevisionHistoryControllerConfig {
  readonly api: RevisionApiClient
  /**
   * Needed to address the virtual `current` revision, which the service serves
   * from the same detail route under a derived id.
   */
  readonly documentId: string
  readonly pageSize?: number
  /** Omitted means no changes are ever reported, not that there are none. */
  readonly diff?: RevisionDiffPort
  /**
   * Notifies the host that a restore was accepted by the service.
   *
   * The document rebuild is not driven from here: the service's room eviction
   * reaches the host as a `document.reset` plus a 4205 close, and the host
   * rebuilds off that. This is the hook for closing the panel and leaving the
   * read-only viewing state.
   */
  readonly onRestoreComplete?: (result: RestoreResult) => void
  readonly onError?: (error: RevisionHistoryPublicError) => void
  /**
   * Notifies the host that the panel opened or closed.
   *
   * The host needs this to enter its read-only viewing state; without it the
   * document stays editable behind an open history sidebar.
   */
  readonly onOpenChange?: (open: boolean) => void
}

/**
 * Reads the real availability off an unavailable-revision failure.
 *
 * `RevisionApiError` carries this as an optional field (see its doc comment);
 * `toPublicError` narrows to the shared `RevisionHistoryPublicError` shape and
 * drops it, so callers that need it must read the original error, not the
 * reduced one. When the service omits it, the unavailable fallback remains
 * conservative and does not attempt to render unknown content.
 */
function readUnavailableAvailability(
  error: unknown
): Exclude<RevisionAvailability, 'ready'> {
  const availability = (error as { availability?: unknown } | null)
    ?.availability
  return availability === 'legacy_pending' ||
    availability === 'legacy_failed' ||
    availability === 'deleted'
    ? availability
    : 'legacy_failed'
}

function isPublicError(value: unknown): value is RevisionHistoryPublicError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { messageKey?: unknown }).messageKey === 'string'
  )
}

const GENERIC_FAILURE: Readonly<
  Record<'list' | 'detail' | 'restore', RevisionHistoryPublicError>
> = Object.freeze({
  list: {
    code: 'REVISION_LIST_FAILED',
    operation: 'list',
    messageKey: 'revisionHistory.listFailed',
    retryable: true,
  },
  detail: {
    code: 'REVISION_DETAIL_FAILED',
    operation: 'detail',
    messageKey: 'revisionHistory.detailFailed',
    retryable: true,
  },
  // Not retryable: the service evicts the room and rewrites state before it can
  // fail late, so an automatic retry could restore twice.
  restore: {
    code: 'RESTORE_FAILED',
    operation: 'restore',
    messageKey: 'revisionHistory.restoreFailed',
    retryable: false,
  },
})

function toPublicError(
  error: unknown,
  operation: 'list' | 'detail' | 'restore'
): RevisionHistoryPublicError {
  if (isPublicError(error)) {
    return {
      code: error.code,
      operation: error.operation,
      messageKey: error.messageKey,
      retryable: error.retryable,
    }
  }

  // Anything not already reduced to a stable code is reported generically: the
  // raw value may carry document text or a token and must not reach state.
  return GENERIC_FAILURE[operation]
}

function wasAborted(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}

/**
 * V2 revision controller.
 *
 * Owns list paging and revision selection over `RevisionApiClient`. It creates
 * no Editor, Provider or Yjs document. Rendering a selected revision belongs to
 * `RevisionViewerHost`; the controller resolves content and comparison state.
 * Restore follows explicit confirmation and leaves collaboration reset to the host.
 */
export class RevisionHistoryController implements RevisionHistoryControllerPort {
  private readonly api: RevisionApiClient
  private readonly documentId: string
  private readonly diff?: RevisionDiffPort
  private readonly pageSize: number
  private readonly onRestoreComplete?: (result: RestoreResult) => void
  private readonly onError?: (error: RevisionHistoryPublicError) => void
  private readonly onOpenChange?: (open: boolean) => void
  private readonly listeners = new Set<StateListener>()
  private state: RevisionHistoryViewState
  private listController: AbortController | null = null
  private detailController: AbortController | null = null
  private compareController: AbortController | null = null
  /**
   * Monotonic stamp for selection work. A response is applied only while it
   * still matches, so a slow earlier request cannot overwrite a later selection.
   */
  private requestGeneration = 0
  private disposed = false

  constructor(config: RevisionHistoryControllerConfig) {
    this.api = config.api
    this.documentId = config.documentId
    this.diff = config.diff
    this.onRestoreComplete = config.onRestoreComplete
    this.pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE
    this.onError = config.onError
    this.onOpenChange = config.onOpenChange
    this.state = deepFreeze(initialState())
  }

  getState(): RevisionHistoryViewState {
    return this.state
  }

  subscribe(listener: StateListener): () => void {
    if (this.disposed) {
      return () => undefined
    }

    this.listeners.add(listener)
    try {
      listener(this.state)
    } catch {
      // A failing view must not prevent it from receiving later snapshots.
    }
    return () => {
      this.listeners.delete(listener)
    }
  }

  open(): void {
    if (this.disposed || this.state.open) {
      return
    }

    // A finished restore leaves `restore` on `rebuilding` for the host to read,
    // and nothing transitions out of it (`cancelRestore` refuses to). That is
    // correct while the panel stays closed, but its dialog renders a
    // viewport-covering backdrop: reopening with it still set paints an
    // uninteractive overlay over the whole page — the document looks completely
    // normal yet no click can place the cursor, and only a reload escapes.
    //
    // Clearing it here rather than in `close()` keeps the host contract intact
    // (`rebuilding` must survive `confirmRestore` so the host can act on it) and
    // scopes the reset to the moment it actually matters: a *new* viewing
    // session, which cannot inherit the previous restore's dialog.
    //
    // `committing` is deliberately not cleared: it is a real in-flight request
    // that resolves itself into `rebuilding` or `error`.
    const restore =
      this.state.restore.status === 'rebuilding'
        ? ({ status: 'idle' } as const)
        : this.state.restore
    this.patch({ open: true, restore })
    this.reportOpenChange(true)
    // Each viewing session starts from the latest page. A prior ready page can
    // become stale while editing or after another collaborator saves a revision.
    if (this.state.open && !this.disposed) {
      void this.fetchPage(null)
    }
  }

  toggle(): void {
    if (this.state.open) {
      this.close()
    } else {
      this.open()
    }
  }

  close(): void {
    if (this.disposed || !this.state.open) {
      return
    }

    // Closing abandons in-flight work; a late list or detail response must not
    // repopulate a panel the user has already dismissed.
    this.abortAll()

    // An aborted `fetchPage` returns without patching — deliberately, so it
    // cannot write into a dismissed panel — which leaves `list` on `loading`.
    // Normalize the status so a closed panel still has a coherent snapshot.
    //
    // Where it lands depends on what the aborted request was doing: a first page
    // had already cleared `items`, so there is nothing to show and `idle` makes
    // reopening fetch again; an append still holds the pages it had, which stay
    // valid along with their cursor.
    const list =
      this.state.list.status === 'loading'
        ? {
            ...this.state.list,
            status:
              this.state.list.items.length > 0
                ? ('ready' as const)
                : ('idle' as const),
          }
        : this.state.list
    this.patch({ open: false, list })
    this.reportOpenChange(false)
  }

  async loadNextPage(): Promise<void> {
    if (
      this.disposed ||
      !this.state.list.hasNextPage ||
      this.state.list.status === 'loading'
    ) {
      return
    }

    await this.fetchPage(this.state.list.nextCursor)
  }

  async selectRevision(id: string): Promise<void> {
    if (this.disposed) {
      return
    }

    const generation = ++this.requestGeneration
    this.detailController?.abort()
    // The in-flight compare side belongs to the previous selection. The
    // generation check would discard it anyway; aborting also stops the request.
    this.compareController?.abort()
    this.compareController = null
    const controller = new AbortController()
    this.detailController = controller

    this.patch({
      selection: {
        ref: { kind: 'revision', id },
        compareTarget: this.state.selection.compareTarget,
        requestGeneration: generation,
      },
      viewer: { status: 'loading', requestGeneration: generation },
    })

    try {
      const content = await this.api.getDetail({
        revisionId: id,
        signal: controller.signal,
      })
      if (this.isStale(generation, controller)) {
        return
      }

      const compareTarget = this.state.selection.compareTarget
      this.patch({
        viewer: {
          status: 'ready',
          selected: content.ref,
          compareTarget,
          content: content.content,
          title: content.title,
          contentHash: content.contentHash,
          compareContent: null,
          compareTitle: null,
          // Changes are only known once the compare side arrives. Showing them
          // is on by default: the toolbar's purpose is to surface what changed.
          showChanges: true,
          totalChanges: 0,
          changes: [],
          // Attribution belongs to the selected revision and arrives in the same
          // response as its body. The compare side's detail carries its own, but
          // that describes a different revision, so `loadCompareSide` keeps this
          // value rather than overwriting it.
          attribution: content.attribution,
        },
        changeNavigation: { current: 0, total: 0 },
      })
      // The compare side loads after the selected body is already renderable:
      // the user sees the revision immediately, and changes appear once the
      // second body arrives.
      await this.loadCompareSide(generation, compareTarget)
    } catch (error) {
      if (wasAborted(error) || this.isStale(generation, controller)) {
        return
      }

      const publicError = toPublicError(error, 'detail')
      // An unavailable revision is a property of that revision, not a transport
      // failure, so it renders as the viewer's unavailable branch.
      this.patch({
        viewer:
          publicError.code === 'REVISION_UNAVAILABLE'
            ? {
                status: 'unavailable',
                ref: { kind: 'revision', id },
                availability: readUnavailableAvailability(error),
              }
            : { status: 'error', error: publicError },
      })
      this.report(publicError)
    }
  }

  async setCompareTarget(target: CompareTarget): Promise<void> {
    if (this.disposed) {
      return
    }

    const generation = this.state.selection.requestGeneration
    this.patch({
      selection: {
        ref: this.state.selection.ref,
        compareTarget: target,
        requestGeneration: generation,
      },
    })

    const viewer = this.state.viewer
    if (viewer.status !== 'ready') {
      return
    }

    // The previously loaded body belongs to the old target, so it is dropped
    // before the new one is fetched: keeping it would diff against the wrong
    // side for as long as the request takes.
    this.patch({
      viewer: {
        ...viewer,
        compareTarget: target,
        compareContent: null,
        totalChanges: 0,
        changes: [],
      },
      changeNavigation: { current: 0, total: 0 },
    })
    await this.loadCompareSide(generation, target)
  }

  setShowChanges(show: boolean): void {
    const viewer = this.state.viewer
    if (this.disposed || viewer.status !== 'ready') {
      return
    }
    if (viewer.showChanges === show) {
      return
    }

    this.patch({ viewer: { ...viewer, showChanges: show } })
  }

  stepChange(delta: number): void {
    const viewer = this.state.viewer
    if (this.disposed || viewer.status !== 'ready') {
      return
    }

    const total = viewer.changes.length
    if (total === 0 || delta === 0) {
      return
    }

    // Wrap in both directions so holding the next button cycles rather than
    // sticking on the last change.
    const zeroBased = this.state.changeNavigation.current - 1
    const next = (((zeroBased + delta) % total) + total) % total
    this.patch({ changeNavigation: { current: next + 1, total } })
  }

  setCurrentChange(index: number): void {
    const viewer = this.state.viewer
    if (this.disposed || viewer.status !== 'ready') {
      return
    }

    const total = viewer.changes.length
    if (!Number.isInteger(index) || index < 0 || index >= total) {
      return
    }

    this.patch({ changeNavigation: { current: index + 1, total } })
  }

  requestRestore(id: string): void {
    if (this.disposed) {
      return
    }

    this.patch({ restore: { status: 'confirming', revisionId: id } })
  }

  /**
   * Performs the restore the user confirmed.
   *
   * The document is not rewritten here. The service evicts the collaboration
   * room and broadcasts `document.reset`, which reaches the host as a 4205 close;
   * the host rebuilds its runtime and clears the local cache off that signal.
   * This controller therefore reports completion and stops — reconstructing the
   * document from the response would race the host's own rebuild.
   */
  async confirmRestore(): Promise<void> {
    if (this.disposed) {
      return
    }

    const restore = this.state.restore
    if (restore.status !== 'confirming') {
      return
    }

    const revisionId = restore.revisionId
    this.patch({ restore: { status: 'committing', revisionId } })

    try {
      const result = await this.api.restore({ revisionId })
      // Disposal is checked but the request is not cancelled: it has already
      // taken effect server-side, so only the local reporting is dropped.
      if (this.disposed) {
        return
      }

      this.patch({ restore: { status: 'rebuilding', revisionId } })
      this.reportRestoreComplete(result)
    } catch (error) {
      if (this.disposed) {
        return
      }

      const publicError = toPublicError(error, 'restore')
      this.patch({
        restore: { status: 'error', revisionId, error: publicError },
      })
      this.report(publicError)
    }
  }

  cancelRestore(): void {
    if (this.disposed || this.state.restore.status === 'idle') {
      return
    }

    // A restore already sent cannot be taken back: the service has evicted the
    // room and rewritten state. Dismissing it here would tell the user it was
    // called off.
    if (
      this.state.restore.status === 'committing' ||
      this.state.restore.status === 'rebuilding'
    ) {
      return
    }

    this.patch({ restore: { status: 'idle' } })
  }

  dispose(): void {
    if (this.disposed) {
      return
    }

    this.disposed = true
    this.abortAll()
    this.listeners.clear()
  }

  /**
   * Diffs two bodies, treating a failure as "no changes".
   *
   * A diff that throws — mismatched schema generations being the realistic
   * cause — must not take down a revision the user can already read.
   */
  private computeChanges(
    compared: JSONContent,
    selected: JSONContent
  ): readonly RevisionChange[] {
    if (this.diff === undefined) {
      return []
    }

    try {
      return this.diff(compared, selected)
    } catch {
      return []
    }
  }

  /**
   * Resolves which revision the selected one is compared against.
   *
   * `previous` is answered from the loaded list because the service exposes no
   * "predecessor of" route: the list is ordered `(ctime DESC, id DESC)`, so the
   * next index is the older neighbour. It returns `null` when that neighbour is
   * not loaded yet or does not exist, which is why the oldest revision shows no
   * changes rather than a fabricated empty comparison.
   */
  private resolveCompareId(target: CompareTarget): string | null {
    const selected = this.state.viewer
    if (selected.status !== 'ready') {
      return null
    }

    switch (target.kind) {
      case 'revision':
        return target.id
      case 'current':
        return currentRevisionId(this.documentId)
      case 'previous': {
        const items = this.state.list.items
        // The virtual current revision is not a list entry, so its predecessor
        // is the newest listed one rather than a neighbour by index.
        if (selected.selected.kind === 'current') {
          return items[0]?.id ?? null
        }
        const selectedId = selected.selected.id
        const index = items.findIndex(item => item.id === selectedId)
        if (index < 0) {
          return null
        }
        return items[index + 1]?.id ?? null
      }
    }
  }

  /**
   * Loads the compare side's body through the same detail route.
   *
   * The service has no diff endpoint; both sides are plain revisions, and the
   * virtual `current` one is addressed by a derived id on that same route.
   */
  private async loadCompareSide(
    generation: number,
    target: CompareTarget
  ): Promise<void> {
    const compareId = this.resolveCompareId(target)
    if (compareId === null) {
      return
    }

    const selected = this.state.viewer
    // Comparing a revision with itself has no changes to show, and the request
    // would be wasted.
    if (
      selected.status === 'ready' &&
      selected.selected.kind === 'revision' &&
      selected.selected.id === compareId
    ) {
      return
    }

    this.compareController?.abort()
    const controller = new AbortController()
    this.compareController = controller

    try {
      const content = await this.api.getDetail({
        revisionId: compareId,
        signal: controller.signal,
      })
      if (this.isStale(generation, controller)) {
        return
      }

      const viewer = this.state.viewer
      // The selection may have moved on to a state that no longer renders a
      // body, in which case there is nothing to attach the compare side to.
      if (viewer.status !== 'ready' || viewer.compareTarget !== target) {
        return
      }

      const changes = this.computeChanges(content.content, viewer.content)
      this.patch({
        viewer: {
          ...viewer,
          compareContent: content.content,
          // Same response as `compareContent`, so the two sides of both diffs
          // (body and title) always describe the same pair of revisions.
          compareTitle: content.title,
          changes,
          totalChanges: changes.length,
        },
        // The cursor is 1-based for display; 0 means "no change selected".
        changeNavigation: {
          current: changes.length === 0 ? 0 : 1,
          total: changes.length,
        },
      })
    } catch (error) {
      if (wasAborted(error) || this.isStale(generation, controller)) {
        return
      }

      // A missing or unreadable compare side degrades to "no changes shown".
      // The selected revision is already rendered, and failing the whole viewer
      // over its neighbour would hide a body the user can legitimately read.
      this.report(toPublicError(error, 'detail'))
    }
  }

  private async fetchPage(cursor: string | null): Promise<void> {
    this.listController?.abort()
    const controller = new AbortController()
    this.listController = controller
    const isFirstPage = cursor === null

    this.patch({
      list: {
        status: 'loading',
        // Appending pages keeps what is already rendered; a refetch of the first
        // page replaces it so a stale list cannot be shown as current.
        items: isFirstPage ? [] : this.state.list.items,
        nextCursor: this.state.list.nextCursor,
        hasNextPage: this.state.list.hasNextPage,
        error: null,
      },
    })

    try {
      const page = await this.api.list({
        cursor,
        limit: this.pageSize,
        signal: controller.signal,
      })
      if (this.disposed || controller.signal.aborted) {
        return
      }

      const items: RevisionListItem[] = isFirstPage
        ? [...page.items]
        : [...this.state.list.items, ...page.items]

      this.patch({
        list: {
          status: 'ready',
          items,
          nextCursor: page.nextCursor,
          hasNextPage: page.hasNextPage,
          error: null,
        },
      })
    } catch (error) {
      if (wasAborted(error) || this.disposed || controller.signal.aborted) {
        return
      }

      const publicError = toPublicError(error, 'list')
      this.patch({
        list: {
          status: 'error',
          items: this.state.list.items,
          nextCursor: this.state.list.nextCursor,
          hasNextPage: this.state.list.hasNextPage,
          error: publicError,
        },
      })
      this.report(publicError)
    }
  }

  /**
   * A result is stale once superseded, disposed, or aborted.
   *
   * The abort check is not redundant: closing the panel aborts without bumping
   * the generation, so a resolved-but-abandoned response would otherwise still
   * be applied and repopulate a dismissed panel.
   */
  private isStale(generation: number, controller: AbortController): boolean {
    return (
      this.disposed ||
      controller.signal.aborted ||
      generation !== this.requestGeneration
    )
  }

  private abortAll(): void {
    this.listController?.abort()
    this.listController = null
    this.detailController?.abort()
    this.detailController = null
    this.compareController?.abort()
    this.compareController = null
  }

  private report(error: RevisionHistoryPublicError): void {
    try {
      this.onError?.(error)
    } catch {
      // The host callback is diagnostic; its failure must not roll back state.
    }
  }

  private reportRestoreComplete(result: RestoreResult): void {
    try {
      this.onRestoreComplete?.(result)
    } catch {
      // The host hook is a notification. Its failure must not turn a successful
      // restore into an error state — the document has already been replaced.
    }
  }

  private reportOpenChange(open: boolean): void {
    try {
      this.onOpenChange?.(open)
    } catch {
      // A failing host hook must not leave the panel's own state inconsistent.
    }
  }

  private patch(
    partial: Partial<Omit<RevisionHistoryViewState, 'version'>>
  ): void {
    this.state = deepFreeze({
      ...this.state,
      ...partial,
      version: this.state.version + 1,
    })

    // Snapshot the listener set: one subscribing during notification already
    // received the current state synchronously from `subscribe`.
    for (const listener of [...this.listeners]) {
      try {
        listener(this.state)
      } catch {
        // A failing view must not stop the remaining subscribers.
      }
    }
  }
}

function initialState(): RevisionHistoryViewState {
  return {
    version: 0,
    open: false,
    list: {
      status: 'idle',
      items: [],
      nextCursor: null,
      hasNextPage: false,
      error: null,
    },
    selection: {
      ref: null,
      compareTarget: { kind: 'previous' },
      requestGeneration: 0,
    },
    viewer: { status: 'empty' },
    restore: { status: 'idle' },
    changeNavigation: { current: 0, total: 0 },
  }
}
