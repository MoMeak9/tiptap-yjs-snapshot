import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  PostgresDocumentStore, PostgresRevisionStore,
  type RevisionInsert, type SqlConnection, type SqlPool,
} from '../src/index'

const docRow = {
  id: 'doc-public', title: 'Example', content_json: '{}', content_hash: 'a'.repeat(64),
  schema_version: 1, revision_count: '2', state: Buffer.from([1, 2]),
  mtime: new Date('2026-01-01T00:00:00Z'), last_modified_by: 'actor', deleted: false,
}

describe('PostgreSQL adapter transaction contract', () => {
  it('requires state-only projection columns to be all absent or all present', () => {
    const schema = readFileSync(new URL('../schema.postgres.sql', import.meta.url), 'utf8')
    expect(schema).toMatch(/content_json IS NULL AND content_hash IS NULL AND schema_version IS NULL/)
    expect(schema).toMatch(/content_json IS NOT NULL AND content_hash IS NOT NULL AND schema_version IS NOT NULL/)
  })
  it('locks the document and inserts a revision on one connection before commit', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    let released = false
    const connection: SqlConnection = {
      query: async <Row extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }> => {
        calls.push({ sql, params })
        if (sql.includes('FOR UPDATE')) return { rows: [docRow] as unknown as Row[] }
        if (sql.startsWith('INSERT INTO v2_revisions')) return { rows: [{
          id: 'r1', document_id: 'doc-public', version: 0, type: 'manual', name: null,
          title: 'Example', content_json: '{}', content_hash: 'a'.repeat(64), schema_version: 1, source_format: 'v2_json',
          state: Buffer.from([1, 2]), created_by: 'actor', contributors: [], attribution: null,
          ctime: new Date('2026-01-02T00:00:00Z'), mtime: new Date('2026-01-02T00:00:00Z'),
          deleted: false, restored_from_revision_id: null,
        }] as unknown as Row[] }
        return { rows: [] }
      },
      release: () => { released = true },
    }
    const pool: SqlPool = {
      query: async () => { throw new Error('unexpected pool query inside transaction') },
      connect: async () => connection,
    }
    const documents = new PostgresDocumentStore(pool)
    const revisions = new PostgresRevisionStore(pool)
    const input: RevisionInsert = {
      id: 'r1', documentId: 'doc-public', type: 'manual', name: null,
      title: 'Example', contentJson: '{}', contentHash: 'a'.repeat(64), schemaVersion: 1, sourceFormat: 'v2_json',
      state: new Uint8Array([1, 2]), createdBy: 'actor', contributors: [], attribution: null,
      materializedAt: new Date('2026-01-02T00:00:00Z'), restoredFromRevisionId: null,
    }
    const result = await documents.transaction(async tx => {
      expect((await tx.readForUpdate('doc-public'))?.id).toBe('doc-public')
      return revisions.insert(input, tx)
    })
    expect(result.version).toBe(0)
    expect(result.sourceFormat).toBe('v2_json')
    expect(calls.map(call => call.sql.split(' ')[0])).toEqual(['BEGIN', 'SELECT', 'INSERT', 'COMMIT'])
    expect(calls[1].sql).toContain('FOR UPDATE')
    expect(calls[2].sql).toContain('COALESCE(MAX(version) + 1, 0)')
    expect(calls[2].params?.[1]).toBe('doc-public')
    expect(calls[2].params?.[8]).toBe('v2_json')
    expect(released).toBe(true)
  })

  it('rolls back and releases the same connection after a failed write', async () => {
    const calls: string[] = []
    let released = false
    const connection: SqlConnection = {
      query: async sql => { calls.push(sql); return { rows: [] } },
      release: () => { released = true },
    }
    const documents = new PostgresDocumentStore({
      query: async () => ({ rows: [] }), connect: async () => connection,
    })
    await expect(documents.transaction(async () => { throw new Error('write failed') })).rejects.toThrow('write failed')
    expect(calls).toEqual(['BEGIN ISOLATION LEVEL READ COMMITTED', 'ROLLBACK'])
    expect(released).toBe(true)
  })

  it('reads list metadata and checks nonempty state without selecting either large column', async () => {
    let sql = ''
    const revisions = new PostgresRevisionStore({
      connect: async () => { throw new Error('unexpected transaction') },
      query: async <Row extends Record<string, unknown>>(statement: string): Promise<{ rows: Row[] }> => {
        sql = statement
        return { rows: [{
          id: 'r-empty', document_id: 'doc-public', version: 0, type: 'manual',
          name: null, title: 'Example', created_by: null, contributors: [],
          ctime: new Date(), deleted: false, restored_from_revision_id: null,
          restored_from_version: null, content_present: true, state_present: false,
        }] as unknown as Row[] }
      },
    })
    const rows = await revisions.list('doc-public', null, 2)
    expect(rows[0].statePresent).toBe(false)
    expect(sql).toContain('octet_length(r.state) > 0 AS state_present')
    expect(sql).toContain('source.version AS restored_from_version')
    expect(sql).not.toContain('r.content_json,')
    expect(sql).not.toContain('r.state,')
  })

  it('reads detail metadata without state and conditionally backfills only derived fields', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const revisions = new PostgresRevisionStore({
      connect: async () => { throw new Error('unexpected transaction') },
      query: async <Row extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }> => {
        calls.push({ sql, params })
        if (sql.startsWith('SELECT') && sql.includes('octet_length(state)')) return { rows: [{
          id: 'r-state', document_id: 'doc-public', version: 1, type: 'auto', name: null,
          title: 'Example', content_json: null, content_hash: null, schema_version: null,
          source_format: 'state_only', created_by: null, contributors: [], attribution: null,
          ctime: new Date('2026-01-02T00:00:00Z'), mtime: new Date('2026-01-02T00:00:00Z'),
          deleted: false, restored_from_revision_id: null, state_bytes: 10,
        }] as unknown as Row[] }
        if (sql.startsWith('SELECT state')) return { rows: [{ state: Buffer.from([1, 2]) }] as unknown as Row[] }
        if (sql.startsWith('UPDATE')) return { rows: [{ id: 'r-state' }] as unknown as Row[] }
        return { rows: [] }
      },
    })
    const row = await revisions.getDetailRow('doc-public', 'r-state')
    expect(row).toMatchObject({ sourceFormat: 'state_only', contentJson: null, stateBytes: 10 })
    expect(calls[0].sql).toContain('octet_length(state) AS state_bytes')
    expect(calls[0].sql).not.toContain(', state,')
    expect(await revisions.getState('doc-public', 'r-state')).toEqual(new Uint8Array([1, 2]))
    expect(calls[1].sql).toContain('deleted = FALSE')
    const filled = await revisions.backfillProjectionIfMissing('doc-public', 'r-state', {
      contentJson: '{"type":"doc"}', contentHash: 'a'.repeat(64), schemaVersion: 1,
      attribution: { kind: 'whole', author: 'author-a' },
    })
    expect(filled).toBe(true)
    expect(calls[2].sql).toContain('content_json IS NULL')
    expect(calls[2].sql).toContain('deleted = FALSE')
    expect(calls[2].sql).not.toMatch(/SET .*\b(state|source_format|mtime)\b/)
    expect(calls[2].params?.slice(0, 2)).toEqual(['doc-public', 'r-state'])
  })

  it('rejects a partially populated imported projection instead of treating it as ready', async () => {
    const revisions = new PostgresRevisionStore({
      connect: async () => { throw new Error('unexpected transaction') },
      query: async <Row extends Record<string, unknown>>(): Promise<{ rows: Row[] }> => ({ rows: [{
        id: 'r-partial', document_id: 'doc-public', version: 1, type: 'auto', name: null,
        title: 'Example', content_json: '{"type":"doc"}', content_hash: null, schema_version: null,
        source_format: 'state_only', created_by: null, contributors: [], attribution: null,
        ctime: new Date(), mtime: new Date(), deleted: false,
        restored_from_revision_id: null, state_bytes: 2,
      }] as unknown as Row[] }),
    })
    await expect(revisions.getDetailRow('doc-public', 'r-partial')).rejects.toThrow('partial')
  })

  it('rejects a v2_json row without its mandatory projection', async () => {
    const revisions = new PostgresRevisionStore({
      connect: async () => { throw new Error('unexpected transaction') },
      query: async <Row extends Record<string, unknown>>(): Promise<{ rows: Row[] }> => ({ rows: [{
        id: 'r-incomplete', document_id: 'doc-public', version: 1, type: 'auto', name: null,
        title: 'Example', content_json: null, content_hash: null, schema_version: null,
        source_format: 'v2_json', created_by: null, contributors: [], attribution: null,
        ctime: new Date(), mtime: new Date(), deleted: false,
        restored_from_revision_id: null, state_bytes: 2,
      }] as unknown as Row[] }),
    })
    await expect(revisions.getDetailRow('doc-public', 'r-incomplete')).rejects.toThrow('lacks projection')
  })
})
