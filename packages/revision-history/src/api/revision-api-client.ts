import type {
  RestoreResult,
  RevisionApiClient,
  RevisionAuthAdapter,
  RevisionAvailability,
  RevisionCollaborator,
  RevisionCollaboratorActivity,
  RevisionContent,
  RevisionHistoryErrorCode,
  RevisionHistoryPublicError,
  RevisionListItem,
  RevisionPage,
} from '../contracts/api'
import type { RevisionAttribution } from '../diff/attribution'

/** Wire names used by the reference backend; hosts can override each one. */
export interface RevisionTransportConfig {
  readonly documentIdQueryKey?: string
  readonly tokenHeader?: string | null
  readonly refreshEnvelopeHeader?: string | null
  readonly routes?: Partial<{
    list: string
    detail: string
    restore: string
  }>
}

export interface RevisionApiClientConfig {
  readonly documentId: string
  /**
   * Opaque base URL that already contains the API prefix, e.g. `/api`. Only a trailing slash is
   * normalized: no host is
   * inferred and no second prefix segment is appended.
   */
  readonly servicePrefix: string
  readonly auth: RevisionAuthAdapter
  readonly fetchImpl?: typeof fetch
  readonly transport?: RevisionTransportConfig
}

/**
 * Error carrying only a stable code.
 *
 * The response body, revision content, token and raw failure message are all
 * deliberately dropped: diagnostics must never be able to surface document text.
 */
export class RevisionApiError
  extends Error
  implements RevisionHistoryPublicError
{
  readonly code: RevisionHistoryErrorCode
  readonly operation: 'list' | 'detail' | 'diff' | 'restore'
  readonly messageKey: string
  readonly retryable: boolean
  /**
   * The revision's real availability, carried only on `REVISION_UNAVAILABLE`.
   *
   * Not part of `RevisionHistoryPublicError`: `list`/`restore` failures have no
   * such thing, and widening the shared interface would force every other
   * failure site to reason about a field that never applies to it. The viewer's
   * `unavailable` branch needs this to show the service's actual reason
   * (pending vs. failed vs. deleted) instead of a guess.
   */
  readonly availability?: Exclude<RevisionAvailability, 'ready'>

  constructor(
    error: RevisionHistoryPublicError & {
      readonly availability?: Exclude<RevisionAvailability, 'ready'>
    }
  ) {
    super(error.code)
    this.name = 'RevisionApiError'
    this.code = error.code
    this.operation = error.operation
    this.messageKey = error.messageKey
    this.retryable = error.retryable
    this.availability = error.availability
  }
}

type Operation = 'list' | 'detail' | 'restore'

const MESSAGE_KEYS: Record<RevisionHistoryErrorCode, string> = {
  REVISION_LIST_FAILED: 'revisionHistory.listFailed',
  REVISION_DETAIL_FAILED: 'revisionHistory.detailFailed',
  REVISION_UNAVAILABLE: 'revisionHistory.unavailable',
  REVISION_SCHEMA_UNSUPPORTED: 'revisionHistory.schemaUnsupported',
  REVISION_HASH_MISMATCH: 'revisionHistory.hashMismatch',
  REVISION_DIFF_FAILED: 'revisionHistory.diffFailed',
  REVISION_API_UNAVAILABLE: 'revisionHistory.apiUnavailable',
  REVISION_BUSY: 'revisionHistory.busy',
  REVISION_UNAUTHORIZED: 'revisionHistory.unauthorized',
  REVISION_RESTORE_UNAVAILABLE: 'revisionHistory.restoreUnavailable',
  REVISION_RESTORE_FORBIDDEN: 'revisionHistory.restoreForbidden',
  RESTORE_PREFLIGHT_FAILED: 'revisionHistory.restorePreflightFailed',
  RESTORE_EPOCH_STALE: 'revisionHistory.restoreEpochStale',
  RESTORE_RUNTIME_MISMATCH: 'revisionHistory.restoreRuntimeMismatch',
  RESTORE_FAILED: 'revisionHistory.restoreFailed',
}

const RETRYABLE: ReadonlySet<RevisionHistoryErrorCode> = new Set([
  'REVISION_LIST_FAILED',
  'REVISION_DETAIL_FAILED',
  'REVISION_BUSY',
])

function fail(
  code: RevisionHistoryErrorCode,
  operation: Operation,
  availability?: Exclude<RevisionAvailability, 'ready'>
): RevisionApiError {
  return new RevisionApiError({
    code,
    operation,
    messageKey: MESSAGE_KEYS[code],
    retryable: RETRYABLE.has(code),
    availability,
  })
}

function normalizePrefix(servicePrefix: string): string {
  return servicePrefix.replace(/\/+$/, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  return typeof value === 'string' ? value : ''
}

function readNullableString(
  source: Record<string, unknown>,
  key: string
): string | null {
  const value = source[key]
  return typeof value === 'string' ? value : null
}

function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function readBoolean(source: Record<string, unknown>, key: string): boolean {
  return source[key] === true
}

function readCollaborators(
  source: Record<string, unknown>,
  key: string
): RevisionCollaborator[] {
  const value = source[key]
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter(isRecord).flatMap(entry => {
    const username = readNullableString(entry, 'username')
    if (username === null || username === '') {
      return []
    }

    const nickname = readNullableString(entry, 'nickname')
    return [{ username, nickname: nickname?.trim() || username }]
  })
}

function readCreatedByUser(
  raw: Record<string, unknown>,
  createdBy: string | null
): RevisionCollaborator | null {
  const value = raw.createdByUser
  if (
    createdBy === null ||
    createdBy === '' ||
    !isRecord(value) ||
    value.username !== createdBy
  ) {
    return null
  }

  return {
    username: createdBy,
    nickname: readNullableString(value, 'nickname')?.trim() || createdBy,
  }
}

/**
 * Reads an optional numeric field, distinguishing absent from zero.
 *
 * `readNumber` folds a missing field to `0`, which for a version number would
 * read as "restored from version 0" instead of "not a restore".
 */
function readNullableNumber(
  source: Record<string, unknown>,
  key: string
): number | null {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Reads the optional per-collaborator activity list.
 *
 * The key is omitted entirely when the service sends nothing usable, so a card
 * stays non-expandable rather than expanding onto an empty list. Entries
 * without a usable name or timestamp are dropped.
 */
function readActivity(raw: Record<string, unknown>): {
  activity?: RevisionCollaboratorActivity[]
} {
  const value = raw.activity
  if (!Array.isArray(value)) {
    return {}
  }

  const activity = value.filter(isRecord).flatMap(entry => {
    const name = readNullableString(entry, 'name')
    const editedAt = readNullableNumber(entry, 'editedAt')
    if (name === null || editedAt === null) {
      return []
    }
    return [
      {
        name,
        editedAt,
        restoredFromVersion: readNullableNumber(entry, 'restoredFromVersion'),
      },
    ]
  })

  return activity.length > 0 ? { activity } : {}
}

/**
 * Reads a coordinate that must have been sent explicitly.
 *
 * `readNumber` folds a missing field to `0`, which for a range start is a legal
 * position — an entry with no `from` would silently attribute the top of the
 * document to somebody.
 */
function readCoordinate(
  source: Record<string, unknown>,
  key: string
): number | null {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Reads per-position attribution.
 *
 * Nothing here throws. Attribution only decides whether changes can be signed,
 * not whether the detail can open, so an unreadable payload degrades to `null`
 * and the overlay renders unsigned in the neutral colour. That is also what makes
 * this forward compatible: when the service adds another shape, a client that
 * does not recognize it goes quiet instead of blank.
 *
 * `null` is a normal answer rather than an error. The field is an interval
 * quantity — it declares only what this revision *added* — so a revision that
 * added nothing (a pure deletion, a title-only edit) legitimately carries none.
 */
function readAttribution(
  raw: Record<string, unknown>
): RevisionAttribution | null {
  const value = raw.attribution
  if (!isRecord(value)) {
    return null
  }

  if (value.kind === 'whole') {
    const author = readString(value, 'author')
    // An empty author would render a nameless badge — an empty box, which reads
    // worse than no badge at all. Nothing is signed instead.
    return author === '' ? null : { kind: 'whole', author }
  }

  if (value.kind === 'ranges' && Array.isArray(value.ranges)) {
    const ranges = value.ranges.filter(isRecord).flatMap(entry => {
      const from = readCoordinate(entry, 'from')
      const to = readCoordinate(entry, 'to')
      const author = readString(entry, 'author')
      if (from === null || to === null || author === '') {
        return []
      }
      return [{ from, to, author }]
    })
    const deletions = readDeletions(value)

    // No usable entry reads as no attribution rather than an empty list: the two
    // mean the same thing downstream, and one fewer state is one fewer branch.
    //
    // Deletions alone are enough to keep the payload: a pure deletion adds no
    // range at all, and the deleter is then the only thing this revision knows.
    if (ranges.length === 0 && deletions.length === 0) {
      return null
    }

    return deletions.length > 0
      ? { kind: 'ranges', ranges, deletions }
      : { kind: 'ranges', ranges }
  }

  return null
}

/**
 * Reads the per-position deletion signatures.
 *
 * Zero-width marks, so only `at` is read — a deletion has no width in *this*
 * revision's coordinate space. Absent field, wrong shape and unusable entries all
 * degrade to an empty list, which reads as "deletions are unsigned here" and is
 * exactly the pre-existing behaviour.
 *
 * Duplicate `at` values are kept rather than collapsed: Yjs merges adjacent
 * deletions into one tombstone, and the service splits that back into one entry
 * per author, so several authors legitimately share a position. Which one a badge
 * shows is decided in `createAttributionIndex`, not here.
 */
function readDeletions(
  value: Record<string, unknown>
): readonly { at: number; author: string }[] {
  if (!Array.isArray(value.deletions)) {
    return []
  }

  return value.deletions.filter(isRecord).flatMap(entry => {
    const at = readCoordinate(entry, 'at')
    const author = readString(entry, 'author')
    if (at === null || author === '') {
      return []
    }
    return [{ at, author }]
  })
}

/**
 * Addressable id for a document's live state.
 *
 * Mirrors the service's `current-<documentId>` form so the same detail endpoint
 * serves "now" without a second route. Kept in sync with the server by the
 * client contract test.
 */
export function currentRevisionId(documentId: string): string {
  return `current-${documentId}`
}

const AVAILABILITY_VALUES: ReadonlySet<string> = new Set([
  'ready',
  'legacy_pending',
  'legacy_failed',
  'deleted',
])

function readAvailability(
  source: Record<string, unknown>
): RevisionAvailability {
  const value = source.availability
  // Unknown values use the wire contract's unavailable fallback. Assuming
  // `ready` would send unusable content to the viewer.
  return typeof value === 'string' && AVAILABILITY_VALUES.has(value)
    ? (value as RevisionAvailability)
    : 'legacy_failed'
}

function toListItem(
  raw: Record<string, unknown>,
  documentId: string
): RevisionListItem {
  const createdBy = readNullableString(raw, 'createdBy')
  return {
    id: readString(raw, 'id'),
    documentId: readString(raw, 'documentId') || documentId,
    title: readString(raw, 'title'),
    name: readNullableString(raw, 'name'),
    // Wire field is `ctime`.
    createdAt: readNumber(raw, 'ctime'),
    createdBy,
    createdByUser: readCreatedByUser(raw, createdBy),
    collaborators: readCollaborators(raw, 'collaborators'),
    ...readActivity(raw),
    restoredFromVersion: readNullableNumber(raw, 'restoredFromVersion'),
    version: readNumber(raw, 'version'),
    type: readString(raw, 'type'),
    availability: readAvailability(raw),
    diffEligible: readBoolean(raw, 'diffEligible'),
    restorable: readBoolean(raw, 'restorable'),
  }
}

/**
 * Applies a refreshed token envelope if the response carried one.
 *
 * A malformed envelope is ignored rather than surfaced: the current token is
 * still valid, so a bad refresh hint must not fail an otherwise good response.
 */
function applyRefreshedToken(
  response: Response,
  auth: RevisionAuthAdapter,
  headerName: string | null
): void {
  if (headerName === null) return
  const header = response.headers.get(headerName)
  if (header === null || header === '') {
    return
  }

  try {
    const parsed: unknown = JSON.parse(header)
    if (!isRecord(parsed)) {
      return
    }
    const token = parsed.token
    const expiresAt = parsed.expiresAt
    if (typeof token !== 'string' || typeof expiresAt !== 'number') {
      return
    }
    auth.applyTokenEnvelope({ token, expiresAt })
  } catch {
    // Not JSON; the existing token remains in force.
  }
}

/**
 * Maps a transport or envelope failure onto a stable code.
 *
 * A 404 becomes `REVISION_API_UNAVAILABLE`, not "revision not found": the
 * rollout gate answers 404 while the V2 surface is switched off, so treating it
 * as a missing revision would misreport a disabled feature during rollout.
 */
const FAILURE_BY_OPERATION: Readonly<
  Record<Operation, RevisionHistoryErrorCode>
> = Object.freeze({
  list: 'REVISION_LIST_FAILED',
  detail: 'REVISION_DETAIL_FAILED',
  restore: 'RESTORE_FAILED',
})

function classify(status: number, operation: Operation): RevisionApiError {
  if (status === 404) {
    // Restore answers 404 for two different things: the rollout gate, and a
    // revision that does not belong to this document. Both are reported as
    // "restore is not available for this revision" — the request must not be
    // retried either way, and the client cannot tell them apart.
    return fail(
      operation === 'restore'
        ? 'REVISION_RESTORE_UNAVAILABLE'
        : 'REVISION_API_UNAVAILABLE',
      operation
    )
  }
  if (status === 503) {
    return fail('REVISION_BUSY', operation)
  }
  // 403 is a read-only collaborator hitting a write-privilege route. It is not
  // retryable and is not a transport failure, so it gets its own code rather
  // than the generic one.
  if (status === 401 || status === 403) {
    return fail(
      operation === 'restore'
        ? 'REVISION_RESTORE_FORBIDDEN'
        : 'REVISION_UNAUTHORIZED',
      operation
    )
  }
  return fail(FAILURE_BY_OPERATION[operation], operation)
}

export function createRevisionApiClient(
  config: RevisionApiClientConfig
): RevisionApiClient {
  const { documentId, auth } = config
  const prefix = normalizePrefix(config.servicePrefix)
  const fetchImpl = config.fetchImpl ?? globalThis.fetch
  const transport = config.transport ?? {}
  const documentIdQueryKey = transport.documentIdQueryKey ?? 'doc_id'
  const tokenHeader = transport.tokenHeader === undefined ? 'x-document-token' : transport.tokenHeader
  const refreshEnvelopeHeader = transport.refreshEnvelopeHeader === undefined
    ? 'x-refresh-document-token-envelope'
    : transport.refreshEnvelopeHeader
  const routes = {
    list: transport.routes?.list ?? '/revisions/list',
    detail: transport.routes?.detail ?? '/revisions/detail',
    restore: transport.routes?.restore ?? '/revisions/restore',
  }

  async function request(
    path: string,
    params: Record<string, string>,
    operation: Operation,
    signal?: AbortSignal,
    body?: Record<string, string>
  ): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({
      [documentIdQueryKey]: documentId,
      ...params,
    })

    let response: Response
    try {
      response = await fetchImpl(`${prefix}${path}?${query.toString()}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(tokenHeader === null ? {} : { [tokenHeader]: auth.getToken() }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      // Propagate cancellation untouched so callers can tell an abandoned
      // request from a failed one; only real failures become domain errors.
      if (signal?.aborted === true) {
        throw error
      }
      throw fail(FAILURE_BY_OPERATION[operation], operation)
    }

    applyRefreshedToken(response, auth, refreshEnvelopeHeader)

    if (!response.ok) {
      throw classify(response.status, operation)
    }

    let envelope: unknown
    try {
      envelope = await response.json()
    } catch {
      throw classify(response.status, operation)
    }

    if (!isRecord(envelope)) {
      throw classify(response.status, operation)
    }
    // A 200 can still carry a non-zero business code.
    if (envelope.code !== 0) {
      throw classify(
        typeof envelope.code === 'number' ? envelope.code : response.status,
        operation
      )
    }
    if (!isRecord(envelope.data)) {
      throw classify(response.status, operation)
    }

    return envelope.data
  }

  return {
    async list(input): Promise<RevisionPage> {
      const params: Record<string, string> = {
        limit: String(input.limit),
      }
      if (input.cursor !== null) {
        params.cursor = input.cursor
      }

      const data = await request(
        routes.list,
        params,
        'list',
        input.signal
      )
      const rawItems = Array.isArray(data.data) ? data.data : []

      return {
        items: rawItems
          .filter(isRecord)
          .map(entry => toListItem(entry, documentId)),
        nextCursor: readNullableString(data, 'nextCursor'),
        // Wire field is `hasMore`.
        hasNextPage: readBoolean(data, 'hasMore'),
      }
    },

    async getDetail(input): Promise<RevisionContent> {
      const data = await request(
        routes.detail,
        { id: input.revisionId },
        'detail',
        input.signal
      )

      const availability = readAvailability(data)
      if (availability !== 'ready') {
        throw fail('REVISION_UNAVAILABLE', 'detail', availability)
      }

      const content = data.content
      // Content is null whenever the service could not canonicalize it, which
      // is reported as unavailable rather than rendered as an empty document.
      // The service claimed `ready` but sent no content. Use the wire contract's
      // unavailable fallback rather than rendering an empty document.
      if (!isRecord(content)) {
        throw fail('REVISION_UNAVAILABLE', 'detail', 'legacy_failed')
      }

      const id = readString(data, 'id')
      return {
        ref:
          id === currentRevisionId(documentId)
            ? { kind: 'current' }
            : { kind: 'revision', id },
        documentId: readString(data, 'documentId') || documentId,
        title: readString(data, 'title'),
        content,
        contentHash: readString(data, 'contentHash'),
        availability: 'ready',
        decodedFromState: readBoolean(data, 'decodedFromState'),
        attribution: readAttribution(data),
      }
    },

    async restore(input): Promise<RestoreResult> {
      // `id` travels in the body, not the query: restore is a write, and an id
      // in the URL would be retained by access logs and browser history.
      const data = await request(
        routes.restore,
        {},
        'restore',
        undefined,
        { id: input.revisionId }
      )

      // The service echoes the requested id. It is read back rather than assumed
      // so a mismatch would be visible instead of silently reported as success.
      return { revisionId: readString(data, 'id') || input.revisionId }
    },
  }
}
