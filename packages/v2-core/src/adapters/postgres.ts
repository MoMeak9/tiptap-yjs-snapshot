import type {
  ClaimedInterval, DocumentPatch, DocumentRecord, DocumentStore, DocumentTransaction, RevisionInsert,
  RevisionDetailRow, RevisionHead, RevisionListRow, RevisionProjection, RevisionRecord, RevisionStore,
} from '../ports'
import type { RevisionCursor } from '../cursor'

/** Structural shape of a pg Pool; install and inject any compatible PostgreSQL driver. */
export interface SqlConnection {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>
  release(): void
}

export interface SqlPool {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>
  connect(): Promise<SqlConnection>
}

interface DocumentRow extends Record<string, unknown> {
  id: string
  title: string
  content_json: string | null
  content_hash: string
  schema_version: number
  revision_count: string | number
  state: Uint8Array | null
  mtime: Date | string
  last_modified_by: string | null
  deleted: boolean
}

interface RevisionBaseRow extends Record<string, unknown> {
  id: string
  document_id: string
  version: number
  type: RevisionRecord['type']
  name: string | null
  title: string
  content_json: string | null
  content_hash: string | null
  schema_version: number | null
  source_format: RevisionRecord['sourceFormat']
  created_by: string | null
  contributors: string[] | string
  attribution: unknown | null
  ctime: Date | string
  mtime: Date | string
  deleted: boolean
  restored_from_revision_id: string | null
}

interface RevisionRow extends RevisionBaseRow {
  state: Uint8Array
}

interface RevisionDetailSqlRow extends RevisionBaseRow {
  state_bytes: number | null
}

interface RevisionListSqlRow extends Record<string, unknown> {
  id: string
  document_id: string
  version: number
  type: RevisionRecord['type']
  name: string | null
  title: string
  created_by: string | null
  contributors: string[] | string
  ctime: Date | string
  deleted: boolean
  restored_from_revision_id: string | null
  restored_from_version: number | null
  content_present: boolean
  state_present: boolean
}

const DOCUMENT_COLUMNS = 'id, title, content_json, content_hash, schema_version, revision_count, state, mtime, last_modified_by, deleted'
const REVISION_COLUMNS = 'id, document_id, version, type, name, title, content_json, content_hash, schema_version, source_format, state, created_by, contributors, attribution, ctime, mtime, deleted, restored_from_revision_id'

function mapDocument(row: DocumentRow): DocumentRecord {
  return {
    id: row.id, title: row.title, contentJson: row.content_json,
    contentHash: row.content_hash, schemaVersion: Number(row.schema_version),
    revisionCount: Number(row.revision_count),
    state: row.state === null ? null : new Uint8Array(row.state),
    mtime: new Date(row.mtime), lastModifiedBy: row.last_modified_by, deleted: row.deleted,
  }
}

function parseArray(value: string[] | string): string[] {
  return Array.isArray(value) ? value : JSON.parse(value) as string[]
}

function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) as unknown : value
}

function mapRevisionBase(row: RevisionBaseRow): Omit<RevisionRecord, 'state'> {
  const present = [row.content_json, row.content_hash, row.schema_version].map(value => value !== null)
  if (present.some(Boolean) && !present.every(Boolean)) throw new TypeError('Revision projection columns are partial')
  if (row.source_format === 'v2_json' && !present.every(Boolean)) throw new TypeError('New V2 revision lacks projection')
  return {
    id: row.id, documentId: row.document_id, version: Number(row.version), type: row.type,
    name: row.name, title: row.title, contentJson: row.content_json,
    contentHash: row.content_hash, schemaVersion: row.schema_version === null ? null : Number(row.schema_version),
    sourceFormat: row.source_format,
    createdBy: row.created_by,
    contributors: parseArray(row.contributors), attribution: parseJson(row.attribution),
    ctime: new Date(row.ctime), mtime: new Date(row.mtime), deleted: row.deleted,
    restoredFromRevisionId: row.restored_from_revision_id,
  }
}

function mapRevision(row: RevisionRow): RevisionRecord {
  return { ...mapRevisionBase(row), state: new Uint8Array(row.state) }
}

function mapRevisionDetail(row: RevisionDetailSqlRow): RevisionDetailRow {
  return { ...mapRevisionBase(row), stateBytes: Number(row.state_bytes ?? 0) }
}

type Queryable = Pick<SqlPool, 'query'>

async function writeDocument(client: Queryable, documentId: string, patch: DocumentPatch): Promise<DocumentRecord> {
  const columns: string[] = []
  const params: unknown[] = []
  const set = (column: string, value: unknown) => {
    params.push(value)
    columns.push(`${column} = $${params.length}`)
  }
  if (patch.title !== undefined) set('title', patch.title)
  if (patch.contentJson !== undefined) set('content_json', patch.contentJson)
  if (patch.contentHash !== undefined) set('content_hash', patch.contentHash)
  if (patch.schemaVersion !== undefined) set('schema_version', patch.schemaVersion)
  if (patch.state !== undefined) set('state', Buffer.from(patch.state))
  if (patch.lastModifiedBy !== undefined) set('last_modified_by', patch.lastModifiedBy)
  if (patch.revisionCountIncrement !== undefined) {
    if (patch.revisionCountIncrement !== 1) throw new RangeError('Only +1 is supported')
    columns.push('revision_count = revision_count + 1')
  }
  if (patch.mtime === undefined) columns.push('mtime = CURRENT_TIMESTAMP')
  else set('mtime', patch.mtime)
  params.push(documentId)
  const { rows } = await client.query<DocumentRow>(
    `UPDATE v2_documents SET ${columns.join(', ')} WHERE id = $${params.length} RETURNING ${DOCUMENT_COLUMNS}`,
    params,
  )
  if (!rows[0]) throw new Error('Document not found')
  return mapDocument(rows[0])
}

export class PostgresDocumentTransaction implements DocumentTransaction {
  constructor(readonly connection: SqlConnection) {}

  async readForUpdate(documentId: string): Promise<DocumentRecord | null> {
    const { rows } = await this.connection.query<DocumentRow>(
      `SELECT ${DOCUMENT_COLUMNS} FROM v2_documents WHERE id = $1 FOR UPDATE`, [documentId],
    )
    return rows[0] ? mapDocument(rows[0]) : null
  }

  write(documentId: string, patch: DocumentPatch): Promise<DocumentRecord> {
    return writeDocument(this.connection, documentId, patch)
  }
}

export class PostgresDocumentStore implements DocumentStore {
  constructor(private readonly pool: SqlPool) {}

  async read(documentId: string): Promise<DocumentRecord | null> {
    const { rows } = await this.pool.query<DocumentRow>(
      `SELECT ${DOCUMENT_COLUMNS} FROM v2_documents WHERE id = $1`, [documentId],
    )
    return rows[0] ? mapDocument(rows[0]) : null
  }

  write(documentId: string, patch: DocumentPatch): Promise<DocumentRecord> {
    return writeDocument(this.pool, documentId, patch)
  }

  async transaction<T>(work: (tx: DocumentTransaction) => Promise<T>): Promise<T> {
    const connection = await this.pool.connect()
    try {
      // A fresh READ COMMITTED view after FOR UPDATE sees the transaction that
      // just released the same document lock. Snapshot isolation can miss it.
      await connection.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      try {
        const result = await work(new PostgresDocumentTransaction(connection))
        await connection.query('COMMIT')
        return result
      } catch (error) {
        await connection.query('ROLLBACK')
        throw error
      }
    } finally {
      connection.release()
    }
  }
}

export class PostgresRevisionStore implements RevisionStore {
  constructor(
    private readonly pool: SqlPool,
    private readonly mergeAttribution?: (existing: unknown, incoming: unknown) => unknown,
  ) {}

  async latest(documentId: string, tx?: DocumentTransaction): Promise<RevisionHead | null> {
    const client = this.client(tx)
    const { rows } = await client.query<{ id: string; content_hash: string; title: string }>(
      `SELECT id, COALESCE(content_hash, '') AS content_hash, title FROM v2_revisions WHERE document_id = $1 AND deleted = FALSE ORDER BY version DESC, id DESC LIMIT 1`,
      [documentId],
    )
    return rows[0] ? { id: rows[0].id, contentHash: rows[0].content_hash, title: rows[0].title } : null
  }

  async get(documentId: string, revisionId: string): Promise<RevisionRecord | null> {
    const { rows } = await this.pool.query<RevisionRow>(
      `SELECT ${REVISION_COLUMNS} FROM v2_revisions WHERE document_id = $1 AND id = $2 LIMIT 1`,
      [documentId, revisionId],
    )
    return rows[0] ? mapRevision(rows[0]) : null
  }

  async getDetailRow(documentId: string, revisionId: string): Promise<RevisionDetailRow | null> {
    const columns = REVISION_COLUMNS.replace(', state,', ', octet_length(state) AS state_bytes,')
    const { rows } = await this.pool.query<RevisionDetailSqlRow>(
      `SELECT ${columns} FROM v2_revisions WHERE document_id = $1 AND id = $2 LIMIT 1`,
      [documentId, revisionId],
    )
    return rows[0] ? mapRevisionDetail(rows[0]) : null
  }

  async getState(documentId: string, revisionId: string): Promise<Uint8Array | null> {
    const { rows } = await this.pool.query<{ state: Uint8Array | null }>(
      'SELECT state FROM v2_revisions WHERE document_id = $1 AND id = $2 AND deleted = FALSE LIMIT 1',
      [documentId, revisionId],
    )
    return rows[0]?.state ? new Uint8Array(rows[0].state) : null
  }

  async list(documentId: string, cursor: RevisionCursor | null, limitPlusOne: number): Promise<readonly RevisionListRow[]> {
    const params: unknown[] = [documentId]
    const keyset = cursor === null ? '' : ' AND (r.version, r.id) < ($2, $3)'
    if (cursor !== null) params.push(cursor.version, cursor.id)
    params.push(limitPlusOne)
    const { rows } = await this.pool.query<RevisionListSqlRow>(
      `SELECT r.id, r.document_id, r.version, r.type, r.name, r.title, r.created_by, r.contributors, r.ctime, r.deleted, r.restored_from_revision_id,` +
      ` r.content_json IS NOT NULL AS content_present, octet_length(r.state) > 0 AS state_present,` +
      ` source.version AS restored_from_version` +
      ` FROM v2_revisions AS r LEFT JOIN v2_revisions AS source ON r.restored_from_revision_id = source.id AND r.document_id = source.document_id` +
      ` WHERE r.document_id = $1 AND r.deleted = FALSE${keyset}` +
      ` ORDER BY r.version DESC, r.id DESC LIMIT $${params.length}`,
      params,
    )
    return rows.map(row => ({
      id: row.id, documentId: row.document_id, version: Number(row.version), type: row.type,
      name: row.name, title: row.title, createdBy: row.created_by,
      contributors: parseArray(row.contributors), ctime: new Date(row.ctime),
      deleted: row.deleted, restoredFromRevisionId: row.restored_from_revision_id,
      restoredFromVersion: row.restored_from_version === null ? null : Number(row.restored_from_version),
      contentPresent: row.content_present, statePresent: row.state_present,
    }))
  }

  async insert(input: RevisionInsert, tx: DocumentTransaction): Promise<RevisionRecord> {
    if (!(tx instanceof PostgresDocumentTransaction)) {
      throw new TypeError('Revision insert must use the Postgres document transaction')
    }
    // The caller already holds the document row lock. The version and ctime are
    // derived at INSERT time, including deleted rows, then returned before COMMIT.
    const { rows } = await tx.connection.query<RevisionRow>(
      `INSERT INTO v2_revisions (` + REVISION_COLUMNS + `)
       SELECT $1, $2, COALESCE(MAX(version) + 1, 0), $3, $4, $5, $6, $7, $8,
              $9, $10, $11, $12::jsonb, $13::jsonb,
              GREATEST($14::timestamptz, COALESCE(MAX(ctime) + INTERVAL '1 millisecond', $14::timestamptz)),
              $14::timestamptz, FALSE, $15
       FROM v2_revisions WHERE document_id = $2
       RETURNING ` + REVISION_COLUMNS,
      [
        input.id, input.documentId, input.type, input.name, input.title,
        input.contentJson, input.contentHash, input.schemaVersion,
        input.sourceFormat, Buffer.from(input.state), input.createdBy,
        JSON.stringify(input.contributors), input.attribution === null ? null : JSON.stringify(input.attribution),
        input.materializedAt, input.restoredFromRevisionId,
      ],
    )
    if (!rows[0]) throw new Error('Revision insert did not return a row')
    return mapRevision(rows[0])
  }

  async backfillProjectionIfMissing(documentId: string, revisionId: string, projection: RevisionProjection): Promise<boolean> {
    const { rows } = await this.pool.query<{ id: string }>(
      `UPDATE v2_revisions SET content_json = $3, content_hash = $4, schema_version = $5, attribution = $6::jsonb` +
      ` WHERE document_id = $1 AND id = $2 AND content_json IS NULL AND deleted = FALSE RETURNING id`,
      [documentId, revisionId, projection.contentJson, projection.contentHash, projection.schemaVersion,
        projection.attribution === null ? null : JSON.stringify(projection.attribution)],
    )
    return rows.length > 0
  }

  async mergeInterval(revisionId: string, interval: ClaimedInterval, tx: DocumentTransaction): Promise<void> {
    if (!(tx instanceof PostgresDocumentTransaction)) throw new TypeError('Foreign document transaction')
    if (interval.contributors.length === 0 && interval.attribution === null) return
    const { rows } = await tx.connection.query<{ contributors: string[] | string; attribution: unknown | null }>(
      'SELECT contributors, attribution FROM v2_revisions WHERE id = $1 FOR UPDATE', [revisionId],
    )
    if (!rows[0]) throw new Error('Revision disappeared during interval merge')
    const contributors = [...new Set([...parseArray(rows[0].contributors), ...interval.contributors])]
    const existingAttribution = parseJson(rows[0].attribution)
    let attribution = existingAttribution
    if (interval.attribution !== null) {
      if (existingAttribution === null) attribution = interval.attribution
      else {
        if (!this.mergeAttribution) throw new Error('An attribution merge function is required for two nonempty intervals')
        attribution = this.mergeAttribution(existingAttribution, interval.attribution)
      }
    }
    // No mtime update: the content did not change and this is only an interval
    // transfer to the winner of an authoritative duplicate check.
    await tx.connection.query(
      'UPDATE v2_revisions SET contributors = $2::jsonb, attribution = $3::jsonb WHERE id = $1',
      [revisionId, JSON.stringify(contributors), attribution === null ? null : JSON.stringify(attribution)],
    )
  }

  private client(tx?: DocumentTransaction): Queryable {
    if (tx === undefined) return this.pool
    if (!(tx instanceof PostgresDocumentTransaction)) throw new TypeError('Foreign document transaction')
    return tx.connection
  }
}
