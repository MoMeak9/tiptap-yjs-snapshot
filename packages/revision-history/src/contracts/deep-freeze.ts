/**
 * Whether a value is a plain object or array, i.e. inert data we may freeze.
 *
 * A whitelist rather than a blacklist of known-dangerous types: the view state
 * gains fields over time, and a blacklist only protects against the types
 * someone remembered to list. Class instances, functions and DOM nodes all fall
 * outside it and are left untouched.
 */
function isFreezableData(value: object): boolean {
  if (Array.isArray(value)) {
    return true
  }
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Freezes the plain-data parts of a state snapshot, recursively.
 *
 * ## Why class instances must be skipped
 *
 * `RevisionChange.deletedContent` is a ProseMirror `Fragment`, and freezing it
 * used to reach far beyond the snapshot:
 *
 *     Fragment → content[] → Node → Node.type → NodeType.contentMatch
 *                                              → ContentMatch.wrapCache
 *                                 → NodeType.schema
 *
 * `NodeType.schema` is the **live editor schema**, not a copy, so selecting a
 * revision that had deletions froze every node type in the running editor.
 * `ContentMatch.wrapCache` is a lazily filled cache: `findWrapping()` appends to
 * it on a miss, which then threw `Cannot add property N, object is not
 * extensible` from inside blockquote/list commands and every other wrapping path.
 *
 * That failure was intermittent and wore many faces. Whether a command threw
 * depended on whether its target pair was already cached, so the same document
 * could lose Enter, lose Backspace, refuse the caret, or behave normally,
 * varying per session and per operation order. The exception escaped through the
 * keymap and aborted the whole command chain. Nothing recovered short of a
 * reload: once frozen, the schema stayed frozen.
 *
 * Freezing these types was never the intent either — ProseMirror values are
 * already immutable by contract, and `wrapCache` is internal bookkeeping rather
 * than observable state.
 */
export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') {
    return value
  }

  const objectValue = value as object
  // Stop at the boundary: neither freeze it nor walk through it, since its own
  // fields are what lead to the schema.
  if (!isFreezableData(objectValue)) {
    return value
  }
  if (seen.has(objectValue)) {
    return value
  }
  seen.add(objectValue)

  for (const key of Reflect.ownKeys(objectValue)) {
    deepFreeze(Reflect.get(objectValue, key), seen)
  }
  return Object.isFrozen(objectValue) ? value : Object.freeze(value)
}
