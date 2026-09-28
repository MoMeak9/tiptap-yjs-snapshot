export interface RevisionCursor { version: number; id: string }

export class RevisionCursorError extends Error {
  readonly code = 'REVISION_CURSOR_MALFORMED'
  constructor() {
    super('REVISION_CURSOR_MALFORMED')
    this.name = 'RevisionCursorError'
  }
}

// Storage adapters may use CUID, UUID, or URL-safe opaque identifiers.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const FORMAT = 'v2'

function valid(cursor: RevisionCursor): boolean {
  return ID_PATTERN.test(cursor.id) && Number.isInteger(cursor.version) && cursor.version >= 0 && cursor.version <= 2_147_483_647
}

export function encodeRevisionCursor(cursor: RevisionCursor): string {
  if (!valid(cursor)) throw new RevisionCursorError()
  return Buffer.from(`${FORMAT}:${cursor.version}:${cursor.id}`, 'utf8').toString('base64url')
}

export function decodeRevisionCursor(raw: string): RevisionCursor {
  if (typeof raw !== 'string' || !raw) throw new RevisionCursorError()
  try {
    const decoded = Buffer.from(raw, 'base64url')
    if (decoded.toString('base64url') !== raw) throw new RevisionCursorError()
    const plaintext = decoded.toString('utf8')
    if (plaintext.length > 96) throw new RevisionCursorError()
    const parts = plaintext.split(':')
    if (parts.length !== 3 || parts[0] !== FORMAT || !/^\d+$/.test(parts[1])) throw new RevisionCursorError()
    const cursor = { version: Number(parts[1]), id: parts[2] }
    if (!valid(cursor)) throw new RevisionCursorError()
    return cursor
  } catch {
    throw new RevisionCursorError()
  }
}

export function currentRevisionId(documentId: string): string {
  if (!documentId) throw new Error('documentId is required')
  return `current-${documentId}`
}

export function parseCurrentRevisionId(id: string): string | null {
  if (!id.startsWith('current-')) return null
  return id.length === 'current-'.length ? null : id.slice('current-'.length)
}
