import { describe, expect, it } from 'vitest'
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
})
