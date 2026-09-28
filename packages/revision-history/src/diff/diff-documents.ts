import { Fragment, type Mark, type Node } from '@tiptap/pm/model'
import { diffSequence } from './sequence-diff'
import { tokenize } from './tokenize'

export type RevisionChangeKind =
  | 'inserted'
  | 'deleted'
  | 'marks-changed'
  | 'attrs-changed'

export interface RevisionChange {
  readonly kind: RevisionChangeKind
  /**
   * Position range in the **selected** document.
   *
   * A deletion has `from === to`: the content is absent there, so the range
   * marks where it used to be rather than covering anything renderable.
   */
  readonly from: number
  readonly to: number
  /** Node type name for block-level changes, `text` for inline ones. */
  readonly typeName: string
  /**
   * The removed text, for deletions only.
   *
   * Carried so the viewer can show what was removed; there is nothing at the
   * position to read it from.
   */
  readonly deletedText?: string
  /**
   * The removed content with its marks and node structure intact.
   *
   * `deletedText` flattens a deletion to characters, which drops bold, links,
   * list items and table rows. The fragment lets the viewer serialise removed
   * content the way the document rendered it. It comes from the compared
   * document, so it is only readable against that side's schema.
   */
  readonly deletedContent?: Fragment
}

export interface RevisionDiff {
  readonly changes: readonly RevisionChange[]
  readonly total: number
}

const EMPTY_DIFF: RevisionDiff = Object.freeze({
  changes: Object.freeze([]),
  total: 0,
})

function markKey(mark: Mark): string {
  const attrs = Object.keys(mark.attrs)
    .sort()
    .map(name => `${name}=${JSON.stringify(mark.attrs[name])}`)
    .join(',')
  return attrs === '' ? mark.type.name : `${mark.type.name}(${attrs})`
}

function marksKey(marks: readonly Mark[]): string {
  return [...marks].map(markKey).sort().join('|')
}

function attrsKey(node: Node): string {
  return Object.keys(node.attrs)
    .sort()
    .map(name => `${name}=${JSON.stringify(node.attrs[name])}`)
    .join(',')
}

/**
 * Content signature that survives having no text.
 *
 * `textContent` alone cannot tell a paragraph holding just an image from an empty
 * paragraph — an image is an inline atom and contributes no text, so both flatten
 * to `''`. They then paired as `equal`, and the insertion was reported against a
 * *neighbouring* block instead: the image rendered unmarked while the empty
 * paragraph below it got the whole block-level fill.
 *
 * Atoms and leaves therefore contribute their type and attrs. `src` is what makes
 * one image distinguishable from another, so attrs have to be in the signature —
 * keying on the type alone would pair two different images as equal and report a
 * swapped image as no change at all.
 */
function contentKey(node: Node): string {
  const parts: string[] = []
  node.forEach(child => {
    if (child.isText) {
      parts.push(child.text ?? '')
      return
    }
    if (child.isAtom || child.isLeaf) {
      parts.push(`<${child.type.name}:${attrsKey(child)}>`)
      return
    }
    parts.push(`<${child.type.name}:${contentKey(child)}>`)
  })
  return parts.join('')
}

/**
 * Identity for pairing children across the two documents.
 *
 * Exact rather than fuzzy: only children that are unmistakably the same pair in
 * the first pass, so an inserted sibling does not drag every following one out of
 * alignment. Children left unpaired get a second, type-based pass — see
 * {@link pairRewrites}.
 */
function identityKey(node: Node): string {
  return node.isText
    ? `text:${node.text ?? ''}`
    : `${node.type.name}:${
        node.isAtom || node.isLeaf ? attrsKey(node) : contentKey(node)
      }`
}

interface Pairing {
  /** `changed` is an unpaired delete/insert rematched by type — a rewrite. */
  kind: 'equal' | 'insert' | 'delete' | 'changed'
  left?: Node
  right?: Node
}

/** Myers over child identities, mapped into the pairing vocabulary used below. */
function pairChildren(
  left: readonly Node[],
  right: readonly Node[]
): Pairing[] {
  return diffSequence(left, right, identityKey).edits.map<Pairing>(edit => {
    if (edit.kind === 'equal') {
      return { kind: 'equal', left: edit.left, right: edit.right }
    }
    return edit.kind === 'delete'
      ? { kind: 'delete', left: edit.left }
      : { kind: 'insert', right: edit.right }
  })
}

/**
 * Rematches unpaired deletes and inserts of the same type as rewrites.
 *
 * Without this an edited paragraph is a delete plus an insert, so the overlay
 * repaints the whole block for a one-character change. Pairing them lets the
 * comparison descend and report only the words that moved.
 *
 * Matching is confined to a run of consecutive unpaired children so a rewrite
 * near the top cannot claim an unrelated block far below, and requires equal type
 * names so a paragraph is never read as a rewritten heading.
 *
 * The run is rewritten **in place**: each `changed` entry replaces the `insert` it
 * was matched to, at that insert's own index. {@link compareChildren} derives
 * positions by accumulating `right.nodeSize` while walking this list, so the list
 * must stay in right-document order. A `changed` pairing consumes exactly the
 * budget its `right` node would have consumed as an `insert`, so substituting in
 * place keeps the accumulator valid. Emitting the `changed` entries in delete
 * order instead let a rewrite consume an unrelated sibling's budget and painted
 * every range in the run onto the wrong node.
 *
 * The matched `delete` is dropped rather than kept: its `left` node is already
 * carried by the `changed` entry, and a second entry for it would report the same
 * content twice.
 *
 * An unmatched `delete` is zero-width, so where it sits does not affect the
 * accumulator — but it does decide the position the deletion is *reported* at, and
 * therefore the order the viewer renders the removed blocks in. Leaving every one
 * of them where the pairing put it read the run back to front whenever a rewrite
 * followed them: clearing a document down to one empty paragraph pairs the **first**
 * removed paragraph with that survivor, so the two blocks below it were emitted
 * before the rewrite and collapsed onto position 0 while the rewrite's own words
 * landed at 1. A page of 文字/分割线/文字 came out as 分割线/下方/上方. So a delete is
 * held back past any `changed` entry it followed in the compared document — see
 * {@link orderUnclaimedDeletes}.
 */
function pairRewrites(pairings: readonly Pairing[]): Pairing[] {
  const result: Pairing[] = []
  let index = 0

  while (index < pairings.length) {
    const pairing = pairings[index]
    if (pairing.kind === 'equal') {
      result.push(pairing)
      index += 1
      continue
    }

    let end = index
    while (end < pairings.length && pairings[end].kind !== 'equal') {
      end += 1
    }
    const run = pairings.slice(index, end)
    const claimed = new Set<Pairing>()
    // 被删子节点在**原文**里的先后。`pairChildren` 按左文档顺序发 `delete`,所以枚举
    // 顺序就是原文顺序;`changed` 稍后继承它配到的那个 delete 的序号,两者因此可比。
    const leftOrder = new Map<Pairing, number>()
    let leftIndex = 0
    for (const entry of run) {
      if (entry.kind === 'delete') {
        leftOrder.set(entry, leftIndex)
        leftIndex += 1
      }
    }
    // Rewrite in right-document order: for each insert, find the most similar
    // still-unclaimed delete of the same type name. Type alone is not enough:
    // a structural insertion can put an empty paragraph before an edited,
    // marked paragraph, and pairing the first paragraph would move the entire
    // marked diff onto the empty node.
    const rewritten = run.map<Pairing>(entry => {
      if (entry.kind !== 'insert' || entry.right === undefined) {
        return entry
      }
      const insertedType = entry.right.type.name
      let match: Pairing | undefined
      let matchScore = -1
      for (const candidate of run) {
        if (
          candidate.kind !== 'delete' ||
          candidate.left === undefined ||
          claimed.has(candidate) ||
          // Compare type *names*, not `NodeType` objects: the two documents may
          // come from different schema generations, where same-named types are
          // distinct instances. Object identity made pairing silently never fire
          // and dropped word-level attribution back to whole-block reporting.
          candidate.left.type.name !== insertedType
        ) {
          continue
        }

        const score = rewriteSimilarity(candidate.left, entry.right)
        if (score > matchScore) {
          match = candidate
          matchScore = score
        }
      }
      if (match === undefined || match.left === undefined) {
        return entry
      }
      claimed.add(match)
      const changed: Pairing = {
        kind: 'changed',
        left: match.left,
        right: entry.right,
      }
      // The rewrite stands in for that delete's node, so it inherits its place in
      // the compared document.
      leftOrder.set(changed, leftOrder.get(match) as number)
      return changed
    })

    result.push(
      ...orderUnclaimedDeletes(
        rewritten.filter(entry => !claimed.has(entry)),
        leftOrder
      )
    )

    index = end
  }

  return pairDistantRewrites(result)
}

/**
 * Recovers rewrites separated by an exactly-equal empty/structural sibling.
 *
 * `pairRewrites` normally stays inside one non-equal run so unrelated blocks
 * cannot claim one another. An exact empty paragraph can split a real rewrite
 * into two runs, however: the old marked paragraph is deleted, the empty
 * paragraph is paired as equal, and the new marked paragraph is inserted. A
 * positive content similarity is normally the extra evidence needed to cross
 * that barrier safely. The one zero-similarity exception is empty ↔ non-empty
 * content of the same node type across empty siblings: Myers can legally choose
 * another one of several identical empty nodes and strand the actual rewrite on
 * opposite sides of the equal run. Pairing that shape avoids rendering “在空段落
 * 中输入” as an unrelated empty-block deletion plus insertion.
 */
function pairDistantRewrites(pairings: readonly Pairing[]): Pairing[] {
  const claimed = new Set<Pairing>()
  const replacements = new Map<Pairing, Pairing>()

  for (const entry of pairings) {
    if (entry.kind !== 'insert' || entry.right === undefined) {
      continue
    }

    let match: Pairing | undefined
    let matchScore = 0
    for (const candidate of pairings) {
      if (
        candidate.kind !== 'delete' ||
        candidate.left === undefined ||
        claimed.has(candidate) ||
        candidate.left.type.name !== entry.right.type.name
      ) {
        continue
      }

      const candidateIndex = pairings.indexOf(candidate)
      const entryIndex = pairings.indexOf(entry)
      const start = Math.min(candidateIndex, entryIndex)
      const end = Math.max(candidateIndex, entryIndex)
      if (
        pairings
          .slice(start + 1, end)
          .some(pairing => !canCrossRewriteBarrier(pairing))
      ) {
        continue
      }

      const score = rewriteSimilarity(candidate.left, entry.right)
      const emptyEndpointRewrite = isEmptyEndpointRewrite(
        candidate.left,
        entry.right
      )
      if (
        score > matchScore ||
        (score === 0 && match === undefined && emptyEndpointRewrite)
      ) {
        match = candidate
        matchScore = score
      }
    }

    if (match?.left === undefined) {
      continue
    }
    claimed.add(match)
    replacements.set(entry, {
      kind: 'changed',
      left: match.left,
      right: entry.right,
    })
  }

  return pairings
    .filter(entry => !claimed.has(entry))
    .map(entry => replacements.get(entry) ?? entry)
}

/**
 * Myers 对重复空节点有多条等价最短路径；一侧为空、另一侧有内容时把它视作填入/清空。
 * 两侧都非空且零相似仍是无关替换，不能借这条规则跨越 equal 边界。
 */
function isEmptyEndpointRewrite(left: Node, right: Node): boolean {
  const leftContent = contentKey(left)
  const rightContent = contentKey(right)
  return (leftContent === '') !== (rightContent === '')
}

/**
 * Says whether an equal pairing is safe to cross while recovering a rewrite.
 *
 * Only an actually empty node is transparent. A non-empty paragraph, image,
 * table, or rule is meaningful document structure and must remain a boundary;
 * otherwise a distant paragraph with a coincidental prefix could claim the
 * wrong deletion.
 */
function canCrossRewriteBarrier(pairing: Pairing): boolean {
  if (
    pairing.kind !== 'equal' ||
    pairing.left === undefined ||
    pairing.right === undefined
  ) {
    return true
  }
  return contentKey(pairing.left) === '' && contentKey(pairing.right) === ''
}

/**
 * Scores two same-type nodes for rewrite pairing.
 *
 * The signature deliberately ignores marks, because a mark-only edit should
 * still descend into the same text. Shared prefix and suffix are cheap to
 * calculate and are sufficient to distinguish a changed long paragraph from
 * an intervening empty paragraph. Ties retain the run's original order via
 * the strict `>` comparison in {@link pairRewrites}.
 */
function rewriteSimilarity(left: Node, right: Node | undefined): number {
  if (right === undefined || left.type.name !== right.type.name) {
    return -1
  }

  const leftContent = contentKey(left)
  const rightContent = contentKey(right)
  if (leftContent === rightContent) {
    return leftContent.length + 1
  }

  let prefix = 0
  const prefixLimit = Math.min(leftContent.length, rightContent.length)
  while (
    prefix < prefixLimit &&
    leftContent.charCodeAt(prefix) === rightContent.charCodeAt(prefix)
  ) {
    prefix += 1
  }

  let suffix = 0
  const suffixLimit = Math.min(
    leftContent.length - prefix,
    rightContent.length - prefix
  )
  while (
    suffix < suffixLimit &&
    leftContent.charCodeAt(leftContent.length - suffix - 1) ===
      rightContent.charCodeAt(rightContent.length - suffix - 1)
  ) {
    suffix += 1
  }

  return prefix + suffix
}

/**
 * Puts the run's unmatched deletions back into compared-document order.
 *
 * Only the deletions move. Every other entry consumes the right-document budget
 * {@link compareChildren} accumulates, so their relative order is fixed — moving
 * one makes a rewrite spend a sibling's budget and paints the whole run onto the
 * wrong nodes, which is the regression {@link pairRewrites} documents.
 *
 * A deletion is held back only past a `changed` entry that it follows in the
 * compared document. Anything else — an unmatched `insert`, in practice — flushes
 * the pending deletions first, so a run with no rewrite in it comes out exactly as
 * it went in. That is deliberate: an unmatched insert has no compared-document
 * position to compare against, so there is no ordering to restore and no reason to
 * disturb what the pairing chose.
 */
function orderUnclaimedDeletes(
  run: readonly Pairing[],
  leftOrder: ReadonlyMap<Pairing, number>
): Pairing[] {
  const ordered: Pairing[] = []
  const pending: Pairing[] = []

  for (const entry of run) {
    if (entry.kind === 'delete') {
      pending.push(entry)
      continue
    }
    if (entry.kind === 'changed') {
      const position = leftOrder.get(entry) as number
      // Only the deletions that genuinely came first. The rest stay pending, which
      // is what moves them after this rewrite.
      while (
        pending.length > 0 &&
        (leftOrder.get(pending[0]) as number) < position
      ) {
        ordered.push(pending.shift() as Pairing)
      }
      ordered.push(entry)
      continue
    }
    ordered.push(...pending.splice(0, pending.length), entry)
  }

  ordered.push(...pending)
  return ordered
}

function childrenOf(node: Node): Node[] {
  const children: Node[] = []
  node.forEach(child => {
    children.push(child)
  })
  return children
}

/**
 * A diffable unit of inline content.
 *
 * Text is split into words so an edit reports only the words it touched; inline
 * atoms stay whole because they have no interior to compare.
 */
interface InlineToken {
  /** Identity for pairing. Deliberately excludes marks — see {@link inlineTokens}. */
  readonly key: string
  readonly marksKey: string
  readonly size: number
  /** The node this token came from, sliced to the token, marks included. */
  readonly node: Node
}

/**
 * Splits a text token into Unicode code points while keeping its marks and
 * ProseMirror offsets intact.
 *
 * Word tokenisation is the preferred path because it keeps ordinary prose
 * readable. It is not sufficient for a word that changed internally, though:
 * `before = "prefixABCsuffix"` and `after = "prefix甲乙suffix"` are different
 * ICU tokens even though both sides have a common prefix and suffix. Refining
 * only the unmatched tokens lets Myers recover that alignment without
 * turning every unchanged word in a document into a character stream.
 */
function splitTextToken(token: InlineToken): InlineToken[] {
  if (!token.node.isText) {
    return [token]
  }

  const text = token.node.text ?? ''
  const result: InlineToken[] = []
  let offset = 0
  for (const codePoint of text) {
    result.push({
      key: `text:${codePoint}`,
      marksKey: token.marksKey,
      size: codePoint.length,
      node: token.node.cut(offset, offset + codePoint.length),
    })
    offset += codePoint.length
  }
  return result
}

function refineUnmatchedTextTokens(
  tokens: readonly InlineToken[],
  ownCounts: ReadonlyMap<string, number>,
  oppositeCounts: ReadonlyMap<string, number>
): InlineToken[] {
  return tokens.flatMap(token =>
    token.node.isText &&
    ownCounts.get(token.key) !== oppositeCounts.get(token.key)
      ? splitTextToken(token)
      : [token]
  )
}

function tokenCounts(tokens: readonly InlineToken[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of tokens) {
    counts.set(token.key, (counts.get(token.key) ?? 0) + 1)
  }
  return counts
}

/**
 * Builds the two inline token streams as a pair.
 *
 * Refinement must be decided from the other side's original word stream. If
 * each side were refined independently, a short segment created by a script
 * boundary could remain a whole token while its counterpart was split, which
 * is exactly the mixed Latin/CJK coordinate drift this diff has to avoid.
 */
function inlineTokenPair(
  left: Node,
  right: Node
): [InlineToken[], InlineToken[]] {
  const leftTokens = inlineTokens(left)
  const rightTokens = inlineTokens(right)
  const leftCounts = tokenCounts(leftTokens)
  const rightCounts = tokenCounts(rightTokens)

  return [
    refineUnmatchedTextTokens(leftTokens, leftCounts, rightCounts),
    refineUnmatchedTextTokens(rightTokens, rightCounts, leftCounts),
  ]
}

/**
 * Splits a block's inline content into tokens.
 *
 * Token identity ignores marks so that bolding a word pairs the same word and
 * reports a mark change, rather than reading as a delete plus an insert.
 */
function inlineTokens(parent: Node): InlineToken[] {
  const tokens: InlineToken[] = []
  parent.forEach(child => {
    if (!child.isText) {
      tokens.push({
        key: `node:${child.type.name}:${attrsKey(child)}`,
        marksKey: marksKey(child.marks),
        size: child.nodeSize,
        node: child,
      })
      return
    }
    const marks = marksKey(child.marks)
    let offset = 0
    for (const token of tokenize(child.text ?? '')) {
      tokens.push({
        key: `text:${token}`,
        marksKey: marks,
        size: token.length,
        // `cut` keeps the source marks, which the deletion widget needs to
        // render removed content as it was styled.
        node: child.cut(offset, offset + token.length),
      })
      offset += token.length
    }
  })
  return tokens
}

/**
 * Accumulates same-kind neighbours into one change.
 *
 * A rewritten phrase spans several tokens; emitting one change each would
 * multiply the change count the navigation reports and paint separate spans over
 * what reads as a single edit.
 */
class ChangeBuilder {
  private pending: {
    kind: RevisionChangeKind
    from: number
    to: number
    typeName: string
    nodes: Node[]
  } | null = null

  constructor(private readonly changes: RevisionChange[]) {}

  add(
    kind: RevisionChangeKind,
    from: number,
    to: number,
    typeName: string,
    node?: Node
  ): void {
    const pending = this.pending
    // `typeName` is part of the predicate, not just `kind` and contiguity:
    // consecutive deletions are all zero-width at the same position, so a deleted
    // inline atom followed by deleted text would otherwise merge into one change
    // labelled with whichever arrived first.
    if (
      pending !== null &&
      pending.kind === kind &&
      pending.typeName === typeName &&
      pending.to === from
    ) {
      pending.to = to
      if (node !== undefined) {
        pending.nodes.push(node)
      }
      return
    }
    this.flush()
    this.pending = {
      kind,
      from,
      to,
      typeName,
      nodes: node === undefined ? [] : [node],
    }
  }

  flush(): void {
    const pending = this.pending
    this.pending = null
    if (pending === null) {
      return
    }
    if (pending.kind !== 'deleted') {
      this.changes.push({
        kind: pending.kind,
        from: pending.from,
        to: pending.to,
        typeName: pending.typeName,
      })
      return
    }
    // `fromArray` rejoins adjacent text nodes that share marks, so a deleted
    // phrase serialises as one run rather than one node per token.
    const content = Fragment.fromArray(pending.nodes)
    this.changes.push({
      kind: 'deleted',
      from: pending.from,
      to: pending.to,
      typeName: pending.typeName,
      deletedText: content.textBetween(0, content.size),
      deletedContent: content,
    })
  }
}

/**
 * Compares the inline content of two paired blocks at word granularity.
 */
function compareInline(
  before: Node,
  after: Node,
  rightStart: number,
  builder: ChangeBuilder
): void {
  const [left, right] = inlineTokenPair(before, after)
  const edits = diffSequence(left, right, token => token.key).edits

  let position = rightStart
  const takeEqual = (leftToken: InlineToken, rightToken: InlineToken): void => {
    if (leftToken.marksKey !== rightToken.marksKey) {
      builder.add(
        'marks-changed',
        position,
        position + rightToken.size,
        rightToken.node.isText ? 'text' : rightToken.node.type.name
      )
    } else {
      builder.flush()
    }
    position += rightToken.size
  }
  const takeDelete = (token: InlineToken): void => {
    builder.add(
      'deleted',
      position,
      position,
      token.node.isText ? 'text' : token.node.type.name,
      token.node
    )
  }
  const takeInsert = (token: InlineToken): void => {
    builder.add(
      'inserted',
      position,
      position + token.size,
      token.node.isText ? 'text' : token.node.type.name
    )
    position += token.size
  }

  for (const edit of edits) {
    if (edit.kind === 'equal') {
      takeEqual(edit.left, edit.right)
    } else if (edit.kind === 'delete') {
      takeDelete(edit.left)
    } else {
      takeInsert(edit.right)
    }
  }
  builder.flush()
}

function compareChildren(
  left: Node,
  right: Node,
  rightStart: number,
  builder: ChangeBuilder
): void {
  const pairings = pairRewrites(
    pairChildren(childrenOf(left), childrenOf(right))
  )
  let rightPosition = rightStart

  for (const pairing of pairings) {
    if (pairing.kind === 'insert' && pairing.right !== undefined) {
      const node = pairing.right
      builder.add(
        'inserted',
        rightPosition,
        rightPosition + node.nodeSize,
        node.type.name
      )
      builder.flush()
      rightPosition += node.nodeSize
      continue
    }

    if (pairing.kind === 'delete' && pairing.left !== undefined) {
      const node = pairing.left
      builder.add(
        'deleted',
        // Zero-width: the content is not in this document, so the range only
        // says where it was removed from.
        rightPosition,
        rightPosition,
        node.type.name,
        node
      )
      builder.flush()
      continue
    }

    const before = pairing.left
    const after = pairing.right
    if (before === undefined || after === undefined) {
      continue
    }

    if (after.isText) {
      if (marksKey(before.marks) !== marksKey(after.marks)) {
        builder.add(
          'marks-changed',
          rightPosition,
          rightPosition + after.nodeSize,
          'text'
        )
        builder.flush()
      }
      rightPosition += after.nodeSize
      continue
    }

    if (attrsKey(before) !== attrsKey(after)) {
      builder.add(
        'attrs-changed',
        rightPosition,
        rightPosition + after.nodeSize,
        after.type.name
      )
      builder.flush()
    }
    if (marksKey(before.marks) !== marksKey(after.marks)) {
      builder.add(
        'marks-changed',
        rightPosition,
        rightPosition + after.nodeSize,
        after.type.name
      )
      builder.flush()
    }

    // Leaf and atom nodes have no comparable interior; recursing into an atom
    // would report its internal structure as document changes.
    if (!after.isLeaf && !after.isAtom) {
      if (after.type.spec.content !== undefined && after.inlineContent) {
        compareInline(before, after, rightPosition + 1, builder)
      } else {
        compareChildren(before, after, rightPosition + 1, builder)
      }
    }
    rightPosition += after.nodeSize
  }
  builder.flush()
}

/**
 * Compares two revision bodies structurally.
 *
 * Positions are reported in `selected`, which is the document the viewer
 * renders; `compared` is the older side and contributes only deletions. The two
 * documents may come from different schema generations, so nothing here assumes
 * matching type sets — unpaired children are simply insertions or deletions.
 *
 * Text is compared at word granularity: an edited sentence reports the words that
 * changed, not the whole block.
 */
export function diffDocuments(compared: Node, selected: Node): RevisionDiff {
  const changes: RevisionChange[] = []
  const builder = new ChangeBuilder(changes)
  // Top-level children start at 0, not 1: the doc node itself occupies no
  // position in its own coordinate space.
  compareChildren(compared, selected, 0, builder)
  builder.flush()

  if (changes.length === 0) {
    return EMPTY_DIFF
  }
  const sorted = [...changes].sort((left, right) => left.from - right.from)
  return { changes: sorted, total: sorted.length }
}

export const EMPTY_REVISION_DIFF = EMPTY_DIFF
