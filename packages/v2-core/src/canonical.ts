import { createHash } from 'node:crypto'
import type { JSONContent } from '@tiptap/core'
import { Node as ProseMirrorNode, type Schema } from '@tiptap/pm/model'

export const CURRENT_SCHEMA_VERSION = 1

/** Only type names leave this boundary; the document body never enters the error. */
export class UnknownProseMirrorTypeError extends Error {
  constructor(
    readonly nodeTypes: readonly string[],
    readonly markTypes: readonly string[],
  ) {
    super('Document contains types missing from the configured ProseMirror schema')
    this.name = 'UnknownProseMirrorTypeError'
  }
}

export class UnsupportedSchemaVersionError extends Error {
  constructor(readonly version: unknown) {
    super('No migration path exists for this document schema version')
    this.name = 'UnsupportedSchemaVersionError'
  }
}

export type SchemaMigration = (json: JSONContent) => JSONContent

export function migrateToCurrentSchemaVersion(
  json: JSONContent,
  fromVersion: unknown,
  migrations: ReadonlyMap<number, SchemaMigration> = new Map(),
): JSONContent {
  if (!Number.isSafeInteger(fromVersion) || (fromVersion as number) < 1 || (fromVersion as number) > CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(fromVersion)
  }
  let migrated = json
  for (let version = fromVersion as number; version < CURRENT_SCHEMA_VERSION; version += 1) {
    const migrate = migrations.get(version)
    if (!migrate) throw new UnsupportedSchemaVersionError(fromVersion)
    migrated = migrate(migrated)
  }
  return migrated
}

const NODE_FIELD_ORDER = ['type', 'attrs', 'marks', 'content', 'text'] as const

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  return Object.fromEntries(Object.keys(source).sort().map(key => [key, sortJsonValue(source[key])]))
}

function canonicalMark(mark: NonNullable<JSONContent['marks']>[number]): NonNullable<JSONContent['marks']>[number] {
  const result: NonNullable<JSONContent['marks']>[number] = { type: mark.type }
  if (mark.attrs && Object.keys(mark.attrs).length > 0) {
    result.attrs = sortJsonValue(mark.attrs) as Record<string, unknown>
  }
  return result
}

/** Stable node field order and recursively stable attribute keys. Empty fields disappear. */
function canonicalNode(node: JSONContent): JSONContent {
  const result: JSONContent = {}
  for (const field of NODE_FIELD_ORDER) {
    switch (field) {
      case 'type': result.type = node.type; break
      case 'attrs':
        if (node.attrs && Object.keys(node.attrs).length > 0) result.attrs = sortJsonValue(node.attrs) as Record<string, unknown>
        break
      case 'marks':
        if (node.marks?.length) result.marks = node.marks.map(canonicalMark)
        break
      case 'content':
        if (node.content?.length) result.content = node.content.map(canonicalNode)
        break
      case 'text':
        if (typeof node.text === 'string') result.text = node.text
        break
    }
  }
  return result
}

function collectUnknownTypes(schema: Schema, json: JSONContent): { nodeTypes: string[]; markTypes: string[] } {
  const nodeTypes = new Set<string>()
  const markTypes = new Set<string>()
  const visit = (node: JSONContent): void => {
    if (typeof node.type === 'string' && !(node.type in schema.nodes)) nodeTypes.add(node.type)
    for (const mark of node.marks ?? []) {
      if (typeof mark.type === 'string' && !(mark.type in schema.marks)) markTypes.add(mark.type)
    }
    for (const child of node.content ?? []) visit(child)
  }
  visit(json)
  return { nodeTypes: [...nodeTypes].sort(), markTypes: [...markTypes].sort() }
}

export function canonicalizeWithSchema(schema: Schema, json: JSONContent): JSONContent {
  const unknown = collectUnknownTypes(schema, json)
  if (unknown.nodeTypes.length || unknown.markTypes.length) {
    throw new UnknownProseMirrorTypeError(unknown.nodeTypes, unknown.markTypes)
  }
  return canonicalNode(ProseMirrorNode.fromJSON(schema, json).toJSON() as JSONContent)
}

/** Use only when strict parsing fails specifically because client and server types differ. */
export function canonicalizeTolerant(json: JSONContent): JSONContent {
  return canonicalNode(json)
}

export function serializeCanonicalJson(json: JSONContent): string {
  return JSON.stringify(json)
}

export function hashCanonicalJson(json: JSONContent): string {
  return createHash('sha256').update(serializeCanonicalJson(json), 'utf8').digest('hex')
}

export interface CanonicalContent {
  readonly json: JSONContent
  readonly serialized: string
  readonly contentHash: string
}

function finish(json: JSONContent): CanonicalContent {
  const serialized = serializeCanonicalJson(json)
  return {
    json,
    serialized,
    contentHash: createHash('sha256').update(serialized, 'utf8').digest('hex'),
  }
}

export function buildCanonicalContent(schema: Schema, json: JSONContent): CanonicalContent {
  return finish(canonicalizeWithSchema(schema, json))
}

export function buildTolerantCanonicalContent(json: JSONContent): CanonicalContent {
  return finish(canonicalizeTolerant(json))
}
