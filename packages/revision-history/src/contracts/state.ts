import type { JSONContent } from '@tiptap/core'
import type { RevisionAttribution } from '../diff/attribution'
import type { RevisionChange } from '../diff/diff-documents'
import type {
  RevisionAvailability,
  RevisionHistoryPublicError,
  RevisionListItem,
  RevisionRef,
} from './api'
import type { CompareTarget } from './controller'

export type RevisionViewerState =
  | { readonly status: 'empty' }
  | {
      readonly status: 'loading'
      readonly requestGeneration: number
    }
  | {
      readonly status: 'ready'
      readonly selected: RevisionRef
      readonly compareTarget: CompareTarget
      /**
       * The selected revision's body.
       *
       * Held in state rather than re-fetched by the view: the viewer renders from
       * a snapshot, and a view that fetched its own content could render a
       * different revision than the one the list shows as selected.
       */
      readonly content: JSONContent
      readonly title: string
      readonly contentHash: string
      /**
       * The compare side's body, once resolved. `null` while it is still being
       * fetched, or when the selected revision has no comparable counterpart
       * (the oldest revision has no previous one).
       */
      readonly compareContent: JSONContent | null
      /**
       * The compare side's title, resolved alongside `compareContent`.
       *
       * Held separately from `title` because the title diff needs both sides, and
       * `null` here carries the same three meanings as `compareContent`'s: still
       * loading, failed, or no counterpart exists. `diffTitle` renders nothing for
       * `null` rather than treating it as an empty title — see its doc comment.
       */
      readonly compareTitle: string | null
      readonly showChanges: boolean
      readonly totalChanges: number
      /**
       * Changes in `content` coordinates, in document order.
       *
       * Held in state so the toolbar's count, the navigation cursor and the
       * rendered decorations all read the same list — computing it per view
       * would let the count and the overlay disagree.
       */
      readonly changes: readonly RevisionChange[]
      /**
       * 该版本的逐处归属（区间量：本区间新增了哪些位置、是谁写的），`null` 表示没有
       * —— 此时整份 diff 不署名、走中性色，不回落到版本级 `createdBy`。
       *
       * 与 `changes` 并列存在状态里而不是让 viewer 自己去要：两者必须来自同一次
       * 详情加载，各自获取会让某一刻的归属对应到另一个版本的变更上。
       */
      readonly attribution: RevisionAttribution | null
    }
  | {
      readonly status: 'unavailable'
      readonly ref: RevisionRef
      readonly availability: Exclude<RevisionAvailability, 'ready'>
    }
  | {
      readonly status: 'error'
      readonly error: RevisionHistoryPublicError
    }

export interface RevisionHistoryViewState {
  readonly version: number
  readonly open: boolean
  readonly list: {
    readonly status: 'idle' | 'loading' | 'ready' | 'error'
    readonly items: readonly RevisionListItem[]
    readonly nextCursor: string | null
    readonly hasNextPage: boolean
    readonly error: RevisionHistoryPublicError | null
  }
  readonly selection: {
    readonly ref: RevisionRef | null
    readonly compareTarget: CompareTarget
    readonly requestGeneration: number
  }
  readonly viewer: RevisionViewerState
  /**
   * Restore progress.
   *
   * `rebuilding` carries no `targetEpoch`: restore writes the snapshot's existing
   * state back directly and mints no epoch. The state
   * means "the service accepted it; the host is reconnecting off the reset
   * broadcast", which is as much as the client can know.
   */
  readonly restore:
    | { readonly status: 'idle' }
    | { readonly status: 'confirming'; readonly revisionId: string }
    | { readonly status: 'committing'; readonly revisionId: string }
    | { readonly status: 'rebuilding'; readonly revisionId: string }
    | {
        readonly status: 'error'
        readonly revisionId: string
        readonly error: RevisionHistoryPublicError
      }
  readonly changeNavigation: {
    readonly current: number
    readonly total: number
  }
}
