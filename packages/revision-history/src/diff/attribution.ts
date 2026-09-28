/**
 * 一段连续内容的归属。位置是**所选版本文档**的 ProseMirror 坐标，与 diff 报出的
 * `from`/`to` 同一坐标系 —— 服务端把两者锚在同一份 canonical 文档上产出。
 *
 * 区间为半开 `[from, to)`：与 ProseMirror 的位置语义一致，相邻两段才能首尾相接
 * 而不重叠。
 */
export interface AttributionRange {
  readonly from: number
  readonly to: number
  readonly author: string
}

/**
 * 逐处归属：普通快照。
 *
 * **这是区间量，不是累计量。** 区间只声明「从上一版到这一版之间新增了哪些位置、是谁
 * 写的」，不描述「此刻每个幸存字符是谁写的」。判据在服务端：拿上一条修订的 Yjs 状态
 * 向量作基线，只声明 `clock` 在基线之后的 item。
 *
 * 之所以必须是区间量，是因为归属的唯一消费者是 diff 徽章，而徽章要回答的是「**这一处
 * 改动**是谁做的」。累计量答的是另一个问题，两者在一处静默冲突：`resolveAuthor` 先探
 * `change.from`，命中即返回。累计量下改一个老段落里的文字、diff 报成块级变更时，开
 * 标签那一位会命中「当年建这个段落的人」并直接返回 —— 徽章签的是三年前的人，真正的
 * 编辑者就在 `from + 1` 上等着却永远问不到。
 *
 * 区间量因此与列表侧的 `collaborators` 成为同一量纲：一个说「这个区间改了哪些位置」，
 * 一个说「谁改的」。两者不再各说各话。
 *
 * 代价是**删除通常没有归属**：Yjs 的删除只在 delete set 里记「删了什么」，不记「谁
 * 删的」，被删 item 可见长度为 0、不产出区间；而删除点两侧若是上一版就存在的内容，
 * 那些位置也不在本区间里。于是徽章从「签错人」变成「不签名」——「未记录」由高亮的
 * 中性色承担，见 {@link AttributionIndex}。
 */
export interface RangesAttribution {
  readonly kind: 'ranges'
  readonly ranges: readonly AttributionRange[]
  /**
   * 这一版里各处删除的署名。缺失或空表示服务端没有删除记录 —— 此时删除不署名，与
   * 本字段出现之前的行为一致。
   */
  readonly deletions?: readonly DeletionMark[]
}

/**
 * 一处删除的署名。
 *
 * **零宽**：`at` 是「原内容曾在这里」的位置，也正是 diff 报删除变更时 `change.from`
 * 落的地方。刻意不是 `[from,to)` 区间 —— 被删内容不在这一版的坐标系里，给不出宽度。
 *
 * 与 `ranges` 分开而不是并进同一个数组：多个删除可以锚在**同一个** `at`（Yjs 会把相邻
 * 删除合并成一个墓碑，服务端按 clock 区间切回各自作者后就是这个形态），而 `ranges`
 * 要求升序不重叠 —— 那是二分查找的前提。
 *
 * 作者不来自 Yjs：delete set 只记「删了什么」不记「谁删的」。这份数据由服务端协同层在
 * 删除那一刻捕获、随修订物化落库。
 */
export interface DeletionMark {
  readonly at: number
  readonly author: string
}

/**
 * 整篇归属：回滚快照。
 *
 * 回滚快照的 Yjs state 是被恢复版的逐字副本，逐处推导会得到内容原作者；这一版
 * 的内容是执行恢复者一个动作造成的，所以整篇归他。
 */
export interface WholeAttribution {
  readonly kind: 'whole'
  readonly author: string
}

export type RevisionAttribution = RangesAttribution | WholeAttribution

export interface AttributionIndex {
  /**
   * 该位置的作者，无归属时 `null`。
   *
   * `null` 的正确读法是「这一版没在这个位置新增内容」，不是「查询失败」。区间量下它
   * 是常态：上一版就存在的内容不在任何区间里。上层据此不署名、不上色，由样式表的中性色
   * 承担 —— 见 {@link RangesAttribution}。
   *
   * **删除不走这里**，它有独立的 {@link deletedAuthorAt}：删除是零宽的，且删除点常常
   * 落在上一版就存在的内容之间，用区间查询必然落空。
   */
  authorAt(position: number): string | null
  /**
   * 当前位置没有精确归属时，向文档前方回溯最近一条服务端证据。
   *
   * `ranges` 与 `deletions` 都参与：区间用排他的右边界代表它最后覆盖到的位置，删除用
   * 零宽锚点 `at`。两者同样近时删除优先，因为它是一次具体操作的显式记录；区间只是
   * 某段新增内容的覆盖范围。
   *
   * 这是客户端 diff 与服务端坐标存在偏差时的就近适配。它刻意与 {@link authorAt}
   * 分开：精确查询仍保持半开区间语义，只有展示层明确选择回溯时才会继承前序作者。
   */
  authorAtOrBefore(position: number): string | null
  /**
   * 返回与 `[from, to)` 相交的服务端新增区间，并裁到查询边界内。
   *
   * 这不是另一套归属推导：返回的仍是建立索引时已经过滤、排序过的同一批 `ranges`。
   * 展示层只在一个整块 diff 内需要表达多位作者时使用它；普通单点查询继续走
   * {@link authorAt} / {@link authorAtOrBefore}，避免两套过滤规则漂移。
   */
  rangesBetween(from: number, to: number): readonly AttributionRange[]
  /**
   * 该位置**被删内容**的删除者，无记录时 `null`。
   *
   * 与 `authorAt` 分开是因为语义不同：那个问「这个位置的内容是谁写的」，这个问「原本在
   * 这个位置、现已不存在的内容是谁删的」。同一个位置两者可以都有值（在一段新增文本的
   * 中间又删掉了旧内容），答案也不必相同。
   *
   * 同一位置有多人时返回**第一个**（服务端保序，即先删的那个）。服务端如实给出全部
   * 作者，取舍留给展示层 —— 需要「等 N 人」或 hover 展开时，改这里的取法即可。
   */
  deletedAuthorAt(position: number): string | null
}

const EMPTY_INDEX: AttributionIndex = Object.freeze({
  authorAt: (): string | null => null,
  authorAtOrBefore: (): string | null => null,
  rangesBetween: (): readonly AttributionRange[] => [],
  deletedAuthorAt: (): string | null => null,
})

interface DeletionEvidence {
  readonly at: number
  readonly author: string
}

/**
 * 保留每个删除锚点的第一位作者，并按坐标排序，供向前就近适配二分查询。
 *
 * `deletedAuthorAt` 的精确查询仍用 Map；这里另建有序表，是因为同一位置多人时必须沿用
 * 同一个“第一位作者”取舍，不能排序后悄悄换人。
 */
function deletionEvidence(
  deletions: readonly DeletionMark[] | undefined
): readonly DeletionEvidence[] {
  if (deletions === undefined || deletions.length === 0) {
    return []
  }

  const firstByPosition = new Map<number, string>()
  for (const mark of deletions) {
    if (
      mark.author === '' ||
      !Number.isFinite(mark.at) ||
      firstByPosition.has(mark.at)
    ) {
      continue
    }
    firstByPosition.set(mark.at, mark.author)
  }

  return [...firstByPosition]
    .map(([at, author]) => ({ at, author }))
    .sort((left, right) => left.at - right.at)
}

/** 返回坐标不大于 `position` 的最后一条删除证据。 */
function deletionAtOrBefore(
  evidence: readonly DeletionEvidence[],
  position: number
): DeletionEvidence | null {
  let low = 0
  let high = evidence.length - 1
  let found: DeletionEvidence | null = null

  while (low <= high) {
    const middle = (low + high) >> 1
    const candidate = evidence[middle]
    if (candidate.at <= position) {
      found = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }

  return found
}

/**
 * 建立位置到删除者的查询。
 *
 * 用 Map 而不是二分：`deletions` 是零宽点，同一位置可以有多条（Yjs 合并相邻删除后，
 * 服务端按 clock 切回各自作者就是这个形态），点集上的相等查询用 Map 最直接。
 * 保留第一条 —— 服务端按写入顺序给出，即先删的那个。
 */
function indexDeletions(
  deletions: readonly DeletionMark[] | undefined
): (position: number) => string | null {
  if (deletions === undefined || deletions.length === 0) {
    return () => null
  }

  const byPosition = new Map<number, string>()
  for (const mark of deletions) {
    if (mark.author === '' || byPosition.has(mark.at)) continue
    byPosition.set(mark.at, mark.author)
  }

  return (position: number) => byPosition.get(position) ?? null
}

/**
 * 建立位置到作者的查询。
 *
 * 三种形态各自的语义：`ranges` 二分查找、`whole` 恒定返回、`null` 恒定为空。
 *
 * 落在任何区间外返回 `null` 而不是就近取一段。区间量下「区间外」覆盖两类位置：上一版
 * 就有的内容，以及被删掉的内容 —— 两者都不该署名，因为徽章说的是「这一处改动是谁做
 * 的」。就近取一段会把「这一版没动这里」答成一个确定的人，而猜出来的归属和错误的归属
 * 没有区别。
 *
 * 查不到时**不回落到版本级 `createdBy`**：那是「谁存了这一版」，与「这段内容是谁写
 * 的」没有可推导关系。留白由高亮的中性色承担。
 */
export function createAttributionIndex(
  attribution: RevisionAttribution | null
): AttributionIndex {
  if (attribution === null) {
    return EMPTY_INDEX
  }

  if (attribution.kind === 'whole') {
    const author = attribution.author
    if (author === '') {
      return EMPTY_INDEX
    }
    // 不看 position：整篇归属与位置无关。删除同样归他 —— 整篇归属的语义就是「这一版
    // 全部由这个人造成」，包括他删掉的部分。
    return Object.freeze({
      authorAt: (): string | null => author,
      authorAtOrBefore: (): string | null => author,
      rangesBetween: (from: number, to: number): readonly AttributionRange[] =>
        to > from ? [{ from, to, author }] : [],
      deletedAuthorAt: (): string | null => author,
    })
  }

  const deletedAuthorAt = indexDeletions(attribution.deletions)
  const deletions = deletionEvidence(attribution.deletions)
  const ranges = [...attribution.ranges]
    .filter(range => range.to > range.from && range.author !== '')
    // 服务端保证有序，这里仍排一次：二分查找的前提是有序，而一次乱序会让查询
    // 静默返回错误的人，比多一次 O(n log n) 昂贵得多。
    .sort((left, right) => left.from - right.from)

  // 只有两者都空才退回空索引。纯删除的修订一条 range 都没有（区间量下「这一版什么都
  // 没新增」是常态），但它的删除署名仍要能查 —— 那恰恰是这类修订唯一有的信息。
  const hasDeletions = (attribution.deletions?.length ?? 0) > 0
  if (ranges.length === 0 && !hasDeletions) {
    return EMPTY_INDEX
  }
  if (ranges.length === 0) {
    return Object.freeze({
      authorAt: (): string | null => null,
      authorAtOrBefore: (position: number): string | null =>
        deletionAtOrBefore(deletions, position)?.author ?? null,
      rangesBetween: (): readonly AttributionRange[] => [],
      deletedAuthorAt,
    })
  }

  const authorAt = (position: number): string | null => {
    let low = 0
    let high = ranges.length - 1
    while (low <= high) {
      const middle = (low + high) >> 1
      const range = ranges[middle]
      if (position < range.from) {
        high = middle - 1
        continue
      }
      if (position >= range.to) {
        low = middle + 1
        continue
      }
      return range.author
    }
    return null
  }

  return Object.freeze({
    authorAt,
    rangesBetween: (from: number, to: number): readonly AttributionRange[] => {
      if (to <= from) {
        return []
      }

      const matches: AttributionRange[] = []
      // 递归拆嵌套块时每个子树都会查询一次。先二分到第一条可能相交的 range，避免
      // 大文档里 N 个节点各自从 ranges[0] 线性扫起而退化成 O(N × R)。
      let low = 0
      let high = ranges.length
      while (low < high) {
        const middle = (low + high) >> 1
        if (ranges[middle].to <= from) {
          low = middle + 1
        } else {
          high = middle
        }
      }

      for (let index = low; index < ranges.length; index += 1) {
        const range = ranges[index]
        if (range.from >= to) {
          break
        }
        matches.push({
          from: Math.max(from, range.from),
          to: Math.min(to, range.to),
          author: range.author,
        })
      }
      return matches
    },
    authorAtOrBefore: (position: number): string | null => {
      const exact = authorAt(position)
      if (exact !== null) {
        return exact
      }

      // 找最后一个起点不晚于当前位置的区间。服务端保证区间互不重叠；客户端已排序，
      // 所以它就是当前位置之前最近的 range 候选。
      let low = 0
      let high = ranges.length - 1
      let precedingRange: AttributionRange | null = null
      while (low <= high) {
        const middle = (low + high) >> 1
        const range = ranges[middle]
        if (range.from <= position) {
          precedingRange = range
          low = middle + 1
        } else {
          high = middle - 1
        }
      }

      const precedingDeletion = deletionAtOrBefore(deletions, position)
      if (precedingRange === null) {
        return precedingDeletion?.author ?? null
      }
      if (precedingDeletion === null) {
        return precedingRange.author
      }

      // range.to 是排他边界，但最接近该边界的已知位置就在它前面；用边界比较距离无需
      // 假设坐标一定是整数。相等时显式删除证据优先。
      return precedingDeletion.at >= precedingRange.to
        ? precedingDeletion.author
        : precedingRange.author
    },
    deletedAuthorAt,
  })
}
