export type SequenceEdit<T> =
  | { readonly kind: 'equal'; readonly left: T; readonly right: T }
  | { readonly kind: 'delete'; readonly left: T }
  | { readonly kind: 'insert'; readonly right: T }

export interface SequenceDiffResult<T> {
  readonly edits: readonly SequenceEdit<T>[]
  /** `coarse` 表示 Myers 超过预算，未对齐中段已降级为“全删 + 全增”。 */
  readonly precision: 'exact' | 'coarse'
}

export interface SequenceDiffOptions {
  /** Myers 允许探索的最大编辑距离。 */
  readonly maxEditDistance?: number
  /** 回溯 trace 允许保存的 Int32 单元总数。 */
  readonly maxTraceCells?: number
}

/**
 * 最坏情况下把算法控制在交互式历史面板可接受的范围内。
 *
 * 公共前后缀会先被剥离，因此“很长文档只改一处”仍只探索很小的 D；真正触发限制的是
 * 大段完全无关的内容，此时粗粒度全删/全增比占满主线程和内存更可取。
 */
const DEFAULT_MAX_EDIT_DISTANCE = 1024
// sum(2D + 1), D=0..1024 = 1,050,625；略留余量但仍控制在约 4.4 MiB。
const DEFAULT_MAX_TRACE_CELLS = 1_100_000
const UNREACHABLE = -1

interface MiddleDiff<T> {
  readonly edits: readonly SequenceEdit<T>[]
  readonly exact: boolean
}

function finiteLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback
  }
  return Math.max(0, Math.floor(value))
}

function frontierValue(
  frontier: Int32Array,
  distance: number,
  diagonal: number
): number {
  if (diagonal < -distance || diagonal > distance) {
    return UNREACHABLE
  }
  return frontier[diagonal + distance] ?? UNREACHABLE
}

function backtrack<T>(
  trace: readonly Int32Array[],
  left: readonly T[],
  right: readonly T[]
): SequenceEdit<T>[] {
  const reversed: SequenceEdit<T>[] = []
  let x = left.length
  let y = right.length

  for (let distance = trace.length - 1; distance > 0; distance -= 1) {
    const previous = trace[distance - 1]
    const diagonal = x - y
    const cameFromInsertion =
      diagonal === -distance ||
      (diagonal !== distance &&
        frontierValue(previous, distance - 1, diagonal - 1) <
          frontierValue(previous, distance - 1, diagonal + 1))
    const previousDiagonal = cameFromInsertion ? diagonal + 1 : diagonal - 1
    const previousX = frontierValue(previous, distance - 1, previousDiagonal)
    const previousY = previousX - previousDiagonal

    while (x > previousX && y > previousY) {
      reversed.push({
        kind: 'equal',
        left: left[x - 1],
        right: right[y - 1],
      })
      x -= 1
      y -= 1
    }

    if (cameFromInsertion) {
      y -= 1
      reversed.push({ kind: 'insert', right: right[y] })
    } else {
      x -= 1
      reversed.push({ kind: 'delete', left: left[x] })
    }
  }

  while (x > 0 && y > 0) {
    reversed.push({
      kind: 'equal',
      left: left[x - 1],
      right: right[y - 1],
    })
    x -= 1
    y -= 1
  }
  while (x > 0) {
    x -= 1
    reversed.push({ kind: 'delete', left: left[x] })
  }
  while (y > 0) {
    y -= 1
    reversed.push({ kind: 'insert', right: right[y] })
  }

  return reversed.reverse()
}

function coarseMiddle<T>(
  left: readonly T[],
  right: readonly T[]
): MiddleDiff<T> {
  return {
    edits: [
      ...left.map<SequenceEdit<T>>(value => ({ kind: 'delete', left: value })),
      ...right.map<SequenceEdit<T>>(value => ({
        kind: 'insert',
        right: value,
      })),
    ],
    exact: false,
  }
}

/** 对已经剥离公共前后缀的中段执行 Myers。 */
function myersMiddle<T, K>(
  left: readonly T[],
  right: readonly T[],
  leftKeys: readonly K[],
  rightKeys: readonly K[],
  options: SequenceDiffOptions
): MiddleDiff<T> {
  if (left.length === 0) {
    return {
      edits: right.map(value => ({ kind: 'insert', right: value })),
      exact: true,
    }
  }
  if (right.length === 0) {
    return {
      edits: left.map(value => ({ kind: 'delete', left: value })),
      exact: true,
    }
  }

  const maximumDistance = Math.min(
    left.length + right.length,
    finiteLimit(options.maxEditDistance, DEFAULT_MAX_EDIT_DISTANCE)
  )
  const maximumTraceCells = finiteLimit(
    options.maxTraceCells,
    DEFAULT_MAX_TRACE_CELLS
  )
  const trace: Int32Array[] = []
  let traceCells = 0

  for (let distance = 0; distance <= maximumDistance; distance += 1) {
    const frontierLength = distance * 2 + 1
    if (traceCells + frontierLength > maximumTraceCells) {
      return coarseMiddle(left, right)
    }
    traceCells += frontierLength

    const current = new Int32Array(frontierLength)
    current.fill(UNREACHABLE)
    const previous = trace[distance - 1]

    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      let x: number
      if (distance === 0) {
        x = 0
      } else {
        const deletionX = frontierValue(previous, distance - 1, diagonal - 1)
        const insertionX = frontierValue(previous, distance - 1, diagonal + 1)
        // 与旧 LCS 保持同一个确定性方向：两条最短路径等价时优先 delete。
        x =
          diagonal === -distance ||
          (diagonal !== distance && deletionX < insertionX)
            ? insertionX
            : deletionX + 1
      }

      let y = x - diagonal
      while (
        x < left.length &&
        y < right.length &&
        Object.is(leftKeys[x], rightKeys[y])
      ) {
        x += 1
        y += 1
      }
      current[diagonal + distance] = x

      if (x >= left.length && y >= right.length) {
        trace.push(current)
        return { edits: backtrack(trace, left, right), exact: true }
      }
    }
    trace.push(current)
  }

  return coarseMiddle(left, right)
}

/**
 * 对任意序列生成确定性的 Myers 最短编辑脚本。
 *
 * `keyOf` 只执行一次，避免 ProseMirror 节点的深层 identity 在每条 snake 上重复计算。
 * 公共前后缀无论是否触发预算降级都会保留；降级只作用于真正无法在预算内对齐的中段。
 */
export function diffSequence<T, K>(
  left: readonly T[],
  right: readonly T[],
  keyOf: (value: T) => K,
  options: SequenceDiffOptions = {}
): SequenceDiffResult<T> {
  const leftKeys = left.map(keyOf)
  const rightKeys = right.map(keyOf)
  let prefix = 0
  while (
    prefix < left.length &&
    prefix < right.length &&
    Object.is(leftKeys[prefix], rightKeys[prefix])
  ) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    Object.is(
      leftKeys[left.length - suffix - 1],
      rightKeys[right.length - suffix - 1]
    )
  ) {
    suffix += 1
  }

  const prefixEdits: SequenceEdit<T>[] = []
  for (let index = 0; index < prefix; index += 1) {
    prefixEdits.push({
      kind: 'equal',
      left: left[index],
      right: right[index],
    })
  }

  const leftEnd = left.length - suffix
  const rightEnd = right.length - suffix
  const middle = myersMiddle(
    left.slice(prefix, leftEnd),
    right.slice(prefix, rightEnd),
    leftKeys.slice(prefix, leftEnd),
    rightKeys.slice(prefix, rightEnd),
    options
  )

  const suffixEdits: SequenceEdit<T>[] = []
  for (let index = 0; index < suffix; index += 1) {
    suffixEdits.push({
      kind: 'equal',
      left: left[leftEnd + index],
      right: right[rightEnd + index],
    })
  }

  return {
    edits: [...prefixEdits, ...middle.edits, ...suffixEdits],
    precision: middle.exact ? 'exact' : 'coarse',
  }
}
