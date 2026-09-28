import type { JSONContent } from '@tiptap/core'
import type { RevisionAttribution } from '../diff/attribution'

export type RevisionRef =
  | { readonly kind: 'revision'; readonly id: string }
  | { readonly kind: 'current' }

export type RevisionAvailability =
  | 'ready'
  | 'legacy_pending'
  | 'legacy_failed'
  | 'deleted'

/**
 * A collaborator's stable identity and display name.
 *
 * `username` is used as the identity key for activity, colours, and DOM
 * attributes. `nickname` is the human-readable name shown in the list.
 */
export interface RevisionCollaborator {
  readonly username: string
  readonly nickname: string
}

/**
 * One collaborator's edit activity inside a revision's interval.
 *
 * The revision card shows a per-edit timestamp under each name once expanded,
 * plus an optional note such as「恢复了第72版内容」.
 */
export interface RevisionCollaboratorActivity {
  /** Username, matching an entry of `collaborators`. */
  readonly name: string
  /** Epoch millis of this edit. */
  readonly editedAt: number
  /** Version this edit restored from, when the edit was a restore. */
  readonly restoredFromVersion?: number | null
}

export interface RevisionListItem {
  readonly id: string
  readonly documentId: string
  readonly title: string
  readonly name: string | null
  /** Wire field is `ctime` (epoch millis); the client maps it to this name. */
  readonly createdAt: number
  /**
   * Username of whoever triggered the revision, or `null` when no actor was
   * recorded (for example an autonomous snapshot).
   *
   * This remains a username because it identifies the actor who triggered the
   * revision; `createdByUser` carries their display profile independently of
   * whether they contributed to this revision's content.
   */
  readonly createdBy: string | null
  /** Optional for compatibility with servers that only return `createdBy`. */
  readonly createdByUser?: RevisionCollaborator | null
  /** Users that contributed inside this revision's interval. */
  readonly collaborators: readonly RevisionCollaborator[]
  /**
   * Per-collaborator edit activity, shown when a card is expanded.
   *
   * Optional because a V2 service may return only the flat `collaborators`
   * list. When it is absent the card does not fabricate edit times.
   */
  readonly activity?: readonly RevisionCollaboratorActivity[]
  /**
   * Version this revision restored its content from, when it was a restore.
   *
   * Optional when the service does not track a source revision for restores.
   */
  readonly restoredFromVersion?: number | null
  readonly version: number
  readonly type: string
  readonly availability: RevisionAvailability
  /**
   * Whether this revision may take part in a JSON diff.
   *
   * **Do not gate the diff UI on this.** List metadata may be less current than
   * the detail response. Selecting a revision resolves its canonical body and
   * gives the viewer the authoritative availability. This field remains useful
   * for diagnostics and list-level hints.
   */
  readonly diffEligible: boolean
  /**
   * Whether the revision *has the data* a restore would need.
   *
   * Independent of `availability`: a revision whose canonicalization failed has
   * no diffable content but may still hold a usable state, and restoring writes
   * that state back directly.
   *
   * It says nothing about whether the caller is *allowed* to restore — that
   * needs write privilege, which only the service checks, answering 403. So this
   * must not be treated as "the button will work".
   */
  readonly restorable: boolean
}

export interface RevisionContent {
  readonly ref: RevisionRef
  readonly documentId: string
  readonly title: string
  readonly content: JSONContent
  readonly contentHash: string
  readonly availability: 'ready'
  /**
   * Whether the service derived `content` from stored V2 state instead of a
   * materialized JSON field. Exposed for observability; rendering does not branch
   * on it because both forms represent the same revision.
   */
  readonly decodedFromState: boolean
  /**
   * 逐处归属，**区间量**：只声明「从上一版到这一版之间，新增了哪些位置、是谁写的」，
   * 不描述「此刻每个幸存字符是谁写的」。
   *
   * 与 `RevisionListItem.collaborators` 同一量纲，两者刻意配套：这个字段说「这个区间
   * 改了哪些位置」，那个字段说「谁改的」。归属的唯一消费者是 diff 徽章，而徽章要回答
   * 「**这一处改动**是谁做的」—— 累计量答的是另一个问题，会让改动签上当年建这个节点
   * 的人。语义细节与后果见 {@link RangesAttribution}。
   *
   * `null` 表示服务端没给或给的形态不认识。区间量下「这一版什么都没新增」（纯删除、
   * 只改标题）也落到这里，所以 `null` 是常态而非异常。此时整份 diff 不署名、走中性
   * 色，**不回落到 `createdBy`**：那是快照创建者，与内容作者无可推导关系。
   *
   * 坐标与 `content` 同源：服务端在同一次解码里产出两者。客户端不校验坐标，越界的区间
   * 由 `createAttributionIndex` 的查询自然落空。
   */
  readonly attribution: RevisionAttribution | null
}

export interface RevisionPage {
  readonly items: readonly RevisionListItem[]
  readonly nextCursor: string | null
  /** Wire field is `hasMore`; cursor pagination has no total to derive it from. */
  readonly hasNextPage: boolean
}

/**
 * Result of a completed restore.
 *
 * `revisionId` is the requested target revision ID. The reference transport
 * answers `{ id: requestedTargetRevisionId }`; an audit row ID is a different
 * value and must not be returned in this field. Live document recovery follows
 * the collaboration reset signal, not this HTTP payload.
 */
export interface RestoreResult {
  readonly revisionId: string
}

/**
 * V2 revision transport.
 *
 * No `documentId` input on any method: the client is constructed for one
 * document and sends it as the `doc_id` routing key by default. The server must
 * verify access independently of this caller-provided key.
 *
 */
export interface RevisionApiClient {
  list(input: {
    cursor: string | null
    limit: number
    signal: AbortSignal
  }): Promise<RevisionPage>
  getDetail(input: {
    revisionId: string
    signal: AbortSignal
  }): Promise<RevisionContent>
  /**
   * Replaces the live document with a revision's stored state.
   *
   * Deliberately takes no `AbortSignal`. Restore is not idempotent from the
   * caller's side: the service evicts the room and rewrites `documents.state`, so
   * a request abandoned in flight may still have taken effect. Cancelling would
   * only hide that from the UI.
   */
  restore(input: { revisionId: string }): Promise<RestoreResult>
}

export interface RevisionAuthAdapter {
  getToken(): string
  applyTokenEnvelope(envelope: {
    readonly token: string
    readonly expiresAt: number
  }): void
  onTokenChange?(listener: (token: string) => void): () => void
}

export type RevisionHistoryErrorCode =
  | 'REVISION_LIST_FAILED'
  | 'REVISION_DETAIL_FAILED'
  | 'REVISION_UNAVAILABLE'
  | 'REVISION_SCHEMA_UNSUPPORTED'
  | 'REVISION_HASH_MISMATCH'
  | 'REVISION_DIFF_FAILED'
  /**
   * The V2 surface is switched off for this caller.
   *
   * Distinct from `REVISION_UNAVAILABLE`, which is about one revision's data.
   * The gate answers 404 rather than 403 so a not-yet-launched endpoint is
   * indistinguishable from a missing route, so a 404 on the collection cannot be
   * reported as "revision not found" without misleading users during rollout.
   */
  | 'REVISION_API_UNAVAILABLE'
  /** Transient service-side capacity limit; retrying is meaningful. */
  | 'REVISION_BUSY'
  /** The token was rejected or does not cover this document. */
  | 'REVISION_UNAUTHORIZED'
  /**
   * Restore is unavailable for this revision.
   *
   * Covers both a disabled rollout gate and a revision that does not belong to
   * this document: the service answers 404 for both and the client cannot
   * distinguish them. Neither is retryable.
   */
  | 'REVISION_RESTORE_UNAVAILABLE'
  /**
   * The caller may read this document but not write it.
   *
   * Restore requires write privilege because it replaces `documents.state`; a
   * read-only collaborator gets this instead of a generic failure.
   */
  | 'REVISION_RESTORE_FORBIDDEN'
  | 'RESTORE_PREFLIGHT_FAILED'
  | 'RESTORE_EPOCH_STALE'
  | 'RESTORE_RUNTIME_MISMATCH'
  | 'RESTORE_FAILED'

export interface RevisionHistoryPublicError {
  readonly code: RevisionHistoryErrorCode
  readonly operation: 'list' | 'detail' | 'diff' | 'restore'
  readonly messageKey: string
  readonly retryable: boolean
}
