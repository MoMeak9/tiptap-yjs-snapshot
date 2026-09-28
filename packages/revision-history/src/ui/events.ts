import type { CompareTarget } from '../contracts/controller'

export const REVISION_CLOSE_EVENT = 'yjs-revision-close' as const
export const REVISION_COMPARE_TARGET_CHANGE_EVENT =
  'yjs-revision-compare-target-change' as const
export const REVISION_SELECT_EVENT = 'yjs-revision-select' as const
export const REVISION_RESTORE_REQUEST_EVENT =
  'yjs-revision-restore-request' as const
export const REVISION_RESTORE_CONFIRM_EVENT =
  'yjs-revision-restore-confirm' as const
export const REVISION_RESTORE_CANCEL_EVENT =
  'yjs-revision-restore-cancel' as const
export const REVISION_LOAD_NEXT_PAGE_EVENT =
  'yjs-revision-load-next-page' as const
export const REVISION_SHOW_CHANGES_EVENT = 'yjs-revision-show-changes' as const
export const REVISION_STEP_CHANGE_EVENT = 'yjs-revision-step-change' as const

export type RevisionCloseDetail = Readonly<Record<string, never>>

export interface RevisionCompareTargetChangeDetail {
  readonly target: CompareTarget
}

export interface RevisionSelectDetail {
  readonly id: string
}

export interface RevisionRestoreRequestDetail {
  readonly id: string
}

export type RevisionRestoreConfirmDetail = Readonly<Record<string, never>>

export type RevisionRestoreCancelDetail = Readonly<Record<string, never>>

export type RevisionLoadNextPageDetail = Readonly<Record<string, never>>

export interface RevisionShowChangesDetail {
  readonly show: boolean
}

export interface RevisionStepChangeDetail {
  /** `1` for the next change, `-1` for the previous one. */
  readonly delta: number
}

export function dispatchRevisionIntent<T>(
  target: EventTarget,
  type: string,
  detail: T
): boolean {
  return target.dispatchEvent(
    new CustomEvent(type, { detail, bubbles: true, composed: true })
  )
}
