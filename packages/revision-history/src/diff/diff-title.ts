import { tokenize } from './tokenize'

/**
 * Token-level diff of two revision titles.
 *
 * ## Why this is separate from `diffDocuments`
 *
 * The body diff runs its LCS over `InlineToken` objects that carry a ProseMirror
 * node, a size and a marks key, and it emits **document positions** for
 * `buildDiffDecorations` to paint inside the viewer's `EditorView`. A title is a
 * bare string: it has no nodes, no positions, and it is not inside that view.
 * Reusing that pipeline would mean inventing fake nodes to throw away again.
 *
 * What *is* shared is {@link tokenize} — the `Intl.Segmenter` boundaries that keep
 * a one-character edit inside a Chinese title from marking the whole title. That
 * is the part worth reusing, and it is reused verbatim.
 */

export type TitleSegmentKind = 'equal' | 'inserted' | 'deleted'

export interface TitleSegment {
  readonly kind: TitleSegmentKind
  readonly text: string
}

/**
 * Diffs two titles into renderable segments.
 *
 * Returns `null` when the title row must not be rendered at all:
 *
 * - **Either side is `null`** — the compare side is still loading, failed, or does
 *   not exist (the oldest revision has no previous one). A diff against a title we
 *   do not have would render the whole thing as inserted, which reads as "someone
 *   set the title in this revision" and is a claim we cannot support.
 * - **The titles are identical** — rendering it anyway would repeat the same title
 *   on every revision in the history. Most revisions do not change the title, so
 *   that is noise, not a change log. This is the caller's cue to render nothing.
 *
 * Note both-empty counts as identical and yields `null`; an empty title is not a
 * change worth a row.
 */
export function diffTitle(
  before: string | null | undefined,
  after: string | null | undefined
): readonly TitleSegment[] | null {
  if (
    before === null ||
    before === undefined ||
    after === null ||
    after === undefined
  ) {
    return null
  }
  if (before === after) {
    return null
  }

  const left = tokenize(before)
  const right = tokenize(after)

  // Classic LCS table, same shape as the body diff's — kept local rather than
  // extracted, because the two operate on different element types and a shared
  // generic would have to be parameterised on key extraction, size and emission.
  // Titles are bounded (128 chars), so the O(n*m) table is trivially small.
  const lengths: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0)
  )
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lengths[i][j] =
        left[i] === right[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1])
    }
  }

  const segments: TitleSegment[] = []
  // Adjacent same-kind tokens are merged so a rewritten phrase renders as one
  // span instead of one span per word — the same reason the body diff has
  // `ChangeBuilder`, minus the position bookkeeping it needs and this does not.
  const push = (kind: TitleSegmentKind, text: string): void => {
    const last = segments[segments.length - 1]
    if (last !== undefined && last.kind === kind) {
      segments[segments.length - 1] = { kind, text: last.text + text }
      return
    }
    segments.push({ kind, text })
  }

  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      push('equal', right[j])
      i += 1
      j += 1
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      push('deleted', left[i])
      i += 1
    } else {
      push('inserted', right[j])
      j += 1
    }
  }
  while (i < left.length) {
    push('deleted', left[i])
    i += 1
  }
  while (j < right.length) {
    push('inserted', right[j])
    j += 1
  }

  return segments
}
