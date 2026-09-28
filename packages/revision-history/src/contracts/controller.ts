import type { Extension } from '@tiptap/core'
import type { NodeViewConstructor } from '@tiptap/pm/view'
import type { RevisionTransportConfig } from '../api/revision-api-client'
import type { RevisionAuthAdapter, RevisionHistoryPublicError } from './api'
import type { RevisionHistoryViewState } from './state'

export type CompareTarget =
  | { readonly kind: 'previous' }
  | { readonly kind: 'current' }
  | { readonly kind: 'revision'; readonly id: string }

export type RuntimeMode =
  | 'live-edit'
  | 'live-readonly'
  | 'revision-viewer'
  | 'restore'

export interface DescriptorFactoryContext {
  readonly mode: RuntimeMode
}

export interface RevisionExtensionDescriptor {
  readonly key: string
  readonly version: number
  readonly dependencies: readonly string[]
  readonly modes: readonly RuntimeMode[]
  readonly schemaCritical: boolean
  readonly renderer: 'required' | 'optional' | 'none'
  readonly fingerprintConfig: Readonly<Record<string, unknown>>
  readonly factory: (context: DescriptorFactoryContext) => Extension
}

export interface RevisionHistoryOpenChangeEvent {
  readonly documentId: string
  readonly open: boolean
}

export interface RevisionDegradationEvent {
  readonly documentId: string
  readonly kinds: readonly (
    | 'unknown-node'
    | 'unknown-mark'
    | 'invalid-content'
  )[]
  readonly names: readonly string[]
  readonly count: number
}

/**
 * The service accepted a restore.
 *
 * Only ids: restore writes the stored state and mints no epoch, and the
 * document rebuild is not driven from here — the service evicts the
 * collaboration room, which reaches the host as a `document.reset` broadcast and
 * a 4205 close. This event is the cue to leave the read-only viewing state, not
 * to reload anything.
 */
export interface RevisionHistoryRestoreCompleteEvent {
  readonly documentId: string
  readonly revisionId: string
}

export interface RevisionHistoryOptions {
  readonly documentId: string
  readonly servicePrefix: string
  /** Kept explicit for hosts that select a history backend; only V2 is supported. */
  readonly dataSource?: 'v2'
  readonly auth: RevisionAuthAdapter
  readonly fetchImpl?: typeof fetch
  readonly transport?: RevisionTransportConfig
  /** Where the sidebar panel is placed. */
  readonly mount: () => HTMLElement
  /**
   * Where the selected revision's body is rendered.
   *
   * Separate from `mount` because the viewer replaces the host's document area
   * while the sidebar sits beside it. Omitted means no body is rendered: the
   * sidebar still lists revisions, which is the pre-viewer behaviour.
   */
  readonly viewerMount?: () => HTMLElement
  /** Optional, host-owned read-only renderers for custom media nodes. */
  readonly nodeViews?: Readonly<Record<string, NodeViewConstructor>>
  /**
   * Whether the host allows restoring this document.
   *
   * Restore replaces `documents.state`, so a document the caller cannot write —
   * a viewer without edit privilege — must not offer the entry. The service also
   * fails restore closed with 403, but that is the last line of defence: an entry
   * shown first already promises an operation the caller cannot perform, and the
   * user only finds out after confirming it.
   *
   * `false` hides the per-card restore action and drops restore intents that
   * reach the panel, which is the only path to the confirmation dialog. It answers
   * a different question than `RevisionListItem.restorable` ("does the service
   * still hold the data a restore needs"): both must be true for the entry.
   *
   * Defaults to `true`, so hosts that use the extension standalone keep the
   * previous behaviour.
   */
  readonly canRestore?: boolean
  /**
   * Reports types a revision used that the running schema no longer has.
   *
   * Such a revision still renders — its text is kept — so this is diagnostic
   * rather than an error path.
   */
  readonly onDegradation?: (event: RevisionDegradationEvent) => void
  readonly addonDescriptors?: readonly RevisionExtensionDescriptor[]
  readonly onOpenChange?: (event: RevisionHistoryOpenChangeEvent) => void
  readonly onRestoreComplete?: (
    event: RevisionHistoryRestoreCompleteEvent
  ) => void
  readonly onError?: (error: RevisionHistoryPublicError) => void
}

export interface RevisionHistoryControllerPort {
  getState(): RevisionHistoryViewState
  subscribe(listener: (snapshot: RevisionHistoryViewState) => void): () => void
  open(): void
  close(): void
  loadNextPage(): Promise<void>
  selectRevision(id: string): Promise<void>
  setCompareTarget(target: CompareTarget): Promise<void>
  setShowChanges(show: boolean): void
  /**
   * Moves the change cursor. Wraps at both ends so repeated presses cycle
   * instead of dead-ending on the last change.
   */
  stepChange(delta: number): void
  setCurrentChange(index: number): void
  requestRestore(id: string): void
  confirmRestore(): Promise<void>
  cancelRestore(): void
}
